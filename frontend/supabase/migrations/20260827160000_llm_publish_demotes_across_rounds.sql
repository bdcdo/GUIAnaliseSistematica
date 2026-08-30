-- A publicação LLM despromove por documento, não por rodada.
--
-- Defeito: uma run no projeto "Zolgensma - Judiciário" publicou 16 documentos
-- em 2026-08-27 e morreu no 17º com 23505 em
-- `responses_one_latest_llm_per_document`. Duas respostas LLM com
-- `is_latest = true` estavam presas na rodada `b3c55b57` enquanto a corrente
-- era a `7994e4eb`; o UPDATE de despromoção não as alcançava e o INSERT
-- seguinte batia no índice.
--
-- A origem é uma assimetria introduzida em 20260731120000. Ali o índice HUMANO
-- foi recriado com `round_id` na chave e o UPDATE do LLM passou a ser escopado
-- por rodada, mas o índice do LLM ficou global, `(project_id, document_id)`,
-- desde 20260717120000:875. Duas metades da mesma invariante que discordam.
-- Enquanto o projeto tem uma rodada só, as duas leituras coincidem; na segunda
-- rodada divergem, e quem denuncia é o Postgres.
--
-- Quem cede é a função, e a razão é `start_project_round`
-- (20260804120000_start_project_round_definer.sql): ela arquiva a rodada
-- inteira na transição, sem filtrar `respondent_type`. A invariante que o
-- sistema de fato implementa é a por projeto, que é a que o índice declara.
-- Recriar o índice com `round_id` legalizaria o estado corrompido e trocaria um
-- erro barulhento por erros silenciosos em onze pontos de leitura que não
-- filtram rodada, mais uma quebra dura em src/lib/auto-comparison.ts, onde um
-- `.maybeSingle()` viraria PGRST116.
--
-- Única mudança em relação à definição viva (20260820170000): sai
-- `AND response.round_id = v_round_id` do UPDATE de despromoção. A validação de
-- rodada corrente que levanta P0R01 fica intacta e continua sendo o portão de
-- entrada: publicar em rodada que deixou de ser a corrente segue proibido. O
-- que muda é só o alcance da limpeza feita depois que o portão já autorizou.
--
-- Efeito colateral esperado: despromover uma resposta de rodada anterior
-- dispara `archive_review_dependencies_on_response_change` (20260717120000:644)
-- sobre ela, arquivando field_reviews/response_equivalences e mexendo em
-- assignments por documento. Não é novidade de comportamento: o mesmo trigger
-- já dispara na despromoção intra-rodada de todo publish. O UPDATE também passa
-- por `responses_enforce_current_round_write` em linha de rodada encerrada
-- porque `answers`/`justifications` ficam inalterados, que é a válvula aberta
-- em 20260820170000.
--
-- Contrato coberto por supabase/tests/responses_one_latest_llm_cross_round.test.sql,
-- que exercita o vermelho recriando a definição pré-correção no próprio teste.
--
-- Registro: bdcdo/dataframeitGUI#715

BEGIN;

CREATE OR REPLACE FUNCTION public.publish_latest_llm_response(
  p_response jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_project_id uuid;
  v_document_id uuid;
  v_round_id uuid;
  v_current_round_id uuid;
  v_document_project_id uuid;
  v_response_id uuid;
  v_is_partial boolean;
BEGIN
  IF p_response IS NULL OR pg_catalog.jsonb_typeof(p_response) <> 'object' THEN
    RAISE EXCEPTION 'p_response must be a JSON object';
  END IF;
  IF pg_catalog.jsonb_typeof(p_response->'answers') <> 'object'
     OR (
       p_response->'justifications' IS NOT NULL
       AND p_response->'justifications' <> 'null'::jsonb
       AND pg_catalog.jsonb_typeof(p_response->'justifications') <> 'object'
     )
     OR (
       p_response->'answer_field_hashes' IS NOT NULL
       AND p_response->'answer_field_hashes' <> 'null'::jsonb
       AND pg_catalog.jsonb_typeof(p_response->'answer_field_hashes') <> 'object'
     ) THEN
    RAISE EXCEPTION 'LLM response answers, justifications, and field hashes must be JSON objects';
  END IF;

  v_project_id := (p_response->>'project_id')::uuid;
  v_document_id := (p_response->>'document_id')::uuid;
  v_round_id := NULLIF(p_response->>'round_id', '')::uuid;
  v_is_partial := COALESCE((p_response->>'is_partial')::boolean, false);

  IF v_round_id IS NULL THEN
    RAISE EXCEPTION 'LLM response round_id is required' USING ERRCODE = '22023';
  END IF;

  SELECT project.current_round_id INTO v_current_round_id
  FROM public.projects AS project
  WHERE project.id = v_project_id
  FOR SHARE;

  IF NOT FOUND OR v_current_round_id IS DISTINCT FROM v_round_id THEN
    -- Mesma razao do P0R01 no trigger: a rodada da resposta nao volta a ser
    -- a corrente sozinha, entao 40001 so servia para o publicador retentar em
    -- laco. O llm_runner e justamente quem chama esta RPC em loop por linha.
    RAISE EXCEPTION 'LLM response round is no longer current'
      USING ERRCODE = 'P0R01';
  END IF;

  SELECT document.project_id INTO v_document_project_id
  FROM public.documents AS document
  WHERE document.id = v_document_id
  FOR UPDATE;

  IF v_document_project_id IS NULL
     OR v_document_project_id IS DISTINCT FROM v_project_id THEN
    RAISE EXCEPTION 'LLM response document does not belong to project';
  END IF;

  DELETE FROM public.auto_review_reconciliation_requests AS request
  WHERE request.document_id = v_document_id;

  -- Sem `round_id` no predicado: o alvo é o que o índice proíbe, que é mais de
  -- uma resposta LLM viva no par (project_id, document_id), de qualquer rodada.
  UPDATE public.responses AS response
  SET is_latest = false
  WHERE response.project_id = v_project_id
    AND response.document_id = v_document_id
    AND response.respondent_type = 'llm'
    AND response.is_latest = true;

  INSERT INTO public.responses (
    project_id, document_id, respondent_id, respondent_type, respondent_name,
    answers, justifications, is_latest, is_partial, pydantic_hash,
    answer_field_hashes, llm_job_id, llm_error, schema_version_major,
    schema_version_minor, schema_version_patch, version_inferred_from, round_id
  ) VALUES (
    v_project_id, v_document_id, NULL, 'llm', p_response->>'respondent_name',
    COALESCE(p_response->'answers', '{}'::jsonb),
    NULLIF(p_response->'justifications', 'null'::jsonb),
    NOT v_is_partial, v_is_partial, p_response->>'pydantic_hash',
    NULLIF(p_response->'answer_field_hashes', 'null'::jsonb),
    NULLIF(p_response->>'llm_job_id', '')::uuid, p_response->>'llm_error',
    COALESCE((p_response->>'schema_version_major')::integer, 0),
    COALESCE((p_response->>'schema_version_minor')::integer, 1),
    COALESCE((p_response->>'schema_version_patch')::integer, 0),
    p_response->>'version_inferred_from', v_round_id
  )
  RETURNING id INTO v_response_id;

  RETURN v_response_id;
END;
$$;

REVOKE ALL ON FUNCTION public.publish_latest_llm_response(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_latest_llm_response(jsonb)
  TO service_role;

COMMIT;
