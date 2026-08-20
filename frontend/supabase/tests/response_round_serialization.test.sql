-- Prova concorrente da barreira entre escrita de responses e ativacao de rodada.
-- As fixtures ficam commitadas para que as duas conexoes dblink as enxerguem;
-- UUIDs reservados e o cleanup do topo tornam reexecucoes seguras apos falha.

CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;

DELETE FROM public.projects
WHERE id = '69000000-0000-0000-0000-000000000001';
DELETE FROM auth.users
WHERE id = '69000000-0000-0000-0000-000000000002';

INSERT INTO auth.users (id, email) VALUES
  ('69000000-0000-0000-0000-000000000002', 'round-serialization@example.test');

INSERT INTO public.projects (id, name, created_by) VALUES
  ('69000000-0000-0000-0000-000000000001', 'round serialization',
   '69000000-0000-0000-0000-000000000002');

INSERT INTO public.documents (id, project_id, title, text, text_hash) VALUES
  ('69000000-0000-0000-0000-000000000003',
   '69000000-0000-0000-0000-000000000001', 'doc', 'texto',
   'round-serialization-doc');

INSERT INTO public.rounds (id, project_id, label) VALUES
  ('69000000-0000-0000-0000-000000000004',
   '69000000-0000-0000-0000-000000000001', 'Rodada seguinte'),
  ('69000000-0000-0000-0000-000000000005',
   '69000000-0000-0000-0000-000000000001', 'Rodada final');

SELECT extensions.dblink_connect(
  'round_writer',
  'host=host.docker.internal port=54322 dbname=postgres user=postgres password=postgres'
);
SELECT extensions.dblink_connect(
  'round_switcher',
  'host=host.docker.internal port=54322 dbname=postgres user=postgres password=postgres'
);

-- O helper converte somente a rejeicao esperada em dado observavel. Qualquer
-- outra excecao continua derrubando a suite.
SELECT extensions.dblink_exec(
  'round_writer',
  $$CREATE FUNCTION pg_temp.try_stale_response() RETURNS text
    LANGUAGE plpgsql AS $fn$
    DECLARE v_old_round uuid;
    BEGIN
      SELECT id INTO STRICT v_old_round
      FROM public.rounds
      WHERE project_id = '69000000-0000-0000-0000-000000000001'
        AND label = 'Rodada inicial';

      INSERT INTO public.responses (
        project_id, document_id, respondent_id, respondent_type,
        respondent_name, answers, is_latest, is_partial, round_id
      ) VALUES (
        '69000000-0000-0000-0000-000000000001',
        '69000000-0000-0000-0000-000000000003',
        '69000000-0000-0000-0000-000000000002', 'humano', 'Writer',
        '{"q1":"stale"}'::jsonb, true, true, v_old_round
      );
      RETURN 'unexpected-success';
    -- P0R01: recusa terminal, nao conflito transitorio (20260820170000).
    EXCEPTION WHEN SQLSTATE 'P0R01' THEN
      RETURN 'rejected-stale-round';
    END;
    $fn$;$$
);

-- 1. A troca ganha o lock: o save espera e, depois do commit, falha fechado.
SELECT extensions.dblink_exec('round_switcher', 'BEGIN');
SELECT extensions.dblink_exec(
  'round_switcher',
  $$UPDATE public.projects
    SET current_round_id = '69000000-0000-0000-0000-000000000004'
    WHERE id = '69000000-0000-0000-0000-000000000001'$$
);
SELECT extensions.dblink_send_query(
  'round_writer',
  'SELECT pg_temp.try_stale_response()'
);
SELECT pg_catalog.pg_sleep(0.2);

DO $$
BEGIN
  IF extensions.dblink_is_busy('round_writer') <> 1 THEN
    RAISE EXCEPTION 'FALHOU: save antigo nao esperou o lock da troca de rodada';
  END IF;
END;
$$;

SELECT extensions.dblink_exec('round_switcher', 'COMMIT');
CREATE TEMP TABLE stale_save_result AS
SELECT * FROM extensions.dblink_get_result('round_writer') AS result(outcome text);
SELECT * FROM extensions.dblink_get_result('round_writer') AS result(outcome text);

DO $$
BEGIN
  IF (SELECT outcome FROM stale_save_result) IS DISTINCT FROM 'rejected-stale-round'
     OR EXISTS (
       SELECT 1 FROM public.responses
       WHERE project_id = '69000000-0000-0000-0000-000000000001'
     ) THEN
    RAISE EXCEPTION 'FALHOU: save antigo gravou depois da troca de rodada';
  END IF;
END;
$$;

-- 2. O save ganha o lock: a ativacao espera e so avanca depois do commit.
UPDATE public.projects
SET current_round_id = (
  SELECT id FROM public.rounds
  WHERE project_id = '69000000-0000-0000-0000-000000000001'
    AND label = 'Rodada inicial'
)
WHERE id = '69000000-0000-0000-0000-000000000001';

SELECT extensions.dblink_exec('round_writer', 'BEGIN');
SELECT extensions.dblink_exec(
  'round_writer',
  $$INSERT INTO public.responses (
      project_id, document_id, respondent_id, respondent_type,
      respondent_name, answers, is_latest, is_partial, round_id
    )
    SELECT '69000000-0000-0000-0000-000000000001',
           '69000000-0000-0000-0000-000000000003',
           '69000000-0000-0000-0000-000000000002', 'humano', 'Writer',
           '{"q1":"before-switch"}'::jsonb, true, true, project.current_round_id
    FROM public.projects AS project
    WHERE project.id = '69000000-0000-0000-0000-000000000001'$$
);
SELECT extensions.dblink_send_query(
  'round_switcher',
  $$UPDATE public.projects
    SET current_round_id = '69000000-0000-0000-0000-000000000005'
    WHERE id = '69000000-0000-0000-0000-000000000001'
    RETURNING 'activated'::text$$
);
SELECT pg_catalog.pg_sleep(0.2);

DO $$
BEGIN
  IF extensions.dblink_is_busy('round_switcher') <> 1 THEN
    RAISE EXCEPTION 'FALHOU: ativacao nao esperou o save ja iniciado';
  END IF;
END;
$$;

SELECT extensions.dblink_exec('round_writer', 'COMMIT');
CREATE TEMP TABLE activation_result AS
SELECT * FROM extensions.dblink_get_result('round_switcher') AS result(outcome text);
SELECT * FROM extensions.dblink_get_result('round_switcher') AS result(outcome text);

DO $$
BEGIN
  IF (SELECT outcome FROM activation_result) IS DISTINCT FROM 'activated'
     OR NOT EXISTS (
       SELECT 1 FROM public.responses
       WHERE project_id = '69000000-0000-0000-0000-000000000001'
         AND answers = '{"q1":"before-switch"}'::jsonb
     )
     OR (SELECT current_round_id FROM public.projects
         WHERE id = '69000000-0000-0000-0000-000000000001')
        IS DISTINCT FROM '69000000-0000-0000-0000-000000000005'::uuid THEN
    RAISE EXCEPTION 'FALHOU: save e ativacao nao produziram ordem linear';
  END IF;
  RAISE NOTICE 'OK: save e troca de rodada serializam nas duas ordens';
END;
$$;

SELECT extensions.dblink_disconnect('round_writer');
SELECT extensions.dblink_disconnect('round_switcher');

DELETE FROM public.projects
WHERE id = '69000000-0000-0000-0000-000000000001';
DELETE FROM auth.users
WHERE id = '69000000-0000-0000-0000-000000000002';
