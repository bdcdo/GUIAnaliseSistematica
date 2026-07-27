-- Prova concorrente do contrato de que o save humano depende (issue #609).
--
-- Como rodar após `npx supabase db reset`:
--   npm run test:db:responses-human-concurrency
-- ou, à mão:
--   docker exec -i supabase_db_frontend psql -U postgres -d postgres \
--     -X -v ON_ERROR_STOP=1 < supabase/tests/responses_latest_human_concurrency.test.sql
--
-- Diferentemente dos testes transacionais comuns, as fixtures precisam estar
-- commitadas para duas conexões dblink enxergarem o mesmo estado. O arquivo usa
-- UUIDs reservados e remove tudo no fim do caminho feliz — sob ON_ERROR_STOP=1
-- um DO que falha aborta ANTES do cleanup, deixando as fixtures commitadas. O
-- que devolve o banco ao estado limpo nesse caso são os DELETE do topo, que
-- re-rodam sobre os mesmos UUIDs reservados na execução seguinte; as conexões
-- dblink morrem junto com a sessão psql. Por isso uma falha aqui não exige
-- limpeza manual, mas o resíduo sobrevive até a próxima execução.
--
-- O que aqui se prova NÃO é a unicidade — disso cuida
-- responses_one_latest_human.test.sql, em uma sessão só. Aqui se prova o
-- contrato do qual persistResponseRow depende quando duas gravações do mesmo
-- par disputam: que a segunda ESPERA a primeira e recebe um 23505 nomeado, e
-- não deadlock, serialization failure ou espera indefinida — é isso que
-- autoriza o app a tratar o conflito como "releia e repita" em vez de erro do
-- usuário. E que o retry então CONVERGE: o UPDATE pela chave lógica encontra a
-- linha da vencedora.
--
-- As conexões rodam como `postgres`. O alvo é o comportamento de bloqueio e do
-- índice, não RLS — esta última é coberta pelas policies exercitadas em
-- canonical_project_identity_rls.test.sql, e conceder DML permanente a
-- `authenticated` aqui sujaria o banco, já que não há transação para reverter.

CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;

DELETE FROM public.projects
WHERE id = '6b000000-0000-0000-0000-000000000001';
DELETE FROM auth.users
WHERE id IN (
  '6a000000-0000-0000-0000-000000000001',
  '6a000000-0000-0000-0000-000000000002'
);

INSERT INTO auth.users (id, email) VALUES
  ('6a000000-0000-0000-0000-000000000001', 'issue609-concurrency-ana@example.test'),
  ('6a000000-0000-0000-0000-000000000002', 'issue609-concurrency-bruno@example.test');

INSERT INTO public.clerk_user_mapping
  (clerk_user_id, supabase_user_id, access_sync_version)
VALUES
  ('issue609-concurrency-ana', '6a000000-0000-0000-0000-000000000001', 1),
  ('issue609-concurrency-bruno', '6a000000-0000-0000-0000-000000000002', 1);

INSERT INTO public.projects (id, name, created_by, pydantic_fields)
VALUES (
  '6b000000-0000-0000-0000-000000000001',
  'issue 609 concurrency',
  '6a000000-0000-0000-0000-000000000001',
  -- O campo carrega `id` UUID porque essa é a forma real de PydanticField
  -- (ver frontend/src/lib/pydantic-field.ts), não porque alguma constraint o
  -- exija: hoje projects.pydantic_fields não tem CHECK de shape em migration
  -- nenhuma. A versão anterior deste comentário afirmava o contrário, descrevendo
  -- uma CHECK que existia só no container local desta máquina, aplicada fora do
  -- controle de versão — as demais suítes de banco inserem `[{"name":"q1"}]` sem
  -- `id` e passam. Manter o `id` mesmo assim: custa nada e a fixture continua
  -- válida se um dia a constraint entrar de verdade.
  '[{"id":"6e000000-0000-0000-0000-000000000001","name":"q1"}]'
);

INSERT INTO public.documents (id, project_id, title, text, text_hash) VALUES
  ('6c000000-0000-0000-0000-000000000001',
   '6b000000-0000-0000-0000-000000000001', 'doc a', 'texto a', 'h-609-a');

INSERT INTO public.project_members (project_id, user_id, role) VALUES
  ('6b000000-0000-0000-0000-000000000001',
   '6a000000-0000-0000-0000-000000000001', 'pesquisador'),
  ('6b000000-0000-0000-0000-000000000001',
   '6a000000-0000-0000-0000-000000000002', 'pesquisador');

SELECT extensions.dblink_connect(
  'issue609_a',
  'host=host.docker.internal port=54322 dbname=postgres user=postgres password=postgres'
);
SELECT extensions.dblink_connect(
  'issue609_b',
  'host=host.docker.internal port=54322 dbname=postgres user=postgres password=postgres'
);

-- ========== 1. Duas gravações do MESMO par: a segunda espera e é recusada ===
--
-- A exceção acontece na sessão remota, e dblink_get_result a propagaria para
-- cá, abortando o teste em vez de o teste observá-la. O helper converte a
-- violação em dado — capturando `unique_violation` NOMEADAMENTE, para não
-- mascarar qualquer outra falha.
SELECT extensions.dblink_exec(
  'issue609_b',
  $$CREATE FUNCTION pg_temp.try_insert_latest_human() RETURNS TEXT
    LANGUAGE plpgsql AS $fn$
    BEGIN
      INSERT INTO public.responses
        (project_id, document_id, respondent_id, respondent_type,
         respondent_name, answers, is_latest, is_partial)
      VALUES
        ('6b000000-0000-0000-0000-000000000001',
         '6c000000-0000-0000-0000-000000000001',
         '6a000000-0000-0000-0000-000000000001', 'humano', 'Ana',
         '{"q1":"de B"}'::jsonb, true, false);
      RETURN 'unexpected-success';
    EXCEPTION WHEN unique_violation THEN
      RETURN pg_catalog.format('rejected:%s', SQLERRM);
    END;
    $fn$;$$
);

SELECT extensions.dblink_exec('issue609_a', 'BEGIN');
SELECT extensions.dblink_exec(
  'issue609_a',
  $$INSERT INTO public.responses
      (id, project_id, document_id, respondent_id, respondent_type,
       respondent_name, answers, is_latest, is_partial)
    VALUES
      ('6d000000-0000-0000-0000-000000000001',
       '6b000000-0000-0000-0000-000000000001',
       '6c000000-0000-0000-0000-000000000001',
       '6a000000-0000-0000-0000-000000000001', 'humano', 'Ana',
       '{"q1":"de A"}'::jsonb, true, false)$$
);

SELECT extensions.dblink_send_query(
  'issue609_b',
  $$SELECT pg_temp.try_insert_latest_human()$$
);
SELECT pg_catalog.pg_sleep(0.2);

DO $$
BEGIN
  IF extensions.dblink_is_busy('issue609_b') <> 1 THEN
    RAISE EXCEPTION
      'FALHOU: a segunda gravação do mesmo par não esperou a primeira';
  END IF;
  RAISE NOTICE 'OK 1a: a segunda gravação espera a primeira em vez de duplicar';
END;
$$;

SELECT extensions.dblink_exec('issue609_a', 'COMMIT');

-- O resultado só pode ser consumido uma vez; a temp table o materializa para
-- as asserções abaixo. O segundo get_result drena o retorno vazio que o
-- protocolo exige antes de a conexão voltar a ser usável.
CREATE TEMP TABLE issue609_insert_result AS
SELECT * FROM extensions.dblink_get_result('issue609_b') AS result(outcome TEXT);
SELECT * FROM extensions.dblink_get_result('issue609_b') AS result(outcome TEXT);

DO $$
DECLARE
  v_outcome TEXT;
  v_rows INTEGER;
BEGIN
  SELECT outcome INTO v_outcome FROM issue609_insert_result;

  IF v_outcome IS NULL OR v_outcome NOT LIKE 'rejected:%' THEN
    RAISE EXCEPTION
      'FALHOU: a gravação perdedora não foi recusada (resultado: %)',
      COALESCE(v_outcome, '<nulo>');
  END IF;

  -- O app distingue "perdi a corrida, releia" de qualquer outra violação de
  -- unicidade pelo NOME do índice na mensagem. Se ele sumir daqui, o
  -- `insErr.message.includes(...)` de persistResponseRow para de reconhecer o
  -- conflito e o conflito vira erro na cara do pesquisador.
  IF v_outcome NOT LIKE '%responses_one_latest_human_per_document%' THEN
    RAISE EXCEPTION
      'FALHOU: a recusa não nomeia o índice que o app procura (mensagem: %)',
      v_outcome;
  END IF;

  SELECT pg_catalog.count(*) INTO v_rows
  FROM public.responses
  WHERE document_id = '6c000000-0000-0000-0000-000000000001'
    AND respondent_id = '6a000000-0000-0000-0000-000000000001'
    AND respondent_type = 'humano'
    AND is_latest;

  IF v_rows <> 1 THEN
    RAISE EXCEPTION
      'FALHOU: sobraram % linhas correntes do mesmo par (esperado 1)', v_rows;
  END IF;

  RAISE NOTICE 'OK 1b: a perdedora recebe 23505 nomeado e sobra uma linha só';
END;
$$;

-- ========== 2. O retry converge: UPDATE pela chave lógica acha a vencedora ==
DO $$
DECLARE
  v_updated INTEGER;
BEGIN
  SELECT result.updated INTO v_updated
  FROM extensions.dblink(
    'issue609_b',
    $q$WITH changed AS (
        UPDATE public.responses
        SET answers = '{"q1":"do retry de B"}'::jsonb
        WHERE project_id = '6b000000-0000-0000-0000-000000000001'
          AND document_id = '6c000000-0000-0000-0000-000000000001'
          AND respondent_id = '6a000000-0000-0000-0000-000000000001'
          AND respondent_type = 'humano'
          AND is_latest = true
        RETURNING id
      )
      SELECT pg_catalog.count(*)::INTEGER FROM changed$q$
  ) AS result(updated INTEGER);

  IF v_updated <> 1 THEN
    RAISE EXCEPTION
      'FALHOU: o retry pela chave lógica afetou % linhas (esperado 1)',
      v_updated;
  END IF;
  RAISE NOTICE 'OK 2: o retry converge para a linha da vencedora';
END;
$$;

-- ========== 3. Respondentes distintos: espera sim, recusa não ==============
--
-- A dupla independente é o método do produto, então o que a restrição NÃO pode
-- fazer é recusar o segundo pesquisador no mesmo documento.
--
-- Ela também não é a razão da espera que se observa aqui: duas gravações
-- COMPLETAS (is_partial = false) no mesmo documento já serializavam antes
-- desta issue, porque `enqueue_auto_review_reconciliation` toma a linha de
-- `documents` com FOR UPDATE — o mutex de publicação que ele compartilha com
-- `publish_latest_llm_response`, para que um save humano observe uma geração
-- LLM inteira ou nenhuma. Medido: a segunda sessão espera em
-- `transactionid`/ShareLock, não no índice.
--
-- O que este cenário prova é o desfecho: ao ser liberada, a gravação do OUTRO
-- respondente SUCEDE. Trocar o índice por um que colidisse entre pessoas
-- distintas (esquecer `respondent_id` da chave, por exemplo) transformaria
-- esse sucesso em 23505.
SELECT extensions.dblink_exec(
  'issue609_b',
  $$CREATE FUNCTION pg_temp.try_insert_other_respondent() RETURNS TEXT
    LANGUAGE plpgsql AS $fn$
    BEGIN
      INSERT INTO public.responses
        (id, project_id, document_id, respondent_id, respondent_type,
         respondent_name, answers, is_latest, is_partial)
      VALUES
        ('6d000000-0000-0000-0000-000000000002',
         '6b000000-0000-0000-0000-000000000001',
         '6c000000-0000-0000-0000-000000000001',
         '6a000000-0000-0000-0000-000000000002', 'humano', 'Bruno',
         '{"q1":"do bruno"}'::jsonb, true, false);
      RETURN 'inserted';
    EXCEPTION WHEN unique_violation THEN
      RETURN pg_catalog.format('rejected:%s', SQLERRM);
    END;
    $fn$;$$
);

-- A segura o mutex do documento com uma gravação completa da própria Ana.
SELECT extensions.dblink_exec('issue609_a', 'BEGIN');
SELECT extensions.dblink_exec(
  'issue609_a',
  $$UPDATE public.responses
    SET answers = '{"q1":"ana de novo"}'::jsonb
    WHERE id = '6d000000-0000-0000-0000-000000000001'$$
);

SELECT extensions.dblink_send_query(
  'issue609_b',
  $$SELECT pg_temp.try_insert_other_respondent()$$
);
SELECT pg_catalog.pg_sleep(0.2);

-- Sem esta asserção o cenário degrada em silêncio: se a espera sumir, o INSERT
-- roda sem disputa e o 'inserted' abaixo continua verde, provando bem menos do
-- que o comentário acima afirma. A mensagem atribui a falha ao mutex, e não à
-- unicidade, para que um vermelho futuro não seja lido como regressão da #609.
DO $$
BEGIN
  IF extensions.dblink_is_busy('issue609_b') <> 1 THEN
    RAISE EXCEPTION
      'FALHOU: a gravação do OUTRO respondente não esperou. A espera vem do '
      'FOR UPDATE em documents de enqueue_auto_review_reconciliation, não da '
      'unicidade: se ele saiu, este cenário parou de exercer contenção.';
  END IF;
  RAISE NOTICE 'OK 3a: a gravação do outro respondente espera o mutex do documento';
END;
$$;

SELECT extensions.dblink_exec('issue609_a', 'COMMIT');

CREATE TEMP TABLE issue609_other_result AS
SELECT * FROM extensions.dblink_get_result('issue609_b') AS result(outcome TEXT);
SELECT * FROM extensions.dblink_get_result('issue609_b') AS result(outcome TEXT);

DO $$
DECLARE
  v_outcome TEXT;
BEGIN
  SELECT outcome INTO v_outcome FROM issue609_other_result;
  IF v_outcome IS DISTINCT FROM 'inserted' THEN
    RAISE EXCEPTION
      'FALHOU: gravação de OUTRO respondente no mesmo documento foi recusada (%)',
      COALESCE(v_outcome, '<nulo>');
  END IF;
  RAISE NOTICE 'OK 3: o segundo pesquisador do mesmo documento é aceito';
END;
$$;

DO $$
DECLARE
  v_rows INTEGER;
BEGIN
  SELECT pg_catalog.count(*) INTO v_rows
  FROM public.responses
  WHERE document_id = '6c000000-0000-0000-0000-000000000001'
    AND respondent_type = 'humano'
    AND is_latest;

  IF v_rows <> 2 THEN
    RAISE EXCEPTION
      'FALHOU: esperadas 2 correntes (uma por pesquisador), encontradas %',
      v_rows;
  END IF;
  RAISE NOTICE 'OK 3b: a dupla independente continua representável';
END;
$$;

-- ========== cleanup ========================================================
SELECT extensions.dblink_disconnect('issue609_a');
SELECT extensions.dblink_disconnect('issue609_b');

DELETE FROM public.projects
WHERE id = '6b000000-0000-0000-0000-000000000001';
DELETE FROM auth.users
WHERE id IN (
  '6a000000-0000-0000-0000-000000000001',
  '6a000000-0000-0000-0000-000000000002'
);
