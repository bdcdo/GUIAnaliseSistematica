-- Contrato de `llm_runs.round_id`, a coluna que o backend escreve desde o #642
-- e que nenhuma migration criava: toda run de LLM morria com PGRST204 em
-- `_persist_run_snapshot` antes do primeiro documento.
--
-- As assercoes (b) e (c) sao replay dos dois writes reais de
-- backend/services/llm_runner.py — o INSERT que nasce sem rodada e o UPDATE do
-- snapshot que a grava. Sem elas o arquivo seria so leitura de catalogo, e
-- catalogo nao reproduz o bug: o que quebrou em producao foi um UPDATE.
--
-- (c) e (c2) gravam uma rodada que NAO e a corrente de proposito. As duas
-- escritas de `fill_current_round_id` convergiam para o mesmo valor que a
-- trigger ja tinha carimbado em (b), e escrita que repete o valor existente nao
-- e observavel: em 2026-08-13 remover `round_id` do SET de (c) deixava a suite
-- verde. Uma rodada distinta e o unico valor que so o write sob teste produz.
--
-- Roda numa transacao e nao deixa fixture no banco local.

BEGIN;

-- (a) Catalogo. Vem primeiro para que a ausencia da coluna produza uma
-- mensagem legivel em vez do 42703 cru que os blocos seguintes levantariam.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.llm_runs'::regclass
      AND attribute.attname = 'round_id'
      AND attribute.atttypid = 'uuid'::regtype
      AND attribute.attnotnull
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'FALHOU: llm_runs.round_id nao existe como uuid NOT NULL';
  END IF;

  -- FK composta, nao `REFERENCES rounds(id)`: a simples aceitaria run de um
  -- projeto carimbada com rodada de outro.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.llm_runs'::regclass
      AND constraint_row.confrelid = 'public.rounds'::regclass
      AND constraint_row.contype = 'f'
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid)
        ILIKE '%FOREIGN KEY (project_id, round_id) REFERENCES rounds(project_id, id)%'
  ) THEN
    RAISE EXCEPTION 'FALHOU: llm_runs nao ancora (project_id, round_id) em rounds';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    JOIN pg_catalog.pg_proc AS proc ON proc.oid = trigger_row.tgfoid
    WHERE trigger_row.tgrelid = 'public.llm_runs'::regclass
      AND NOT trigger_row.tgisinternal
      AND proc.proname = 'fill_current_round_id'
  ) THEN
    RAISE EXCEPTION 'FALHOU: llm_runs nao preenche a rodada corrente no INSERT';
  END IF;

  RAISE NOTICE 'OK: catalogo tem round_id NOT NULL, FK composta e trigger';
END;
$$;

INSERT INTO auth.users (id, email) VALUES
  ('7c000000-0000-0000-0000-000000000001', 'llm-runs-round@example.test');

-- A trigger `projects_create_initial_round` cria a rodada de cada projeto.
INSERT INTO public.projects (id, name, created_by) VALUES
  ('7c100000-0000-0000-0000-000000000001', 'run com rodada corrente',
   '7c000000-0000-0000-0000-000000000001'),
  ('7c100000-0000-0000-0000-000000000002', 'projeto vizinho',
   '7c000000-0000-0000-0000-000000000001'),
  ('7c100000-0000-0000-0000-000000000003', 'projeto sem rodada',
   '7c000000-0000-0000-0000-000000000001');

-- (b) Replay de `_persist_run_insert`: o POST /api/llm/run cria a linha sem
-- `round_id` porque a rodada so e lida depois, ja dentro do background task.
-- Sem o preenchimento automatico o NOT NULL inverteria o bug — o INSERT
-- passaria a falhar e a run ficaria invisivel na aba Execucoes.
INSERT INTO public.llm_runs (job_id, project_id, filter_mode, status, phase, heartbeat_at)
VALUES (
  '7c200000-0000-0000-0000-000000000001',
  '7c100000-0000-0000-0000-000000000001',
  'all', 'running', 'loading', now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.llm_runs AS run
    JOIN public.projects AS project ON project.id = run.project_id
    WHERE run.job_id = '7c200000-0000-0000-0000-000000000001'
      AND run.round_id = project.current_round_id
  ) THEN
    RAISE EXCEPTION 'FALHOU: INSERT sem round_id nao herdou a rodada corrente';
  END IF;
  RAISE NOTICE 'OK: run nasce carimbada com a rodada corrente do projeto';
END;
$$;

-- Segunda rodada do mesmo projeto, sem promove-la a corrente. Ela existe para
-- que (c) tenha um valor que so o proprio UPDATE consiga produzir: enquanto o
-- snapshot gravava a rodada corrente, ele repetia o carimbo que a trigger de
-- (b) ja tinha posto, e remover `round_id` do SET deixava a suite verde —
-- medido em 2026-08-13, exatamente a mutacao correspondente ao write que
-- quebrou em producao.
INSERT INTO public.rounds (id, project_id, label) VALUES
  ('7c300000-0000-0000-0000-000000000001',
   '7c100000-0000-0000-0000-000000000001', 'Rodada 2');

-- (c) Replay de `_persist_run_snapshot` (llm_runner.py:216-227) — o write que
-- produzia o PGRST204 em producao. As demais colunas do payload acompanham
-- porque e o UPDATE inteiro que precisa passar, nao so a coluna nova.
--
-- A rodada gravada e deliberadamente diferente da corrente, e nao um capricho
-- do teste: o INSERT nasce no POST /api/llm/run e o snapshot roda depois, ja
-- no background task, relendo `current_round_id` (llm_runner.py:1216 e :1262).
-- Se o coordenador trocar a rodada nesse intervalo, a run migra — e o comentario
-- da migration chama isso de "o UPDATE do snapshot continua mandando na rodada
-- final". Nao ha guarda contra esse UPDATE: `enforce_current_response_round_write`
-- protege `responses`, nao `llm_runs`.
UPDATE public.llm_runs
SET llm_provider = 'google',
    llm_model = 'gemini-2.5-flash',
    document_count = 3,
    pydantic_code = 'class Resposta(BaseModel): pass',
    round_id = '7c300000-0000-0000-0000-000000000001'
WHERE job_id = '7c200000-0000-0000-0000-000000000001';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.llm_runs AS run
    JOIN public.projects AS project ON project.id = run.project_id
    WHERE run.job_id = '7c200000-0000-0000-0000-000000000001'
      AND run.round_id = '7c300000-0000-0000-0000-000000000001'
      -- O discriminante: e esta metade que morre se `round_id` sair do SET,
      -- porque a trigger de (b) deixou a run na rodada corrente.
      AND run.round_id IS DISTINCT FROM project.current_round_id
      AND run.llm_model = 'gemini-2.5-flash'
      AND run.document_count = 3
  ) THEN
    RAISE EXCEPTION 'FALHOU: snapshot da execucao nao gravou rodada e metadados';
  END IF;
  RAISE NOTICE 'OK: snapshot da execucao move a run para a rodada que gravou';
END;
$$;

-- (c2) A outra metade do contrato de `fill_current_round_id`: valor explicito
-- nunca e sobrescrito. Sem isso, uma trigger que carimbasse incondicionalmente
-- passaria em (b) e so quebraria em producao, no INSERT de um cliente
-- round-aware.
INSERT INTO public.llm_runs (job_id, project_id, round_id, status, phase)
VALUES (
  '7c200000-0000-0000-0000-000000000003',
  '7c100000-0000-0000-0000-000000000001',
  '7c300000-0000-0000-0000-000000000001',
  'running', 'loading'
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.llm_runs AS run
    JOIN public.projects AS project ON project.id = run.project_id
    WHERE run.job_id = '7c200000-0000-0000-0000-000000000003'
      AND run.round_id = '7c300000-0000-0000-0000-000000000001'
      AND run.round_id IS DISTINCT FROM project.current_round_id
  ) THEN
    RAISE EXCEPTION 'FALHOU: INSERT com rodada explicita foi sobrescrito pela trigger';
  END IF;
  RAISE NOTICE 'OK: rodada explicita no INSERT sobrevive a trigger';
END;
$$;

-- (d) O NOT NULL morde de fato, nao so no catalogo. A trigger cobre INSERT;
-- projeto sem rodada corrente e UPDATE para NULL continuam barrados.
UPDATE public.projects
SET current_round_id = NULL
WHERE id = '7c100000-0000-0000-0000-000000000003';

DO $$
BEGIN
  BEGIN
    INSERT INTO public.llm_runs (job_id, project_id, status, phase)
    VALUES (
      '7c200000-0000-0000-0000-000000000002',
      '7c100000-0000-0000-0000-000000000003',
      'running', 'loading'
    );
    RAISE EXCEPTION 'TESTE FALHOU: run de projeto sem rodada foi aceita';
  EXCEPTION
    WHEN not_null_violation THEN
      NULL;
  END;

  BEGIN
    UPDATE public.llm_runs
    SET round_id = NULL
    WHERE job_id = '7c200000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'TESTE FALHOU: run existente ficou sem rodada';
  EXCEPTION
    WHEN not_null_violation THEN
      NULL;
  END;

  RAISE NOTICE 'OK: run sem rodada e irrepresentavel no INSERT e no UPDATE';
END;
$$;

-- (e) A FK composta recusa rodada de outro projeto; e o cascade de `projects`
-- continua funcionando apesar de a FK ser NO ACTION — a checagem de integridade
-- roda no fim do statement, quando o cascade ja removeu a run.
DO $$
DECLARE
  v_foreign_round uuid;
BEGIN
  SELECT current_round_id INTO STRICT v_foreign_round
  FROM public.projects WHERE id = '7c100000-0000-0000-0000-000000000002';

  BEGIN
    UPDATE public.llm_runs
    SET round_id = v_foreign_round
    WHERE job_id = '7c200000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'TESTE FALHOU: run aceitou rodada de outro projeto';
  EXCEPTION
    WHEN foreign_key_violation THEN
      NULL;
  END;

  DELETE FROM public.projects
  WHERE id = '7c100000-0000-0000-0000-000000000001';

  IF EXISTS (
    SELECT 1 FROM public.llm_runs
    WHERE job_id = '7c200000-0000-0000-0000-000000000001'
  ) THEN
    RAISE EXCEPTION 'FALHOU: exclusao do projeto nao removeu a execucao';
  END IF;

  RAISE NOTICE 'OK: rodada e do proprio projeto e o cascade sobrevive a FK';
END;
$$;

ROLLBACK;
