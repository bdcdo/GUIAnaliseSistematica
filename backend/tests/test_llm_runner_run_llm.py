"""Teste de integração de run_llm (issue #377).

Pré-requisito bloqueante do refactor: hoje nenhum teste chama `run_llm`
diretamente (os outros arquivos `test_llm_runner_*` só cobrem os helpers já
extraídos). Mocka só a fronteira externa — cliente Supabase e `dataframeit` —
e deixa rodar de verdade a compilação Pydantic, o flatten/filtro de campos e a
classificação de cobertura, para servir de rede de segurança antes de extrair
o laço de pós-processamento por linha (linhas 970-1120).

Cobre os 4 cenários pedidos pela issue: happy path, run parcial (não falha),
run comprometida (RuntimeError) e exceção não tratada persistida.
"""

import asyncio
import sys
from collections.abc import Callable
from types import SimpleNamespace

from supabase import PostgrestAPIError

from services.llm_runner import _PROBE_DOC_ID, _jobs, init_job, run_llm

JOB_ID = "job-1"
PROJECT_ID = "proj-1"

PYDANTIC_CODE = """from pydantic import BaseModel, Field

class Analysis(BaseModel):
    campo_a: str = Field(description="Campo A")
    campo_b: str = Field(description="Campo B")
    campo_c: str = Field(description="Campo C")
"""

NESTED_PYDANTIC_CODE = """from pydantic import BaseModel, Field

class Doenca(BaseModel):
    doenca: str = Field(description="Doença")

class Analysis(BaseModel):
    q5: Doenca = Field(description="Q5")
"""

SPLIT_PYDANTIC_CODE = """from pydantic import BaseModel, Field

class Analysis(BaseModel):
    campo_a: str = Field(description="Campo A")
    campo_b: str = Field(description="Campo B")
    campo_c: str = Field(description="Campo C")
    campo_d: str = Field(description="Campo D")
"""

# Texto do 400 que o Gemini devolve quando o schema é grande demais. Medido
# contra a API real em 2026-08-13 com o schema de 62 campos do projeto
# Zolgensma-Judiciário; o mesmo schema com 31 campos responde 200.
#
# Duas propriedades importam e estão preservadas na cópia: a mensagem não diz
# o que está errado ("Request contains an invalid argument"), e o texto
# `INVALID_ARGUMENT` NÃO casa com o padrão `InvalidArgument` de
# NON_RECOVERABLE_ERRORS por causa do underscore — por isso o dataframeit a
# trata como recuperável e o prefixo é "[Falhou após ...]".
_SCHEMA_RECUSADO = (
    "[Falhou após 3 tentativa(s)] ChatGoogleGenerativeAIError: Error calling "
    "model 'gemini-3.7-flash' (INVALID_ARGUMENT): 400 INVALID_ARGUMENT. "
    "{'error': {'code': 400, 'message': 'Request contains an invalid "
    "argument.', 'status': 'INVALID_ARGUMENT'}}"
)


class _FakeQuery:
    """Fake do query builder do Supabase.

    Aplica os filtros .eq()/.in_()/.is_() de verdade em execute() quando
    `data` é uma lista de rows (ex.: "documents"); um "select_data" em
    formato de dict único (ex.: "projects", uma única row já resolvida)
    passa direto, já que os testes atuais nunca variam entre múltiplos
    projetos. Sem filtro real, uma regressão no `.is_("excluded_at",
    "null")` de run_llm (bug histórico documentado em llm_runner.py —
    docs arquivados voltando a receber resposta LLM) passaria batida por
    este "teste de integração".
    """

    def __init__(self, data, on_execute=None):
        self._data = data
        self._filters: list[tuple[str, str, object]] = []
        self._single = False
        self._on_execute = on_execute

    def eq(self, column, value):
        self._filters.append(("eq", column, value))
        return self

    def in_(self, column, values):
        self._filters.append(("in", column, values))
        return self

    def is_(self, column, value):
        self._filters.append(("is", column, value))
        return self

    def single(self, *a, **k):
        self._single = True
        return self

    def maybe_single(self, *a, **k):
        self._single = True
        return self

    def _matches(self, row: dict) -> bool:
        for op, column, value in self._filters:
            if op == "eq" and row.get(column) != value:
                return False
            if op == "in" and row.get(column) not in value:
                return False
            if op == "is":
                if value == "null":
                    if row.get(column) is not None:
                        return False
                elif row.get(column) != value:
                    return False
        return True

    def execute(self):
        if self._on_execute is not None:
            self._on_execute(list(self._filters))
        if isinstance(self._data, list):
            rows = [r for r in self._data if self._matches(r)]
            if self._single:
                return SimpleNamespace(data=rows[0] if rows else None)
            return SimpleNamespace(data=rows)
        return SimpleNamespace(data=self._data)


class _RaisingQuery(_FakeQuery):
    def execute(self):
        raise self._data


class _FakeTable:
    def __init__(self, select_data=None, select_error=None):
        self.select_data = select_data
        self.select_error = select_error
        self.insert_calls: list[dict] = []
        self.update_calls: list[dict] = []
        self.name = ""
        self.operation_log: list[
            tuple[str, str, dict, list[tuple[str, str, object]]]
        ] = []

    def select(self, *a, **k):
        if self.select_error is not None:
            return _RaisingQuery(self.select_error)
        return _FakeQuery(self.select_data)

    def insert(self, payload):
        def record(filters):
            self.insert_calls.append(payload)
            self.operation_log.append((self.name, "insert", payload, filters))

        return _FakeQuery(payload, on_execute=record)

    def update(self, payload):
        def record(filters):
            self.update_calls.append(payload)
            self.operation_log.append((self.name, "update", payload, filters))

        return _FakeQuery(payload, on_execute=record)


class _FakeSupabase:
    def __init__(
        self,
        tables: dict[str, _FakeTable],
        *,
        rpc_errors: dict[str, Exception | Callable[[dict], Exception | None]]
        | None = None,
    ):
        self._tables = tables
        self._rpc_errors = rpc_errors or {}
        self.rpc_calls: list[tuple[str, dict]] = []
        # rpc_calls só grava sucesso, porque _RaisingQuery levanta antes do
        # on_execute. Isso é fiel ao real e é o que faz _published_responses
        # medir publicação efetiva, mas deixa "recusada" indistinguível de
        # "nunca tentada". rpc_attempts registra a tentativa antes de decidir o
        # erro, e é ele que testemunha o que o laço parou de tentar.
        self.rpc_attempts: list[tuple[str, dict]] = []
        self.operation_log: list[
            tuple[str, str, dict, list[tuple[str, str, object]]]
        ] = []
        for name, table in tables.items():
            table.name = name
            table.operation_log = self.operation_log

    def table(self, name):
        return self._tables[name]

    def rpc(self, name, params):
        # O valor de rpc_errors pode ser a exceção pronta (falha em toda
        # chamada) ou um callable que recebe os params e decide por chamada,
        # devolvendo None para deixar passar — é o que permite falhar num
        # documento só. Discriminar por isinstance e não por callable(): uma
        # classe de exceção também é callable, e um valor legado passado como
        # classe seria chamado em vez de levantado.
        self.rpc_attempts.append((name, params))
        error = self._rpc_errors.get(name)
        if error is not None and not isinstance(error, Exception):
            error = error(params)
        if error is not None:
            return _RaisingQuery(error)

        def record(_filters):
            self.rpc_calls.append((name, params))

        return _FakeQuery(params, on_execute=record)


def _project_row(**overrides) -> dict:
    row: dict = {
        "pydantic_code": PYDANTIC_CODE,
        "prompt_template": None,
        "llm_provider": "google",
        "llm_model": "gemini-2.5-flash",
        "llm_kwargs": {},
        "description": None,
        "pydantic_fields": [],
        "schema_version_major": 1,
        "schema_version_minor": 0,
        "schema_version_patch": 0,
        "current_round_id": "round-1",
    }
    row.update(overrides)
    return row


def _docs(n: int) -> list[dict]:
    # project_id precisa estar presente para o fake filtrar de verdade em
    # .eq("project_id", ...) — a query real roda sobre a tabela inteira,
    # não só as colunas do .select().
    return [
        {
            "id": f"doc-{i}",
            "project_id": PROJECT_ID,
            "text": f"texto {i}",
            "title": f"Doc {i}",
            "external_id": None,
        }
        for i in range(n)
    ]


def _make_fake_dataframeit(
    row_specs: dict[str, dict],
    calls: list[dict] | None = None,
    errors: dict[str, str] | None = None,
    error_always: str | None = None,
    max_schema_fields: int | None = None,
    retry_success: bool = False,
    probe_errors: list[str | None] | None = None,
):
    """row_specs: {doc_id: {field: value}}.

    Campos ausentes do spec de um doc simulam resposta incompleta do
    provider (o dataframeit real também não garante 100% de cobertura).

    errors: {doc_id: mensagem de _error_details}. Espelha o ponto central do
    dataframeit real — ele NÃO propaga exceção do provider: marca a linha com
    `_dataframeit_status='error'`, escreve a mensagem em `_error_details` e
    devolve o frame como se tivesse dado certo.

    Os três modos de erro são distintos de propósito, porque é justamente
    entre eles que o canário precisa discriminar:

    - `errors` falha em documentos nomeados e **passa** em qualquer outro
      texto — é o erro que depende do documento (azar pontual);
    - `error_always` falha em toda linha, seja qual for o texto — é o erro de
      configuração (modelo inexistente, chave inválida);
    - `max_schema_fields` falha quando o schema passa de N campos e passa
      abaixo disso — é a recusa de schema medida em produção contra o Gemini
      (`400 INVALID_ARGUMENT`), que não depende do documento nem do modelo,
      só do tamanho do que se pediu.

    `retry_success` não é um modo de erro: é **sucesso** que passou por retry.
    A lib real escreve `"Sucesso após N retry(s)"` em `_error_details`
    mantendo o status `'processed'`, e reproduzir isso é o que permite testar
    que ninguém confunda a mensagem com uma recusa.

    `probe_errors` roteia as sondas de texto trivial, em ordem: cada elemento
    é a mensagem daquela sonda (ou None para passar), e depois que a lista
    acaba a sonda volta ao comportamento normal. Serve para escrever o que os
    outros modos não conseguem — um provider que muda de resposta entre uma
    sonda e a seguinte, como acontece quando um 429 cai no meio da bisseção.

    Duas fidelidades a mais, ambas atrás de bug encontrado em revisão:

    - o frame recebido é mutado **in-place**, como faz o dataframeit
      (`to_pandas` devolve o mesmo objeto e `_setup_columns` escreve nele);
    - num frame que já tenha as colunas do modelo, a lib avisa e devolve
      **sem chamar o provider**. Sem esse ramo aqui, um chamador que rode duas
      vezes sobre o mesmo frame parece funcionar no teste e perde o documento
      em produção.
    """
    errors = errors or {}
    sondas_restantes = list(probe_errors or [])

    def _fake(batch_df, model_class, prompt_template, **kwargs):
        ja_processado = [c for c in model_class.model_fields if c in batch_df.columns]
        if ja_processado and not kwargs.get("resume"):
            # Nem registra em `calls`: nenhuma chamada ao provider aconteceu.
            return batch_df.copy()
        if calls is not None:
            calls.append(
                {
                    "document_ids": list(batch_df["id"]),
                    "model_fields": set(model_class.model_fields),
                    "prompt_template": prompt_template,
                    "kwargs": kwargs,
                }
            )
        schema_recusado = (
            max_schema_fields is not None
            and len(model_class.model_fields) > max_schema_fields
        )

        e_sonda = list(batch_df["id"]) == [_PROBE_DOC_ID]
        sonda_roteada = e_sonda and sondas_restantes

        def _erro(doc_id):
            if sonda_roteada:
                return sondas_restantes.pop(0)
            if error_always:
                return error_always
            if schema_recusado:
                return _SCHEMA_RECUSADO
            return errors.get(doc_id)

        detalhes = [_erro(doc_id) for doc_id in batch_df["id"]]
        # Linha que falhou não ganha resposta nenhuma: no dataframeit real a
        # exceção sobe antes da escrita das colunas, que ficam com o None que
        # `_setup_columns` criou. Preencher aqui apesar do erro faria um
        # documento perdido parecer completo — o teste mediria a contagem de
        # chamadas e não o dano.
        for field in model_class.model_fields:
            batch_df[field] = [
                None if erro is not None else row_specs.get(doc_id, {}).get(field)
                for doc_id, erro in zip(batch_df["id"], detalhes, strict=True)
            ]
        batch_df["_dataframeit_status"] = [
            "error" if d is not None else "processed" for d in detalhes
        ]
        batch_df["_error_details"] = [
            d
            if d is not None
            else ("Sucesso após 1 retry(s)" if retry_success else None)
            for d in detalhes
        ]
        return batch_df.copy()

    return _fake


def _build_supabase(
    project_row,
    docs,
    *,
    documents_error=None,
    rpc_errors: dict[str, Exception | Callable[[dict], Exception | None]] | None = None,
) -> _FakeSupabase:
    return _FakeSupabase(
        {
            "projects": _FakeTable(select_data=project_row),
            "documents": _FakeTable(select_data=docs, select_error=documents_error),
            "responses": _FakeTable(),
            "llm_runs": _FakeTable(),
        },
        rpc_errors=rpc_errors,
    )


def _run_llm_sync(
    monkeypatch,
    sb: _FakeSupabase,
    row_specs: dict[str, dict],
    *,
    dataframeit_calls: list[dict] | None = None,
    wakeup_calls: list[bool] | None = None,
    dataframeit_errors: dict[str, str] | None = None,
    dataframeit_error_always: str | None = None,
    max_schema_fields: int | None = None,
    retry_success: bool = False,
    probe_errors: list[str | None] | None = None,
) -> None:
    monkeypatch.setattr("services.llm_runner.get_supabase", lambda: sb)
    monkeypatch.setitem(
        sys.modules,
        "dataframeit",
        SimpleNamespace(
            dataframeit=_make_fake_dataframeit(
                row_specs,
                dataframeit_calls,
                dataframeit_errors,
                dataframeit_error_always,
                max_schema_fields,
                retry_success,
                probe_errors,
            )
        ),
    )

    async def _fake_wakeup() -> bool:
        if wakeup_calls is not None:
            wakeup_calls.append(True)
        return True

    monkeypatch.setattr(
        "services.llm_runner.wake_auto_review_reconciliation", _fake_wakeup
    )
    init_job(JOB_ID, PROJECT_ID, "all")
    asyncio.run(run_llm(JOB_ID, PROJECT_ID))


def _last_update_where(table: _FakeTable, **kv) -> dict | None:
    for payload in reversed(table.update_calls):
        if all(payload.get(k) == v for k, v in kv.items()):
            return payload
    return None


def _published_responses(sb: _FakeSupabase) -> list[dict]:
    return [
        params["p_response"]
        for name, params in sb.rpc_calls
        if name == "publish_latest_llm_response"
    ]


def _api_error(code, message: str) -> PostgrestAPIError:
    """APIError de verdade, montado como o postgrest o monta.

    O construtor recebe o dict do corpo de erro do PostgREST e lê `code`,
    `message`, `hint` e `details` dele. `code` chega como str no caminho normal
    (o SQLSTATE que o Postgres devolveu) e como int quando o corpo não é JSON
    parseável — daí a anotação frouxa aqui.
    """
    return PostgrestAPIError(
        {"message": message, "code": code, "hint": None, "details": None}
    )


def _failing_publish(failures: dict[str, PostgrestAPIError]):
    """Injeta falha da RPC de publicação só nos documentos nomeados."""

    def decide(params: dict) -> PostgrestAPIError | None:
        return failures.get(params["p_response"]["document_id"])

    return decide


def _published_doc_ids(sb: _FakeSupabase) -> list[str]:
    return [row["document_id"] for row in _published_responses(sb)]


def _attempted_doc_ids(sb: _FakeSupabase) -> list[str]:
    """Documentos cuja publicação foi tentada, tenham sido aceitos ou não."""
    return [
        params["p_response"]["document_id"]
        for name, params in sb.rpc_attempts
        if name == "publish_latest_llm_response"
    ]


def teardown_function(_fn):
    _jobs.clear()


def test_run_llm_happy_path(monkeypatch):
    docs = _docs(2)
    row_specs = {
        d["id"]: {"campo_a": "a", "campo_b": "b", "campo_c": "c"} for d in docs
    }
    sb = _build_supabase(
        _project_row(
            pydantic_fields=[
                {"name": "campo_a", "hash": "ha"},
                {"name": "campo_b"},
            ]
        ),
        docs,
    )

    wakeup_calls: list[bool] = []
    _run_llm_sync(monkeypatch, sb, row_specs, wakeup_calls=wakeup_calls)

    assert _jobs[JOB_ID]["status"] == "completed"
    inserts = _published_responses(sb)
    assert len(inserts) == 2
    assert all(
        row["is_partial"] is False and row["is_latest"] is True for row in inserts
    )
    assert all(row["llm_error"] is None for row in inserts)
    assert all(row["round_id"] == "round-1" for row in inserts)
    assert all(
        row["answer_field_hashes"] == {"campo_a": "ha", "campo_b": None}
        for row in inserts
    )
    assert wakeup_calls == [True]

    completion = _last_update_where(sb.table("llm_runs"), status="completed")
    assert completion is not None
    assert "error_message" not in completion  # sem warnings no happy path

    project_updates = sb.table("projects").update_calls
    assert any("pydantic_hash" in payload for payload in project_updates)

    snapshot = next(
        payload
        for payload in sb.table("llm_runs").update_calls
        if "document_count" in payload
    )
    assert snapshot["round_id"] == "round-1"


def test_run_llm_preserves_captured_round_and_aborts_on_non_api_error(
    monkeypatch,
):
    """A outra metade da régua: o que não vem do banco aborta a run inteira.

    O nome anterior prometia cobertura de rodada obsoleta que este teste não
    dá — ele injeta RuntimeError, não um APIError com P0R01, e por isso segue
    verde por mérito sob a régua nova. Quem cobre o P0R01 é
    test_run_llm_stale_round_from_the_database_aborts_the_whole_run.
    """
    docs = _docs(1)
    sb = _build_supabase(
        _project_row(current_round_id="round-captured"),
        docs,
        rpc_errors={
            "publish_latest_llm_response": RuntimeError(
                "round changed while LLM run was processing"
            )
        },
    )

    _run_llm_sync(
        monkeypatch,
        sb,
        {"doc-0": {"campo_a": "a", "campo_b": "b", "campo_c": "c"}},
    )

    snapshot = next(
        payload
        for payload in sb.table("llm_runs").update_calls
        if "document_count" in payload
    )
    assert snapshot["round_id"] == "round-captured"
    assert _jobs[JOB_ID]["status"] == "error"
    assert _jobs[JOB_ID]["error_type"] == "RuntimeError"
    assert _jobs[JOB_ID]["errors"] == ["round changed while LLM run was processing"]
    error_update = _last_update_where(sb.table("llm_runs"), status="error")
    assert error_update is not None
    assert error_update["error_message"] == (
        "round changed while LLM run was processing"
    )


def test_run_llm_routes_kwargs_without_leaking_internal_options(monkeypatch):
    docs = _docs(1)
    row_specs = {"doc-0": {"campo_a": "a", "campo_b": "b", "campo_c": "c"}}
    dataframeit_calls: list[dict] = []
    sb = _build_supabase(
        _project_row(
            llm_kwargs={
                "include_justifications": True,
                "parallel_requests": 2,
                "rate_limit_delay": 0.25,
                "partial_coverage_threshold": 0.4,
                "run_failure_threshold": 0.9,
                "resume": True,
                "track_tokens": True,
                "temperature": 0.2,
            }
        ),
        docs,
    )

    _run_llm_sync(monkeypatch, sb, row_specs, dataframeit_calls=dataframeit_calls)

    assert len(dataframeit_calls) == 1
    kwargs = dataframeit_calls[0]["kwargs"]
    assert kwargs["parallel_requests"] == 2
    assert kwargs["rate_limit_delay"] == 0.25
    assert kwargs["resume"] is False
    assert kwargs["track_tokens"] is True
    assert kwargs["model_kwargs"] == {"temperature": 0.2}
    for internal_key in [
        "include_justifications",
        "partial_coverage_threshold",
        "run_failure_threshold",
    ]:
        assert internal_key not in kwargs
        assert internal_key not in kwargs["model_kwargs"]


def test_run_llm_processes_multiple_batches_and_tracks_progress(monkeypatch):
    docs = _docs(3)
    row_specs = {
        doc["id"]: {"campo_a": "a", "campo_b": "b", "campo_c": "c"} for doc in docs
    }
    dataframeit_calls: list[dict] = []
    sb = _build_supabase(
        _project_row(llm_kwargs={"parallel_requests": 2}),
        docs,
    )

    _run_llm_sync(monkeypatch, sb, row_specs, dataframeit_calls=dataframeit_calls)

    # A primeira batch leva um documento só (canário do erro de provider); as
    # demais seguem o parallel_requests configurado.
    assert [call["document_ids"] for call in dataframeit_calls] == [
        ["doc-0"],
        ["doc-1", "doc-2"],
    ]
    assert _jobs[JOB_ID]["current_batch"] == 2
    assert _jobs[JOB_ID]["total_batches"] == 2
    assert _jobs[JOB_ID]["progress"] == 3
    assert {row["document_id"] for row in _published_responses(sb)} == {
        "doc-0",
        "doc-1",
        "doc-2",
    }
    # Heartbeat persistido no fim da primeira batch — que agora é o canário,
    # de um documento.
    assert any(
        update.get("progress") == 1 for update in sb.table("llm_runs").update_calls
    )


def test_run_llm_zero_failure_threshold_allows_complete_run(monkeypatch):
    docs = _docs(1)
    row_specs = {"doc-0": {"campo_a": "a", "campo_b": "b", "campo_c": "c"}}
    sb = _build_supabase(
        _project_row(llm_kwargs={"run_failure_threshold": 0}),
        docs,
    )

    _run_llm_sync(monkeypatch, sb, row_specs)

    assert _jobs[JOB_ID]["status"] == "completed"
    assert _last_update_where(sb.table("llm_runs"), status="completed") is not None


def test_run_llm_flattens_nested_model_before_adding_justifications(monkeypatch):
    docs = _docs(1)
    row_specs = {
        "doc-0": {
            "q5__doenca": "AME",
            "q5__doenca_justification": "O documento identifica AME.",
        }
    }
    dataframeit_calls: list[dict] = []
    sb = _build_supabase(
        _project_row(
            pydantic_code=NESTED_PYDANTIC_CODE,
            llm_kwargs={"include_justifications": True},
        ),
        docs,
    )

    _run_llm_sync(monkeypatch, sb, row_specs, dataframeit_calls=dataframeit_calls)

    model_fields = dataframeit_calls[0]["model_fields"]
    assert "q5__doenca" in model_fields
    assert "q5__doenca_justification" in model_fields
    assert "q5_justification" not in model_fields
    inserted = _published_responses(sb)[0]
    assert inserted["answers"] == {"q5": {"doenca": "AME"}}
    assert inserted["justifications"] == {"q5": "doenca: O documento identifica AME."}


def test_run_llm_publishes_each_response_atomically_without_bulk_update(monkeypatch):
    docs = _docs(1)
    row_specs = {"doc-0": {"campo_a": "a", "campo_b": "b", "campo_c": "c"}}
    sb = _build_supabase(_project_row(), docs)

    _run_llm_sync(monkeypatch, sb, row_specs)

    assert sb.table("responses").update_calls == []
    assert sb.table("responses").insert_calls == []
    assert [name for name, _params in sb.rpc_calls].count(
        "publish_latest_llm_response"
    ) == 1
    assert _published_responses(sb)[0]["document_id"] == "doc-0"


def test_run_llm_completes_empty_run_without_calling_dataframeit(monkeypatch):
    dataframeit_calls: list[dict] = []
    sb = _build_supabase(_project_row(), [])

    _run_llm_sync(monkeypatch, sb, row_specs={}, dataframeit_calls=dataframeit_calls)

    assert _jobs[JOB_ID]["status"] == "completed"
    assert _jobs[JOB_ID]["total"] == 0
    assert dataframeit_calls == []
    assert _published_responses(sb) == []
    completion = _last_update_where(sb.table("llm_runs"), status="completed")
    assert completion is not None
    assert completion["progress"] == 0
    assert completion["total"] == 0


def test_run_llm_skips_excluded_documents(monkeypatch):
    """Guarda o filtro `.is_("excluded_at", "null")` em run_llm — bug
    histórico documentado em llm_runner.py: o backend não filtrava docs
    arquivados, recriando respostas LLM neles. O fake precisa aplicar esse
    filtro de verdade (ver _FakeQuery._matches); senão este teste passaria
    mesmo com o filtro quebrado.
    """
    docs = _docs(2)
    docs.append(
        {
            "id": "doc-archived",
            "project_id": PROJECT_ID,
            "text": "texto arquivado",
            "title": "Doc arquivado",
            "external_id": None,
            "excluded_at": "2026-01-01T00:00:00Z",
        }
    )
    row_specs = {
        d["id"]: {"campo_a": "a", "campo_b": "b", "campo_c": "c"} for d in docs
    }
    sb = _build_supabase(_project_row(), docs)

    _run_llm_sync(monkeypatch, sb, row_specs)

    assert _jobs[JOB_ID]["status"] == "completed"
    inserts = _published_responses(sb)
    assert {row["document_id"] for row in inserts} == {"doc-0", "doc-1"}


def test_run_llm_partial_run_does_not_fail(monkeypatch):
    docs = _docs(4)
    row_specs = {
        d["id"]: {"campo_a": "a", "campo_b": "b", "campo_c": "c"} for d in docs
    }
    # doc-0 só recebe 1 de 3 campos -> coverage 0.33 < 0.5 (partial_coverage_threshold)
    row_specs["doc-0"] = {"campo_a": "a"}
    sb = _build_supabase(_project_row(), docs)

    _run_llm_sync(monkeypatch, sb, row_specs)

    assert _jobs[JOB_ID]["status"] == "completed"
    assert _jobs[JOB_ID]["processed_partial"] == 1
    assert _jobs[JOB_ID]["processed_complete"] == 3
    assert _jobs[JOB_ID]["processed_empty"] == 0

    inserts = _published_responses(sb)
    assert len(inserts) == 4
    partial_row = next(row for row in inserts if row["document_id"] == "doc-0")
    assert partial_row["is_partial"] is True
    assert (
        partial_row["is_latest"] is False
    )  # respostas parciais nascem is_latest=false

    completion = _last_update_where(sb.table("llm_runs"), status="completed")
    assert completion is not None
    assert "Warnings (1 doc(s))" in completion["error_message"]


def test_run_llm_compromised_run_raises_runtime_error(monkeypatch):
    docs = _docs(4)
    row_specs = {
        d["id"]: {"campo_a": "a", "campo_b": "b", "campo_c": "c"} for d in docs
    }
    # 2 de 4 docs com cobertura baixa -> partial_ratio 0.5 >= run_failure_threshold (0.3)
    row_specs["doc-0"] = {"campo_a": "a"}
    row_specs["doc-1"] = {"campo_a": "a"}
    sb = _build_supabase(_project_row(), docs)

    _run_llm_sync(monkeypatch, sb, row_specs)

    assert _jobs[JOB_ID]["status"] == "error"
    assert _jobs[JOB_ID]["error_type"] == "RuntimeError"
    assert "Run comprometida" in _jobs[JOB_ID]["errors"][0]

    # As respostas já foram publicadas (com is_latest=false) ANTES do raise —
    # o RuntimeError só marca a run como erro, não desfaz o que já foi salvo.
    inserts = _published_responses(sb)
    assert len(inserts) == 4

    error_update = _last_update_where(sb.table("llm_runs"), status="error")
    assert error_update is not None
    assert "Run comprometida" in error_update["error_message"]


# Publicação resiliente a falha de linha. A régua que separa falha de linha de
# falha de run é por exclusão: aborta P0R01 e o que não for APIError; tolera
# APIError com qualquer outro code. Ver _ROUND_CHANGED_SQLSTATE no llm_runner.

_UNIQUE_VIOLATION = (
    "duplicate key value violates unique constraint "
    '"responses_one_latest_llm_per_document"'
)


def test_run_llm_publish_failure_in_one_row_does_not_abort_the_others(monkeypatch):
    """O caso de 27/08: uma linha recusada pelo banco não derruba a run.

    Antes desta guarda a run morria no doc-1 e os dois documentos seguintes
    nunca eram tentados, com o custo do LLM de todos eles já pago.
    """
    docs = _docs(4)
    row_specs = {
        d["id"]: {"campo_a": "a", "campo_b": "b", "campo_c": "c"} for d in docs
    }
    sb = _build_supabase(
        _project_row(),
        docs,
        rpc_errors={
            "publish_latest_llm_response": _failing_publish(
                {"doc-1": _api_error("23505", _UNIQUE_VIOLATION)}
            )
        },
    )

    _run_llm_sync(monkeypatch, sb, row_specs)

    # As demais linhas ficaram gravadas: é o que este nó entrega.
    assert _published_doc_ids(sb) == ["doc-0", "doc-2", "doc-3"]

    # Tolerância zero: a run termina, mas reprova. Linha que não publicou é
    # dado perdido, mais grave que resposta parcial, que ao menos foi gravada.
    assert _jobs[JOB_ID]["status"] == "error"
    error_update = _last_update_where(sb.table("llm_runs"), status="error")
    assert error_update is not None
    assert "doc-1" in error_update["error_message"]
    assert "responses_one_latest_llm_per_document" in error_update["error_message"]
    # A mensagem do banco chega legível, não como o repr do dict cru que
    # str(APIError) devolve.
    assert "{'message'" not in error_update["error_message"]


def test_run_llm_stale_round_from_the_database_aborts_the_whole_run(monkeypatch):
    """P0R01 invalida a run inteira, não a linha: nada depois dele é tentado.

    Guard contra afrouxar a régua. Ele passaria com o código anterior a este
    nó, em que tudo abortava — o que o prova é a mutação da cláusula de
    re-raise, não a execução da suíte.
    """
    docs = _docs(4)
    row_specs = {
        d["id"]: {"campo_a": "a", "campo_b": "b", "campo_c": "c"} for d in docs
    }
    sb = _build_supabase(
        _project_row(),
        docs,
        rpc_errors={
            "publish_latest_llm_response": _failing_publish(
                {
                    "doc-1": _api_error(
                        "P0R01", "LLM response round is no longer current"
                    )
                }
            )
        },
    )

    _run_llm_sync(monkeypatch, sb, row_specs)

    # doc-2 e doc-3 nunca foram TENTADOS: é isso que distingue abortar de
    # tolerar. A contagem de publicações sozinha não testemunha isso — ela
    # seria idêntica se as três tivessem sido tentadas e recusadas —, então
    # quem responde é rpc_attempts.
    assert _published_doc_ids(sb) == ["doc-0"]
    assert _attempted_doc_ids(sb) == ["doc-0", "doc-1"]
    assert _jobs[JOB_ID]["status"] == "error"
    error_update = _last_update_where(sb.table("llm_runs"), status="error")
    assert error_update is not None
    assert "P0R01" in error_update["error_message"]


def test_run_llm_treats_non_sqlstate_code_as_a_row_failure(monkeypatch):
    """502 no lugar do SQLSTATE cai no ramo de falha de linha, e formata.

    Quando o corpo da resposta não é JSON parseável,
    generate_default_error_message preenche `code` com o status HTTP — um int.
    Este teste fixa o comportamento observável: a linha falha, as demais
    publicam e a mensagem sai montada. Ele NÃO protege a normalização com
    `str()` na comparação, que é indistinguível por teste (nenhum int iguala
    uma str); o que morde ali é o unitário de _describe_postgrest_error.
    """
    docs = _docs(3)
    row_specs = {
        d["id"]: {"campo_a": "a", "campo_b": "b", "campo_c": "c"} for d in docs
    }
    sb = _build_supabase(
        _project_row(),
        docs,
        rpc_errors={
            "publish_latest_llm_response": _failing_publish(
                {"doc-1": _api_error(502, "JSON could not be generated")}
            )
        },
    )

    _run_llm_sync(monkeypatch, sb, row_specs)

    assert _published_doc_ids(sb) == ["doc-0", "doc-2"]
    error_update = _last_update_where(sb.table("llm_runs"), status="error")
    assert error_update is not None
    assert "doc-1" in error_update["error_message"]


def test_run_llm_stops_after_consecutive_publish_failures(monkeypatch):
    """Falha sistêmica aborta cedo em vez de pagar N round-trips condenados.

    RLS negada, pool esgotado e gateway fora falham nas N linhas iguais. Sem o
    corte, resiliência vira insistência e o relatório final é N cópias da mesma
    mensagem em vez de um diagnóstico.
    """
    docs = _docs(9)
    row_specs = {
        d["id"]: {"campo_a": "a", "campo_b": "b", "campo_c": "c"} for d in docs
    }
    falhas = {
        f"doc-{i}": _api_error("42501", "new row violates row-level security policy")
        for i in range(1, 9)
    }
    sb = _build_supabase(
        _project_row(),
        docs,
        rpc_errors={"publish_latest_llm_response": _failing_publish(falhas)},
    )

    _run_llm_sync(monkeypatch, sb, row_specs)

    # doc-0 publica; doc-1..doc-5 falham e o corte para no quinto consecutivo.
    # doc-6 em diante nunca são tentados.
    assert _published_doc_ids(sb) == ["doc-0"]
    # Comparar a lista de tentativas como conjunto, e não por substring: "doc-1"
    # casa dentro de "doc-10" e a asserção passaria por acidente numa run maior.
    assert _attempted_doc_ids(sb) == [f"doc-{i}" for i in range(6)]
    assert _jobs[JOB_ID]["status"] == "error"
    error_update = _last_update_where(sb.table("llm_runs"), status="error")
    assert error_update is not None
    # A mensagem se declara corte, e com o número da sequência, não do total.
    assert "5 falhas seguidas" in error_update["error_message"]
    assert "não chegaram a ser tentados" in error_update["error_message"]


def test_run_llm_publish_failure_keeps_the_partial_coverage_diagnosis(monkeypatch):
    """Falha de publicação não apaga o diagnóstico de cobertura do LLM.

    partial_warnings só alcançam error_message pelo caminho completed, via
    _persist_run_completion. Sem a cauda, uma run que falhou ao publicar
    perderia a informação de que o LLM também respondeu mal.
    """
    docs = _docs(4)
    row_specs = {
        d["id"]: {"campo_a": "a", "campo_b": "b", "campo_c": "c"} for d in docs
    }
    row_specs["doc-3"] = {"campo_a": "a"}  # cobertura 0.33, abaixo do limiar
    sb = _build_supabase(
        _project_row(),
        docs,
        rpc_errors={
            "publish_latest_llm_response": _failing_publish(
                {"doc-1": _api_error("23505", _UNIQUE_VIOLATION)}
            )
        },
    )

    _run_llm_sync(monkeypatch, sb, row_specs)

    error_update = _last_update_where(sb.table("llm_runs"), status="error")
    assert error_update is not None
    assert "doc-1" in error_update["error_message"]
    assert "cobertura parcial" in error_update["error_message"]


def test_run_llm_falhas_intercaladas_nao_disparam_o_corte(monkeypatch):
    """O corte é por falhas SEGUIDAS, e sucesso no meio zera a contagem.

    Sem este teste a palavra "consecutivas" na constante não é exercitada:
    remover o `consecutive_failures = 0` do caminho de sucesso, ou trocar o
    gatilho pelo total acumulado, passaria despercebido. Aqui há 6 falhas, mais
    que o limiar de 5, e nenhuma sequência maior que 1 — o laço tem de ir até o
    fim e publicar todos os pares.
    """
    docs = _docs(12)
    row_specs = {
        d["id"]: {"campo_a": "a", "campo_b": "b", "campo_c": "c"} for d in docs
    }
    impares = {
        f"doc-{i}": _api_error("23505", _UNIQUE_VIOLATION) for i in range(1, 12, 2)
    }
    sb = _build_supabase(
        _project_row(),
        docs,
        rpc_errors={"publish_latest_llm_response": _failing_publish(impares)},
    )

    _run_llm_sync(monkeypatch, sb, row_specs)

    assert _published_doc_ids(sb) == [f"doc-{i}" for i in range(0, 12, 2)]
    # Toda linha foi tentada: o corte não disparou em momento nenhum.
    assert len(_attempted_doc_ids(sb)) == 12
    error_update = _last_update_where(sb.table("llm_runs"), status="error")
    assert error_update is not None
    assert "6 doc(s)" in error_update["error_message"]
    assert "seguidas" not in error_update["error_message"]


def test_run_llm_falha_de_publicacao_vence_a_run_comprometida(monkeypatch):
    """Quando as duas guardas disparam, a mensagem é a da publicação.

    A ordem é justificada no docstring de _raise_if_publish_failed: a mensagem
    da run comprometida afirma que as respostas foram gravadas com
    is_latest=false, o que é falso para linha que nunca chegou ao banco. Sem
    este teste, inverter as duas chamadas não quebra nada.
    """
    docs = _docs(4)
    row_specs = {
        d["id"]: {"campo_a": "a", "campo_b": "b", "campo_c": "c"} for d in docs
    }
    # 2 de 4 parciais: ratio 0.5, acima do run_failure_threshold de 0.3.
    row_specs["doc-2"] = {"campo_a": "a"}
    row_specs["doc-3"] = {"campo_a": "a"}
    sb = _build_supabase(
        _project_row(),
        docs,
        rpc_errors={
            "publish_latest_llm_response": _failing_publish(
                {"doc-1": _api_error("23505", _UNIQUE_VIOLATION)}
            )
        },
    )

    _run_llm_sync(monkeypatch, sb, row_specs)

    error_update = _last_update_where(sb.table("llm_runs"), status="error")
    assert error_update is not None
    assert error_update["error_message"].startswith("Publicação falhou")
    assert "Run comprometida" not in error_update["error_message"]
    # E o diagnóstico de cobertura não se perde: vai na cauda.
    assert "cobertura parcial" in error_update["error_message"]


def test_run_llm_falha_em_todas_as_linhas_abaixo_do_limiar(monkeypatch):
    """Run curta em que tudo falha: nada publica e o corte não mascara nada.

    Com 3 documentos o limiar de 5 nunca é alcançado, então este é o caminho
    sem corte, com publish_failures cobrindo o laço inteiro.
    """
    docs = _docs(3)
    row_specs = {
        d["id"]: {"campo_a": "a", "campo_b": "b", "campo_c": "c"} for d in docs
    }
    todas = {f"doc-{i}": _api_error("42501", "rls") for i in range(3)}
    sb = _build_supabase(
        _project_row(),
        docs,
        rpc_errors={"publish_latest_llm_response": _failing_publish(todas)},
    )

    _run_llm_sync(monkeypatch, sb, row_specs)

    assert _published_doc_ids(sb) == []
    assert len(_attempted_doc_ids(sb)) == 3
    error_update = _last_update_where(sb.table("llm_runs"), status="error")
    assert error_update is not None
    assert "3 doc(s)" in error_update["error_message"]
    assert "seguidas" not in error_update["error_message"]


# Erro determinístico de configuração: o provider recusa o modelo em toda
# linha. Texto copiado do incidente que motivou o canário (gemini-3-flash, um
# ID que nunca existiu na API).
_MODEL_NOT_FOUND = (
    "[Erro não-recuperável] ChatGoogleGenerativeAIError: Error calling model "
    "'gemini-3-flash' (NOT_FOUND): 404 NOT_FOUND. models/gemini-3-flash is not "
    "found for API version v1beta"
)
# Falha passageira que o dataframeit já tentou de novo e desistiu. Casa
# explicitamente com RECOVERABLE_ERRORS ('ResourceExhausted', '429'), e é esse
# casamento — não o prefixo — que a distingue da recusa de schema em
# _SCHEMA_RECUSADO, que carrega o mesmo prefixo e não casa com lista nenhuma.
_RATE_LIMIT_EXHAUSTED = (
    "[Falhou após 3 tentativa(s)] ResourceExhausted: 429 rate limit exceeded"
)


def test_run_llm_canary_aborts_before_publishing_when_provider_rejects_model(
    monkeypatch,
):
    # 26 documentos: a escala do incidente real, em que as 26 chamadas foram
    # gastas e 26 respostas vazias publicadas antes de alguém perceber o 404.
    docs = _docs(26)
    row_specs = {doc["id"]: {} for doc in docs}
    dataframeit_calls: list[dict] = []
    sb = _build_supabase(_project_row(llm_model="gemini-3-flash"), docs)

    # `error_always`, e não `errors` por documento: um modelo inexistente
    # falha para qualquer texto, inclusive o texto trivial que o canário usa
    # para sondar. Com o erro amarrado aos ids dos documentos, a sonda passaria
    # e o teste mediria o oposto do que promete.
    _run_llm_sync(
        monkeypatch,
        sb,
        row_specs,
        dataframeit_calls=dataframeit_calls,
        dataframeit_error_always=_MODEL_NOT_FOUND,
    )

    assert _jobs[JOB_ID]["status"] == "error"
    assert _jobs[JOB_ID]["error_type"] == "RuntimeError"
    message = _jobs[JOB_ID]["errors"][0]
    # A mensagem tem de nomear o modelo: o diagnóstico antigo falava em
    # cobertura baixa e mandava o usuário procurar defeito no schema.
    assert "google/gemini-3-flash" in message
    assert "404 NOT_FOUND" in message
    assert "Run comprometida" not in message

    # O que a guarda existe para evitar: o abort acontece com um documento
    # gasto, não com 26. As chamadas extras são as sondas de texto trivial —
    # nenhuma delas carrega documento do projeto.
    doc_calls = [
        call["document_ids"]
        for call in dataframeit_calls
        if any(str(i).startswith("doc-") for i in call["document_ids"])
    ]
    assert doc_calls == [["doc-0"]]
    assert _published_responses(sb) == []

    error_update = _last_update_where(sb.table("llm_runs"), status="error")
    assert error_update is not None
    assert "404 NOT_FOUND" in error_update["error_message"]


def test_run_llm_canary_lets_recoverable_error_reach_the_statistical_path(
    monkeypatch,
):
    # Mesma forma do teste acima — todo documento falhando já no canário — mas
    # com erro recuperável. É o discriminante: uma guarda que abortasse em
    # qualquer falha do primeiro documento passaria no teste anterior e
    # quebraria aqui, matando a run inteira por azar pontual.
    #
    # `error_always` é a forma fiel: rate limit não escolhe documento, e falha
    # na sonda de texto trivial exatamente como falha na chamada real. Amarrar
    # o erro aos ids faria a sonda passar e o teste mediria outra coisa — é a
    # porta de `_is_transient` que precisa segurar aqui, não a sonda.
    docs = _docs(4)
    row_specs = {doc["id"]: {} for doc in docs}
    dataframeit_calls: list[dict] = []
    sb = _build_supabase(_project_row(), docs)

    _run_llm_sync(
        monkeypatch,
        sb,
        row_specs,
        dataframeit_calls=dataframeit_calls,
        dataframeit_error_always=_RATE_LIMIT_EXHAUSTED,
    )

    # Todas as batches rodaram e as respostas foram publicadas (parciais, com
    # is_latest=false) — só então o caminho estatístico reprovou a run. E
    # nenhuma divisão foi tentada: o schema nunca foi a variável.
    assert _doc_batches(dataframeit_calls) == [
        ["doc-0"],
        ["doc-1", "doc-2", "doc-3"],
    ]
    assert all(
        call["model_fields"] == {"campo_a", "campo_b", "campo_c"}
        for call in dataframeit_calls
    )
    assert len(_published_responses(sb)) == 4
    assert _jobs[JOB_ID]["status"] == "error"
    assert "Run comprometida" in _jobs[JOB_ID]["errors"][0]


def _doc_batches(calls: list[dict]) -> list[list[str]]:
    """Só as chamadas que carregam documento do projeto, na ordem.

    As sondas de texto trivial também passam pelo fake; separá-las é o que
    permite afirmar quantos documentos a run gastou.
    """
    return [
        call["document_ids"]
        for call in calls
        if any(str(i).startswith("doc-") for i in call["document_ids"])
    ]


def _campos_por_lote(calls: list[dict], doc_id: str) -> list[set[str]]:
    """Os conjuntos de campos pedidos nas chamadas que levaram `doc_id`."""
    return [call["model_fields"] for call in calls if doc_id in call["document_ids"]]


def test_run_llm_divide_o_schema_quando_o_provider_recusa_o_modelo_inteiro(
    monkeypatch,
):
    # Forma do incidente de 2026-08-13: o schema com justificativas dobra de
    # tamanho e o provider recusa o modelo inteiro, sem dizer por quê. Aqui
    # são 4 campos + 4 justificativas = 8, com o provider aceitando no máximo
    # 4 — o que obriga a partir em dois lotes de 2 campos e 2 justificativas.
    docs = _docs(3)
    campos = ["campo_a", "campo_b", "campo_c", "campo_d"]
    todos = campos + [f"{c}_justification" for c in campos]
    row_specs = {doc["id"]: {c: f"v-{c}" for c in todos} for doc in docs}
    calls: list[dict] = []
    sb = _build_supabase(
        _project_row(
            pydantic_code=SPLIT_PYDANTIC_CODE,
            llm_kwargs={"include_justifications": True},
        ),
        docs,
    )

    _run_llm_sync(
        monkeypatch, sb, row_specs, dataframeit_calls=calls, max_schema_fields=4
    )

    # A run completa: dividir é transparente para quem só olha o resultado.
    assert _jobs[JOB_ID]["status"] == "completed"
    respostas = _published_responses(sb)
    assert len(respostas) == 3

    # E entrega o schema INTEIRO. Sem a fusão dos frames, cada documento
    # sairia só com os campos do último lote — uma resposta parcial que a via
    # estatística reprovaria, e o motivo verdadeiro ficaria invisível.
    for r in respostas:
        assert set(r["answers"]) == set(campos)

    lotes = _campos_por_lote(calls, "doc-0")
    # A primeira chamada é o modelo inteiro: schema que já cabe não paga
    # nada, e só quando ele é recusado é que a bisseção começa.
    assert lotes[0] == set(todos)
    aceitos = [lote for lote in lotes[1:] if len(lote) <= 4]
    assert len(aceitos) == 2
    assert set().union(*aceitos) == set(todos)


def test_run_llm_mantem_cada_justificativa_no_lote_do_campo_que_ela_justifica(
    monkeypatch,
):
    # Invariante semântica, não cosmética: separados, o modelo produziria a
    # justificativa numa chamada em que a resposta correspondente não foi
    # decidida — justificaria uma resposta que ele não deu. Um split ingênuo
    # por índice quebra isto, e é a regressão silenciosa mais provável aqui.
    docs = _docs(1)
    campos = ["campo_a", "campo_b", "campo_c", "campo_d"]
    todos = campos + [f"{c}_justification" for c in campos]
    row_specs = {doc["id"]: {c: f"v-{c}" for c in todos} for doc in docs}
    calls: list[dict] = []
    sb = _build_supabase(
        _project_row(
            pydantic_code=SPLIT_PYDANTIC_CODE,
            llm_kwargs={"include_justifications": True},
        ),
        docs,
    )

    # Limite de 2 força o lote mínimo — um campo e a justificativa dele.
    _run_llm_sync(
        monkeypatch, sb, row_specs, dataframeit_calls=calls, max_schema_fields=2
    )

    assert _jobs[JOB_ID]["status"] == "completed"
    lotes = [lote for lote in _campos_por_lote(calls, "doc-0") if len(lote) <= 2]
    assert len(lotes) == 4
    for lote in lotes:
        for nome in lote:
            if nome.endswith("_justification"):
                assert nome.removesuffix("_justification") in lote


def test_run_llm_nao_divide_quando_o_erro_e_do_documento(monkeypatch):
    # O discriminante que faltava: erro que falha NAQUELE documento e passa em
    # qualquer outro texto não é configuração. A tupla de strings não
    # distingue os dois casos — a sonda com texto trivial distingue.
    docs = _docs(4)
    row_specs = {doc["id"]: {} for doc in docs}
    calls: list[dict] = []
    sb = _build_supabase(_project_row(), docs)

    _run_llm_sync(
        monkeypatch,
        sb,
        row_specs,
        dataframeit_calls=calls,
        # Casa com NON_RECOVERABLE_ERRORS ('BadRequestError'), então o critério
        # antigo mataria a run inteira por um documento só.
        dataframeit_errors={
            "doc-0": "[Erro não-recuperável] BadRequestError: 400 context length exceeded"
        },
    )

    # Nenhuma divisão: os campos pedidos são sempre o schema inteiro.
    assert all(
        lote == {"campo_a", "campo_b", "campo_c"}
        for lote in _campos_por_lote(calls, "doc-0")
    )
    # E a run seguiu até o fim, deixando a via estatística julgar.
    assert _doc_batches(calls) == [["doc-0"], ["doc-1", "doc-2", "doc-3"]]
    assert len(_published_responses(sb)) == 4


def test_run_llm_aborta_quando_nem_um_campo_sozinho_e_aceito(monkeypatch):
    # Piso da bisseção. Se o provider recusa até o lote de um campo, o
    # problema não é tamanho e continuar partindo seria laço infinito.
    docs = _docs(3)
    row_specs = {doc["id"]: {} for doc in docs}
    calls: list[dict] = []
    sb = _build_supabase(_project_row(), docs)

    _run_llm_sync(
        monkeypatch,
        sb,
        row_specs,
        dataframeit_calls=calls,
        max_schema_fields=0,
    )

    assert _jobs[JOB_ID]["status"] == "error"
    assert _published_responses(sb) == []
    erro = _jobs[JOB_ID]["errors"][0]
    assert "INVALID_ARGUMENT" in erro
    assert _doc_batches(calls) == [["doc-0"]]
    # A unidade do piso é o GRUPO (campo + justificativa, ou aninhado com os
    # subcampos), não o campo: dizer "um único campo" mandaria o usuário
    # procurar um schema de um campo que a bisseção nunca chega a pedir.
    assert "um único grupo de campos" in erro
    # E a dica que a #691 dava continua chegando: recusar até o menor pedido
    # possível é como um modelo inexistente ou uma chave inválida se
    # manifestam, e a bisseção não pode custar ao usuário essa orientação.
    assert "Confira o nome do modelo e a chave de API" in erro


def _sondas(calls: list[dict]) -> list[set[str]]:
    """Os campos pedidos em cada sonda de texto trivial, na ordem."""
    return [
        call["model_fields"]
        for call in calls
        if call["document_ids"] == [_PROBE_DOC_ID]
    ]


def test_run_llm_refaz_o_canario_de_verdade_depois_de_dividir(monkeypatch):
    # O documento do canário é processado ANTES de a divisão ser conhecida,
    # então a run precisa refazê-lo com os lotes novos. O dataframeit grava
    # as colunas no frame que recebe e, num frame que já as tenha, devolve
    # sem chamar o provider — se o refazer reaproveitar o frame do canário,
    # este documento sai vazio.
    #
    # São 5 documentos de propósito: com 1 perdido em 5, a cobertura baixa
    # fica em 0,2, abaixo do run_failure_threshold de 0,3. A run reporta
    # "completed" e o documento some sem ninguém ser avisado — que é
    # exatamente a forma do dano em produção (1 em 26).
    docs = _docs(5)
    campos = ["campo_a", "campo_b", "campo_c", "campo_d"]
    todos = campos + [f"{c}_justification" for c in campos]
    row_specs = {doc["id"]: {c: f"v-{c}" for c in todos} for doc in docs}
    sb = _build_supabase(
        _project_row(
            pydantic_code=SPLIT_PYDANTIC_CODE,
            llm_kwargs={"include_justifications": True},
        ),
        docs,
    )

    _run_llm_sync(monkeypatch, sb, row_specs, max_schema_fields=4)

    assert _jobs[JOB_ID]["status"] == "completed"
    por_doc = {r["document_id"]: r for r in _published_responses(sb)}
    assert set(por_doc) == {d["id"] for d in docs}
    # A asserção que importa é sobre o documento do canário, não sobre a
    # média: os outros quatro nunca passaram pelo caminho do refazer.
    assert set(por_doc["doc-0"]["answers"]) == set(campos)


def test_run_llm_sucesso_apos_retry_no_canario_nao_dispara_divisao(monkeypatch):
    # O dataframeit escreve "Sucesso após N retry(s)" em `_error_details`
    # mantendo o status 'processed'. Quem lê só a mensagem toma um documento
    # bem-sucedido por uma recusa de schema — e, no canário, um único retry
    # (banal sob rate limit do Gemini) bastaria para dividir um schema que
    # cabe, dobrando o custo da run inteira.
    docs = _docs(3)
    campos = ["campo_a", "campo_b", "campo_c"]
    row_specs = {doc["id"]: {c: f"v-{c}" for c in campos} for doc in docs}
    calls: list[dict] = []
    sb = _build_supabase(_project_row(), docs)

    _run_llm_sync(
        monkeypatch, sb, row_specs, dataframeit_calls=calls, retry_success=True
    )

    assert _jobs[JOB_ID]["status"] == "completed"
    # Nenhuma sonda: o canário não foi lido como falha, então não houve o que
    # discriminar. Contar sondas é o discriminante — o resultado final é o
    # mesmo com ou sem a divisão espúria, só o custo muda.
    assert _sondas(calls) == []
    assert all(lote == set(campos) for lote in _campos_por_lote(calls, "doc-0"))


def test_run_llm_sucesso_apos_retry_na_sonda_nao_conta_como_recusa(monkeypatch):
    # Mesma confusão, agora na sonda: aqui ela é pior, porque "Sucesso após 1
    # retry(s)" não casa com RECOVERABLE_ERRORS e portanto nem a porta de
    # transitório o barra. A bisseção leria "não cabe" a cada nível e mataria
    # no piso uma run que o provider nunca recusou.
    #
    # Cinco documentos porque o canário falha de verdade aqui: 1 perdido em 5
    # fica abaixo do run_failure_threshold, então a run só termina em "error"
    # se a sonda for mal lida — que é justamente o que se quer medir.
    docs = _docs(5)
    campos = ["campo_a", "campo_b", "campo_c"]
    row_specs = {doc["id"]: {c: f"v-{c}" for c in campos} for doc in docs}
    calls: list[dict] = []
    sb = _build_supabase(_project_row(), docs)

    _run_llm_sync(
        monkeypatch,
        sb,
        row_specs,
        dataframeit_calls=calls,
        # O canário falha de verdade (erro daquele documento), então a sonda
        # é consultada; ela responde com sucesso-após-retry.
        dataframeit_errors={"doc-0": "[Erro não-recuperável] BadRequestError: 400"},
        retry_success=True,
    )

    assert _jobs[JOB_ID]["status"] == "completed"
    # Uma sonda só, e ela encerrou a questão: o schema inteiro passou.
    assert _sondas(calls) == [set(campos)]
    assert len(_published_responses(sb)) == 5


def test_run_llm_sonda_transitoria_no_meio_da_bissecao_nao_vira_veredito(
    monkeypatch,
):
    # A bisseção dispara sondas em sequência logo depois de parallel_requests
    # chamadas — é ali que um 429 é mais provável. Sem distinguir "não cabe"
    # de "não deu para perguntar", o rate limit vira veredito sobre o schema:
    # a recursão desce até o piso e aborta a run com uma mensagem que culpa o
    # tamanho do pedido.
    docs = _docs(3)
    campos = ["campo_a", "campo_b", "campo_c"]
    row_specs = {doc["id"]: {c: f"v-{c}" for c in campos} for doc in docs}
    calls: list[dict] = []
    sb = _build_supabase(_project_row(), docs)

    _run_llm_sync(
        monkeypatch,
        sb,
        row_specs,
        dataframeit_calls=calls,
        dataframeit_error_always=_SCHEMA_RECUSADO,
        # 1ª sonda: o modelo inteiro é recusado, a bisseção começa.
        # 2ª sonda: 429 no meio do caminho.
        probe_errors=[
            _SCHEMA_RECUSADO,
            "[Falhou após 3 tentativa(s)] ResourceExhausted: 429 quota",
        ],
    )

    erro = _jobs[JOB_ID]["errors"][0]
    # A run termina denunciando o erro que o provider de fato deu, e não
    # inventando um veredito sobre o schema a partir de um rate limit.
    assert "INVALID_ARGUMENT" in erro
    assert "um único grupo de campos" not in erro
    # E parou de martelar o provider: duas sondas, não a árvore inteira.
    assert len(_sondas(calls)) == 2


def test_run_llm_pergunta_pelo_schema_inteiro_uma_vez_so(monkeypatch):
    # A sonda de entrada e a primeira pergunta da bisseção são a mesma:
    # "o modelo inteiro cabe?". Fazê-las separadamente custava uma chamada
    # paga ao provider em toda decisão de divisão.
    docs = _docs(1)
    campos = ["campo_a", "campo_b", "campo_c", "campo_d"]
    todos = campos + [f"{c}_justification" for c in campos]
    row_specs = {doc["id"]: {c: f"v-{c}" for c in todos} for doc in docs}
    calls: list[dict] = []
    sb = _build_supabase(
        _project_row(
            pydantic_code=SPLIT_PYDANTIC_CODE,
            llm_kwargs={"include_justifications": True},
        ),
        docs,
    )

    _run_llm_sync(
        monkeypatch, sb, row_specs, dataframeit_calls=calls, max_schema_fields=4
    )

    sondas = _sondas(calls)
    assert [len(s) for s in sondas] == [8, 4, 4]
    assert sondas[0] == set(todos)


def test_run_llm_marca_o_documento_quando_um_dos_lotes_falha(monkeypatch):
    # Fusão dos frames: um lote que erra sozinho não pode desaparecer. Sem a
    # regra "erro em qualquer lote marca a linha", o documento sairia como
    # resposta parcial silenciosa e o erro do provider nunca chegaria ao
    # usuário.
    import pandas as pd

    from services.llm_runner import _merge_chunk_frames

    a = pd.DataFrame(
        [
            {
                "id": "doc-0",
                "campo_a": "x",
                "_dataframeit_status": "processed",
                "_error_details": None,
            }
        ]
    )
    b = pd.DataFrame(
        [
            {
                "id": "doc-0",
                "campo_b": None,
                "_dataframeit_status": "error",
                "_error_details": "boom",
            }
        ]
    )

    merged = _merge_chunk_frames([a, b])
    linha = merged.iloc[0]
    assert linha["campo_a"] == "x"
    assert "campo_b" in merged.columns
    assert linha["_dataframeit_status"] == "error"
    assert "boom" in linha["_error_details"]


def test_run_llm_unhandled_exception_is_persisted(monkeypatch):
    sb = _build_supabase(_project_row(), _docs(2), documents_error=ValueError("boom"))

    _run_llm_sync(monkeypatch, sb, row_specs={})

    assert _jobs[JOB_ID]["status"] == "error"
    assert _jobs[JOB_ID]["error_type"] == "ValueError"
    assert _jobs[JOB_ID]["errors"] == ["boom"]

    # Falhou antes de qualquer processamento: nenhuma resposta foi inserida.
    assert _published_responses(sb) == []

    error_update = _last_update_where(sb.table("llm_runs"), status="error")
    assert error_update is not None
    assert error_update["error_message"] == "boom"
