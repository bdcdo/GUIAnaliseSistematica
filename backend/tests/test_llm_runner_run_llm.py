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
from types import SimpleNamespace

from services.llm_runner import _jobs, init_job, run_llm

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
        rpc_errors: dict[str, Exception] | None = None,
    ):
        self._tables = tables
        self._rpc_errors = rpc_errors or {}
        self.rpc_calls: list[tuple[str, dict]] = []
        self.operation_log: list[
            tuple[str, str, dict, list[tuple[str, str, object]]]
        ] = []
        for name, table in tables.items():
            table.name = name
            table.operation_log = self.operation_log

    def table(self, name):
        return self._tables[name]

    def rpc(self, name, params):
        if name in self._rpc_errors:
            return _RaisingQuery(self._rpc_errors[name])

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
    """
    errors = errors or {}

    def _fake(batch_df, model_class, prompt_template, **kwargs):
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
        out = batch_df.copy()
        for field in model_class.model_fields:
            out[field] = [
                row_specs.get(doc_id, {}).get(field) for doc_id in batch_df["id"]
            ]

        def _erro(doc_id):
            if error_always:
                return error_always
            if schema_recusado:
                return _SCHEMA_RECUSADO
            return errors.get(doc_id)

        detalhes = [_erro(doc_id) for doc_id in batch_df["id"]]
        out["_dataframeit_status"] = [
            "error" if d is not None else "processed" for d in detalhes
        ]
        out["_error_details"] = detalhes
        return out

    return _fake


def _build_supabase(
    project_row,
    docs,
    *,
    documents_error=None,
    rpc_errors: dict[str, Exception] | None = None,
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


def test_run_llm_preserves_captured_round_and_propagates_stale_round_error(
    monkeypatch,
):
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
    assert "INVALID_ARGUMENT" in _jobs[JOB_ID]["errors"][0]
    assert _doc_batches(calls) == [["doc-0"]]


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
