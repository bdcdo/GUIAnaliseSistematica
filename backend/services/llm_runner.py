"""
LLM runner service — coordinates dataframeit execution.

Security: o schema Pydantic do projeto é reconstruído a partir do AST validado
(`build_model_from_code`), sem exec — ver services/pydantic_compiler.
"""

import hashlib
import logging
import random
import re
import time
import traceback
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import pandas as pd

# Importado no topo (e não junto do `from dataframeit import dataframeit` que
# vive dentro de _run_dataframeit_batches) porque os testes substituem
# sys.modules["dataframeit"] por um SimpleNamespace sem submódulos: resolver a
# tupla em import-time do módulo mantém esses testes válidos sem que eles
# precisem conhecer este import.
from dataframeit.errors import NON_RECOVERABLE_ERRORS

from services.auto_review_reconciliation import wake_auto_review_reconciliation
from services.condition_evaluator import evaluate_condition, extract_field_conditions
from services.pydantic_compiler import build_model_from_code, extract_json_schema_extra
from services.supabase_client import get_supabase

logger = logging.getLogger(__name__)

# In-memory job tracking
_jobs: dict[str, dict] = {}

_JUSTIFICATION_FIELD_SUFFIX = "_justification"
_GENERATED_JUSTIFICATION_FIELDS_ATTR = "__generated_justification_fields__"


def _status_from_row(row: dict) -> dict:
    """Shape a llm_runs row as a StatusResponse-compatible dict."""
    return {
        "status": row.get("status", "error"),
        "phase": row.get("phase", "error"),
        "progress": row.get("progress") or 0,
        "total": row.get("total") or 0,
        "errors": [row["error_message"]] if row.get("error_message") else [],
        "eta_seconds": None,
        "current_batch": 0,
        "total_batches": 0,
        "error_traceback": row.get("error_traceback"),
        "error_type": row.get("error_type"),
        "error_line": row.get("error_line"),
        "error_column": row.get("error_column"),
        "pydantic_code": row.get("pydantic_code"),
        # Counters persistidos em llm_runs pelo save loop (ver
        # _persist_run_progress). No fallback de container reiniciado, ainda
        # mostram o ultimo snapshot conhecido — antes desta migration ficavam
        # zerados, o que mascarava o trabalho ja feito.
        "processed_complete": row.get("processed_complete") or 0,
        "processed_partial": row.get("processed_partial") or 0,
        "processed_empty": row.get("processed_empty") or 0,
    }


def get_job_status(job_id: str) -> dict:
    if job_id in _jobs:
        return _jobs[job_id]
    # Fallback: job vanished from memory (container restart) but may exist in DB.
    try:
        sb = get_supabase()
        row = (
            sb.table("llm_runs")
            .select(
                "status, phase, progress, total, error_message, error_type, "
                "error_traceback, error_line, error_column, pydantic_code, "
                "processed_complete, processed_partial, processed_empty"
            )
            .eq("job_id", job_id)
            .maybe_single()
            .execute()
            .data
        )
        if row:
            return _status_from_row(row)
    except Exception:
        logger.exception("Failed to fetch job status from llm_runs fallback")
    return {
        "status": "error",
        "phase": "error",
        "progress": 0,
        "total": 0,
        "errors": ["Job not found"],
        "eta_seconds": None,
        "current_batch": 0,
        "total_batches": 0,
        "processed_complete": 0,
        "processed_partial": 0,
        "processed_empty": 0,
    }


def _extract_pydantic_location(
    exc: Exception, tb: str
) -> tuple[int | None, int | None]:
    """Best-effort line/column inside pydantic_code where the error originated."""
    if isinstance(exc, SyntaxError) and exc.filename in (None, "<pydantic_schema>"):
        return exc.lineno, exc.offset
    # build_model_from_code envolve erros de sintaxe num SchemaError e carrega
    # lineno/offset nele (o `compile`/exec antigo expunha um SyntaxError direto,
    # caminho que não existe mais). getattr evita acoplar o import do SchemaError.
    lineno = getattr(exc, "lineno", None)
    if isinstance(lineno, int):
        return lineno, getattr(exc, "offset", None)
    m = re.search(r'File "<pydantic_schema>", line (\d+)', tb)
    if m:
        return int(m.group(1)), None
    return None, None


def _persist_run_insert(sb, job_id: str, project_id: str, filter_mode: str) -> None:
    """Insert the initial 'running' row as soon as the job starts.

    Re-raise on failure: se o INSERT em llm_runs morrer silenciosamente, a run
    fica órfã (executa em memória mas não aparece na aba Execuções), o que já
    enganou o usuário no passado. Melhor falhar a request do /run e mostrar o
    erro de cara em vez de seguir uma execução invisível.
    """
    sb.table("llm_runs").insert(
        {
            "job_id": job_id,
            "project_id": project_id,
            "filter_mode": filter_mode,
            "status": "running",
            "phase": "loading",
            # heartbeat inicial. O save loop renova a cada ~2s (ver
            # _persist_run_progress); cleanup ativo (mark_stale_runs_as_error)
            # marca como erro runs cujo heartbeat ficou velho.
            "heartbeat_at": datetime.now(timezone.utc).isoformat(),
        }
    ).execute()


def _persist_run_progress(sb, job_id: str, jobs_state: dict) -> None:
    """Persistir snapshot de counters + heartbeat em llm_runs.

    Chamado periodicamente pelo save loop (throttle 2s). Erros aqui são
    logados, não re-lançados: a run principal não deve abortar só porque uma
    atualização de progresso falhou. O próximo tick tenta de novo.
    """
    try:
        sb.table("llm_runs").update(
            {
                "processed_complete": jobs_state.get("processed_complete", 0),
                "processed_partial": jobs_state.get("processed_partial", 0),
                "processed_empty": jobs_state.get("processed_empty", 0),
                "progress": jobs_state.get("progress", 0),
                "heartbeat_at": datetime.now(timezone.utc).isoformat(),
            }
        ).eq("job_id", job_id).execute()
    except Exception:
        logger.exception("Failed to UPDATE llm_runs progress for job %s", job_id)


def mark_stale_runs_as_error(sb, project_id: str) -> int:
    """Marcar como 'error' runs órfãs do projeto (sem heartbeat recente).

    Critério: status='running' e (heartbeat antigo OR heartbeat null com
    started_at antigo). O segundo caso cobre runs criadas antes desta
    migration que nunca terão heartbeat.

    Retorna o número de runs marcadas como erro. Idempotente.
    """
    now = datetime.now(timezone.utc)
    # 10 minutos sem heartbeat = morta. O save loop renova a cada ~2s, mas
    # o heartbeat na fase de processing só dispara após cada batch retornar
    # — uma chamada single-batch a um provider lento (Claude com thinking,
    # OpenAI sob throttling) pode passar de 5min sem update. 10min absorve
    # esse caso sem deixar runs zumbis pendurarem por muito tempo. 30min
    # para runs sem heartbeat (pré-migration) — conservador.
    heartbeat_cutoff_iso = (now - timedelta(minutes=10)).isoformat()
    started_cutoff_iso = (now - timedelta(minutes=30)).isoformat()

    error_msg = (
        "Execução abandonada (sem heartbeat — possivelmente o backend "
        "reiniciou ou a máquina hibernou)."
    )
    # PostgREST .or_ syntax: separa termos por vírgula; agrupa com and(...).
    # Assunção: timestamps de datetime.isoformat() não contêm vírgulas nem
    # parênteses — caracteres reservados pela sintaxe da .or_(). Hoje verdade
    # (ISO-8601 usa apenas dígitos, "-", "T", ":", "."), mas se algum dia for
    # migrado para um formato que possa conter esses chars, será preciso usar
    # .or_("...", reference_table=...) ou escapar adequadamente.
    or_clause = (
        f"heartbeat_at.lt.{heartbeat_cutoff_iso},"
        f"and(heartbeat_at.is.null,started_at.lt.{started_cutoff_iso})"
    )
    res = (
        sb.table("llm_runs")
        .update(
            {
                "status": "error",
                "phase": "error",
                "error_message": error_msg,
                "completed_at": now.isoformat(),
            }
        )
        .eq("project_id", project_id)
        .eq("status", "running")
        .or_(or_clause)
        .execute()
    )
    return len(res.data or [])


def _persist_run_snapshot(sb, job_id: str, project: dict, doc_count: int) -> None:
    """Backfill provider/model/pydantic snapshot after the project is loaded.

    Não engolir erro: se essa atualização falhar, a aba Execuções fica sem
    metadados da run e o usuário não consegue diagnosticar nada depois.
    """
    sb.table("llm_runs").update(
        {
            "llm_provider": project.get("llm_provider"),
            "llm_model": project.get("llm_model"),
            "document_count": doc_count,
            "pydantic_code": project.get("pydantic_code"),
            # A rodada é capturada junto do restante do snapshot da execução.
            # Mesmo que o coordenador inicie outra rodada enquanto o provider
            # processa os documentos, todas as respostas desta run continuam
            # apontando para a rodada que estava ativa no início.
            "round_id": project.get("current_round_id"),
        }
    ).eq("job_id", job_id).execute()


def _persist_run_completion(
    sb,
    job_id: str,
    progress: int,
    total: int,
    warnings: list[str] | None = None,
    counters: dict | None = None,
) -> None:
    """Mark the run as completed. Errors here are logged but do not re-raise.

    Diferente de _persist_run_insert/_snapshot: aqui a execução já terminou e o
    payload já está em responses. Ressuscitar a exception levaria a `_persist_run_error`
    em cascata e duplicaria o registro de falha. Logar é suficiente.

    `counters` recebe dict com processed_complete/partial/empty para fechar
    o snapshot final consistente — sem isso, o último update via
    _persist_run_progress poderia ter ficado desatualizado em até 2s.
    """
    try:
        payload: dict = {
            "status": "completed",
            "phase": "completed",
            "progress": progress,
            "total": total,
            "completed_at": datetime.now(timezone.utc).isoformat(),
        }
        if counters:
            payload["processed_complete"] = counters.get("processed_complete", 0)
            payload["processed_partial"] = counters.get("processed_partial", 0)
            payload["processed_empty"] = counters.get("processed_empty", 0)
        # Persistir warnings de cobertura parcial reutilizando error_message
        # (evita migration). Motivo: llm_runs.error_message é o único campo
        # livre para texto diagnóstico pós-completion.
        if warnings:
            payload["error_message"] = "Warnings ({} doc(s)): {}".format(
                len(warnings), " | ".join(warnings[:20])
            )
        sb.table("llm_runs").update(payload).eq("job_id", job_id).execute()
    except Exception:
        logger.exception("Failed to UPDATE llm_runs completion for job %s", job_id)


def _persist_run_error(
    sb, job_id: str, exc: Exception, tb: str, counters: dict | None = None
) -> tuple[int | None, int | None]:
    line, col = _extract_pydantic_location(exc, tb)
    try:
        payload: dict = {
            "status": "error",
            "phase": "error",
            "error_message": str(exc),
            "error_type": type(exc).__name__,
            "error_traceback": tb,
            "error_line": line,
            "error_column": col,
            "completed_at": datetime.now(timezone.utc).isoformat(),
        }
        if counters:
            payload["processed_complete"] = counters.get("processed_complete", 0)
            payload["processed_partial"] = counters.get("processed_partial", 0)
            payload["processed_empty"] = counters.get("processed_empty", 0)
        sb.table("llm_runs").update(payload).eq("job_id", job_id).execute()
    except Exception:
        logger.exception("Failed to UPDATE llm_runs error for job %s", job_id)
    return line, col


def _answers_have_content(answers: dict) -> bool:
    """True se algum field tem valor significativo. Espelha
    LlmResponseRow.classifyResponse no frontend para counters consistentes.
    """
    for v in answers.values():
        if v is None:
            continue
        if isinstance(v, str):
            if v.strip():
                return True
        elif isinstance(v, list):
            if v:
                return True
        elif isinstance(v, dict):
            if v:
                return True
        else:
            return True
    return False


def _is_nan(val) -> bool:
    """True se val for um float NaN. Outros tipos não são considerados NaN.

    Necessário porque dataframeit deixa np.nan em rows com erro, e bool(NaN)
    é True em Python — sem essa guarda, NaN passaria como "preenchido".
    """
    return isinstance(val, float) and pd.isna(val)


def _extract_answers_from_row(row, model_class) -> tuple[dict, dict]:
    """Extrai answers e justifications de uma row do result_df.

    Itera sobre `model_class.model_fields` (não sobre as colunas da row) para
    descartar colunas internas do dataframeit (`_dataframeit_status`,
    `_error_details`) e qualquer extra que o provider tenha incluído.

    Filtra NaN explicitamente — sem isso, rows que dataframeit marcou como
    erro (que vêm com NaN nos campos) entrariam em `answers` como "preenchido".

    Tipos: listas são preservadas como listas (o JSONB da coluna `answers`
    aceita arrays); todos os outros tipos primitivos (int, bool, float, etc.)
    são convertidos para `str` via `str(val)`. Isso é intencional — o frontend
    (`formatValue` em LlmResponseRow.tsx) e o pipeline de comparação tratam
    answers como strings, então normalizar aqui evita ramos especiais
    downstream. Se algum dia precisar do tipo original, será preciso revisitar
    LlmResponseRow + classify.ts em conjunto.
    """
    answers: dict = {}
    justifications: dict = {}
    generated_justification_fields = _generated_justification_fields(model_class)

    for field_name in model_class.model_fields:
        if field_name in generated_justification_fields:
            continue
        val = row.get(field_name)
        if val is not None and not _is_nan(val):
            if isinstance(val, list):
                answers[field_name] = val
            else:
                answers[field_name] = str(val)

        just_col = f"{field_name}{_JUSTIFICATION_FIELD_SUFFIX}"
        # `just_col in row` aceita tanto dict quanto pandas.Series; truthy
        # check em conjunto com _is_nan cobre None, "", e NaN.
        if just_col in generated_justification_fields and just_col in row:
            jval = row[just_col]
            if jval and not _is_nan(jval):
                justifications[field_name] = str(jval)

    return answers, justifications


def _build_llm_error_message(
    *,
    dfi_error: str | None,
    is_empty: bool,
    is_partial: bool,
    dfi_status,
    pre_prune_keys: list[str],
    post_prune_keys: list[str],
    answered_count: int,
    active_expected_count: int,
) -> str | None:
    """Monta a mensagem para responses.llm_error a partir do diagnóstico.

    Hierarquia (ordem importa):
    1. Erro cru do dataframeit (timeout, parse, structured-output null)
    2. answers vazio após prune (LLM trouxe os campos mas evaluate_condition
       zerou) ou LLM trouxe vazio direto
    3. Cobertura baixa (LLM já chega com poucos campos)
    Retorna None quando a resposta está saudável.
    """
    if dfi_error:
        return f"dataframeit: {dfi_error}"
    if is_empty:
        return (
            f"answers vazio após prune; pre_prune_keys={pre_prune_keys}; "
            f"dfi_status={dfi_status}"
        )
    if is_partial:
        return (
            f"cobertura baixa ({answered_count}/{active_expected_count}); "
            f"pre_prune_keys={pre_prune_keys}; "
            f"post_prune_keys={post_prune_keys}"
        )
    return None


@dataclass(frozen=True)
class _RunMetadata:
    """Metadados invariantes por run, compartilhados entre todas as rows.

    Agrupa os campos que antes eram passados soltos como kwargs duplicados
    em `_process_and_save_rows` e `_build_llm_response_row` — um campo novo
    de metadado passa a ser adicionado em 1 lugar (a dataclass) em vez de 2
    assinaturas + 2 call sites.
    """

    project_id: str
    round_id: str
    llm_provider: str
    llm_model: str
    pydantic_hash: str
    answer_field_hashes: dict[str, str | None]
    schema_version_major: int
    schema_version_minor: int
    schema_version_patch: int


@dataclass(frozen=True)
class _PreparedLlmModel:
    model_class: object
    nested_field_map: dict


@dataclass(frozen=True)
class _DataframeitRunConfig:
    parallel_requests: int
    rate_limit_delay: float
    partial_coverage_threshold: float
    run_failure_threshold: float
    model_kwargs: dict
    dfi_kwargs: dict


DATAFRAMEIT_PARAMS = {
    "api_key",
    "max_retries",
    "base_delay",
    "max_delay",
    "track_tokens",
    "use_search",
    "search_provider",
    "search_per_field",
    "max_results",
    "search_depth",
    "search_groups",
    "save_trace",
    "resume",
    "reprocess_columns",
    "status_column",
}


def _build_llm_response_row(
    *,
    run: _RunMetadata,
    doc_id: str,
    answers: dict,
    justifications: dict | None,
    is_partial: bool,
    job_id: str,
    llm_error_msg: str | None,
) -> dict:
    """Monta o dict de insert em `responses` para uma resposta LLM.

    Extraído para teste unitário (tests/test_llm_runner_response_row.py): a
    construção do payload era inline no save loop e gravava `pydantic_hash` mas
    NÃO a versão semver, deixando toda resposta LLM com schema_version NULL — o
    que cegava o filtro de versão da aba Comparar (B1 do PR de mistura de
    versões).
    """
    return {
        "project_id": run.project_id,
        "round_id": run.round_id,
        "document_id": doc_id,
        "respondent_type": "llm",
        "respondent_name": f"{run.llm_provider}/{run.llm_model}",
        "answers": answers,
        "justifications": justifications if justifications else None,
        # is_latest: respostas parciais já nascem como False para não
        # poluírem Comparar (ver PR #65). Para respostas completas, a RPC de
        # publicação troca o latest anterior e grava a outbox atomicamente.
        "is_latest": not is_partial,
        # is_partial: imutável após o insert. Preserva o classificador
        # "cobertura baixa" mesmo depois que uma run posterior supersede esta
        # resposta (ver migration 20260425000000).
        "is_partial": is_partial,
        "pydantic_hash": run.pydantic_hash,
        "answer_field_hashes": run.answer_field_hashes,
        # Correlaciona a resposta com a execução que a produziu para a aba
        # LLM > Respostas (ver migration 20260424000000).
        "llm_job_id": job_id,
        # Diagnóstico por documento (ver migration 20260504000002). Null quando
        # a resposta é saudável; senão traz o motivo real.
        "llm_error": llm_error_msg,
        # Versão semver do schema no momento do insert (B1). Grava também
        # version_inferred_from="live_save" — a versão foi capturada ao vivo do
        # projeto, igual ao caminho humano (frontend/src/actions/responses.ts);
        # isso faz o backfill (actions/schema.ts) PULAR estas linhas em vez de
        # re-inferir por hash/timestamp e sobrescrever a versão correta.
        "schema_version_major": run.schema_version_major,
        "schema_version_minor": run.schema_version_minor,
        "schema_version_patch": run.schema_version_patch,
        "version_inferred_from": "live_save",
    }


# Prompt-base exigente usado quando o campo não traz um
# `justification_prompt` próprio no schema. Obriga o LLM a ancorar a
# justificativa em um trecho textual do documento, em vez de produzir uma
# explicação vaga. {name} é substituído pelo nome do campo.
DEFAULT_JUSTIFICATION_PROMPT = (
    "Justificativa para a resposta de '{name}'. OBRIGATÓRIO: (1) cite "
    "textualmente, entre aspas, o trecho do documento que embasa a "
    "resposta; (2) explique em uma ou duas frases como esse trecho leva à "
    "resposta escolhida. Se nenhum trecho específico embasar a resposta, "
    "declare isso explicitamente e explique o raciocínio com base na "
    "ausência."
)


def _generated_justification_fields(model_class) -> frozenset[str]:
    """Return fields created by _extend_model_with_justifications."""
    return getattr(model_class, _GENERATED_JUSTIFICATION_FIELDS_ATTR, frozenset())


def _extend_model_with_justifications(model_class):
    """Add a justification field for each existing field in the model.

    O texto-base do prompt da justificativa vem de
    ``json_schema_extra['justification_prompt']`` quando o coordenador o
    configurou no schema (ver #88); caso contrário usa
    ``DEFAULT_JUSTIFICATION_PROMPT``, que exige citação textual do trecho do
    documento. O placeholder ``{name}`` é substituído pelo nome do campo.
    """
    from pydantic import Field, create_model

    extra_fields = {}
    for name, info in model_class.model_fields.items():
        extra = extract_json_schema_extra(info)
        custom = extra.get("justification_prompt")
        if isinstance(custom, str) and custom.strip():
            base = custom.strip()
            # Permite {name} no texto custom; se o coordenador usou outras
            # chaves (ou chaves não intencionais), cai no texto literal.
            try:
                desc = base.format(name=name)
            except (KeyError, IndexError, ValueError):
                desc = base
        else:
            desc = DEFAULT_JUSTIFICATION_PROMPT.format(name=name)
        just_name = f"{name}{_JUSTIFICATION_FIELD_SUFFIX}"
        if just_name in model_class.model_fields:
            raise ValueError(
                f"O campo gerado de justificativa '{just_name}' colide com "
                "um campo existente no schema. Renomeie o campo existente."
            )
        extra_fields[just_name] = (str, Field(description=desc))
    extended_model = create_model(
        f"{model_class.__name__}WithJustifications",
        __base__=model_class,
        **extra_fields,
    )
    setattr(
        extended_model,
        _GENERATED_JUSTIFICATION_FIELDS_ATTR,
        frozenset(extra_fields),
    )
    return extended_model


# Separador usado para achatar nested BaseModels em top-level (ver
# _flatten_nested_basemodels abaixo). Dois underscores minimizam colisão com
# nomes de campo reais (q2_id_..., q24a_...).
_NESTED_FLATTEN_SEP = "__"


def _flatten_nested_basemodels(model_class):
    """Expande fields cujo tipo é um BaseModel em campos top-level.

    Motivação: alguns providers (Gemini em especial) achatam silenciosamente
    subfields de BaseModel aninhado no topo do JSON de saída. Como os
    subfields desses modelos costumam ter defaults (Optional[str]=None),
    o Pydantic aceita o dict vazio para o BaseModel pai sem erro, e a
    resposta é persistida com quase nenhum campo real. Achatar antes de
    enviar ao LLM elimina essa classe de falha silenciosa.

    Retorna (FlatModel, field_map) onde field_map[original_name] é uma
    lista de (flat_name, sub_name) usada para reconstruir o dict aninhado
    após o parse. Quando nenhum field é BaseModel, retorna o próprio
    model_class com field_map vazio.
    """
    from pydantic import BaseModel, create_model

    flat_fields: dict = {}
    field_map: dict[str, list[tuple[str, str]]] = {}

    for name, info in model_class.model_fields.items():
        ann = info.annotation
        if (
            isinstance(ann, type)
            and issubclass(ann, BaseModel)
            and ann is not BaseModel
        ):
            field_map[name] = []
            for sub_name, sub_info in ann.model_fields.items():
                flat_name = f"{name}{_NESTED_FLATTEN_SEP}{sub_name}"
                flat_fields[flat_name] = (sub_info.annotation, sub_info)
                field_map[name].append((flat_name, sub_name))
        else:
            flat_fields[name] = (info.annotation, info)

    if not field_map:
        return model_class, field_map

    flat_model = create_model(
        f"{model_class.__name__}Flat",
        __base__=BaseModel,
        **flat_fields,
    )
    return flat_model, field_map


def _filter_model_for_llm(model_class, pydantic_fields: list[dict]):
    """Return a model class excluding fields that should not be sent to the LLM.

    A field is excluded when its ``target`` in ``pydantic_fields`` is either
    ``"none"`` (hidden from everyone) or ``"human_only"``. Returns the original
    ``model_class`` unchanged when no fields need to be excluded.

    Note: the filtered model is created with ``__base__=BaseModel``, so any
    custom ``model_config`` or validators on the original class are not
    preserved. This is acceptable because ``dataframeit`` only inspects the
    schema (fields + annotations). If custom validators become relevant,
    switch to ``__base__=model_class`` and drop excluded fields differently.
    """
    from pydantic import BaseModel, create_model

    excluded_names = {
        f["name"]
        for f in (pydantic_fields or [])
        if f.get("target") in ("none", "human_only")
    }
    if not excluded_names:
        return model_class

    kept: dict = {}
    for name, info in model_class.model_fields.items():
        if name in excluded_names:
            continue
        kept[name] = (info.annotation, info)

    return create_model(
        f"{model_class.__name__}ForLLM",
        __base__=BaseModel,
        **kept,
    )


def _compile_model(pydantic_code: str):
    """Compile Pydantic code and return the model class.

    Constrói a classe a partir do AST validado (allowlist), sem exec — mesma
    via de compile_pydantic. Ver services/pydantic_compiler.build_model_from_code.
    """
    return build_model_from_code(pydantic_code)


def _build_prompt(
    project_description: str | None,
    prompt_template: str | None,
) -> str:
    """Assemble the final prompt from project metadata + additional instructions."""
    parts = [
        "Voce e um assistente de pesquisa especializado em analise de conteudo.",
        "Analise o documento fornecido e responda as perguntas de classificacao.",
        "",
        "## Instrucoes gerais",
        "- Leia o documento completo antes de classificar.",
        "- Baseie suas respostas exclusivamente no conteudo do documento.",
        "- Se houver ambiguidade, escolha a opcao mais conservadora.",
        "- Para campos de texto, seja conciso e objetivo.",
    ]

    if project_description and project_description.strip():
        parts.append("")
        parts.append("## Contexto do estudo")
        parts.append(project_description.strip())

    if prompt_template and prompt_template.strip():
        parts.append("")
        parts.append("## Instrucoes adicionais")
        parts.append(prompt_template.strip())

    return "\n".join(parts)


def _filter_docs(
    sb,
    docs: list[dict],
    project_id: str,
    filter_mode: str,
    max_response_count: int | None,
    sample_size: int | None,
) -> list[dict]:
    """Apply filtering to the document list based on filter_mode."""
    if filter_mode == "all":
        return docs

    if filter_mode in ("pending", "max_responses"):
        # Fetch current LLM responses to count per document
        existing = (
            sb.table("responses")
            .select("document_id")
            .eq("project_id", project_id)
            .eq("respondent_type", "llm")
            .eq("is_latest", True)
            .execute()
            .data
        )
        counts = Counter(r["document_id"] for r in existing)

        if filter_mode == "pending":
            docs = [d for d in docs if counts.get(d["id"], 0) == 0]
        elif filter_mode == "max_responses" and max_response_count is not None:
            docs = [d for d in docs if counts.get(d["id"], 0) <= max_response_count]

    if filter_mode == "random_sample" and sample_size is not None:
        if len(docs) > sample_size:
            docs = random.sample(docs, sample_size)

    return docs


def _pop_threshold(llm_kwargs: dict, key: str, default: float) -> float:
    raw = llm_kwargs.pop(key, None)
    if raw is None:
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        logger.warning(
            "llm_kwargs['%s']=%r não é número, usando default %s",
            key,
            raw,
            default,
        )
        return default
    if not 0 <= value <= 1:
        logger.warning(
            "llm_kwargs['%s']=%s fora de [0,1], usando default %s",
            key,
            value,
            default,
        )
        return default
    return value


def _normalize_llm_kwargs(llm_kwargs: dict) -> _DataframeitRunConfig:
    parallel_requests = llm_kwargs.pop("parallel_requests", 5)
    rate_limit_delay = llm_kwargs.pop("rate_limit_delay", 0.5)
    partial_coverage_threshold = _pop_threshold(
        llm_kwargs, "partial_coverage_threshold", 0.5
    )
    run_failure_threshold = _pop_threshold(llm_kwargs, "run_failure_threshold", 0.3)
    model_kwargs = {k: v for k, v in llm_kwargs.items() if k not in DATAFRAMEIT_PARAMS}
    dfi_kwargs = {k: v for k, v in llm_kwargs.items() if k in DATAFRAMEIT_PARAMS}
    dfi_kwargs.pop("resume", None)
    return _DataframeitRunConfig(
        parallel_requests=parallel_requests,
        rate_limit_delay=rate_limit_delay,
        partial_coverage_threshold=partial_coverage_threshold,
        run_failure_threshold=run_failure_threshold,
        model_kwargs=model_kwargs,
        dfi_kwargs=dfi_kwargs,
    )


def _prepare_llm_model(
    pydantic_code: str,
    pydantic_fields: list[dict],
    include_justifications: bool,
) -> _PreparedLlmModel:
    model_class = _compile_model(pydantic_code)
    if not model_class:
        raise RuntimeError("Nenhuma classe BaseModel encontrada no código Pydantic.")
    model_class = _filter_model_for_llm(model_class, pydantic_fields)
    model_class, nested_field_map = _flatten_nested_basemodels(model_class)
    if include_justifications:
        model_class = _extend_model_with_justifications(model_class)
    return _PreparedLlmModel(
        model_class=model_class,
        nested_field_map=nested_field_map,
    )


def _load_documents_for_run(
    sb,
    project_id: str,
    document_ids: list[str] | None,
    filter_mode: str,
    max_response_count: int | None,
    sample_size: int | None,
) -> list[dict]:
    query = (
        sb.table("documents")
        .select("id, text, title, external_id")
        .eq("project_id", project_id)
        .is_("excluded_at", "null")
    )
    if document_ids:
        query = query.in_("id", document_ids)
    docs = query.execute().data
    return _filter_docs(
        sb, docs, project_id, filter_mode, max_response_count, sample_size
    )


def _expected_llm_fields(model_class) -> set[str]:
    expected_llm_fields = set()
    generated_justification_fields = _generated_justification_fields(model_class)
    for name in model_class.model_fields:
        if name in generated_justification_fields:
            continue
        if _NESTED_FLATTEN_SEP in name:
            expected_llm_fields.add(name.split(_NESTED_FLATTEN_SEP, 1)[0])
        else:
            expected_llm_fields.add(name)
    return expected_llm_fields


def _fatal_provider_error(frame: pd.DataFrame) -> str | None:
    """Erro de configuração do provider (modelo inexistente, chave inválida,
    permissão) visível já no canário — a mensagem, ou None se não houver.

    Só classifica como fatal o que o próprio dataframeit marcou como sem
    retry: `NON_RECOVERABLE_ERRORS` é a mesma tupla que ele consulta em
    `is_recoverable_error` para decidir não tentar de novo, então não há um
    segundo critério aqui para desatualizar quando a lib mudar o dela.

    A distinção importa: um erro que esgotou retries num documento específico
    (rate limit, timeout) continua indo para a via estatística de
    `_raise_if_run_compromised`. Matar a run inteira por ele confundiria azar
    pontual com configuração errada.

    Exige que TODAS as linhas do frame tenham falhado assim — o sinal é "o
    provider recusou tudo que viu", não "uma linha falhou".
    """
    if frame.empty:
        return None
    first_error: str | None = None
    for _, row in frame.iterrows():
        _, dfi_error = _extract_dataframeit_error(row)
        if dfi_error is None:
            return None
        lowered = dfi_error.lower()
        if not any(pattern.lower() in lowered for pattern in NON_RECOVERABLE_ERRORS):
            return None
        if first_error is None:
            first_error = dfi_error
    return first_error


def _run_dataframeit_batches(
    *,
    sb,
    job_id: str,
    jobs_state: dict,
    docs: list[dict],
    model_class,
    prompt_template: str,
    llm_provider: str,
    llm_model: str,
    config: _DataframeitRunConfig,
) -> pd.DataFrame:
    df = pd.DataFrame([{"id": d["id"], "texto": d["text"]} for d in docs])
    from dataframeit import dataframeit

    batch_size = max(1, config.parallel_requests)
    # A primeira batch leva um documento só, como canário. O dataframeit não
    # propaga erro do provider: ele grava o erro na célula e devolve o frame
    # normalmente, então um modelo inexistente ou uma chave inválida só
    # apareceria em _raise_if_run_compromised — depois de gastar uma chamada por
    # documento e de _process_and_save_rows ter publicado uma resposta vazia
    # para cada um. Com o canário o pior caso é uma chamada e nenhuma escrita.
    batches = [
        batch
        for batch in [
            df.iloc[0:1],
            *(df.iloc[i : i + batch_size] for i in range(1, len(df), batch_size)),
        ]
        # Partição vazia não é batch: sem o filtro, um df sem linhas produziria
        # uma "primeira batch" vazia e o provider seria chamado à toa.
        if not batch.empty
    ]
    jobs_state.update(phase="processing", total_batches=len(batches))

    result_frames = []
    proc_start = time.time()
    last_proc_heartbeat = 0.0
    for idx, batch_df in enumerate(batches):
        jobs_state["current_batch"] = idx + 1
        batch_result = dataframeit(
            batch_df,
            model_class,
            prompt_template,
            text_column="texto",
            provider=llm_provider,
            model=llm_model,
            parallel_requests=config.parallel_requests,
            rate_limit_delay=config.rate_limit_delay,
            model_kwargs=config.model_kwargs if config.model_kwargs else None,
            resume=False,
            **config.dfi_kwargs,
        )
        if idx == 0:
            fatal = _fatal_provider_error(batch_result)
            if fatal:
                # A afirmação "nenhuma resposta foi gravada" depende de esta
                # função rodar inteira antes de _process_and_save_rows, que é
                # quem publica (ver run_llm). Mover a publicação para dentro do
                # loop de batches tornaria a mensagem mentirosa.
                raise RuntimeError(
                    f"O provider recusou o modelo '{llm_provider}/{llm_model}' "
                    f"no primeiro dos {len(df)} documentos, então a run foi "
                    f"abortada e nenhuma resposta foi gravada. Confira o nome "
                    f"do modelo e a chave de API. "
                    f"Erro do provider: {fatal}"
                )
        result_frames.append(batch_result)
        processed = sum(len(f) for f in result_frames)
        jobs_state["progress"] = processed
        elapsed = time.time() - proc_start
        if processed > 0:
            jobs_state["eta_seconds"] = round(
                (elapsed / processed) * (len(df) - processed), 1
            )
        now_ts = time.time()
        if now_ts - last_proc_heartbeat >= 2.0:
            _persist_run_progress(sb, job_id, jobs_state)
            last_proc_heartbeat = now_ts

    return pd.concat(result_frames, ignore_index=True)


def _raise_if_run_compromised(
    partial_warnings: list[str],
    dfi_error_samples: dict[str, str],
    total_processed: int,
    run_failure_threshold: float,
) -> None:
    if not partial_warnings:
        return
    partial_ratio = len(partial_warnings) / total_processed if total_processed else 0.0
    if partial_ratio < run_failure_threshold:
        return
    error_examples = list(dfi_error_samples.values())[:3]
    sections = [
        f"Run comprometida: {len(partial_warnings)}/{total_processed} "
        f"docs ({int(partial_ratio * 100)}%) com resposta parcial. "
        f"Respostas gravadas com is_latest=false."
    ]
    if error_examples:
        sections.append("Erros do provider: " + " || ".join(error_examples))
    sections.append("Exemplos de cobertura baixa: " + " || ".join(partial_warnings[:3]))
    raise RuntimeError(" ".join(sections))


def init_job(job_id: str, project_id: str, filter_mode: str) -> None:
    """Inicializar estado do job + INSERT em llm_runs.

    Chamado sincronamente pelo endpoint /run antes do background task. Se
    o INSERT falhar (RLS, conexão, payload malformado), a exceção sobe pro
    handler do FastAPI e o usuário vê 500 em vez de uma run fantasma que
    nunca aparece em Execuções.
    """
    sb = get_supabase()
    _jobs[job_id] = {
        "status": "running",
        "phase": "loading",
        "progress": 0,
        "total": 0,
        "errors": [],
        "started_at": time.time(),
        "eta_seconds": None,
        "current_batch": 0,
        "total_batches": 0,
        "error_traceback": None,
        "error_type": None,
        "error_line": None,
        "error_column": None,
        "pydantic_code": None,
        # Counters atualizados durante a fase de saving para o frontend
        # mostrar feedback ao vivo de quantos documentos saíram completos /
        # parciais / vazios (ver LlmConfigurePane). Classificação espelha
        # LlmResponseRow.classifyResponse no frontend.
        "processed_complete": 0,
        "processed_partial": 0,
        "processed_empty": 0,
        # Throttle do _persist_run_progress (atualiza a cada 2s).
        "last_progress_persist": 0.0,
    }
    try:
        _persist_run_insert(sb, job_id, project_id, filter_mode)
    except Exception:
        # Mantém _jobs limpo se o INSERT falhar — sem isso, o dict acumula
        # entradas órfãs até o próximo restart do processo (jobs nunca
        # consultados, já que /run retornou 500 ao usuário).
        _jobs.pop(job_id, None)
        raise


@dataclass(frozen=True)
class _ProcessedLlmRow:
    doc_id: str
    answers: dict
    justifications: dict
    dfi_status: object
    dfi_error: str | None
    answers_pre_prune_keys: list[str]
    active_expected: set[str]
    answered: set[str]
    is_empty: bool
    is_partial: bool
    llm_error_msg: str | None


def _extract_dataframeit_error(row) -> tuple[object, str | None]:
    dfi_status = row.get("_dataframeit_status")
    dfi_error_raw = row.get("_error_details")
    dfi_error = (
        str(dfi_error_raw)
        if dfi_error_raw is not None and pd.notna(dfi_error_raw)
        else None
    )
    return dfi_status, dfi_error


def _reconstruct_nested_answers(
    answers: dict,
    justifications: dict,
    nested_field_map: dict,
) -> None:
    """Restore the persisted nested shape before evaluating conditions.

    Conditions refer to the parent fields used by the UI and human answers, so
    reconstruction must happen before pruning. Subfield justifications are
    joined into one string to preserve the frontend's Record<string, string>
    contract.
    """
    for original_name, subs in nested_field_map.items():
        sub_dict: dict = {}
        sub_justs: dict = {}
        for flat_name, sub_name in subs:
            if flat_name in answers:
                sub_dict[sub_name] = answers.pop(flat_name)
            if flat_name in justifications:
                sub_justs[sub_name] = justifications.pop(flat_name)
        if sub_dict:
            answers[original_name] = sub_dict
        if sub_justs:
            justifications[original_name] = "\n".join(
                f"{key}: {value}" for key, value in sub_justs.items()
            )


def _prune_inactive_conditionals(
    answers: dict,
    justifications: dict,
    field_conditions: dict,
) -> None:
    for field_name, condition in field_conditions.items():
        if not evaluate_condition(condition, answers, field_name):
            answers.pop(field_name, None)
            justifications.pop(field_name, None)


def _active_expected_fields(
    expected_llm_fields: set[str],
    field_conditions: dict,
    answers: dict,
) -> set[str]:
    """Exclude inactive conditional fields from the coverage denominator."""
    return {
        name
        for name in expected_llm_fields
        if name not in field_conditions
        or evaluate_condition(field_conditions[name], answers, name)
    }


def _build_processed_llm_row(
    row,
    model_class,
    nested_field_map: dict,
    field_conditions: dict,
    expected_llm_fields: set[str],
    partial_coverage_threshold: float,
) -> _ProcessedLlmRow:
    doc_id = row["id"]
    dfi_status, dfi_error = _extract_dataframeit_error(row)
    answers, justifications = _extract_answers_from_row(row, model_class)
    _reconstruct_nested_answers(answers, justifications, nested_field_map)
    answers_pre_prune_keys = sorted(answers.keys())
    if field_conditions:
        _prune_inactive_conditionals(answers, justifications, field_conditions)
    active_expected = _active_expected_fields(
        expected_llm_fields,
        field_conditions,
        answers,
    )
    answered = set(answers.keys()) & active_expected
    coverage = len(answered) / len(active_expected) if active_expected else 1.0
    is_partial = coverage < partial_coverage_threshold
    is_empty = not _answers_have_content(answers)
    llm_error_msg = _build_llm_error_message(
        dfi_error=dfi_error,
        is_empty=is_empty,
        is_partial=is_partial,
        dfi_status=dfi_status,
        pre_prune_keys=answers_pre_prune_keys,
        post_prune_keys=sorted(answers.keys()),
        answered_count=len(answered),
        active_expected_count=len(active_expected),
    )
    return _ProcessedLlmRow(
        doc_id=doc_id,
        answers=answers,
        justifications=justifications,
        dfi_status=dfi_status,
        dfi_error=dfi_error,
        answers_pre_prune_keys=answers_pre_prune_keys,
        active_expected=active_expected,
        answered=answered,
        is_empty=is_empty,
        is_partial=is_partial,
        llm_error_msg=llm_error_msg,
    )


def _record_processed_row_outcome(
    sb,
    job_id: str,
    jobs_state: dict,
    partial_warnings: list[str],
    dfi_error_samples: dict[str, str],
    processed_row: _ProcessedLlmRow,
) -> None:
    """Update run diagnostics, counters, warnings, and the throttled heartbeat.

    Provider errors are deduplicated by the complete message hash: grouping by
    a shared prefix previously merged distinct failures. MD5 is only a compact
    deduplication key, never a security primitive. Persisting progress here also
    keeps a live run distinguishable from an abandoned one during scale-to-zero.
    """
    if processed_row.is_empty:
        jobs_state["processed_empty"] += 1
    elif processed_row.is_partial:
        jobs_state["processed_partial"] += 1
    else:
        jobs_state["processed_complete"] += 1

    if processed_row.is_partial or processed_row.is_empty or processed_row.dfi_error:
        logger.warning(
            "LLM row diag doc=%s status=%s error=%s pre_prune=%s post_prune=%s",
            processed_row.doc_id,
            processed_row.dfi_status,
            processed_row.dfi_error,
            processed_row.answers_pre_prune_keys,
            sorted(processed_row.answers.keys()),
        )

    if processed_row.dfi_error:
        key = hashlib.md5(
            processed_row.dfi_error.encode("utf-8", errors="replace"),
            usedforsecurity=False,
        ).hexdigest()[:16]
        if key not in dfi_error_samples:
            dfi_error_samples[key] = (
                f"doc={processed_row.doc_id}: {processed_row.dfi_error}"
            )

    if processed_row.is_partial:
        missing = sorted(processed_row.active_expected - processed_row.answered)
        suffix = "..." if len(missing) > 8 else ""
        warning_msg = (
            f"doc={processed_row.doc_id}: cobertura baixa "
            f"({len(processed_row.answered)}/{len(processed_row.active_expected)}); "
            f"faltaram: {missing[:8]}{suffix}"
        )
        partial_warnings.append(warning_msg)
        jobs_state.setdefault("warnings", []).append(warning_msg)

    now_ts = time.time()
    if now_ts - jobs_state["last_progress_persist"] >= 2.0:
        _persist_run_progress(sb, job_id, jobs_state)
        jobs_state["last_progress_persist"] = now_ts


def _process_and_save_rows(
    sb,
    job_id: str,
    jobs_state: dict,
    result_df: pd.DataFrame,
    prepared_model: _PreparedLlmModel,
    partial_coverage_threshold: float,
    run: _RunMetadata,
) -> tuple[list[str], dict[str, str]]:
    """Transform and persist each dataframeit row in its canonical shape."""
    partial_warnings: list[str] = []
    dfi_error_samples: dict[str, str] = {}
    field_conditions = extract_field_conditions(prepared_model.model_class)
    expected_llm_fields = _expected_llm_fields(prepared_model.model_class)

    for _, row in result_df.iterrows():
        processed_row = _build_processed_llm_row(
            row,
            prepared_model.model_class,
            prepared_model.nested_field_map,
            field_conditions,
            expected_llm_fields,
            partial_coverage_threshold,
        )
        _record_processed_row_outcome(
            sb,
            job_id,
            jobs_state,
            partial_warnings,
            dfi_error_samples,
            processed_row,
        )
        response = _build_llm_response_row(
            run=run,
            doc_id=processed_row.doc_id,
            answers=processed_row.answers,
            justifications=processed_row.justifications,
            is_partial=processed_row.is_partial,
            job_id=job_id,
            llm_error_msg=processed_row.llm_error_msg,
        )
        sb.rpc("publish_latest_llm_response", {"p_response": response}).execute()

    return partial_warnings, dfi_error_samples


async def run_llm(
    job_id: str,
    project_id: str,
    document_ids: list[str] | None = None,
    filter_mode: str = "all",
    max_response_count: int | None = None,
    sample_size: int | None = None,
):
    """Run dataframeit on all (or filtered) documents.

    Pré-condição: init_job(job_id, project_id, filter_mode) já foi chamado
    pelo handler do /run. Aqui já assumimos _jobs[job_id] populado e
    llm_runs row existente.
    """
    sb = get_supabase()

    try:
        # Load project (only needed columns)
        project = (
            sb.table("projects")
            .select(
                "pydantic_code, prompt_template, llm_provider, llm_model, llm_kwargs, description, pydantic_fields, schema_version_major, schema_version_minor, schema_version_patch, current_round_id"
            )
            .eq("id", project_id)
            .single()
            .execute()
            .data
        )
        pydantic_code = project["pydantic_code"]
        # Versão semver corrente do projeto, gravada em cada resposta para que a
        # aba Comparar consiga separar rodadas por versão (ver B1 do PR de
        # mistura de versões). Fallbacks espelham o caminho humano em
        # frontend/src/actions/responses.ts. As colunas em `projects` são
        # NOT NULL DEFAULT (migration 20260420000000), então os `or`/default
        # abaixo são apenas defensivos.
        schema_version_major = project.get("schema_version_major") or 0
        schema_version_minor = (
            project.get("schema_version_minor")
            if project.get("schema_version_minor") is not None
            else 1
        )
        schema_version_patch = project.get("schema_version_patch") or 0
        prompt_template = _build_prompt(
            project.get("description"),
            project["prompt_template"],
        )
        llm_provider = project["llm_provider"]
        llm_model = project["llm_model"]
        llm_kwargs = project["llm_kwargs"] or {}
        pydantic_hash = hashlib.sha256(pydantic_code.encode()).hexdigest()[:16]

        # Build per-field hash snapshot for staleness detection
        answer_field_hashes = {
            f["name"]: f.get("hash") for f in (project.get("pydantic_fields") or [])
        }

        docs = _load_documents_for_run(
            sb,
            project_id,
            document_ids,
            filter_mode,
            max_response_count,
            sample_size,
        )

        _jobs[job_id]["total"] = len(docs)
        _jobs[job_id]["pydantic_code"] = pydantic_code
        _persist_run_snapshot(sb, job_id, project, len(docs))

        if not docs:
            _jobs[job_id]["status"] = "completed"
            _persist_run_completion(sb, job_id, 0, 0)
            return

        include_justifications = llm_kwargs.pop("include_justifications", False)
        prepared_model = _prepare_llm_model(
            pydantic_code,
            project.get("pydantic_fields") or [],
            include_justifications,
        )
        run_config = _normalize_llm_kwargs(llm_kwargs)
        result_df = _run_dataframeit_batches(
            sb=sb,
            job_id=job_id,
            jobs_state=_jobs[job_id],
            docs=docs,
            model_class=prepared_model.model_class,
            prompt_template=prompt_template,
            llm_provider=llm_provider,
            llm_model=llm_model,
            config=run_config,
        )

        _jobs[job_id].update(phase="saving", eta_seconds=None)

        run_metadata = _RunMetadata(
            project_id=project_id,
            round_id=project["current_round_id"],
            llm_provider=llm_provider,
            llm_model=llm_model,
            pydantic_hash=pydantic_hash,
            answer_field_hashes=answer_field_hashes,
            schema_version_major=schema_version_major,
            schema_version_minor=schema_version_minor,
            schema_version_patch=schema_version_patch,
        )
        partial_warnings, dfi_error_samples = _process_and_save_rows(
            sb,
            job_id,
            _jobs[job_id],
            result_df,
            prepared_model,
            run_config.partial_coverage_threshold,
            run_metadata,
        )
        await wake_auto_review_reconciliation()

        sb.table("projects").update({"pydantic_hash": pydantic_hash}).eq(
            "id", project_id
        ).execute()

        _raise_if_run_compromised(
            partial_warnings,
            dfi_error_samples,
            len(result_df),
            run_config.run_failure_threshold,
        )

        _jobs[job_id].update(status="completed", phase="completed", eta_seconds=0)
        _persist_run_completion(
            sb,
            job_id,
            _jobs[job_id]["progress"],
            _jobs[job_id]["total"],
            warnings=partial_warnings or None,
            counters=_jobs[job_id],
        )

    except Exception as e:
        tb = traceback.format_exc()
        # Passa counters do _jobs para fechar snapshot consistente em llm_runs
        # mesmo quando a run falha mid-loop. Sem isso, o último _persist_run_progress
        # poderia ter ficado até 2s atrás.
        counters = _jobs.get(job_id) or {}
        line, col = _persist_run_error(sb, job_id, e, tb, counters=counters)
        _jobs[job_id]["status"] = "error"
        _jobs[job_id]["phase"] = "error"
        _jobs[job_id]["errors"].append(str(e))
        _jobs[job_id]["error_type"] = type(e).__name__
        _jobs[job_id]["error_traceback"] = tb
        _jobs[job_id]["error_line"] = line
        _jobs[job_id]["error_column"] = col
        logger.exception("LLM run %s failed", job_id)


async def run_llm_fields(
    job_id: str,
    project_id: str,
    field_names: list[str],
    document_ids: list[str] | None = None,
):
    """Re-run LLM only for specific fields."""
    await run_llm(job_id, project_id, document_ids)
