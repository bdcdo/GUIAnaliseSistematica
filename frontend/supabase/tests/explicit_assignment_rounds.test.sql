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
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'FALHOU:%' THEN RAISE; END IF;
  END;
  IF (SELECT count(*) FROM public.rounds WHERE project_id = '71000000-0000-0000-0000-000000000002') <> before_rounds
     OR (SELECT count(*) FROM public.assignment_batches WHERE project_id = '71000000-0000-0000-0000-000000000002') <> before_batches
     OR (SELECT current_round_id FROM public.projects WHERE id = '71000000-0000-0000-0000-000000000002') <> current_round THEN
    RAISE EXCEPTION 'FALHOU: sorteio vazio deixou rodada/lote/ativacao parcial';
  END IF;
  RAISE NOTICE 'OK: zero inserts faz rollback completo';
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

ROLLBACK;
