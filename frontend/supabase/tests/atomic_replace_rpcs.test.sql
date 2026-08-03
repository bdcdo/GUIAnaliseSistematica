-- Verificação de atomicidade das RPCs transacionais (issues #181 e #284).
--
-- Como rodar (após `npx supabase start` e `npx supabase db reset`):
--   psql "$(npx supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '\"')" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/atomic_replace_rpcs.test.sql
-- Sucesso = nenhuma exceção e os NOTICE "OK ..." no final. Qualquer FALHOU aborta.
--
-- Roda inteiro dentro de BEGIN ... ROLLBACK: não altera dados locais. Prova a
-- ATOMICIDADE (a chamada à função é um statement atômico — erro no INSERT ou no
-- UPDATE reverte os DELETEs/UPDATEs anteriores da mesma chamada). A maioria dos
-- blocos roda como owner (o objeto é a transação); o bloco "RLS" abaixo troca
-- para o role `authenticated` com um JWT forjado para provar que, sob SECURITY
-- INVOKER, a RLS continua filtrando dentro da função (um não-coordenador não
-- apaga dados via a RPC). Sem dependência de profiles/auth.users: os FKs
-- created_by / respondent_id / reviewer_id / user_id são todos nuláveis.

BEGIN;

-- ----- Fixtures -----
INSERT INTO public.projects (id, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'proj atomic test');

-- D1 = doc alvo do "replace"; D2 = doc ativo cujo external_id 'EXISTING' será
-- colidido pelo INSERT do caminho de falha.
INSERT INTO public.documents (id, project_id, external_id, title, text, text_hash) VALUES
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', NULL,       'D1 alvo',  'texto d1', 'h-d1'),
  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'EXISTING', 'D2 ativo', 'texto d2', 'h-d2');

-- A resposta humana corrente precisa de autor: responses_human_latest_has_actor_check
-- (#609) torna irrepresentável a linha humana is_latest sem respondent_id. O que
-- este teste prova — que replace_and_add_documents apaga a response — não depende
-- de quem respondeu, então a fixture apenas passa a nomear o respondente.
-- UUID 7777… e não 5555…/6666…: esses dois já nomeiam outras entidades deste
-- arquivo (a review logo abaixo e o assignment em seguida).
INSERT INTO auth.users (id, email) VALUES
  ('77777777-7777-7777-7777-777777777777', 'atomic-replace-respondent@example.test');
INSERT INTO public.clerk_user_mapping
  (clerk_user_id, supabase_user_id, access_sync_version)
VALUES
  ('atomic-replace-clerk', '77777777-7777-7777-7777-777777777777', 1);

INSERT INTO public.responses (id, project_id, document_id, respondent_id, respondent_type, answers) VALUES
  ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '77777777-7777-7777-7777-777777777777', 'humano', '{"campo":"x"}');

INSERT INTO public.reviews (id, project_id, document_id, field_name, verdict) VALUES
  ('55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'campo', 'concordo');

INSERT INTO public.assignments (id, project_id, document_id, status, type) VALUES
  ('66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'concluido', 'codificacao');

-- ----- RLS: authenticated não-coordenador não apaga dados via a RPC -----
-- A decisão central do PR é SECURITY INVOKER justamente para manter a RLS valendo
-- dentro da transação. Aqui forjamos um JWT cujo subject não possui mapping
-- concluído (logo clerk_uid() é NULL) e trocamos para o role
-- `authenticated`. Os braços das policies de responses/reviews (respondent_id /
-- reviewer_id IN member_identity OR coordinator_or_creator OR is_master) não
-- batem -> o DELETE da RPC enxerga 0 linhas e não apaga nada. Sem inserts no
-- payload (o foco é o DELETE; um INSERT exigiria WITH CHECK e mascararia o teste).
--
-- Em produção o role `authenticated` tem DML nestas tabelas (o app opera via
-- PostgREST autenticado); o supabase local não concede por padrão. Concede aqui
-- (revertido no ROLLBACK) para isolar a camada sob teste — a RLS, não o GRANT.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.responses, public.reviews, public.assignments, public.documents
  TO authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"clerk-sem-mapping","supabase_uid":"99999999-9999-9999-9999-999999999999"}', true);
SET LOCAL ROLE authenticated;
SELECT public.replace_and_add_documents(
  '11111111-1111-1111-1111-111111111111'::uuid,
  ARRAY['22222222-2222-2222-2222-222222222222'::uuid],
  true,          -- tenta apagar responses/reviews + reset assignments
  '[]'::jsonb,
  '[]'::jsonb
);
RESET ROLE;

DO $$
DECLARE n_resp int; n_rev int; a_status text;
BEGIN
  SELECT count(*) INTO n_resp   FROM public.responses   WHERE id = '44444444-4444-4444-4444-444444444444';
  SELECT count(*) INTO n_rev    FROM public.reviews     WHERE id = '55555555-5555-5555-5555-555555555555';
  SELECT status   INTO a_status FROM public.assignments WHERE id = '66666666-6666-6666-6666-666666666666';
  IF n_resp <> 1 THEN RAISE EXCEPTION 'FALHOU RLS: response apagada por nao-coordenador via RPC (n=%)', n_resp; END IF;
  IF n_rev  <> 1 THEN RAISE EXCEPTION 'FALHOU RLS: review apagada por nao-coordenador via RPC (n=%)', n_rev; END IF;
  IF a_status <> 'concluido' THEN RAISE EXCEPTION 'FALHOU RLS: assignment resetado por nao-coordenador via RPC (status=%)', a_status; END IF;
  RAISE NOTICE 'OK RLS: authenticated nao-coordenador nao apagou responses/reviews/assignments via a RPC';
END $$;

-- ----- #284: falha no INSERT reverte os deletes/reset da mesma chamada -----
DO $$
BEGIN
  PERFORM public.replace_and_add_documents(
    '11111111-1111-1111-1111-111111111111'::uuid,
    ARRAY['22222222-2222-2222-2222-222222222222'::uuid],
    true,            -- delete responses/reviews + reset assignments
    '[]'::jsonb,     -- sem dup updates
    -- novo doc com external_id 'EXISTING' (já ativo) -> viola o índice parcial
    '[{"external_id":"EXISTING","title":"colide","text":"y","text_hash":"h-new","metadata":null}]'::jsonb
  );
  RAISE EXCEPTION 'TESTE FALHOU: a RPC deveria ter abortado com unique_violation';
EXCEPTION
  WHEN unique_violation THEN
    RAISE NOTICE 'OK: RPC abortou com unique_violation (esperado)';
END $$;

DO $$
DECLARE n_resp int; n_rev int; a_status text;
BEGIN
  SELECT count(*) INTO n_resp   FROM public.responses   WHERE id = '44444444-4444-4444-4444-444444444444';
  SELECT count(*) INTO n_rev    FROM public.reviews     WHERE id = '55555555-5555-5555-5555-555555555555';
  SELECT status   INTO a_status FROM public.assignments WHERE id = '66666666-6666-6666-6666-666666666666';
  IF n_resp <> 1   THEN RAISE EXCEPTION 'FALHOU #284: response apagada sem rollback (n=%)', n_resp; END IF;
  IF n_rev  <> 1   THEN RAISE EXCEPTION 'FALHOU #284: review apagada sem rollback (n=%)', n_rev; END IF;
  IF a_status <> 'concluido' THEN RAISE EXCEPTION 'FALHOU #284: assignment resetado sem rollback (status=%)', a_status; END IF;
  RAISE NOTICE 'OK #284: responses/reviews/assignments preservados apos falha (rollback atomico)';
END $$;

-- ----- #284: caminho feliz atualiza um doc duplicado (passo UPDATE) -----
-- Sem deletes nem inserts: só o UPDATE dos duplicados, que antes não tinha
-- cobertura. Atualiza D1 (text + external_id) e confere que pegou.
DO $$
DECLARE v_text text; v_ext text;
BEGIN
  PERFORM public.replace_and_add_documents(
    '11111111-1111-1111-1111-111111111111'::uuid,
    ARRAY[]::uuid[],
    false,           -- sem deletes
    '[{"id":"22222222-2222-2222-2222-222222222222","text":"d1 atualizado","title":"D1 upd","external_id":"DUP-UPD","text_hash":"h-d1-upd","metadata":null}]'::jsonb,
    '[]'::jsonb      -- sem inserts
  );
  SELECT text, external_id INTO v_text, v_ext
    FROM public.documents WHERE id = '22222222-2222-2222-2222-222222222222';
  IF v_text <> 'd1 atualizado' THEN RAISE EXCEPTION 'FALHOU: UPDATE nao alterou text (text=%)', v_text; END IF;
  IF v_ext  <> 'DUP-UPD'       THEN RAISE EXCEPTION 'FALHOU: UPDATE nao alterou external_id (ext=%)', v_ext; END IF;
  RAISE NOTICE 'OK #284: passo UPDATE atualizou o doc duplicado';
END $$;

-- ----- #284: falha no UPDATE (colisao de external_id) tambem reverte deletes -----
-- D1 recebe external_id 'EXISTING', já ativo em D2 -> viola o índice único
-- parcial DENTRO do passo UPDATE. Como há delete_responses=true, o DELETE roda
-- antes; a exceção deve reverter inclusive esse DELETE (atomicidade no UPDATE).
DO $$
DECLARE n_resp int;
BEGIN
  PERFORM public.replace_and_add_documents(
    '11111111-1111-1111-1111-111111111111'::uuid,
    ARRAY['22222222-2222-2222-2222-222222222222'::uuid],
    true,            -- apaga responses/reviews antes do UPDATE
    '[{"id":"22222222-2222-2222-2222-222222222222","text":"colide","title":"x","external_id":"EXISTING","text_hash":"h-x","metadata":null}]'::jsonb,
    '[]'::jsonb
  );
  RAISE EXCEPTION 'TESTE FALHOU: o UPDATE deveria ter abortado com unique_violation';
EXCEPTION
  WHEN unique_violation THEN
    SELECT count(*) INTO n_resp FROM public.responses WHERE id = '44444444-4444-4444-4444-444444444444';
    IF n_resp <> 1 THEN RAISE EXCEPTION 'FALHOU #284: response apagada sem rollback na falha do UPDATE (n=%)', n_resp; END IF;
    RAISE NOTICE 'OK #284: falha no UPDATE reverteu o DELETE anterior (rollback atomico)';
END $$;

-- ----- #284: caminho feliz aplica deletes + insere o novo doc -----
DO $$
DECLARE n_new int; n_resp int;
BEGIN
  PERFORM public.replace_and_add_documents(
    '11111111-1111-1111-1111-111111111111'::uuid,
    ARRAY['22222222-2222-2222-2222-222222222222'::uuid],
    true, '[]'::jsonb,
    '[{"external_id":"NEW-OK","title":"novo","text":"z","text_hash":"h-ok","metadata":null}]'::jsonb
  );
  SELECT count(*) INTO n_new  FROM public.documents WHERE project_id = '11111111-1111-1111-1111-111111111111' AND external_id = 'NEW-OK';
  SELECT count(*) INTO n_resp FROM public.responses WHERE id = '44444444-4444-4444-4444-444444444444';
  IF n_new  <> 1 THEN RAISE EXCEPTION 'FALHOU: novo doc nao inserido no caminho feliz (n=%)', n_new; END IF;
  IF n_resp <> 0 THEN RAISE EXCEPTION 'FALHOU: deleteResponses nao apagou a response no caminho feliz (n=%)', n_resp; END IF;
  RAISE NOTICE 'OK #284: caminho feliz inseriu o novo doc e aplicou os deletes';
END $$;

-- ----- #181: apply_lottery_assignments(replace) descarta pendentes do tipo + insere -----
DO $$
DECLARE n_pend int; v_round_id uuid;
BEGIN
  PERFORM set_config(
    'request.jwt.claims',
    '{"sub":"atomic-replace-clerk","supabase_uid":"77777777-7777-7777-7777-777777777777"}',
    true
  );
  SELECT current_round_id INTO v_round_id
  FROM public.projects WHERE id = '11111111-1111-1111-1111-111111111111';

  -- Pendente antiga (em D2) que deve ser descartada pelo modo replace.
  INSERT INTO public.assignments (project_id, document_id, status, type)
    VALUES ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'pendente', 'codificacao');
  PERFORM public.apply_lottery_assignments(
    '11111111-1111-1111-1111-111111111111'::uuid, 'codificacao', v_round_id,
    NULL, false, '{}'::jsonb,
    '[{"document_id":"22222222-2222-2222-2222-222222222222","user_id":null}]'::jsonb,
    true
  );
  SELECT count(*) INTO n_pend FROM public.assignments
    WHERE project_id = '11111111-1111-1111-1111-111111111111' AND type = 'codificacao' AND status = 'pendente';
  IF n_pend <> 1 THEN RAISE EXCEPTION 'FALHOU #181: esperava 1 pendente (a nova), achei %', n_pend; END IF;
  RAISE NOTICE 'OK #181: replace descartou a pendente antiga e inseriu a nova atomicamente';
END $$;

-- ----- #521: status/completed_at por linha, com default para quem os omite -----
-- O par já codificado nasce concluído; a linha sem as chaves cai no COALESCE.
-- Sem isto (a versão anterior da RPC), o documento codificado pelo Explorar
-- ficava eternamente pendente na fila: nada promove um assignment criado DEPOIS
-- da response.
DO $$
DECLARE
  r_status text;
  r_done timestamptz;
  r_default text;
  r_default_done timestamptz;
  v_round_id uuid;
BEGIN
  SELECT current_round_id INTO v_round_id
  FROM public.projects WHERE id = '11111111-1111-1111-1111-111111111111';

  -- Este DELETE limpa a fixture de assignments dos blocos anteriores, então
  -- este bloco tem de continuar sendo o ÚLTIMO: um caso novo inserido abaixo
  -- herdaria a tabela vazia e passaria por vácuo, sem sinal nenhum.
  DELETE FROM public.assignments WHERE project_id = '11111111-1111-1111-1111-111111111111';
  PERFORM public.apply_lottery_assignments(
    '11111111-1111-1111-1111-111111111111'::uuid, 'codificacao', v_round_id,
    NULL, false, '{}'::jsonb,
    '[{"document_id":"22222222-2222-2222-2222-222222222222","user_id":null,
       "status":"concluido","completed_at":"2026-07-20T10:00:00Z"},
      {"document_id":"33333333-3333-3333-3333-333333333333","user_id":null}]'::jsonb,
    false
  );

  SELECT status, completed_at INTO r_status, r_done FROM public.assignments
    WHERE document_id = '22222222-2222-2222-2222-222222222222' AND type = 'codificacao';
  IF r_status IS DISTINCT FROM 'concluido' THEN
    RAISE EXCEPTION 'FALHOU #521: esperava status concluido, achei %', r_status;
  END IF;
  IF r_done IS DISTINCT FROM '2026-07-20T10:00:00Z'::timestamptz THEN
    RAISE EXCEPTION 'FALHOU #521: completed_at nao veio do payload (%)', r_done;
  END IF;

  SELECT status, completed_at INTO r_default, r_default_done FROM public.assignments
    WHERE document_id = '33333333-3333-3333-3333-333333333333' AND type = 'codificacao';
  IF r_default IS DISTINCT FROM 'pendente' OR r_default_done IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU #521: linha sem status deveria cair em pendente/NULL (%, %)',
      r_default, r_default_done;
  END IF;
  RAISE NOTICE 'OK #521: status/completed_at por linha, com pendente como default';
END $$;

ROLLBACK;
