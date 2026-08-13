-- Regression tests for cycle-aware auto-review reconciliation.
--
-- Run after `npx supabase db reset`:
--   docker exec -i supabase_db_frontend psql -U postgres -d postgres \
--     -X -v ON_ERROR_STOP=1 < supabase/tests/auto_review_reconciliation_outbox.test.sql

BEGIN;

-- The migration's structural RPCs run with a service-role JWT. Keeping the
-- claim explicit also lets this suite verify authenticated nested triggers
-- without relying on the guard's local-postgres bypass.
SET LOCAL request.jwt.claims = '{"role":"service_role"}';

INSERT INTO auth.users (id, email) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'researcher@example.test'),
  ('a0000000-0000-0000-0000-000000000002', 'arbitrator@example.test');

INSERT INTO public.clerk_user_mapping
  (clerk_user_id, supabase_user_id, access_sync_version)
SELECT id::TEXT, id, 1
FROM auth.users
WHERE id::TEXT LIKE 'a0000000-0000-0000-0000-%';

INSERT INTO public.projects (
  id, name, created_by, pydantic_hash, pydantic_fields,
  schema_version_major, schema_version_minor, schema_version_patch
) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'cycle test',
   'a0000000-0000-0000-0000-000000000001', 'schema-hash',
   '[{"name":"q1","type":"text","target":"all","hash":"q1-hash"}]',
   1, 0, 0),
  ('b0000000-0000-0000-0000-000000000002', 'trigger test',
   'a0000000-0000-0000-0000-000000000001', 'schema-hash',
   '[{"name":"q1","type":"text","target":"all","hash":"q1-hash"}]',
   1, 0, 0);

INSERT INTO public.documents (id, project_id, title, text, text_hash) VALUES
  ('c0000000-0000-0000-0000-000000000001',
   'b0000000-0000-0000-0000-000000000001', 'doc', 'text', 'cycle-doc'),
  ('c0000000-0000-0000-0000-000000000002',
   'b0000000-0000-0000-0000-000000000002', 'trigger doc', 'text', 'trigger-doc');

INSERT INTO public.project_members (
  project_id, user_id, role, can_arbitrate
) VALUES
  ('b0000000-0000-0000-0000-000000000001',
   'a0000000-0000-0000-0000-000000000001', 'pesquisador', false),
  ('b0000000-0000-0000-0000-000000000001',
   'a0000000-0000-0000-0000-000000000002', 'pesquisador', true);

INSERT INTO public.responses (
  id, project_id, document_id, respondent_id, respondent_type, answers,
  justifications, is_latest, pydantic_hash, answer_field_hashes,
  schema_version_major, schema_version_minor, schema_version_patch,
  version_inferred_from
) VALUES
  ('d0000000-0000-0000-0000-000000000001',
   'b0000000-0000-0000-0000-000000000001',
   'c0000000-0000-0000-0000-000000000001',
   'a0000000-0000-0000-0000-000000000001', 'humano', '{"q1":"human-v1"}',
   NULL, true, 'schema-hash', '{"q1":"q1-hash"}', 1, 0, 0, 'live_save'),
  ('d0000000-0000-0000-0000-000000000002',
   'b0000000-0000-0000-0000-000000000001',
   'c0000000-0000-0000-0000-000000000001', NULL, 'llm', '{"q1":"llm"}',
   '{"q1":"because"}', true, 'schema-hash', '{"q1":"q1-hash"}',
   1, 0, 0, 'live_save');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.auto_review_reconciliation_requests
    WHERE document_id = 'c0000000-0000-0000-0000-000000000001'
      AND llm_response_id = 'd0000000-0000-0000-0000-000000000002'
      AND allow_new_cycles = true
  ) OR NOT EXISTS (
    SELECT 1 FROM public.final_answers
    WHERE document_id = 'c0000000-0000-0000-0000-000000000001'
      AND field_name = 'q1'
      AND answer IS NULL
      AND provenance = 'aguarda_reconciliacao'
  ) THEN
    RAISE EXCEPTION 'LLM insert did not enqueue reconciliation fail-closed';
  END IF;

END;
$$;

-- Human-first publication has nothing to reconcile against yet, so it must not
-- enqueue: a request without an LLM generation is work no worker can finish
-- (#670). The save is not lost — the LLM publication below enqueues it.
INSERT INTO public.responses (
  id, project_id, document_id, respondent_id, respondent_type, answers,
  is_latest, is_partial, pydantic_hash, answer_field_hashes,
  schema_version_major, schema_version_minor, schema_version_patch
) VALUES (
  'd0000000-0000-0000-0000-000000000010',
  'b0000000-0000-0000-0000-000000000002',
  'c0000000-0000-0000-0000-000000000002',
  'a0000000-0000-0000-0000-000000000001', 'humano', '{"q1":"human"}',
  true, false, 'schema-hash', '{"q1":"q1-hash"}', 1, 0, 0
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.auto_review_reconciliation_requests
    WHERE document_id = 'c0000000-0000-0000-0000-000000000002'
  ) THEN
    RAISE EXCEPTION 'human-first save enqueued without a current LLM generation';
  END IF;
END;
$$;

INSERT INTO public.responses (
  id, project_id, document_id, respondent_type, answers, justifications,
  is_latest, is_partial, pydantic_hash, answer_field_hashes,
  schema_version_major, schema_version_minor, schema_version_patch
) VALUES (
  'd0000000-0000-0000-0000-000000000011',
  'b0000000-0000-0000-0000-000000000002',
  'c0000000-0000-0000-0000-000000000002', 'llm', '{"q1":"llm"}', NULL,
  true, false, 'schema-hash', '{"q1":"q1-hash"}', 1, 0, 0
);

DO $$
DECLARE
  v_rejected BOOLEAN := false;
BEGIN
  -- Contrapartida da asserção anterior: o save humano que não enfileirou não se
  -- perdeu. A publicação da geração LLM é que enfileira, e o dreno relê as
  -- respostas humanas correntes daquele instante.
  IF (SELECT llm_response_id FROM public.auto_review_reconciliation_requests
      WHERE document_id = 'c0000000-0000-0000-0000-000000000002')
     IS DISTINCT FROM 'd0000000-0000-0000-0000-000000000011'::UUID THEN
    RAISE EXCEPTION 'LLM generation did not enqueue the pending human reconciliation';
  END IF;

  BEGIN
    INSERT INTO public.auto_review_reconciliation_requests (
      document_id, project_id, llm_response_id, allow_new_cycles
    ) VALUES (
      'c0000000-0000-0000-0000-000000000001',
      'b0000000-0000-0000-0000-000000000002',
      'd0000000-0000-0000-0000-000000000002', true
    );
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'reconciliation request document does not belong to project' THEN
      RAISE;
    END IF;
    v_rejected := true;
  END;

  IF NOT v_rejected THEN
    RAISE EXCEPTION 'malformed project/document/request trio was accepted';
  END IF;
END;
$$;

-- Contrato do token de ACK. O dreno apaga a request casando também
-- `requested_at` (auto-review-reconciler.ts, acknowledge), porque o
-- reenfileiramento humano mantém a MESMA geração LLM: sem essa coluna o worker
-- não distingue a linha que leu da que um save posterior recriou, e apaga a
-- segunda. O que este bloco fixa é a premissa de banco disso — o
-- `ON CONFLICT DO UPDATE` reescreve `requested_at` e preserva `llm_response_id`.
--
-- A suíte roda numa transação só e `pg_catalog.now()` é transaction_timestamp(),
-- então dois enqueues seguidos gravariam o MESMO valor: afirmar "o timestamp
-- avançou" seria vácuo aqui. Empurrar o valor para o passado antes do re-save é
-- o que faz a asserção morder.
DO $$
DECLARE
  v_llm_response_id UUID;
  v_requested_at TIMESTAMPTZ;
BEGIN
  UPDATE public.auto_review_reconciliation_requests
  SET requested_at = pg_catalog.now() - INTERVAL '1 minute'
  WHERE document_id = 'c0000000-0000-0000-0000-000000000002';

  UPDATE public.responses
  SET answers = '{"q1":"human-revisado"}'
  WHERE id = 'd0000000-0000-0000-0000-000000000010';

  SELECT request.llm_response_id, request.requested_at
  INTO STRICT v_llm_response_id, v_requested_at
  FROM public.auto_review_reconciliation_requests AS request
  WHERE request.document_id = 'c0000000-0000-0000-0000-000000000002';

  IF v_requested_at <> pg_catalog.now() THEN
    RAISE EXCEPTION
      'human re-save did not refresh the ACK token; requested_at is %',
      v_requested_at;
  END IF;

  IF v_llm_response_id IS DISTINCT FROM
     'd0000000-0000-0000-0000-000000000011'::UUID THEN
    RAISE EXCEPTION 'human re-save changed the enqueued LLM generation';
  END IF;
END;
$$;

-- Documento só com codificação humana, sem geração LLM nenhuma: é o cenário da
-- #670 e a fixture das três asserções seguintes.
INSERT INTO public.documents (id, project_id, title, text, text_hash) VALUES
  ('c0000000-0000-0000-0000-000000000003',
   'b0000000-0000-0000-0000-000000000002', 'human-only doc', 'text',
   'human-only-doc');

INSERT INTO public.responses (
  id, project_id, document_id, respondent_id, respondent_type, answers,
  is_latest, is_partial, pydantic_hash, answer_field_hashes,
  schema_version_major, schema_version_minor, schema_version_patch
) VALUES (
  'd0000000-0000-0000-0000-000000000013',
  'b0000000-0000-0000-0000-000000000002',
  'c0000000-0000-0000-0000-000000000003',
  'a0000000-0000-0000-0000-000000000001', 'humano', '{"q1":"human-only"}',
  true, false, 'schema-hash', '{"q1":"q1-hash"}', 1, 0, 0
);

-- #670: é o NOT NULL da coluna que torna "request sem geração para comparar" um
-- estado inconstruível. O guard do trigger sozinho protegeria só o caminho que
-- passa por ele; a constraint protege qualquer canal de escrita, inclusive os
-- que ainda não existem. Asserção estrutural porque a comportamental abaixo não
-- consegue distinguir a constraint do validate: BEFORE trigger roda ANTES da
-- checagem de NOT NULL, então é sempre o validate que responde primeiro.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS column_meta
    WHERE column_meta.attrelid = 'public.auto_review_reconciliation_requests'::REGCLASS
      AND column_meta.attname = 'llm_response_id'
      AND column_meta.attnotnull
  ) THEN
    RAISE EXCEPTION 'llm_response_id still admits NULL';
  END IF;
END;
$$;

DO $$
DECLARE
  v_rejected BOOLEAN := false;
BEGIN
  BEGIN
    INSERT INTO public.auto_review_reconciliation_requests (
      document_id, project_id, llm_response_id, allow_new_cycles
    ) VALUES (
      'c0000000-0000-0000-0000-000000000003',
      'b0000000-0000-0000-0000-000000000002', NULL, true
    );
  EXCEPTION
    WHEN not_null_violation THEN
      v_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM <> 'reconciliation request must reference its current complete LLM response' THEN
        RAISE;
      END IF;
      v_rejected := true;
  END;

  IF NOT v_rejected THEN
    RAISE EXCEPTION 'request without an LLM generation was accepted';
  END IF;
END;
$$;

-- A geração precisa ser a CORRENTE, não qualquer uma do documento: uma request
-- apontando para geração superada faria o dreno reconciliar contra respostas
-- que a publicação seguinte já substituiu.
INSERT INTO public.responses (
  id, project_id, document_id, respondent_type, answers, justifications,
  is_latest, is_partial, pydantic_hash, answer_field_hashes,
  schema_version_major, schema_version_minor, schema_version_patch
) VALUES (
  'd0000000-0000-0000-0000-000000000012',
  'b0000000-0000-0000-0000-000000000002',
  'c0000000-0000-0000-0000-000000000002', 'llm', '{"q1":"llm-superseded"}', NULL,
  false, false, 'schema-hash', '{"q1":"q1-hash"}', 1, 0, 0
);

DO $$
DECLARE
  v_rejected BOOLEAN := false;
BEGIN
  BEGIN
    UPDATE public.auto_review_reconciliation_requests
    SET llm_response_id = 'd0000000-0000-0000-0000-000000000012'
    WHERE document_id = 'c0000000-0000-0000-0000-000000000002';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'reconciliation request must reference its current complete LLM response' THEN
      RAISE;
    END IF;
    v_rejected := true;
  END;

  IF NOT v_rejected THEN
    RAISE EXCEPTION 'request pointing at a superseded LLM generation was accepted';
  END IF;
END;
$$;

-- O reparo do coordenador (regenerateAutoReviewBacklog) é o SEGUNDO produtor e
-- precisa do mesmo contrato: documento sem geração LLM corrente fica fora do
-- backlog em vez de virar linha insatisfazível.
DO $$
BEGIN
  -- Apagar a request de c…0002 é o que torna o discriminante abaixo capaz de
  -- morder: ela foi criada pelo trigger na publicação da geração LLM e ainda
  -- está viva aqui, então um `NOT EXISTS` sobre a linha preexistente passaria
  -- mesmo que o JOIN LATERAL casasse zero documentos. Zerada a fila, só o
  -- próprio reparo pode recriá-la.
  DELETE FROM public.auto_review_reconciliation_requests
  WHERE document_id = 'c0000000-0000-0000-0000-000000000002';

  PERFORM public.enqueue_auto_review_reconciliation_for_project(
    'b0000000-0000-0000-0000-000000000002'
  );

  IF EXISTS (
    SELECT 1 FROM public.auto_review_reconciliation_requests
    WHERE document_id = 'c0000000-0000-0000-0000-000000000003'
  ) THEN
    RAISE EXCEPTION 'backlog regeneration enqueued a document without an LLM generation';
  END IF;

  -- Discriminante: o documento que TEM geração corrente volta a entrar, senão a
  -- asserção acima passaria com um reparo que simplesmente não enfileira nada.
  IF NOT EXISTS (
    SELECT 1 FROM public.auto_review_reconciliation_requests
    WHERE document_id = 'c0000000-0000-0000-0000-000000000002'
      AND llm_response_id = 'd0000000-0000-0000-0000-000000000011'
  ) THEN
    RAISE EXCEPTION 'backlog regeneration dropped a document with a current LLM generation';
  END IF;
END;
$$;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims =
  '{"role":"authenticated","sub":"a0000000-0000-0000-0000-000000000001","supabase_uid":"a0000000-0000-0000-0000-000000000001"}';

DO $$
BEGIN
  IF NOT public.is_auto_review_reconciliation_pending(
    'b0000000-0000-0000-0000-000000000001',
    'c0000000-0000-0000-0000-000000000001',
    'd0000000-0000-0000-0000-000000000002'
  ) THEN
    RAISE EXCEPTION 'authenticated member cannot read pending provenance';
  END IF;
END;
$$;

RESET ROLE;
SET LOCAL request.jwt.claims = '{"role":"service_role"}';

DO $$
DECLARE
  v_rejected BOOLEAN := false;
BEGIN
  BEGIN
    PERFORM public.reconcile_auto_review_cycles('[{
      "human_response_id":"d0000000-0000-0000-0000-000000000001",
      "llm_response_id":"d0000000-0000-0000-0000-000000000002",
      "field_names":["q1"],
      "divergent_field_names":["q1"],
      "expected_human_updated_at":"2000-01-01T00:00:00Z",
      "expected_llm_updated_at":"2000-01-01T00:00:00Z",
      "expected_project_pydantic_hash":"schema-hash",
      "expected_equivalence_ids":[]
    }]'::JSONB);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'auto-review reconciliation inputs changed; retry required' THEN
      RAISE;
    END IF;
    v_rejected := true;
  END;

  IF NOT v_rejected THEN
    RAISE EXCEPTION 'stale reconciliation inputs were accepted';
  END IF;
END;
$$;

-- The rest of this suite drives reconciliation directly, as the Next worker
-- would do before acknowledging this exact request.
DELETE FROM public.auto_review_reconciliation_requests
WHERE llm_response_id = 'd0000000-0000-0000-0000-000000000002';

CREATE FUNCTION pg_temp.reconcile_q1(
  p_human_response_id UUID,
  p_llm_response_id UUID,
  p_divergent_field_names JSONB
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_human_updated_at TIMESTAMPTZ;
  v_llm_updated_at TIMESTAMPTZ;
  v_pydantic_hash TEXT;
  v_equivalence_ids JSONB;
BEGIN
  SELECT updated_at INTO STRICT v_human_updated_at
  FROM public.responses WHERE id = p_human_response_id;
  SELECT updated_at, project.pydantic_hash
  INTO STRICT v_llm_updated_at, v_pydantic_hash
  FROM public.responses AS response
  JOIN public.projects AS project ON project.id = response.project_id
  WHERE response.id = p_llm_response_id;
  SELECT COALESCE(pg_catalog.jsonb_agg(id::TEXT ORDER BY id), '[]'::JSONB)
  INTO v_equivalence_ids
  FROM public.response_equivalences
  WHERE field_name = 'q1'
    AND superseded_at IS NULL
    AND (
      (response_a_id = p_human_response_id AND response_b_id = p_llm_response_id)
      OR (response_a_id = p_llm_response_id AND response_b_id = p_human_response_id)
    );

  RETURN public.reconcile_auto_review_cycles(pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'human_response_id', p_human_response_id,
      'llm_response_id', p_llm_response_id,
      'field_names', '["q1"]'::JSONB,
      'divergent_field_names', p_divergent_field_names,
      'expected_human_updated_at', v_human_updated_at,
      'expected_llm_updated_at', v_llm_updated_at,
      'expected_project_pydantic_hash', v_pydantic_hash,
      'expected_equivalence_ids', v_equivalence_ids
    )
  ));
END;
$$;

DO $$
DECLARE
  v_result JSONB;
  v_review public.field_reviews%ROWTYPE;
BEGIN
  v_result := pg_temp.reconcile_q1(
    'd0000000-0000-0000-0000-000000000001',
    'd0000000-0000-0000-0000-000000000002',
    '["q1"]'::JSONB
  );

  IF (v_result->>'created')::INTEGER <> 1 THEN
    RAISE EXCEPTION 'expected one cycle, got %', v_result;
  END IF;

  SELECT * INTO STRICT v_review
  FROM public.field_reviews
  WHERE document_id = 'c0000000-0000-0000-0000-000000000001'
    AND field_name = 'q1'
    AND superseded_at IS NULL;

  IF v_review.cycle_no <> 1
     OR v_review.human_answer_snapshot <> '"human-v1"'::JSONB
     OR v_review.llm_answer_snapshot <> '"llm"'::JSONB
     OR v_review.llm_justification_snapshot <> '"because"'::JSONB THEN
    RAISE EXCEPTION 'cycle snapshots are wrong: %', row_to_json(v_review);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.assignments
    WHERE document_id = v_review.document_id
      AND user_id = v_review.self_reviewer_id
      AND type = 'auto_revisao'
      AND status = 'pendente'
  ) THEN
    RAISE EXCEPTION 'compatibility assignment was not projected';
  END IF;
END;
$$;

-- A verdict belongs to the snapshotted values. Editing the mutable response
-- supersedes that cycle and creates a new pending one without erasing history.
DO $$
DECLARE
  v_review_id UUID;
  v_result JSONB;
BEGIN
  SELECT id INTO STRICT v_review_id
  FROM public.field_reviews
  WHERE document_id = 'c0000000-0000-0000-0000-000000000001'
    AND field_name = 'q1';

  v_result := public.submit_auto_review_verdicts(
    'b0000000-0000-0000-0000-000000000001',
    'c0000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000001',
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'field_review_id', v_review_id,
      'field_name', 'q1',
      'verdict', 'admite_erro'
    ))
  );

  IF (v_result->>'arbitrated')::INTEGER <> 0 OR NOT EXISTS (
    SELECT 1 FROM public.field_reviews
    WHERE id = v_review_id AND self_verdict = 'admite_erro'
  ) THEN
    RAISE EXCEPTION 'atomic self-review submission failed: %', v_result;
  END IF;
END;
$$;

-- Production writes happen inside a SECURITY DEFINER response RPC while the
-- JWT role remains authenticated. The temporary grant reproduces that caller
-- context without bypassing the nested field_reviews guard as postgres.
GRANT SELECT, UPDATE ON public.responses TO authenticated;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims =
  '{"role":"authenticated","sub":"a0000000-0000-0000-0000-000000000001","supabase_uid":"a0000000-0000-0000-0000-000000000001"}';

UPDATE public.responses
SET answers = '{"q1":"human-v2"}', updated_at = pg_catalog.now()
WHERE id = 'd0000000-0000-0000-0000-000000000001';

RESET ROLE;
SET LOCAL request.jwt.claims = '{"role":"service_role"}';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.field_reviews
    WHERE document_id = 'c0000000-0000-0000-0000-000000000001'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.field_review_cycle_history_entries
    WHERE document_id = 'c0000000-0000-0000-0000-000000000001'
      AND cycle_no = 1
      AND superseded_reason = 'answer_changed'
      AND self_verdict = 'admite_erro'
  ) THEN
    RAISE EXCEPTION 'response UPDATE did not invalidate/archive atomically';
  END IF;
END;
$$;

DO $$
DECLARE
  v_result JSONB;
  v_count INTEGER;
BEGIN
  v_result := pg_temp.reconcile_q1(
    'd0000000-0000-0000-0000-000000000001',
    'd0000000-0000-0000-0000-000000000002',
    '["q1"]'::JSONB
  );

  IF (v_result->>'created')::INTEGER <> 1
     OR (v_result->>'superseded')::INTEGER <> 0 THEN
    RAISE EXCEPTION 'edit did not rotate the cycle: %', v_result;
  END IF;

  SELECT count(*) INTO v_count FROM public.auto_review_cycle_history
  WHERE document_id = 'c0000000-0000-0000-0000-000000000001'
    AND field_name = 'q1';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'expected two review cycles, got %', v_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.field_review_cycle_history_entries
    WHERE document_id = 'c0000000-0000-0000-0000-000000000001'
      AND field_name = 'q1'
      AND cycle_no = 1
      AND superseded_reason = 'answer_changed'
      AND self_verdict = 'admite_erro'
  ) THEN
    RAISE EXCEPTION 'old verdict/history was not preserved';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.field_reviews
    WHERE document_id = 'c0000000-0000-0000-0000-000000000001'
      AND field_name = 'q1'
      AND cycle_no = 2
      AND superseded_at IS NULL
      AND self_verdict IS NULL
      AND human_answer_snapshot = '"human-v2"'::JSONB
  ) THEN
    RAISE EXCEPTION 'new active cycle is not a clean snapshot';
  END IF;

  v_result := pg_temp.reconcile_q1(
    'd0000000-0000-0000-0000-000000000001',
    'd0000000-0000-0000-0000-000000000002',
    '["q1"]'::JSONB
  );
  IF (v_result->>'created')::INTEGER <> 0
     OR (v_result->>'superseded')::INTEGER <> 0 THEN
    RAISE EXCEPTION 'identical reconciliation is not idempotent: %', v_result;
  END IF;
END;
$$;

-- Veredito, atribuição, decisão final, comentário e fechamento das projeções
-- legadas pertencem a duas transações de domínio, não a várias chamadas HTTP.
DO $$
DECLARE
  v_review_id UUID;
  v_result JSONB;
BEGIN
  SELECT id INTO STRICT v_review_id
  FROM public.field_reviews
  WHERE document_id = 'c0000000-0000-0000-0000-000000000001'
    AND field_name = 'q1';

  v_result := public.submit_auto_review_verdicts(
    'b0000000-0000-0000-0000-000000000001',
    'c0000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000001',
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'field_review_id', v_review_id,
      'field_name', 'q1',
      'verdict', 'contesta_llm',
      'justification', 'discordo'
    ))
  );
  IF (v_result->>'arbitrated')::INTEGER <> 1 THEN
    RAISE EXCEPTION 'atomic arbitration assignment failed: %', v_result;
  END IF;

  UPDATE public.field_reviews
  SET blind_verdict = 'humano', blind_decided_at = pg_catalog.now()
  WHERE id = v_review_id;

  PERFORM public.submit_final_review_verdicts(
    'b0000000-0000-0000-0000-000000000001',
    'c0000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000002',
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'field_review_id', v_review_id,
      'field_name', 'q1',
      'verdict', 'llm',
      'question_improvement_suggestion', 'clarificar',
      'comment_body', 'comentário atômico'
    ))
  );

  IF NOT EXISTS (
    SELECT 1 FROM public.field_reviews
    WHERE id = v_review_id AND final_verdict = 'llm'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.project_comments
    WHERE field_review_id = v_review_id AND body = 'comentário atômico'
  ) THEN
    RAISE EXCEPTION 'atomic final verdict effects are incomplete';
  END IF;
END;
$$;

-- Consensus (or an incomplete coding) closes the active cycle. No placeholder
-- row remains in the canonical queue.
DO $$
DECLARE
  v_result JSONB;
BEGIN
  v_result := pg_temp.reconcile_q1(
    'd0000000-0000-0000-0000-000000000001',
    'd0000000-0000-0000-0000-000000000002',
    '[]'::JSONB
  );

  IF (v_result->>'superseded')::INTEGER <> 1 OR EXISTS (
    SELECT 1 FROM public.field_reviews
    WHERE document_id = 'c0000000-0000-0000-0000-000000000001'
      AND superseded_at IS NULL
  ) THEN
    RAISE EXCEPTION 'consensus did not close the active cycle: %', v_result;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.assignments
    WHERE document_id = 'c0000000-0000-0000-0000-000000000001'
      AND user_id = 'a0000000-0000-0000-0000-000000000001'
      AND type = 'auto_revisao'
      AND status = 'concluido'
  ) THEN
    RAISE EXCEPTION 'compatibility projection stayed open after consensus';
  END IF;
END;
$$;

-- Equivalence decisions also snapshot values. Re-marking the same response IDs
-- after an edit ends the stale pair and creates a new active decision.
DO $$
DECLARE
  v_inserted INTEGER;
BEGIN
  v_inserted := public.record_response_equivalences('[{
    "project_id":"b0000000-0000-0000-0000-000000000001",
    "document_id":"c0000000-0000-0000-0000-000000000001",
    "field_name":"q1",
    "response_a_id":"d0000000-0000-0000-0000-000000000001",
    "response_b_id":"d0000000-0000-0000-0000-000000000002",
    "reviewer_id":"a0000000-0000-0000-0000-000000000001"
  }]'::JSONB);
  IF v_inserted <> 1 THEN
    RAISE EXCEPTION 'equivalence was not inserted';
  END IF;

  UPDATE public.responses SET answers = '{"q1":"human-v3"}'
  WHERE id = 'd0000000-0000-0000-0000-000000000001';

  v_inserted := public.record_response_equivalences('[{
    "project_id":"b0000000-0000-0000-0000-000000000001",
    "document_id":"c0000000-0000-0000-0000-000000000001",
    "field_name":"q1",
    "response_a_id":"d0000000-0000-0000-0000-000000000001",
    "response_b_id":"d0000000-0000-0000-0000-000000000002",
    "reviewer_id":"a0000000-0000-0000-0000-000000000001"
  }]'::JSONB);
  IF v_inserted <> 1 THEN
    RAISE EXCEPTION 'edited pair did not create a new equivalence cycle';
  END IF;

  IF (SELECT count(*) FROM public.response_equivalence_history
      WHERE document_id = 'c0000000-0000-0000-0000-000000000001') <> 2
     OR (SELECT count(*) FROM public.response_equivalences
         WHERE document_id = 'c0000000-0000-0000-0000-000000000001'
           AND superseded_at IS NULL
           AND response_a_answer_snapshot = '"human-v3"'::JSONB) <> 1 THEN
    RAISE EXCEPTION 'equivalence history/current pair is inconsistent';
  END IF;
END;
$$;

-- A DELETE issued by a frontend instance from before the RPC rollout still
-- crosses the same archive boundary.
DELETE FROM public.response_equivalences
WHERE document_id = 'c0000000-0000-0000-0000-000000000001';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.response_equivalences
    WHERE document_id = 'c0000000-0000-0000-0000-000000000001'
  ) OR (SELECT count(*) FROM public.response_equivalence_history_entries
        WHERE document_id = 'c0000000-0000-0000-0000-000000000001') <> 2
     OR NOT EXISTS (
       SELECT 1 FROM public.response_equivalence_history_entries
       WHERE document_id = 'c0000000-0000-0000-0000-000000000001'
         AND response_a_answer_snapshot = '"human-v3"'::JSONB
         AND superseded_reason = 'manually_removed'
     ) THEN
    RAISE EXCEPTION 'DELETE did not preserve equivalence history';
  END IF;
END;
$$;

-- LLM replacement is atomic and its outbox entry is coalesced by document.
DO $$
DECLARE
  v_first_id UUID;
  v_second_id UUID;
  v_current_before_failure UUID;
  v_failure_recorded BOOLEAN;
BEGIN
  v_first_id := public.publish_latest_llm_response(pg_catalog.jsonb_build_object(
    'project_id', 'b0000000-0000-0000-0000-000000000001',
    'round_id', (SELECT current_round_id FROM public.projects WHERE id = 'b0000000-0000-0000-0000-000000000001'),
    'document_id', 'c0000000-0000-0000-0000-000000000001',
    'respondent_name', 'test/model',
    'answers', '{"q1":"llm-v2"}'::JSONB,
    'justifications', '{"q1":"because-v2"}'::JSONB,
    'is_partial', false,
    'pydantic_hash', 'schema-hash',
    'answer_field_hashes', '{"q1":"q1-hash"}'::JSONB,
    'llm_job_id', 'e0000000-0000-0000-0000-000000000001',
    'schema_version_major', 1,
    'schema_version_minor', 0,
    'schema_version_patch', 0,
    'version_inferred_from', 'live_save'
  ));

  v_second_id := public.publish_latest_llm_response(pg_catalog.jsonb_build_object(
    'project_id', 'b0000000-0000-0000-0000-000000000001',
    'round_id', (SELECT current_round_id FROM public.projects WHERE id = 'b0000000-0000-0000-0000-000000000001'),
    'document_id', 'c0000000-0000-0000-0000-000000000001',
    'respondent_name', 'test/model',
    'answers', '{"q1":"llm-v3"}'::JSONB,
    'justifications', '{"q1":"because-v3"}'::JSONB,
    'is_partial', false,
    'pydantic_hash', 'schema-hash',
    'answer_field_hashes', '{"q1":"q1-hash"}'::JSONB,
    'llm_job_id', 'e0000000-0000-0000-0000-000000000002',
    'schema_version_major', 1,
    'schema_version_minor', 0,
    'schema_version_patch', 0,
    'version_inferred_from', 'live_save'
  ));

  IF (SELECT count(*) FROM public.responses
      WHERE project_id = 'b0000000-0000-0000-0000-000000000001'
        AND document_id = 'c0000000-0000-0000-0000-000000000001'
        AND respondent_type = 'llm' AND is_latest) <> 1
     OR EXISTS (SELECT 1 FROM public.responses WHERE id = v_first_id AND is_latest)
     OR NOT EXISTS (SELECT 1 FROM public.responses WHERE id = v_second_id AND is_latest)
     OR (SELECT llm_response_id FROM public.auto_review_reconciliation_requests
         WHERE document_id = 'c0000000-0000-0000-0000-000000000001')
        IS DISTINCT FROM v_second_id THEN
    RAISE EXCEPTION 'LLM publication did not coalesce latest response/request';
  END IF;

  v_failure_recorded := public.record_auto_review_reconciliation_failure(
    'c0000000-0000-0000-0000-000000000001',
    v_second_id,
    'transient failure'
  );
  IF NOT v_failure_recorded OR NOT EXISTS (
    SELECT 1 FROM public.auto_review_reconciliation_requests
    WHERE document_id = 'c0000000-0000-0000-0000-000000000001'
      AND llm_response_id = v_second_id
      AND attempt_count = 1
      AND last_error = 'transient failure'
      AND next_attempt_at > pg_catalog.now()
  ) THEN
    RAISE EXCEPTION 'atomic failure recording did not apply retry backoff (recorded %, expected %): %',
      v_failure_recorded,
      v_second_id,
      (SELECT pg_catalog.row_to_json(request)
       FROM public.auto_review_reconciliation_requests AS request
       WHERE request.document_id = 'c0000000-0000-0000-0000-000000000001');
  END IF;

  SELECT id INTO STRICT v_current_before_failure
  FROM public.responses
  WHERE project_id = 'b0000000-0000-0000-0000-000000000001'
    AND document_id = 'c0000000-0000-0000-0000-000000000001'
    AND respondent_type = 'llm' AND is_latest;

  BEGIN
    PERFORM public.publish_latest_llm_response(pg_catalog.jsonb_build_object(
      'project_id', 'b0000000-0000-0000-0000-000000000001',
      'round_id', (SELECT current_round_id FROM public.projects WHERE id = 'b0000000-0000-0000-0000-000000000001'),
      'document_id', 'c0000000-0000-0000-0000-000000000001',
      'answers', '{"q1":"must-rollback"}'::JSONB,
      'is_partial', false,
      'llm_job_id', 'not-a-uuid'
    ));
    RAISE EXCEPTION 'invalid publication unexpectedly succeeded';
  EXCEPTION WHEN invalid_text_representation THEN
    NULL;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM public.responses
    WHERE id = v_current_before_failure AND is_latest
  ) OR (SELECT llm_response_id FROM public.auto_review_reconciliation_requests
        WHERE document_id = 'c0000000-0000-0000-0000-000000000001')
       IS DISTINCT FROM v_second_id THEN
    RAISE EXCEPTION 'failed publication did not roll back response and outbox';
  END IF;

  PERFORM public.publish_latest_llm_response(pg_catalog.jsonb_build_object(
    'project_id', 'b0000000-0000-0000-0000-000000000001',
    'round_id', (SELECT current_round_id FROM public.projects WHERE id = 'b0000000-0000-0000-0000-000000000001'),
    'document_id', 'c0000000-0000-0000-0000-000000000001',
    'respondent_name', 'test/model',
    'answers', '{"q1":null}'::JSONB,
    'is_partial', true,
    'llm_job_id', 'e0000000-0000-0000-0000-000000000003'
  ));

  IF EXISTS (
    SELECT 1 FROM public.responses
    WHERE project_id = 'b0000000-0000-0000-0000-000000000001'
      AND document_id = 'c0000000-0000-0000-0000-000000000001'
      AND respondent_type = 'llm' AND is_latest
  ) OR EXISTS (
    SELECT 1 FROM public.auto_review_reconciliation_requests
    WHERE document_id = 'c0000000-0000-0000-0000-000000000001'
  ) THEN
    RAISE EXCEPTION 'partial LLM publication became current or enqueued work';
  END IF;
END;
$$;

DO $$
DECLARE
  v_rejected BOOLEAN := false;
BEGIN
  BEGIN
    UPDATE public.responses
    SET is_partial = true
    WHERE id = 'd0000000-0000-0000-0000-000000000011';
  EXCEPTION WHEN check_violation THEN
    v_rejected := true;
  END;

  IF NOT v_rejected THEN
    RAISE EXCEPTION 'partial LLM response remained latest';
  END IF;
END;
$$;

DO $$
DECLARE
  v_fn TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.field_reviews'::REGCLASS
      AND conname = 'field_reviews_unique'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.response_equivalences'::REGCLASS
      AND conname = 'response_equivalences_project_id_document_id_field_name_res_key'
  ) THEN
    RAISE EXCEPTION 'legacy ON CONFLICT constraints were not preserved';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[
    'public.reconcile_auto_review_cycles(jsonb)',
    'public.publish_latest_llm_response(jsonb)',
    'public.auto_review_reconciliation_capability()',
    'public.record_auto_review_reconciliation_failure(uuid,uuid,text)',
    'public.enqueue_auto_review_reconciliation_for_project(uuid)',
    'public.assign_arbitration_cycles_if_eligible(uuid,uuid,uuid,uuid[])',
    'public.submit_auto_review_verdicts(uuid,uuid,uuid,jsonb)',
    'public.submit_final_review_verdicts(uuid,uuid,uuid,jsonb)'
  ] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'invalid service-only ACL for %', v_fn;
    END IF;
  END LOOP;

  IF has_table_privilege('anon', 'public.auto_review_reconciliation_requests', 'SELECT')
     OR has_table_privilege('authenticated', 'public.auto_review_reconciliation_requests', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.auto_review_reconciliation_requests', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'invalid reconciliation outbox ACL';
  END IF;

  v_fn := 'public.record_response_equivalences(jsonb)';
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'invalid equivalence RPC ACL';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[
    'public.remove_response_equivalence(uuid,uuid)'
  ] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'invalid authenticated RPC ACL for %', v_fn;
    END IF;
  END LOOP;
END;
$$;

ROLLBACK;
