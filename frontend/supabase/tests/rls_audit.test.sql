-- Auditoria de catálogo da superfície de RLS e de execução (issue #134).
--
-- Como rodar após `npx supabase db reset`:
--   docker exec -i supabase_db_frontend psql -U postgres -d postgres \
--     -X -v ON_ERROR_STOP=1 < supabase/tests/rls_audit.test.sql
--
-- As invariantes de catálogo são estruturais: valem para qualquer tabela,
-- view ou função que exista, sem enumerar nomes. É isso que as torna um
-- detector — uma tabela nova sem RLS, ou uma função de trigger nova deixada
-- executável por cliente, derruba o gate sem ninguém precisar lembrar de
-- adicioná-la a uma lista. O preço é que elas ficam vermelhas quando alguém
-- introduz o gap, que é exatamente o comportamento desejado.
--
-- A segunda metade fixa o contrato de autoria da pendência de ambiguidade para
-- contas-alias (issue #474), em invariantes PAREADAS: o que a conta-alias
-- consegue fazer e o que ela não consegue. Uma sozinha passaria por vácuo.

BEGIN;

-- ========== Invariantes de catálogo ==========

DO $$
DECLARE
  achado text;
BEGIN
  -- Toda tabela de `public` carrega dado de projeto e precisa de RLS. A ausência
  -- não é degradação parcial: sem RLS a tabela fica legível por qualquer sessão
  -- autenticada, independentemente das policies das tabelas vizinhas.
  SELECT relation.relname INTO achado
  FROM pg_class AS relation
  WHERE relation.relnamespace = 'public'::regnamespace
    AND relation.relkind = 'r'
    AND NOT relation.relrowsecurity
  ORDER BY 1
  LIMIT 1;
  IF achado IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU contrato: tabela public sem RLS: %', achado;
  END IF;

  -- RLS habilitada sem nenhuma policy nega tudo — o que é seguro, mas indica
  -- tabela exposta a papel de cliente por engano. O par com a invariante acima
  -- é o que fecha o deny-by-default: uma cobre "sem RLS", a outra "com RLS e
  -- sem regra".
  SELECT relation.relname INTO achado
  FROM pg_class AS relation
  WHERE relation.relnamespace = 'public'::regnamespace
    AND relation.relkind = 'r'
    AND NOT EXISTS (
      SELECT 1 FROM pg_policy AS policy WHERE policy.polrelid = relation.oid
    )
    AND (
      has_table_privilege(
        'anon', relation.oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      )
      OR has_table_privilege(
        'authenticated', relation.oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      )
    )
  ORDER BY 1
  LIMIT 1;
  IF achado IS NOT NULL THEN
    RAISE EXCEPTION
      'FALHOU contrato: tabela sem policy exposta a papel de cliente: %', achado;
  END IF;

  -- `USING (true)` / `WITH CHECK (true)` numa tabela de projeto anula a RLS sem
  -- desabilitá-la, o que é pior que não ter policy: o catálogo parece protegido.
  SELECT policy.tablename || '.' || policy.policyname INTO achado
  FROM pg_policies AS policy
  WHERE policy.schemaname = 'public'
    AND (
      btrim(lower(coalesce(policy.qual, '')), '() ') = 'true'
      OR btrim(lower(coalesce(policy.with_check, '')), '() ') = 'true'
    )
  ORDER BY 1
  LIMIT 1;
  IF achado IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU contrato: policy literalmente permissiva: %', achado;
  END IF;

  -- View sem `security_invoker=true` no PG15 executa com os direitos do dono e
  -- ignora a RLS das tabelas de base — o furo que motivou a correção de
  -- final_answers e lottery_doc_stats.
  SELECT relation.relname INTO achado
  FROM pg_class AS relation
  WHERE relation.relnamespace = 'public'::regnamespace
    AND relation.relkind = 'v'
    AND NOT (
      coalesce(relation.reloptions, ARRAY[]::text[])
      @> ARRAY['security_invoker=true']
    )
  ORDER BY 1
  LIMIT 1;
  IF achado IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU contrato: view sem security_invoker: %', achado;
  END IF;

  -- SECURITY DEFINER sem `search_path` fixado deixa o chamador escolher em que
  -- schema os nomes não qualificados resolvem, com os privilégios do owner.
  SELECT procedure.oid::regprocedure::text INTO achado
  FROM pg_proc AS procedure
  WHERE procedure.pronamespace = 'public'::regnamespace
    AND procedure.prosecdef
    AND NOT (
      coalesce(procedure.proconfig, ARRAY[]::text[])
      @> ARRAY['search_path=""']
    )
  ORDER BY 1
  LIMIT 1;
  IF achado IS NOT NULL THEN
    RAISE EXCEPTION
      'FALHOU contrato: SECURITY DEFINER sem search_path vazio: %', achado;
  END IF;

  RAISE NOTICE 'OK catálogo: RLS, deny-by-default, policies, views e definers';
END;
$$;

DO $$
DECLARE
  achado text;
BEGIN
  -- O PostgREST expõe como RPC toda função que o papel da requisição pode
  -- executar. Função de trigger chamada fora do trigger recebe NEW/OLD nulos e
  -- um TG_OP inexistente; com DEFINER, grava com os privilégios do owner.
  -- Toda função em `public` nasce com EXECUTE para PUBLIC, então o fechamento
  -- exige revogar de PUBLIC — revogar só dos papéis nomeados deixa a herança.
  SELECT procedure.oid::regprocedure::text INTO achado
  FROM pg_proc AS procedure
  JOIN pg_trigger AS trigger ON trigger.tgfoid = procedure.oid
  WHERE procedure.pronamespace = 'public'::regnamespace
    AND NOT trigger.tgisinternal
    AND (
      has_function_privilege('anon', procedure.oid, 'EXECUTE')
      OR has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
      OR has_function_privilege('service_role', procedure.oid, 'EXECUTE')
    )
  ORDER BY 1
  LIMIT 1;
  IF achado IS NOT NULL THEN
    RAISE EXCEPTION
      'FALHOU contrato: função de trigger executável por cliente: %', achado;
  END IF;

  -- As duas RPCs de domínio são chamadas só pelo client de sessão. O par de
  -- asserções é deliberado: exigir que `authenticated` TENHA execute impede que
  -- alguém "conserte" a primeira metade revogando de todo mundo e quebrando o
  -- caminho de produção.
  IF has_function_privilege(
       'anon',
       'public.replace_and_add_documents(uuid,uuid[],boolean,jsonb,jsonb)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.replace_and_add_documents(uuid,uuid[],boolean,jsonb,jsonb)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.replace_and_add_documents(uuid,uuid[],boolean,jsonb,jsonb)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'FALHOU contrato: grants de replace_and_add_documents';
  END IF;

  IF to_regprocedure(
       'public.apply_lottery_assignments(uuid,text,uuid,jsonb,boolean)'
     ) IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU contrato: overload legada de apply_lottery_assignments ainda existe';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.apply_lottery_assignments(uuid,text,uuid,text,boolean,jsonb,jsonb,boolean)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.apply_lottery_assignments(uuid,text,uuid,text,boolean,jsonb,jsonb,boolean)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.apply_lottery_assignments(uuid,text,uuid,text,boolean,jsonb,jsonb,boolean)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'FALHOU contrato: grants de apply_lottery_assignments';
  END IF;

  -- Varredura sobre TODAS as views e TODOS os privilégios, não sobre uma lista
  -- de nomes com SELECT. A primeira versão desta asserção checava apenas SELECT
  -- em `final_answers` e `lottery_doc_stats`, e por isso daria produção por
  -- limpa: lá, `final_answers` tinha o SELECT revogado mas conservava
  -- INSERT/UPDATE/DELETE para `anon` (ver 20260724140000).
  --
  -- Limitação conhecida: o Supabase local não reproduz os default privileges do
  -- remoto, então esta asserção passa localmente mesmo quando o remoto viola.
  -- Ela é uma rede contra regressão introduzida por migration, não substituto de
  -- auditar o catálogo de produção.
  SELECT relation.oid::regclass::text INTO achado
  FROM pg_class AS relation
  WHERE relation.relnamespace = 'public'::regnamespace
    AND relation.relkind = 'v'
    AND has_table_privilege(
      'anon', relation.oid,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    )
  ORDER BY 1
  LIMIT 1;
  IF achado IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU contrato: anon tem privilégio em view de public: %', achado;
  END IF;

  -- RPC alcançável sem call site é superfície sem contrapartida.
  IF to_regprocedure('public.remove_answer_key(uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'FALHOU contrato: RPC órfã remove_answer_key ainda existe';
  END IF;

  RAISE NOTICE 'OK superfície: funções de trigger fechadas e RPCs explícitas';
END;
$$;

-- ========== Autoria da pendência de ambiguidade para conta-alias (#474) ==========
-- Fixture mínimo: a conta-alias NÃO é membro; quem é membro é a identidade
-- canônica. `addMember` impede ativamente que a conta vinculada seja membro
-- própria, então essa assimetria é o estado normal, não uma borda.

INSERT INTO auth.users (id, email) VALUES
  ('30000000-0000-0000-0000-000000000001', 'audit-owner@example.test'),
  ('30000000-0000-0000-0000-000000000002', 'audit-canonical@example.test'),
  ('30000000-0000-0000-0000-000000000003', 'audit-alias@example.test');

INSERT INTO public.clerk_user_mapping
  (clerk_user_id, supabase_user_id, access_sync_version)
SELECT id::text, id, 1
FROM auth.users
WHERE id::text LIKE '30000000-0000-0000-0000-%';

INSERT INTO public.projects (id, name, created_by) VALUES
  ('40000000-0000-0000-0000-000000000001', 'Projeto da auditoria',
   '30000000-0000-0000-0000-000000000001');

INSERT INTO public.project_members (project_id, user_id, role) VALUES
  ('40000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000001', 'coordenador'),
  ('40000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000002', 'pesquisador');

INSERT INTO public.member_email_links
  (project_id, member_user_id, email, linked_user_id, created_by)
VALUES
  ('40000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000002',
   'audit-alias@example.test',
   '30000000-0000-0000-0000-000000000003',
   '30000000-0000-0000-0000-000000000001');

INSERT INTO public.documents (id, project_id, text) VALUES
  ('50000000-0000-0000-0000-000000000001',
   '40000000-0000-0000-0000-000000000001',
   'texto da auditoria');

-- O ambiente local não concede DML de `public` por default; o remoto concede.
-- Os grants abaixo somem no ROLLBACK e mantêm a decisão de visibilidade na RLS.
GRANT SELECT ON public.profiles, public.projects, public.project_members,
  public.member_email_links, public.documents, public.reviews,
  public.project_comments
  TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.project_comments TO authenticated;

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"30000000-0000-0000-0000-000000000003","supabase_uid":"30000000-0000-0000-0000-000000000003"}',
  true
);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  removidas integer;
BEGIN
  -- Pré-condição: a conta-alias herda o acesso do membro canônico (#440). Sem
  -- isso as duas asserções seguintes passariam por vácuo, porque a policy
  -- recusaria tudo por falta de acesso ao projeto, não por autoria.
  IF NOT EXISTS (
    SELECT 1 FROM public.auth_user_accessible_project_ids() AS acessivel(project_id)
    WHERE acessivel.project_id = '40000000-0000-0000-0000-000000000001'
  ) THEN
    RAISE EXCEPTION
      'FALHOU contrato: conta-alias não herda acesso ao projeto do membro canônico';
  END IF;

  -- Metade 1: a conta-alias CONSEGUE criar a pendência sob a própria conta
  -- autenticada. É o caminho que `submitVerdict` usa (`author_id = user.id`), e
  -- foi o que resolveu o sintoma relatado na #474.
  BEGIN
    INSERT INTO public.project_comments
      (project_id, document_id, field_name, author_id, body, kind)
    VALUES
      ('40000000-0000-0000-0000-000000000001',
       '50000000-0000-0000-0000-000000000001',
       'campo_ambiguo',
       '30000000-0000-0000-0000-000000000003',
       'Campo marcado como ambíguo na revisão (aba Comparar).',
       'ambiguity');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      'FALHOU contrato: conta-alias não cria a pendência de ambiguidade (% / %)',
      SQLSTATE, SQLERRM;
  END;

  -- Metade 2: a mesma conta NÃO consegue atribuir a autoria ao membro canônico.
  -- A policy de INSERT exige `author_id = clerk_uid()`, e a decisão registrada
  -- na 20260716155000 é que a conta bruta permanece a fonte de autoria. Trocar
  -- isso exige afrouxar a policy — mudança de produto, não correção de bug.
  BEGIN
    INSERT INTO public.project_comments
      (project_id, document_id, field_name, author_id, body, kind)
    VALUES
      ('40000000-0000-0000-0000-000000000001',
       '50000000-0000-0000-0000-000000000001',
       'outro_campo',
       '30000000-0000-0000-0000-000000000002',
       'Autoria canônica.',
       'ambiguity');
    RAISE EXCEPTION
      'FALHOU contrato: autoria pelo membro canônico foi aceita sem afrouxar a policy';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;

  -- Metade 3: a conta-alias remove a pendência que criou. O alinhamento da
  -- remoção já existia (20260612090200); a asserção impede que ele regrida.
  DELETE FROM public.project_comments
  WHERE project_id = '40000000-0000-0000-0000-000000000001'
    AND kind = 'ambiguity';
  GET DIAGNOSTICS removidas = ROW_COUNT;
  IF removidas <> 1 THEN
    RAISE EXCEPTION
      'FALHOU contrato: conta-alias removeu % pendência(s) de ambiguidade, esperado 1',
      removidas;
  END IF;

  RAISE NOTICE 'OK conta-alias: cria e remove a pendência, autoria canônica recusada';
END;
$$;

RESET ROLE;

ROLLBACK;
