-- Contrato das rodadas explicitas e do sorteio atomico.
-- Executar apos `npx supabase db reset` com psql -v ON_ERROR_STOP=1.
BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('70000000-0000-0000-0000-000000000001', 'round-creator@example.test'),
  ('70000000-0000-0000-0000-000000000002', 'round-victim@example.test');

INSERT INTO public.clerk_user_mapping
  (clerk_user_id, supabase_user_id, access_sync_version)
VALUES
  ('round-creator-clerk', '70000000-0000-0000-0000-000000000001', 1);

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"round-creator-clerk","supabase_uid":"70000000-0000-0000-0000-000000000001"}',
  true
);
CREATE TEMP TABLE created_project_result (project_id uuid NOT NULL);
GRANT INSERT ON created_project_result TO authenticated;
SET LOCAL ROLE authenticated;

INSERT INTO created_project_result
SELECT public.create_project_with_initial_round(
  'created atomically', NULL, 'auto_review_llm');

RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);

DO $$
DECLARE v_project_id uuid;
BEGIN
  SELECT project_id INTO STRICT v_project_id FROM created_project_result;
  IF NOT EXISTS (
       SELECT 1 FROM public.project_members
       WHERE project_members.project_id = v_project_id
         AND user_id = '70000000-0000-0000-0000-000000000001'
         AND role = 'coordenador'
     ) OR NOT EXISTS (
       SELECT 1 FROM public.projects
       WHERE id = v_project_id
         AND created_by = '70000000-0000-0000-0000-000000000001'
         AND current_round_id IS NOT NULL
     ) OR EXISTS (
       SELECT 1 FROM public.project_members
       WHERE project_members.project_id = v_project_id
         AND user_id = '70000000-0000-0000-0000-000000000002'
     ) THEN
    RAISE EXCEPTION 'FALHOU: criacao atomica aceitou identidade diferente do JWT';
  END IF;
  IF pg_catalog.to_regprocedure(
       'public.create_project_with_initial_round(text,text,uuid,text)'
     ) IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU: assinatura vulneravel com p_created_by continua exposta';
  END IF;
  RAISE NOTICE 'OK: projeto, coordenador e rodada inicial criados atomicamente';
END $$;

DO $$
DECLARE v_rejected boolean := false;
BEGIN
  BEGIN
    PERFORM public.create_project_with_initial_round(
      'sem identidade', NULL, 'auto_review_llm');
  EXCEPTION WHEN invalid_authorization_specification THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FALHOU: criacao sem identidade autenticada foi aceita';
  END IF;
  RAISE NOTICE 'OK: criacao sem identidade falha fechado';
END $$;

INSERT INTO public.projects (id, name) VALUES
  ('71000000-0000-0000-0000-000000000001', 'round test A'),
  ('71000000-0000-0000-0000-000000000002', 'round test B');

-- Os casos abaixo rodam como owner para isolar atomicidade das policies, mas a
-- troca de rodada tem gate proprio dentro de `start_project_round`
-- (20260804120000) — SECURITY DEFINER ignora RLS, entao a autorizacao e checada
-- em codigo e vale para qualquer role. Sem membership o ator do JWT nao seria
-- coordenador de projeto nenhum e todos os casos de rodada nova parariam no
-- gate. A fixture apenas passa a declarar o que o caminho de producao sempre
-- exigiu; a isolacao das policies continua valendo, porque o owner segue
-- ignorando a RLS.
INSERT INTO public.project_members (project_id, user_id, role) VALUES
  ('71000000-0000-0000-0000-000000000001',
   '70000000-0000-0000-0000-000000000001', 'coordenador'),
  ('71000000-0000-0000-0000-000000000002',
   '70000000-0000-0000-0000-000000000001', 'coordenador');

INSERT INTO public.documents (id, project_id, text) VALUES
  ('72000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000001', 'doc A'),
  ('72000000-0000-0000-0000-000000000002', '71000000-0000-0000-0000-000000000002', 'doc B');

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.rounds
  WHERE project_id IN ('71000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000002')
    AND label = 'Rodada inicial';
  IF n <> 2 THEN RAISE EXCEPTION 'FALHOU: projetos novos nao criaram rodada inicial'; END IF;

  BEGIN
    UPDATE public.projects
    SET current_round_id = (SELECT current_round_id FROM public.projects WHERE id = '71000000-0000-0000-0000-000000000002')
    WHERE id = '71000000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'FALHOU: current_round aceitou rodada de outro projeto';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  RAISE NOTICE 'OK: rodada inicial e identidade canonica de projeto';
END $$;

-- As RPCs de escrita derivam a autoria do JWT, inclusive quando o teste roda
-- como owner para isolar atomicidade das demais policies.
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"round-creator-clerk","supabase_uid":"70000000-0000-0000-0000-000000000001"}',
  true
);

DO $$
DECLARE old_round uuid; result jsonb; new_round uuid;
BEGIN
  SELECT current_round_id INTO old_round FROM public.projects
  WHERE id = '71000000-0000-0000-0000-000000000001';

  INSERT INTO public.assignments (project_id, round_id, document_id, type, status)
  VALUES ('71000000-0000-0000-0000-000000000001', old_round,
          '72000000-0000-0000-0000-000000000001', 'codificacao', 'em_andamento');

  BEGIN
    PERFORM public.apply_lottery_assignments(
      '71000000-0000-0000-0000-000000000001', 'codificacao', old_round,
      'Rodada 2', false, '{}'::jsonb,
      '[{"document_id":"72000000-0000-0000-0000-000000000001","user_id":null}]'::jsonb, false);
    RAISE EXCEPTION 'FALHOU: abriu rodada sem confirmar trabalho aberto';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'FALHOU:%' THEN RAISE; END IF;
  END;

  result := public.apply_lottery_assignments(
    '71000000-0000-0000-0000-000000000001', 'codificacao', old_round,
    'Rodada 2', true, '{"label":"Lote rodada 2","mode":"append","balancing":"round"}'::jsonb,
    '[{"document_id":"72000000-0000-0000-0000-000000000001","user_id":null}]'::jsonb, false);
  new_round := (result->>'round_id')::uuid;

  IF (result->>'inserted')::int <> 1 OR new_round = old_round THEN
    RAISE EXCEPTION 'FALHOU: retorno inesperado da nova rodada: %', result;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.assignments WHERE round_id = old_round AND status = 'em_andamento')
     OR NOT EXISTS (SELECT 1 FROM public.assignments WHERE round_id = new_round AND status = 'pendente') THEN
    RAISE EXCEPTION 'FALHOU: redistribuicao nao preservou historico/separou rodada nova';
  END IF;
  RAISE NOTICE 'OK: nova rodada redistribui sem ocupacao da rodada anterior';
END $$;

DO $$
DECLARE current_round uuid; before_rounds int; before_batches int;
BEGIN
  SELECT current_round_id INTO current_round FROM public.projects
  WHERE id = '71000000-0000-0000-0000-000000000002';
  SELECT count(*) INTO before_rounds FROM public.rounds WHERE project_id = '71000000-0000-0000-0000-000000000002';
  SELECT count(*) INTO before_batches FROM public.assignment_batches WHERE project_id = '71000000-0000-0000-0000-000000000002';
  BEGIN
    PERFORM public.apply_lottery_assignments(
      '71000000-0000-0000-0000-000000000002', 'codificacao', current_round,
      'Rodada vazia', true, '{}'::jsonb, '[]'::jsonb, false);
    RAISE EXCEPTION 'FALHOU: sorteio vazio deveria abortar';
  EXCEPTION WHEN invalid_parameter_value THEN
    IF SQLERRM LIKE 'FALHOU:%' THEN RAISE; END IF;
  END;
  IF (SELECT count(*) FROM public.rounds WHERE project_id = '71000000-0000-0000-0000-000000000002') <> before_rounds
     OR (SELECT count(*) FROM public.assignment_batches WHERE project_id = '71000000-0000-0000-0000-000000000002') <> before_batches
     OR (SELECT current_round_id FROM public.projects WHERE id = '71000000-0000-0000-0000-000000000002') <> current_round THEN
    RAISE EXCEPTION 'FALHOU: sorteio vazio deixou rodada/lote/ativacao parcial';
  END IF;
  RAISE NOTICE 'OK: zero inserts faz rollback completo';
END $$;

-- A mesma fonte canonica alimenta a pre-visualizacao e a validacao
-- transacional. O historico permanece consultavel por round_id, enquanto a
-- view do dialogo considera somente a rodada atual e documentos ativos.
INSERT INTO public.projects (id, name) VALUES
  ('71000000-0000-0000-0000-000000000003', 'scope work contract');
INSERT INTO public.project_members (project_id, user_id, role) VALUES
  ('71000000-0000-0000-0000-000000000003',
   '70000000-0000-0000-0000-000000000001', 'coordenador');

INSERT INTO public.documents
  (id, project_id, text, exclusion_pending_at, excluded_at)
VALUES
  ('72000000-0000-0000-0000-000000000003', '71000000-0000-0000-0000-000000000003', 'active doc', NULL, NULL),
  ('72000000-0000-0000-0000-000000000004', '71000000-0000-0000-0000-000000000003', 'pending scope doc', now(), NULL),
  ('72000000-0000-0000-0000-000000000005', '71000000-0000-0000-0000-000000000003', 'excluded doc', NULL, now());

-- Linhas da rodada inicial viram historia sem serem apagadas. A response
-- humana continua is_latest=true de proposito: so o filtro por round_id pode
-- impedi-la de contaminar lottery_doc_stats.
INSERT INTO public.responses (
  project_id, document_id, respondent_id, respondent_type, answers
) VALUES (
  '71000000-0000-0000-0000-000000000003',
  '72000000-0000-0000-0000-000000000003',
  '70000000-0000-0000-0000-000000000001',
  'humano',
  '{}'::jsonb
);
INSERT INTO public.assignments (project_id, document_id, type, status)
VALUES (
  '71000000-0000-0000-0000-000000000003',
  '72000000-0000-0000-0000-000000000003',
  'codificacao',
  'em_andamento'
);

INSERT INTO public.rounds (id, project_id, label)
VALUES (
  '73000000-0000-0000-0000-000000000003',
  '71000000-0000-0000-0000-000000000003',
  'Rodada atual'
);
UPDATE public.projects
SET current_round_id = '73000000-0000-0000-0000-000000000003',
    round_strategy = 'manual'
WHERE id = '71000000-0000-0000-0000-000000000003';

INSERT INTO public.responses (
  project_id, document_id, respondent_type, respondent_name, answers
) VALUES (
  '71000000-0000-0000-0000-000000000003',
  '72000000-0000-0000-0000-000000000003',
  'llm',
  'scope-contract/test',
  '{}'::jsonb
);
INSERT INTO public.assignments (project_id, document_id, type, status) VALUES
  ('71000000-0000-0000-0000-000000000003', '72000000-0000-0000-0000-000000000003', 'codificacao', 'em_andamento'),
  ('71000000-0000-0000-0000-000000000003', '72000000-0000-0000-0000-000000000004', 'arbitragem', 'pendente'),
  ('71000000-0000-0000-0000-000000000003', '72000000-0000-0000-0000-000000000005', 'comparacao', 'em_andamento'),
  ('71000000-0000-0000-0000-000000000003', '72000000-0000-0000-0000-000000000003', 'arbitragem', 'concluido');

DO $$
DECLARE
  v_initial_round uuid;
  v_active_count integer;
  v_pending_count integer;
  v_human_count integer;
  v_has_llm boolean;
  v_active_coding integer;
  v_active_comparison integer;
  v_has_assignment boolean;
  v_has_assignment_legacy boolean;
BEGIN
  SELECT round.id INTO STRICT v_initial_round
  FROM public.rounds AS round
  WHERE round.project_id = '71000000-0000-0000-0000-000000000003'
    AND round.id <> '73000000-0000-0000-0000-000000000003';

  SELECT
    COALESCE(sum(work.open_count) FILTER (WHERE work.scope_state = 'active'), 0),
    COALESCE(sum(work.open_count) FILTER (WHERE work.scope_state = 'pending_scope'), 0)
  INTO v_active_count, v_pending_count
  FROM public.lottery_round_work_counts AS work
  WHERE work.project_id = '71000000-0000-0000-0000-000000000003'
    AND work.round_id = '73000000-0000-0000-0000-000000000003';

  IF v_active_count <> 1 OR v_pending_count <> 1 THEN
    RAISE EXCEPTION
      'FALHOU: contagem canonica esperava active=1/pending_scope=1, recebeu %/%',
      v_active_count, v_pending_count;
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM public.lottery_round_work_counts
       WHERE project_id = '71000000-0000-0000-0000-000000000003'
         AND round_id = '73000000-0000-0000-0000-000000000003'
         AND assignment_type = 'arbitragem'
         AND scope_state = 'pending_scope'
         AND open_count = 1
     ) OR EXISTS (
       SELECT 1 FROM public.lottery_round_work_counts
       WHERE project_id = '71000000-0000-0000-0000-000000000003'
         AND round_id = '73000000-0000-0000-0000-000000000003'
         AND assignment_type = 'comparacao'
     ) THEN
    RAISE EXCEPTION 'FALHOU: tipos abertos ou documento excluido foram classificados incorretamente';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.lottery_round_work_counts
    WHERE project_id = '71000000-0000-0000-0000-000000000003'
      AND round_id = v_initial_round
      AND assignment_type = 'codificacao'
      AND scope_state = 'active'
      AND open_count = 1
  ) THEN
    RAISE EXCEPTION 'FALHOU: fonte canonica perdeu o historico por rodada';
  END IF;

  SELECT
    stats.human_coding_count,
    stats.has_llm_response,
    stats.active_codificacao,
    stats.active_comparacao,
    stats.has_assignment_in_current_round,
    stats.has_any_assignment_ever
  INTO
    v_human_count,
    v_has_llm,
    v_active_coding,
    v_active_comparison,
    v_has_assignment,
    v_has_assignment_legacy
  FROM public.lottery_doc_stats AS stats
  WHERE stats.id = '72000000-0000-0000-0000-000000000003';

  IF v_human_count <> 0 OR NOT v_has_llm OR v_active_coding <> 1
     OR v_active_comparison <> 0 OR NOT v_has_assignment THEN
    RAISE EXCEPTION 'FALHOU: lottery_doc_stats misturou rodadas: human=%, llm=%, coding=%, comparison=%, assigned=%',
      v_human_count, v_has_llm, v_active_coding, v_active_comparison, v_has_assignment;
  END IF;
  IF v_has_assignment_legacy IS DISTINCT FROM v_has_assignment THEN
    RAISE EXCEPTION
      'FALHOU: alias legado divergiu da ocupacao canonica: legado=%, canonico=%',
      v_has_assignment_legacy, v_has_assignment;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.lottery_doc_stats
    WHERE id IN (
      '72000000-0000-0000-0000-000000000004',
      '72000000-0000-0000-0000-000000000005'
    )
  ) THEN
    RAISE EXCEPTION 'FALHOU: lottery_doc_stats expos documento pendente ou excluido';
  END IF;
  RAISE NOTICE 'OK: estatisticas por rodada e alias legado usam o contrato canonico';
END $$;

DO $$
DECLARE
  v_round_id uuid := '73000000-0000-0000-0000-000000000003';
  v_before_rounds integer;
  v_before_batches integer;
  v_result jsonb;
  v_rejected boolean;
  v_batch_creator uuid;
BEGIN
  SELECT count(*) INTO v_before_rounds
  FROM public.rounds WHERE project_id = '71000000-0000-0000-0000-000000000003';
  SELECT count(*) INTO v_before_batches
  FROM public.assignment_batches WHERE project_id = '71000000-0000-0000-0000-000000000003';

  v_rejected := false;
  BEGIN
    PERFORM public.apply_lottery_assignments(
      '71000000-0000-0000-0000-000000000003', 'codificacao', v_round_id,
      'Rodada com snapshot obsoleto', false,
      '{"open_work_snapshot":{"active_count":2,"pending_scope_count":1,"confirm_active":true,"confirm_pending_scope":true}}'::jsonb,
      '[{"document_id":"72000000-0000-0000-0000-000000000003","user_id":null}]'::jsonb,
      false
    );
  EXCEPTION WHEN serialization_failure THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FALHOU: RPC aceitou snapshot de trabalho aberto obsoleto';
  END IF;

  v_rejected := false;
  BEGIN
    PERFORM public.apply_lottery_assignments(
      '71000000-0000-0000-0000-000000000003', 'codificacao', v_round_id,
      NULL, false, '{}'::jsonb,
      '[{"document_id":"72000000-0000-0000-0000-000000000005","user_id":null}]'::jsonb,
      false
    );
  EXCEPTION WHEN serialization_failure THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FALHOU: RPC criou fila para documento excluido';
  END IF;

  v_rejected := false;
  BEGIN
    PERFORM public.apply_lottery_assignments(
      '71000000-0000-0000-0000-000000000003', 'codificacao', v_round_id,
      'Rodada sem confirmar ativos', true,
      '{"open_work_snapshot":{"active_count":1,"pending_scope_count":1,"confirm_active":false,"confirm_pending_scope":true}}'::jsonb,
      '[{"document_id":"72000000-0000-0000-0000-000000000003","user_id":null}]'::jsonb,
      false
    );
  EXCEPTION WHEN raise_exception THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FALHOU: confirmacao unica sobrepos confirm_active=false';
  END IF;

  v_rejected := false;
  BEGIN
    PERFORM public.apply_lottery_assignments(
      '71000000-0000-0000-0000-000000000003', 'codificacao', v_round_id,
      'Rodada sem confirmar pendentes de escopo', true,
      '{"open_work_snapshot":{"active_count":1,"pending_scope_count":1,"confirm_active":true,"confirm_pending_scope":false}}'::jsonb,
      '[{"document_id":"72000000-0000-0000-0000-000000000003","user_id":null}]'::jsonb,
      false
    );
  EXCEPTION WHEN raise_exception THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FALHOU: confirmacao unica sobrepos confirm_pending_scope=false';
  END IF;

  IF (SELECT count(*) FROM public.rounds WHERE project_id = '71000000-0000-0000-0000-000000000003') <> v_before_rounds
     OR (SELECT count(*) FROM public.assignment_batches WHERE project_id = '71000000-0000-0000-0000-000000000003') <> v_before_batches THEN
    RAISE EXCEPTION 'FALHOU: validacao de snapshot/confirmacao deixou escrita parcial';
  END IF;

  v_result := public.apply_lottery_assignments(
    '71000000-0000-0000-0000-000000000003', 'codificacao', v_round_id,
    'Rodada confirmada', false,
    '{"created_by":"70000000-0000-0000-0000-000000000002","open_work_snapshot":{"active_count":1,"pending_scope_count":1,"confirm_active":true,"confirm_pending_scope":true}}'::jsonb,
    '[{"document_id":"72000000-0000-0000-0000-000000000003","user_id":null}]'::jsonb,
    false
  );

  SELECT batch.created_by INTO v_batch_creator
  FROM public.assignment_batches AS batch
  WHERE batch.id = (v_result->>'batch_id')::uuid;
  IF (v_result->>'inserted')::integer <> 1
     OR v_batch_creator IS DISTINCT FROM '70000000-0000-0000-0000-000000000001'::uuid THEN
    RAISE EXCEPTION 'FALHOU: resultado/autoria canonica inesperados: %, %', v_result, v_batch_creator;
  END IF;
  RAISE NOTICE 'OK: snapshot e confirmacoes sao revalidados; autoria vem do JWT';
END $$;

-- ON CONFLICT nao pode transformar uma proposta de duas atribuicoes num lote
-- parcial de uma. O erro 40001 reverte inclusive a linha que chegou a inserir.
INSERT INTO public.projects (id, name) VALUES
  ('71000000-0000-0000-0000-000000000004', 'partial insert rollback');
INSERT INTO public.documents (id, project_id, text) VALUES
  ('72000000-0000-0000-0000-000000000006', '71000000-0000-0000-0000-000000000004', 'conflicting doc');
INSERT INTO public.assignments (project_id, document_id, user_id, type, status)
VALUES (
  '71000000-0000-0000-0000-000000000004',
  '72000000-0000-0000-0000-000000000006',
  '70000000-0000-0000-0000-000000000001',
  'codificacao',
  'pendente'
);

DO $$
DECLARE
  v_round_id uuid;
  v_before_batches integer;
  v_rejected boolean := false;
BEGIN
  SELECT current_round_id INTO v_round_id
  FROM public.projects WHERE id = '71000000-0000-0000-0000-000000000004';
  SELECT count(*) INTO v_before_batches
  FROM public.assignment_batches WHERE project_id = '71000000-0000-0000-0000-000000000004';

  BEGIN
    PERFORM public.apply_lottery_assignments(
      '71000000-0000-0000-0000-000000000004', 'codificacao', v_round_id,
      NULL, false, '{}'::jsonb,
      '[{"document_id":"72000000-0000-0000-0000-000000000006","user_id":"70000000-0000-0000-0000-000000000001"},{"document_id":"72000000-0000-0000-0000-000000000006","user_id":"70000000-0000-0000-0000-000000000002"}]'::jsonb,
      false
    );
  EXCEPTION WHEN serialization_failure THEN
    v_rejected := true;
  END;

  IF NOT v_rejected
     OR (SELECT count(*) FROM public.assignments WHERE project_id = '71000000-0000-0000-0000-000000000004') <> 1
     OR (SELECT count(*) FROM public.assignment_batches WHERE project_id = '71000000-0000-0000-0000-000000000004') <> v_before_batches THEN
    RAISE EXCEPTION 'FALHOU: conflito parcial nao reverteu lote e assignments';
  END IF;
  RAISE NOTICE 'OK: insercao parcial falha com 40001 e rollback completo';
END $$;

DO $$
DECLARE round_a uuid; round_b uuid;
BEGIN
  SELECT current_round_id INTO round_a FROM public.projects WHERE id = '71000000-0000-0000-0000-000000000001';
  SELECT current_round_id INTO round_b FROM public.projects WHERE id = '71000000-0000-0000-0000-000000000002';
  BEGIN
    INSERT INTO public.assignments (project_id, round_id, document_id, type)
    VALUES ('71000000-0000-0000-0000-000000000001', round_b,
            '72000000-0000-0000-0000-000000000001', 'codificacao');
    RAISE EXCEPTION 'FALHOU: assignment aceitou rodada de outro projeto';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  INSERT INTO public.assignments (project_id, round_id, document_id, type)
  VALUES ('71000000-0000-0000-0000-000000000002', round_b,
          '72000000-0000-0000-0000-000000000002', 'comparacao');
  BEGIN
    INSERT INTO public.assignments (project_id, round_id, document_id, type)
    VALUES ('71000000-0000-0000-0000-000000000002', round_b,
            '72000000-0000-0000-0000-000000000002', 'comparacao');
    RAISE EXCEPTION 'FALHOU: duas comparacoes ativas na mesma rodada';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  RAISE NOTICE 'OK: FKs cross-project e comparacao ativa por rodada';
END $$;

-- Uma resposta humana ou LLM capturada na rodada anterior não pode tocar o
-- histórico depois da ativação, mesmo usando service_role/postgres.
DO $$
DECLARE
  v_old_round uuid;
  v_current_round uuid;
  v_current_llm uuid;
  v_rejected boolean := false;
BEGIN
  SELECT current_round_id INTO v_current_round
  FROM public.projects
  WHERE id = '71000000-0000-0000-0000-000000000001';

  SELECT id INTO v_old_round
  FROM public.rounds
  WHERE project_id = '71000000-0000-0000-0000-000000000001'
    AND id <> v_current_round;

  v_current_llm := public.publish_latest_llm_response(
    pg_catalog.jsonb_build_object(
      'project_id', '71000000-0000-0000-0000-000000000001',
      'document_id', '72000000-0000-0000-0000-000000000001',
      'round_id', v_current_round,
      'respondent_name', 'test/current',
      'answers', '{"q1":"current"}'::jsonb,
      'is_partial', false
    )
  );

  v_rejected := false;
  BEGIN
    PERFORM public.publish_latest_llm_response(
      pg_catalog.jsonb_build_object(
        'project_id', '71000000-0000-0000-0000-000000000001',
        'document_id', '72000000-0000-0000-0000-000000000001',
        'answers', '{}'::jsonb,
        'is_partial', false
      )
    );
  EXCEPTION WHEN invalid_parameter_value THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FALHOU: publicacao LLM sem round_id foi aceita';
  END IF;

  v_rejected := false;
  BEGIN
    PERFORM public.publish_latest_llm_response(
      pg_catalog.jsonb_build_object(
        'project_id', '71000000-0000-0000-0000-000000000001',
        'document_id', '72000000-0000-0000-0000-000000000001',
        'round_id', v_old_round,
        'respondent_name', 'test/stale',
        'answers', '{"q1":"stale"}'::jsonb,
        'is_partial', false
      )
    );
  EXCEPTION WHEN serialization_failure THEN
    v_rejected := true;
  END;

  IF NOT v_rejected
     OR NOT EXISTS (
       SELECT 1 FROM public.responses
       WHERE id = v_current_llm AND is_latest
     )
     OR EXISTS (
       SELECT 1 FROM public.responses
       WHERE project_id = '71000000-0000-0000-0000-000000000001'
         AND round_id = v_old_round
         AND respondent_type = 'llm'
         AND answers = '{"q1":"stale"}'::jsonb
     ) THEN
    RAISE EXCEPTION 'FALHOU: publicacao LLM antiga alterou a rodada atual';
  END IF;

  v_rejected := false;
  BEGIN
    INSERT INTO public.responses (
      project_id, document_id, respondent_type, answers, is_latest,
      is_partial, round_id
    ) VALUES (
      '71000000-0000-0000-0000-000000000001',
      '72000000-0000-0000-0000-000000000001',
      'humano', '{}'::jsonb, true, true, v_old_round
    );
  EXCEPTION WHEN serialization_failure THEN
    v_rejected := true;
  END;

  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FALHOU: response humana entrou em rodada historica';
  END IF;
  RAISE NOTICE 'OK: responses humanas e LLM antigas falham sem alterar latest';
END $$;

-- A assinatura nova tambem precisa funcionar com o mesmo role usado pelo
-- PostgREST. Rodar apenas como owner provaria atomicidade, mas nao a composicao
-- real de SECURITY INVOKER com RLS e autoria derivada do JWT.
INSERT INTO public.projects (id, name) VALUES
  ('71000000-0000-0000-0000-000000000005', 'authenticated lottery');
INSERT INTO public.project_members (project_id, user_id, role) VALUES (
  '71000000-0000-0000-0000-000000000005',
  '70000000-0000-0000-0000-000000000001',
  'coordenador'
);
INSERT INTO public.documents (id, project_id, text) VALUES (
  '72000000-0000-0000-0000-000000000007',
  '71000000-0000-0000-0000-000000000005',
  'authenticated doc'
);
CREATE TEMP TABLE authenticated_lottery_result (result jsonb NOT NULL);
GRANT INSERT ON authenticated_lottery_result TO authenticated;
-- O Supabase local nao reproduz os default privileges CRUD do remoto (limite
-- ja documentado em rls_audit.test.sql). Conceder apenas o necessario dentro
-- desta transacao permite testar as policies e o SECURITY INVOKER reais.
GRANT SELECT, UPDATE ON public.projects TO authenticated;
GRANT SELECT, UPDATE ON public.documents TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assignment_batches TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assignments TO authenticated;

SET LOCAL ROLE authenticated;
INSERT INTO authenticated_lottery_result
SELECT public.apply_lottery_assignments(
  '71000000-0000-0000-0000-000000000005',
  'codificacao',
  (
    SELECT current_round_id
    FROM public.projects
    WHERE id = '71000000-0000-0000-0000-000000000005'
  ),
  NULL,
  false,
  '{"open_work_snapshot":{"active_count":0,"pending_scope_count":0,"confirm_active":false,"confirm_pending_scope":false}}'::jsonb,
  '[{"document_id":"72000000-0000-0000-0000-000000000007","user_id":"70000000-0000-0000-0000-000000000001"}]'::jsonb,
  false
);
RESET ROLE;

DO $$
DECLARE v_result jsonb;
BEGIN
  SELECT result INTO STRICT v_result FROM authenticated_lottery_result;
  IF (v_result->>'inserted')::integer <> 1
     OR NOT EXISTS (
       SELECT 1
       FROM public.assignment_batches AS batch
       WHERE batch.id = (v_result->>'batch_id')::uuid
         AND batch.created_by = '70000000-0000-0000-0000-000000000001'
     ) THEN
    RAISE EXCEPTION 'FALHOU: RPC autenticada nao gravou lote/autoria esperados: %', v_result;
  END IF;
  RAISE NOTICE 'OK: RPC nova executa como authenticated sob RLS';
END $$;

-- Troca de rodada como authenticated. O caso acima roda com
-- `p_new_round_label` NULL e so exercita a rodada corrente; o ramo de rodada
-- nova escreve em `rounds` e `responses`, cujas policies nunca foram
-- atravessadas por nenhum caso deste arquivo (os demais rodam como owner, que
-- ignora RLS). Foi por essa fresta que o 42501 do #642/#645 chegou a producao.
--
-- O elemento discriminante e a resposta DE TERCEIRO e a DE LLM: o WITH CHECK de
-- "Users manage own responses" exige `respondent_type = 'humano'` e autoria do
-- chamador, entao um caso com apenas a resposta do proprio coordenador passaria
-- mesmo sem o conserto e nao provaria nada.
INSERT INTO public.projects (id, name) VALUES
  ('71000000-0000-0000-0000-000000000006', 'authenticated round switch');
INSERT INTO public.project_members (project_id, user_id, role) VALUES
  ('71000000-0000-0000-0000-000000000006',
   '70000000-0000-0000-0000-000000000001', 'coordenador'),
  ('71000000-0000-0000-0000-000000000006',
   '70000000-0000-0000-0000-000000000002', 'pesquisador');
INSERT INTO public.documents (id, project_id, text) VALUES (
  '72000000-0000-0000-0000-000000000008',
  '71000000-0000-0000-0000-000000000006',
  'round switch doc'
);
INSERT INTO public.responses (
  project_id, document_id, respondent_id, respondent_type, answers, is_latest,
  is_partial, round_id
)
SELECT
  '71000000-0000-0000-0000-000000000006',
  '72000000-0000-0000-0000-000000000008',
  respondent.id,
  respondent.kind,
  '{"q1":"a"}'::jsonb,
  true,
  false,
  project.current_round_id
FROM public.projects AS project
CROSS JOIN (VALUES
  ('70000000-0000-0000-0000-000000000001'::uuid, 'humano'),
  ('70000000-0000-0000-0000-000000000002'::uuid, 'humano'),
  (NULL::uuid, 'llm')
) AS respondent(id, kind)
WHERE project.id = '71000000-0000-0000-0000-000000000006';

CREATE TEMP TABLE authenticated_round_result (result jsonb NOT NULL);
GRANT INSERT ON authenticated_round_result TO authenticated;
-- Em producao `authenticated` tem os default privileges CRUD sobre as duas
-- tabelas e so a RLS decide. Sem estes GRANTs o teste local falharia por
-- privilegio de tabela ausente e nunca chegaria a avaliar a policy.
GRANT SELECT, INSERT ON public.rounds TO authenticated;
GRANT SELECT, UPDATE ON public.responses TO authenticated;

SET LOCAL ROLE authenticated;
INSERT INTO authenticated_round_result
SELECT public.apply_lottery_assignments(
  '71000000-0000-0000-0000-000000000006',
  'codificacao',
  (
    SELECT current_round_id
    FROM public.projects
    WHERE id = '71000000-0000-0000-0000-000000000006'
  ),
  'Rodada 2',
  false,
  '{"open_work_snapshot":{"active_count":0,"pending_scope_count":0,"confirm_active":true,"confirm_pending_scope":true}}'::jsonb,
  '[{"document_id":"72000000-0000-0000-0000-000000000008","user_id":"70000000-0000-0000-0000-000000000001"}]'::jsonb,
  false
);
RESET ROLE;

DO $$
DECLARE
  v_result jsonb;
  v_new_round uuid;
  v_stale integer;
BEGIN
  SELECT result INTO STRICT v_result FROM authenticated_round_result;
  v_new_round := (v_result->>'round_id')::uuid;

  IF NOT EXISTS (
    SELECT 1 FROM public.rounds
    WHERE id = v_new_round
      AND project_id = '71000000-0000-0000-0000-000000000006'
      AND label = 'Rodada 2'
  ) THEN
    RAISE EXCEPTION 'FALHOU: rodada nova nao foi criada: %', v_result;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.projects
    WHERE id = '71000000-0000-0000-0000-000000000006'
      AND current_round_id = v_new_round
  ) THEN
    RAISE EXCEPTION 'FALHOU: rodada nova nao foi ativada no projeto';
  END IF;

  -- O coracao do #642: arquivar a rodada anterior. Antes do conserto esta
  -- contagem nunca chegava a ser feita — a RPC abortava com 42501.
  SELECT count(*) INTO v_stale
  FROM public.responses
  WHERE project_id = '71000000-0000-0000-0000-000000000006'
    AND round_id <> v_new_round
    AND is_latest;
  IF v_stale <> 0 THEN
    RAISE EXCEPTION
      'FALHOU: % responses da rodada anterior seguem is_latest', v_stale;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.assignments
    WHERE project_id = '71000000-0000-0000-0000-000000000006'
      AND round_id = v_new_round
      AND document_id = '72000000-0000-0000-0000-000000000008'
  ) THEN
    RAISE EXCEPTION 'FALHOU: atribuicao nao caiu na rodada nova';
  END IF;

  RAISE NOTICE 'OK: coordenador troca de rodada arquivando responses alheias e de LLM';
END $$;

-- O gate de `start_project_round` nao pode depender da RLS das tabelas que ela
-- escreve: SECURITY DEFINER as ignora. Um membro nao-coordenador do projeto
-- (portanto capaz de enxerga-lo) deve receber 42501 da propria funcao. O
-- mapping abaixo e o que faz a negativa vir do PAPEL: sem ele `clerk_uid()`
-- seria NULL e o teste passaria por identidade ausente, discriminando outra
-- coisa.
INSERT INTO public.clerk_user_mapping
  (clerk_user_id, supabase_user_id, access_sync_version)
VALUES
  ('round-researcher-clerk', '70000000-0000-0000-0000-000000000002', 1);

DO $$
DECLARE v_denied boolean := false;
BEGIN
  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    '{"sub":"round-researcher-clerk","supabase_uid":"70000000-0000-0000-0000-000000000002"}',
    true
  );
  BEGIN
    PERFORM public.start_project_round(
      '71000000-0000-0000-0000-000000000006',
      (SELECT current_round_id FROM public.projects
       WHERE id = '71000000-0000-0000-0000-000000000006'),
      'Rodada 3', NULL, NULL, true, true
    );
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := true;
  END;
  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    '{"sub":"round-creator-clerk","supabase_uid":"70000000-0000-0000-0000-000000000001"}',
    true
  );
  IF NOT v_denied THEN
    RAISE EXCEPTION 'FALHOU: pesquisador iniciou rodada por chamada direta';
  END IF;
  RAISE NOTICE 'OK: start_project_round nega pesquisador com gate proprio';
END $$;

ROLLBACK;
