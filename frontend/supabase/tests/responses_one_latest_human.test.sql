-- Unicidade da resposta humana corrente em `responses` (issue #609).
--
-- Como rodar (após `npx supabase start` e `npx supabase db reset`):
--   npm run test:db:responses-human-latest
-- ou, à mão:
--   docker exec -e PGPASSWORD=postgres -i supabase_db_frontend \
--     psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 \
--     < supabase/tests/responses_one_latest_human.test.sql
--
-- O teste roda inteiro dentro de BEGIN ... ROLLBACK; nada sobrevive. Qualquer
-- RAISE EXCEPTION marcado como FALHOU aborta com exit code != 0 sob
-- ON_ERROR_STOP=1.
--
-- Cobre os dois lados da restrição, que é onde mora o risco de um índice mal
-- escrito: o que ele DEVE recusar (mesma pessoa duas vezes) e o que ele NÃO
-- pode passar a recusar (dupla independente, histórico, LLM). O cenário 9
-- guarda o achado que a issue não previu: unify_project_members construía o
-- estado proibido antes de desfazê-lo.

BEGIN;

-- ---------------------------------------------------------------- fixtures
INSERT INTO auth.users (id, email) VALUES
  ('60910000-0000-0000-0000-000000000001', 'issue609-coord@example.test'),
  ('60910000-0000-0000-0000-000000000002', 'issue609-ana@example.test'),
  ('60910000-0000-0000-0000-000000000003', 'issue609-bruno@example.test');

INSERT INTO public.clerk_user_mapping
  (clerk_user_id, supabase_user_id, access_sync_version)
SELECT id::text, id, 1
FROM auth.users
WHERE id::text LIKE '60910000-0000-0000-0000-%';

INSERT INTO public.projects (id, name, created_by) VALUES
  ('60900000-0000-0000-0000-000000000001', 'Issue 609 - unicidade humana',
   '60910000-0000-0000-0000-000000000001');

INSERT INTO public.project_members (project_id, user_id, role) VALUES
  ('60900000-0000-0000-0000-000000000001',
   '60910000-0000-0000-0000-000000000001', 'coordenador'),
  ('60900000-0000-0000-0000-000000000001',
   '60910000-0000-0000-0000-000000000002', 'pesquisador'),
  ('60900000-0000-0000-0000-000000000001',
   '60910000-0000-0000-0000-000000000003', 'pesquisador');

INSERT INTO public.documents (id, project_id, title, text) VALUES
  ('60920000-0000-0000-0000-000000000001',
   '60900000-0000-0000-0000-000000000001', 'Doc A', 'texto A'),
  ('60920000-0000-0000-0000-000000000002',
   '60900000-0000-0000-0000-000000000001', 'Doc B', 'texto B');

-- A resposta corrente de Ana no Doc A. Todo cenário abaixo parte daqui.
INSERT INTO public.responses
  (id, project_id, document_id, respondent_id, respondent_type,
   respondent_name, answers, is_latest, is_partial)
VALUES
  ('60930000-0000-0000-0000-000000000001',
   '60900000-0000-0000-0000-000000000001',
   '60920000-0000-0000-0000-000000000001',
   '60910000-0000-0000-0000-000000000002', 'humano', 'Ana',
   '{"campo": "primeira"}'::jsonb, true, false);

-- ============ 1. Segunda corrente da MESMA pessoa no MESMO doc =============
DO $$
DECLARE
  blocked BOOLEAN := false;
BEGIN
  BEGIN
    INSERT INTO public.responses
      (project_id, document_id, respondent_id, respondent_type,
       respondent_name, answers, is_latest, is_partial)
    VALUES
      ('60900000-0000-0000-0000-000000000001',
       '60920000-0000-0000-0000-000000000001',
       '60910000-0000-0000-0000-000000000002', 'humano', 'Ana',
       '{"campo": "segunda"}'::jsonb, true, false);
  EXCEPTION WHEN unique_violation THEN
    blocked := true;
  END;

  IF NOT blocked THEN
    RAISE EXCEPTION
      'FALHOU: segunda resposta humana corrente da mesma pessoa foi aceita';
  END IF;
  RAISE NOTICE 'OK 1: segunda corrente da mesma pessoa recusada com 23505';
END;
$$;

-- ============ 2. Promover histórica do mesmo autor (caminho do unify) ======
INSERT INTO public.responses
  (id, project_id, document_id, respondent_id, respondent_type,
   respondent_name, answers, is_latest, is_partial)
VALUES
  ('60930000-0000-0000-0000-000000000002',
   '60900000-0000-0000-0000-000000000001',
   '60920000-0000-0000-0000-000000000001',
   '60910000-0000-0000-0000-000000000002', 'humano', 'Ana',
   '{"campo": "historica"}'::jsonb, false, false);

DO $$
DECLARE
  blocked BOOLEAN := false;
BEGIN
  BEGIN
    UPDATE public.responses
    SET is_latest = true
    WHERE id = '60930000-0000-0000-0000-000000000002';
  EXCEPTION WHEN unique_violation THEN
    blocked := true;
  END;

  IF NOT blocked THEN
    RAISE EXCEPTION
      'FALHOU: UPDATE promoveu histórica a corrente com outra corrente viva';
  END IF;
  RAISE NOTICE 'OK 2: promoção de histórica recusada com 23505';
END;
$$;

-- ============ 3. Humano corrente sem respondent_id =========================
-- Sem este CHECK o índice não restringe nada nesse caso: NULL nunca colide.
DO $$
DECLARE
  blocked BOOLEAN := false;
BEGIN
  BEGIN
    INSERT INTO public.responses
      (project_id, document_id, respondent_id, respondent_type,
       respondent_name, answers, is_latest, is_partial)
    VALUES
      ('60900000-0000-0000-0000-000000000001',
       '60920000-0000-0000-0000-000000000002',
       NULL, 'humano', 'Anônima',
       '{"campo": "sem autor"}'::jsonb, true, false);
  EXCEPTION WHEN check_violation THEN
    blocked := true;
  END;

  IF NOT blocked THEN
    RAISE EXCEPTION
      'FALHOU: resposta humana corrente sem respondent_id foi aceita';
  END IF;
  RAISE NOTICE 'OK 3: humano corrente sem autor recusado com 23514';
END;
$$;

-- ============ 4-8. O que a restrição NÃO pode passar a recusar =============
-- Um índice mal escrito quebra o produto aqui, e não no caso 1.
DO $$
BEGIN
  -- 4. Dupla independente: dois humanos DISTINTOS correntes no mesmo doc.
  INSERT INTO public.responses
    (id, project_id, document_id, respondent_id, respondent_type,
     respondent_name, answers, is_latest, is_partial)
  VALUES
    ('60930000-0000-0000-0000-000000000003',
     '60900000-0000-0000-0000-000000000001',
     '60920000-0000-0000-0000-000000000001',
     '60910000-0000-0000-0000-000000000003', 'humano', 'Bruno',
     '{"campo": "do bruno"}'::jsonb, true, false);

  -- 5. Mesma pessoa: 1 corrente + N históricas (a do caso 2 já é uma).
  INSERT INTO public.responses
    (project_id, document_id, respondent_id, respondent_type,
     respondent_name, answers, is_latest, is_partial)
  VALUES
    ('60900000-0000-0000-0000-000000000001',
     '60920000-0000-0000-0000-000000000001',
     '60910000-0000-0000-0000-000000000002', 'humano', 'Ana',
     '{"campo": "outra historica"}'::jsonb, false, false);

  -- 6. LLM corrente convive com humano corrente no mesmo doc.
  INSERT INTO public.responses
    (project_id, document_id, respondent_id, respondent_type,
     respondent_name, answers, is_latest, is_partial)
  VALUES
    ('60900000-0000-0000-0000-000000000001',
     '60920000-0000-0000-0000-000000000001',
     NULL, 'llm', 'gemini/flash',
     '{"campo": "do llm"}'::jsonb, true, false);

  -- 7. Histórico humano sem autor continua representável (o CHECK isenta).
  INSERT INTO public.responses
    (project_id, document_id, respondent_id, respondent_type,
     respondent_name, answers, is_latest, is_partial)
  VALUES
    ('60900000-0000-0000-0000-000000000001',
     '60920000-0000-0000-0000-000000000002',
     NULL, 'humano', 'Legado sem autor',
     '{"campo": "legado"}'::jsonb, false, false);

  -- 8. Mesma pessoa corrente em documentos diferentes.
  INSERT INTO public.responses
    (project_id, document_id, respondent_id, respondent_type,
     respondent_name, answers, is_latest, is_partial)
  VALUES
    ('60900000-0000-0000-0000-000000000001',
     '60920000-0000-0000-0000-000000000002',
     '60910000-0000-0000-0000-000000000002', 'humano', 'Ana',
     '{"campo": "doc B"}'::jsonb, true, false);

  RAISE NOTICE 'OK 4-8: dupla independente, histórico, LLM e outro doc seguem permitidos';
END;
$$;

-- ============ 9. unify_project_members não colide com a restrição ==========
-- Ana e Bruno têm, cada um, resposta corrente no Doc A (casos 1 e 4). Unificar
-- Bruno em Ana faz a RPC repontar respondent_id — o statement que, na ordem
-- anterior, produzia duas correntes da mesma pessoa e estouraria 23505.
DO $$
DECLARE
  v_current_count INTEGER;
  v_winner UUID;
BEGIN
  -- Source e target são memberships terminais; a própria RPC remove a
  -- membership do source e registra o alias no fim. Por isso o vínculo NÃO é
  -- inserido aqui: `linked_user_id` que ainda seja membro é recusado pelo
  -- guard `enforce_terminal_member_email_alias`.
  PERFORM public.unify_project_members(
    '60900000-0000-0000-0000-000000000001',
    '60910000-0000-0000-0000-000000000003',  -- source: Bruno
    '60910000-0000-0000-0000-000000000002',  -- target: Ana
    '60910000-0000-0000-0000-000000000003',  -- a conta do source vira o alias
    'issue609-bruno@example.test',
    '60910000-0000-0000-0000-000000000001',
    0
  );

  SELECT pg_catalog.count(*) INTO v_current_count
  FROM public.responses
  WHERE document_id = '60920000-0000-0000-0000-000000000001'
    AND respondent_type = 'humano'
    AND is_latest;

  IF v_current_count <> 1 THEN
    RAISE EXCEPTION
      'FALHOU: unificação deixou % respostas humanas correntes no Doc A (esperado 1)',
      v_current_count;
  END IF;

  -- O vencedor tem de ser o mesmo que a ordem antiga elegia: a mais recente
  -- por COALESCE(updated_at, created_at) DESC, id DESC. Bruno foi inserido
  -- depois de Ana, então a linha dele prevalece — só que agora sob Ana.
  SELECT id INTO v_winner
  FROM public.responses
  WHERE document_id = '60920000-0000-0000-0000-000000000001'
    AND respondent_type = 'humano'
    AND is_latest;

  IF v_winner <> '60930000-0000-0000-0000-000000000003' THEN
    RAISE EXCEPTION
      'FALHOU: unificação elegeu vencedor % (esperado a linha mais recente)',
      v_winner;
  END IF;

  RAISE NOTICE 'OK 9: unificação convive com a restrição e mantém o mesmo vencedor';
END;
$$;

-- ============ Prova do vermelho ===========================================
-- Sem isto o arquivo provaria apenas que ALGO recusou o INSERT do caso 1 — e a
-- tabela tem três triggers próprios, qualquer um deles um suspeito plausível.
-- Derrubar o índice e repetir o mesmo INSERT mostra que o 23505 vinha DELE, e
-- de quebra prova que este teste é vermelho sem a migration. O ROLLBACK final
-- devolve o índice.
DROP INDEX public.responses_one_latest_human_per_document;

DO $$
DECLARE
  accepted BOOLEAN := false;
BEGIN
  BEGIN
    INSERT INTO public.responses
      (project_id, document_id, respondent_id, respondent_type,
       respondent_name, answers, is_latest, is_partial)
    VALUES
      ('60900000-0000-0000-0000-000000000001',
       '60920000-0000-0000-0000-000000000002',
       '60910000-0000-0000-0000-000000000002', 'humano', 'Ana',
       '{"campo": "duplicata sem indice"}'::jsonb, true, false);
    accepted := true;
  EXCEPTION WHEN unique_violation THEN
    accepted := false;
  END;

  IF NOT accepted THEN
    RAISE EXCEPTION
      'FALHOU: o 23505 do caso 1 não vinha do índice — sem ele o INSERT ainda é recusado';
  END IF;
  RAISE NOTICE 'OK: prova do vermelho — sem o índice a duplicata passa';
END;
$$;

ROLLBACK;
