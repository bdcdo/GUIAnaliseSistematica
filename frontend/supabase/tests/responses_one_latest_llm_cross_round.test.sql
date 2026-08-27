-- Contrato de publish_latest_llm_response depois da migration 20260827160000:
-- a despromocao alcanca qualquer resposta LLM viva do documento, de qualquer
-- rodada, e nao so a da rodada que esta sendo publicada.
--
-- O bug que este teste fixa: 20260731120000 recriou o indice HUMANO com
-- round_id na chave e escopou o UPDATE do LLM por rodada, mas deixou o indice
-- do LLM global — (project_id, document_id), de 20260717120000:875. Com uma
-- rodada so as duas leituras coincidem. Na segunda rodada divergem: a resposta
-- viva presa na rodada anterior nao e alcancada pelo UPDATE, e o INSERT
-- seguinte bate em responses_one_latest_llm_per_document. Em producao
-- (2026-08-27) isso matou uma run no 17o de 44 documentos, depois de todas as
-- chamadas ao LLM ja terem sido pagas.
--
-- Como rodar (apos `npx supabase start` e `npx supabase db reset`):
--   bash scripts/run-sql-test.sh \
--     supabase/tests/responses_one_latest_llm_cross_round.test.sql
--
-- Validar pelo exit code, nao por contar OKs na saida.
-- Roda inteiro em BEGIN ... ROLLBACK; nao deixa fixtures no banco local.
--
-- O bloco (c) reinstala a definicao PRE-correcao e exige que ela colida. Sem
-- ele o teste passaria identico nos dois schemas e nao mediria nada. Ele e
-- desfeito pelo ROLLBACK final, como todo o resto.

BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('7b000000-0000-0000-0000-000000000001', 'llm-cross-round@example.test');

INSERT INTO public.clerk_user_mapping
  (clerk_user_id, supabase_user_id, access_sync_version)
VALUES
  ('7b000000-0000-0000-0000-000000000001',
   '7b000000-0000-0000-0000-000000000001', 1);

INSERT INTO public.projects (id, name, created_by, pydantic_fields) VALUES
  ('7b100000-0000-0000-0000-000000000001', 'llm cross round',
   '7b000000-0000-0000-0000-000000000001', '[{"name":"q1"}]');

INSERT INTO public.documents (id, project_id, title, text, text_hash) VALUES
  ('7b200000-0000-0000-0000-000000000001',
   '7b100000-0000-0000-0000-000000000001', 'doc', 'texto',
   'llm-cross-round-doc');

INSERT INTO public.rounds (id, project_id, label) VALUES
  ('7b300000-0000-0000-0000-000000000001',
   '7b100000-0000-0000-0000-000000000001', 'Rodada antiga'),
  ('7b300000-0000-0000-0000-000000000002',
   '7b100000-0000-0000-0000-000000000001', 'Rodada corrente');

-- ========== (a) Premissa: o indice do LLM continua global ==========
-- O teste inteiro pressupoe que responses_one_latest_llm_per_document nao tem
-- round_id na chave. Se alguem o rechavear, (c) para de colidir e a suite
-- passaria a aprovar sem exercitar nada. A premissa vira assercao.
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT indexdef INTO v_def
  FROM pg_catalog.pg_indexes
  WHERE schemaname = 'public'
    AND indexname = 'responses_one_latest_llm_per_document';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'FALHOU: indice responses_one_latest_llm_per_document ausente';
  END IF;
  IF v_def LIKE '%round_id%' THEN
    RAISE EXCEPTION
      'FALHOU: indice do LLM passou a ter round_id na chave; (c) nao colide mais e este teste deixou de medir. Indice: %',
      v_def;
  END IF;
  RAISE NOTICE 'OK: indice do LLM segue chaveado por (project_id, document_id)';
END $$;

-- A primeira resposta nasce na rodada antiga, enquanto ela ainda e a corrente.
UPDATE public.projects
SET current_round_id = '7b300000-0000-0000-0000-000000000001'
WHERE id = '7b100000-0000-0000-0000-000000000001';

DO $$
DECLARE
  v_antiga uuid;
BEGIN
  v_antiga := public.publish_latest_llm_response(
    pg_catalog.jsonb_build_object(
      'project_id', '7b100000-0000-0000-0000-000000000001',
      'document_id', '7b200000-0000-0000-0000-000000000001',
      'round_id', '7b300000-0000-0000-0000-000000000001',
      'respondent_name', 'test/antiga',
      'answers', '{"q1":"antiga"}'::jsonb,
      'is_partial', false
    )
  );

  IF NOT EXISTS (
    SELECT 1 FROM public.responses WHERE id = v_antiga AND is_latest
  ) THEN
    RAISE EXCEPTION 'FALHOU: publicacao na rodada antiga nao nasceu is_latest';
  END IF;
END $$;

-- A rodada vira. A resposta LLM acima fica viva fora da rodada corrente: e
-- exatamente o estado medido em producao em 27/08.
UPDATE public.projects
SET current_round_id = '7b300000-0000-0000-0000-000000000002'
WHERE id = '7b100000-0000-0000-0000-000000000001';

SAVEPOINT orfa_viva;

-- ========== (b) VERDE: a publicacao na rodada corrente despromove a orfa =====
DO $$
DECLARE
  v_nova uuid;
  v_vivas integer;
  v_constraint text;
BEGIN
  v_nova := public.publish_latest_llm_response(
    pg_catalog.jsonb_build_object(
      'project_id', '7b100000-0000-0000-0000-000000000001',
      'document_id', '7b200000-0000-0000-0000-000000000001',
      'round_id', '7b300000-0000-0000-0000-000000000002',
      'respondent_name', 'test/corrente',
      'answers', '{"q1":"corrente"}'::jsonb,
      'is_partial', false
    )
  );

  IF EXISTS (
    SELECT 1 FROM public.responses
    WHERE document_id = '7b200000-0000-0000-0000-000000000001'
      AND respondent_type = 'llm'
      AND round_id = '7b300000-0000-0000-0000-000000000001'
      AND is_latest
  ) THEN
    RAISE EXCEPTION
      'FALHOU: a resposta LLM da rodada anterior continua is_latest';
  END IF;

  SELECT count(*) INTO v_vivas
  FROM public.responses
  WHERE document_id = '7b200000-0000-0000-0000-000000000001'
    AND respondent_type = 'llm'
    AND is_latest;

  IF v_vivas <> 1 THEN
    RAISE EXCEPTION
      'FALHOU: esperava 1 resposta LLM viva no documento, encontrei %', v_vivas;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.responses
    WHERE id = v_nova
      AND is_latest
      AND round_id = '7b300000-0000-0000-0000-000000000002'
  ) THEN
    RAISE EXCEPTION 'FALHOU: a viva nao e a recem-publicada na rodada corrente';
  END IF;

  RAISE NOTICE
    'OK: publicacao na rodada corrente despromoveu a viva da rodada anterior';
EXCEPTION
  WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    RAISE EXCEPTION
      'FALHOU: publicacao cross-round ainda colide em %; a correcao de 20260827160000 nao esta aplicada',
      COALESCE(v_constraint, '(sem nome)');
END $$;

-- Desfaz (b) e devolve a orfa viva, para que (c) parta do mesmo estado.
ROLLBACK TO SAVEPOINT orfa_viva;

-- ========== (c) VERMELHO: a definicao pre-correcao tem que colidir ==========
-- Copia CONGELADA do corpo vigente ate 20260820170000, cuja unica diferenca
-- para o de 20260827160000 e o `AND response.round_id = v_round_id` no UPDATE
-- de despromocao. Nao atualizar junto com a funcao viva: o valor deste bloco
-- esta em ser historia parada. Desfeito pelo ROLLBACK do fim do arquivo.
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

  UPDATE public.responses AS response
  SET is_latest = false
  WHERE response.project_id = v_project_id
    AND response.round_id = v_round_id
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

DO $$
DECLARE
  v_colidiu boolean := false;
  v_constraint text;
BEGIN
  BEGIN
    PERFORM public.publish_latest_llm_response(
      pg_catalog.jsonb_build_object(
        'project_id', '7b100000-0000-0000-0000-000000000001',
        'document_id', '7b200000-0000-0000-0000-000000000001',
        'round_id', '7b300000-0000-0000-0000-000000000002',
        'respondent_name', 'test/corrente',
        'answers', '{"q1":"corrente"}'::jsonb,
        'is_partial', false
      )
    );
  EXCEPTION WHEN unique_violation THEN
    v_colidiu := true;
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
  END;

  IF NOT v_colidiu THEN
    RAISE EXCEPTION
      'FALHOU: a definicao pre-correcao publicou sem colidir; o vermelho nao existe e o verde de (b) nao prova nada';
  END IF;

  -- Nao basta colidir: tem que colidir NO indice do LLM. Qualquer outra unique
  -- daria um vermelho que nao e o desta correcao.
  IF v_constraint IS DISTINCT FROM 'responses_one_latest_llm_per_document' THEN
    RAISE EXCEPTION
      'FALHOU: colidiu em % e nao em responses_one_latest_llm_per_document',
      COALESCE(v_constraint, '(sem nome)');
  END IF;

  RAISE NOTICE
    'OK: a definicao pre-correcao colide em responses_one_latest_llm_per_document';
END $$;

ROLLBACK;
