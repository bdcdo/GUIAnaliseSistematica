-- Contrato do trigger enforce_current_response_round_write apos a migration
-- 20260820170000.
--
-- O bug que este teste fixa: como o trigger ja trata round_id como imutavel em
-- UPDATE, a comparacao com projects.current_round_id passava a confrontar a
-- rodada DA PROPRIA LINHA. Toda linha de rodada encerrada falhava em qualquer
-- UPDATE, inclusive manutencao de is_latest — e o estado era irreparavel, pois
-- consertar exigia justamente o UPDATE recusado. Em producao (2026-08-20) isso
-- rendeu 101.580 erros em 20 minutos e 2 vCPU saturados por retry que nunca
-- convergia.
--
-- Como rodar (apos `npx supabase start` e `npx supabase db reset`):
--   bash scripts/run-sql-test.sh supabase/tests/round_write_maintenance.test.sql
--
-- Validar pelo exit code, nao por contar OKs na saida.
-- Roda inteiro em BEGIN ... ROLLBACK; nao deixa fixtures no banco local.

BEGIN;

INSERT INTO auth.users (id, email) VALUES
  ('7a000000-0000-0000-0000-000000000001', 'round-maintenance@example.test');

INSERT INTO public.clerk_user_mapping
  (clerk_user_id, supabase_user_id, access_sync_version)
VALUES
  ('7a000000-0000-0000-0000-000000000001',
   '7a000000-0000-0000-0000-000000000001', 1);

INSERT INTO public.projects (id, name, created_by, pydantic_fields) VALUES
  ('7a100000-0000-0000-0000-000000000001', 'round maintenance',
   '7a000000-0000-0000-0000-000000000001', '[{"name":"q1"}]');

INSERT INTO public.documents (id, project_id, title, text, text_hash) VALUES
  ('7a200000-0000-0000-0000-000000000001',
   '7a100000-0000-0000-0000-000000000001', 'doc', 'texto',
   'round-maintenance-doc');

INSERT INTO public.rounds (id, project_id, label) VALUES
  ('7a300000-0000-0000-0000-000000000001',
   '7a100000-0000-0000-0000-000000000001', 'Rodada antiga'),
  ('7a300000-0000-0000-0000-000000000002',
   '7a100000-0000-0000-0000-000000000001', 'Rodada corrente');

-- A resposta nasce na rodada antiga, enquanto ela ainda e a corrente.
UPDATE public.projects
SET current_round_id = '7a300000-0000-0000-0000-000000000001'
WHERE id = '7a100000-0000-0000-0000-000000000001';

INSERT INTO public.responses
  (id, project_id, document_id, respondent_id, respondent_type,
   answers, is_latest, round_id)
VALUES
  ('7a400000-0000-0000-0000-000000000001',
   '7a100000-0000-0000-0000-000000000001',
   '7a200000-0000-0000-0000-000000000001',
   '7a000000-0000-0000-0000-000000000001', 'humano',
   '{"q1":"antiga"}'::jsonb, true,
   '7a300000-0000-0000-0000-000000000001');

-- A rodada vira. A linha acima passa a ser historico.
UPDATE public.projects
SET current_round_id = '7a300000-0000-0000-0000-000000000002'
WHERE id = '7a100000-0000-0000-0000-000000000001';

-- ========== 1. Manutencao em linha historica PASSA (o bug) ==========
DO $$
BEGIN
  UPDATE public.responses
  SET is_latest = false
  WHERE id = '7a400000-0000-0000-0000-000000000001';

  IF (SELECT is_latest FROM public.responses
      WHERE id = '7a400000-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION 'FALHOU: is_latest nao foi arquivado';
  END IF;
  RAISE NOTICE 'OK: arquivar is_latest em rodada encerrada e permitido';
EXCEPTION
  WHEN SQLSTATE 'P0R01' THEN
    RAISE EXCEPTION
      'FALHOU: manutencao de is_latest ainda bloqueada em rodada encerrada';
END;
$$;

-- ========== 2. Conteudo em linha historica CONTINUA bloqueado ==========
DO $$
DECLARE
  v_state text;
BEGIN
  BEGIN
    UPDATE public.responses
    SET answers = '{"q1":"editada-fora-de-rodada"}'::jsonb
    WHERE id = '7a400000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'FALHOU: editar conteudo de rodada encerrada foi aceito';
  EXCEPTION
    WHEN SQLSTATE 'P0R01' THEN
      RAISE NOTICE 'OK: conteudo em rodada encerrada continua recusado';
    WHEN SQLSTATE '40001' THEN
      RAISE EXCEPTION
        'FALHOU: recusa voltou a usar 40001, que faz o cliente retentar';
  END;
END;
$$;

-- ========== 3. round_id segue imutavel ==========
DO $$
BEGIN
  BEGIN
    UPDATE public.responses
    SET round_id = '7a300000-0000-0000-0000-000000000002'
    WHERE id = '7a400000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'FALHOU: round_id deixou de ser imutavel';
  EXCEPTION
    WHEN SQLSTATE '23514' THEN
      RAISE NOTICE 'OK: round_id continua imutavel';
  END;
END;
$$;

-- ========== 4. INSERT em rodada encerrada recusado, e nao com 40001 ==========
DO $$
BEGIN
  BEGIN
    INSERT INTO public.responses
      (project_id, document_id, respondent_id, respondent_type,
       answers, is_latest, round_id)
    VALUES
      ('7a100000-0000-0000-0000-000000000001',
       '7a200000-0000-0000-0000-000000000001',
       '7a000000-0000-0000-0000-000000000001', 'humano',
       '{"q1":"nova"}'::jsonb, true,
       '7a300000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'FALHOU: resposta nova entrou em rodada encerrada';
  EXCEPTION
    WHEN SQLSTATE 'P0R01' THEN
      RAISE NOTICE 'OK: INSERT em rodada encerrada recusado com codigo terminal';
    WHEN SQLSTATE '40001' THEN
      RAISE EXCEPTION
        'FALHOU: INSERT recusado com 40001 — o cliente vai retentar sem fim';
  END;
END;
$$;

ROLLBACK;
