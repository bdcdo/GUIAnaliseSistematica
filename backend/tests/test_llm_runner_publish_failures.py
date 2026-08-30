"""Testes dos helpers da publicação resiliente a falha de linha.

Cobrem as duas armadilhas que o módulo não tem como pegar sozinho: `mypy`
ignora `services/llm_runner.py` por inteiro (`ignore_errors` no pyproject),
então nem a normalização de `code` nem a forma da mensagem têm rede de tipo.
"""

from supabase import PostgrestAPIError

from services.llm_runner import (
    _dedup_key,
    _describe_postgrest_error,
    _format_publish_failures,
    _PublishFailure,
)


def _api_error(code, message: str, **extra) -> PostgrestAPIError:
    body = {"message": message, "code": code, "hint": None, "details": None}
    body.update(extra)
    return PostgrestAPIError(body)


def test_dedup_key_agrupa_mensagem_identica_e_separa_mensagem_distinta():
    assert _dedup_key("boom") == _dedup_key("boom")
    assert _dedup_key("boom") != _dedup_key("boom.")


def test_dedup_key_aceita_bytes_invalidos_sem_levantar():
    # errors="replace" na codificação: uma mensagem com surrogate solto vinda
    # do banco não pode derrubar a formatação do relatório de erro.
    assert len(_dedup_key("erro \ud800 solto")) == 16


def test_describe_nao_devolve_o_repr_do_dict_cru():
    """str(APIError) é o dict; a mensagem que vai para a tela não pode ser.

    O construtor da lib guarda o corpo do erro em `args` e depois congela
    `str(self)` ali, quando `args[0]` ainda é o dict.
    """
    exc = _api_error("23505", "duplicate key value violates unique constraint")
    assert str(exc).startswith("{'message'")

    descrito = _describe_postgrest_error(exc)
    assert descrito == "[23505] duplicate key value violates unique constraint"
    assert "{'message'" not in descrito


def test_describe_normaliza_code_inteiro_de_gateway():
    # generate_default_error_message põe o status HTTP em `code` quando o corpo
    # da resposta não é JSON parseável — um int, não um SQLSTATE.
    exc = _api_error(502, "JSON could not be generated")
    assert exc.code == 502
    assert _describe_postgrest_error(exc) == "[502] JSON could not be generated"


def test_describe_sobrevive_a_erro_sem_code_e_sem_message():
    exc = _api_error(None, "")
    assert _describe_postgrest_error(exc) == "[sem código] sem mensagem"


def test_format_lista_todos_os_docs_e_deduplica_as_mensagens():
    falhas = [
        _PublishFailure("doc-1", "[23505] duplicate key"),
        _PublishFailure("doc-2", "[23505] duplicate key"),
        _PublishFailure("doc-3", "[42501] rls"),
    ]

    msg = _format_publish_failures(falhas, [])

    # Todos os document_id entram: é o que permite decidir a rerodada.
    for doc in ("doc-1", "doc-2", "doc-3"):
        assert doc in msg
    assert "3 doc(s)" in msg
    # A segunda cópia da mesma recusa do Postgres não vira segunda amostra.
    assert msg.count("duplicate key") == 1
    assert "doc=doc-1: [23505] duplicate key" in msg
    assert "doc=doc-3: [42501] rls" in msg


def test_format_anexa_a_cauda_de_cobertura_parcial():
    falhas = [_PublishFailure("doc-1", "[23505] duplicate key")]

    msg = _format_publish_failures(falhas, ["doc=doc-9: cobertura baixa (1/3)"])

    assert "cobertura parcial" in msg
    assert "doc-9" in msg


def test_format_sem_warnings_nao_inventa_a_cauda():
    msg = _format_publish_failures([_PublishFailure("doc-1", "[23505] x")], [])
    assert "cobertura parcial" not in msg


def test_format_distingue_corte_por_falhas_seguidas():
    falhas = [_PublishFailure(f"doc-{i}", "[42501] rls") for i in range(1, 6)]

    corte = _format_publish_failures(falhas, [], consecutive=5)
    fim = _format_publish_failures(falhas, [])

    assert "interrompida" in corte.lower()
    assert "5 falhas seguidas" in corte
    assert "não chegaram a ser tentados" in corte
    assert "interrompida" not in fim.lower()
    assert "5 doc(s)" in fim


def test_format_conta_a_sequencia_e_nao_o_total_no_corte():
    """ "N falhas seguidas" tem que ser a sequência, não o acumulado do laço.

    O corte dispara na quinta falha *consecutiva*, e `consecutive_failures` é
    zerado a cada publicação bem-sucedida. Uma falha isolada lá atrás continua
    em `publish_failures`, então usar `len()` na abertura anuncia uma sequência
    maior do que a que de fato houve — inflando justamente o diagnóstico que
    separa "causa da run" de "azar isolado".
    """
    falhas = [_PublishFailure("doc-0", "[23505] duplicate key")] + [
        _PublishFailure(f"doc-{i}", "[42501] rls") for i in range(6, 11)
    ]

    msg = _format_publish_failures(falhas, [], consecutive=5)

    assert "5 falhas seguidas" in msg
    assert "6 falhas seguidas" not in msg
    # A lista completa continua íntegra: são 6 documentos sem resposta gravada.
    for doc in ("doc-0", "doc-6", "doc-7", "doc-8", "doc-9", "doc-10"):
        assert doc in msg
