-- Contrato das rodadas explicitas e do sorteio atomico.
-- Executar apos `npx supabase db reset` com psql -v ON_ERROR_STOP=1.
BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('70000000-0000-0000-0000-000000000001', 'round-creator@example.test');

DO $$
DECLARE v_project_id uuid;
BEGIN
  v_project_id := public.create_project_with_initial_round(
    'created atomically', NULL, '70000000-0000-0000-0000-000000000001', 'auto_review_llm');
  IF NOT EXISTS (
       SELECT 1 FROM public.project_members
       WHERE project_members.project_id = v_project_id
         AND user_id = '70000000-0000-0000-0000-000000000001'
         AND role = 'coordenador'
     ) OR NOT EXISTS (
       SELECT 1 FROM public.projects
       WHERE id = v_project_id AND current_round_id IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'FALHOU: criacao atomica nao criou coordenador/rodada';
  END IF;
  RAISE NOTICE 'OK: projeto, coordenador e rodada inicial criados atomicamente';
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

ROLLBACK;
