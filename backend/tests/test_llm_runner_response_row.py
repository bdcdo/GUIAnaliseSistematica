"""Tests for _build_llm_response_row — payload de insert de uma resposta LLM.

Regressão do B1 (mistura de versões na Comparar): o payload era inline e
gravava pydantic_hash mas NÃO a versão semver, deixando toda resposta LLM com
schema_version NULL e cegando o filtro de versão da aba Comparar.
"""

from services.llm_runner import _build_llm_response_row, _RunMetadata


def _run(**overrides) -> _RunMetadata:
    base = dict(
        project_id="proj-1",
        round_id="round-1",
        llm_provider="google_genai",
        llm_model="gemini-3-flash-preview",
        pydantic_hash="3c5e901f76547135",
        answer_field_hashes={"q1": "h1"},
        schema_version_major=0,
        schema_version_minor=20,
        schema_version_patch=0,
    )
    base.update(overrides)
    return _RunMetadata(**base)


def _kwargs(**overrides):
    base = dict(
        run=_run(),
        doc_id="doc-1",
        answers={"q1": "Sim"},
        justifications={"q1": "porque sim"},
        is_partial=False,
        job_id="job-1",
        llm_error_msg=None,
    )
    base.update(overrides)
    return base


def test_grava_schema_version():
    row = _build_llm_response_row(**_kwargs())
    assert row["schema_version_major"] == 0
    assert row["schema_version_minor"] == 20
    assert row["schema_version_patch"] == 0


def test_version_inferred_from_live_save():
    # "live_save" faz o backfill (actions/schema.ts) pular estas linhas em vez
    # de re-inferir e sobrescrever a versão correta.
    row = _build_llm_response_row(**_kwargs())
    assert row["version_inferred_from"] == "live_save"


def test_is_latest_segue_is_partial():
    completa = _build_llm_response_row(**_kwargs(is_partial=False))
    assert completa["is_latest"] is True
    assert completa["is_partial"] is False

    parcial = _build_llm_response_row(**_kwargs(is_partial=True))
    assert parcial["is_latest"] is False
    assert parcial["is_partial"] is True


def test_campos_basicos_preservados():
    row = _build_llm_response_row(**_kwargs())
    assert row["respondent_type"] == "llm"
    assert "respondent_id" not in row
    assert row["respondent_name"] == "google_genai/gemini-3-flash-preview"
    assert row["pydantic_hash"] == "3c5e901f76547135"
    assert row["llm_job_id"] == "job-1"
    assert row["llm_error"] is None
    assert row["round_id"] == "round-1"


def test_justifications_vazio_vira_none():
    row = _build_llm_response_row(**_kwargs(justifications={}))
    assert row["justifications"] is None


def test_aceita_versao_diferente_de_zero():
    row = _build_llm_response_row(
        **_kwargs(
            run=_run(
                schema_version_major=1,
                schema_version_minor=2,
                schema_version_patch=3,
            )
        )
    )
    assert (
        row["schema_version_major"],
        row["schema_version_minor"],
        row["schema_version_patch"],
    ) == (1, 2, 3)
