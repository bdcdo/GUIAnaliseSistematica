-- Contrato das referências a `responses`: toda coluna que aponta para uma
-- resposta carrega o documento dela (issues #625, #628; migration
-- 20260805120000_response_references_document_scoped.sql).
--
-- As cinco colunas NÃO estavam no mesmo estado antes desta migration, e a
-- estrutura do arquivo reflete isso:
--
--  * `reviews.chosen_response_id` não tinha guarda NENHUMA — e é exatamente
--    onde a #623 encontrou 3 vereditos gravados no documento errado, em
--    produção. Para ela, a FK é garantia nova.
--  * `response_equivalences` e `field_reviews` já eram protegidas por trigger
--    (`snapshot_response_equivalence_answers`, `snapshot_field_review_cycle`),
--    e por isso produção nunca acusou violação nelas. Ali a FK é DEFESA EM
--    PROFUNDIDADE: não depende de o trigger sobreviver a uma migration futura
--    — risco concreto, documentado na #602, onde guards por trigger tiveram de
--    ser retirados por efeito colateral.
--
-- Consequência para o teste: nessas duas tabelas o trigger recusa ANTES da
-- checagem da FK, então uma asserção ingênua passaria idêntica se a FK não
-- existisse. Por isso cada uma tem DOIS casos — um fixando o comportamento
-- vigente (recusa por trigger) e outro com o trigger desabilitado dentro da
-- transação, que é o único que de fato mede a FK.
--
-- Os demais casos e o que cada um impede:
--
--  * POSITIVO (referência dentro do mesmo documento passa): sem ele, uma FK que
--    recusasse TUDO faria os negativos passarem e o contrato seria vácuo.
--  * NULO em `reviews.chosen_response_id`: 294 das 1.482 reviews de produção
--    não escolhem resposta — veredito sem escolha é legítimo. Uma FK composta
--    que recusasse NULL quebraria a Comparação inteira; MATCH SIMPLE é o que
--    permite isso, e o caso fixa a permissão.
--  * `reviews.document_id` NOT NULL: é ELE que faz a FK valer, porque MATCH
--    SIMPLE não verifica nada quando qualquer coluna da chave é nula. Sem a
--    restrição de nulidade a FK existiria sem restringir — mesmo modo de falha
--    que o CHECK de autoria de 20260727120000:117-128 evita no índice único.
--
-- Como rodar (após `npx supabase start` e `npx supabase db reset`):
--   psql "$(npx supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '"')" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/response_references_document_scoped.test.sql
--
-- Validar pelo exit code, não por contar OKs na saída.
-- A transação termina em ROLLBACK e não deixa fixtures no banco local.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SELECT plan(12);

CREATE OR REPLACE FUNCTION pg_temp.rejected_constraint(statement TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  actual_constraint TEXT;
BEGIN
  EXECUTE statement;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS actual_constraint = CONSTRAINT_NAME;
  RETURN actual_constraint;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.rejected_sqlstate(statement TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  actual_sqlstate TEXT;
BEGIN
  EXECUTE statement;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS actual_sqlstate = RETURNED_SQLSTATE;
  RETURN actual_sqlstate;
END;
$$;

-- ========== Fixtures ========================================================
-- O trigger de auth cria os profiles que sustentam reviewer_id/respondent_id.
INSERT INTO auth.users (id, email) VALUES
  ('62510000-0000-0000-0000-000000000001', 'coordenadora-625@example.test'),
  ('62510000-0000-0000-0000-000000000002', 'pesquisadora-625@example.test');

INSERT INTO public.clerk_user_mapping
  (clerk_user_id, supabase_user_id, access_sync_version)
SELECT id::TEXT, id, 1
FROM auth.users
WHERE id::TEXT LIKE '62510000-0000-0000-0000-%';

INSERT INTO public.projects (id, name, created_by) VALUES (
  '62520000-0000-0000-0000-000000000001',
  'referencias document-scoped',
  '62510000-0000-0000-0000-000000000001'
);

-- DOIS documentos no MESMO projeto: é essa a configuração que a FK
-- project-scoped da #603 deixaria passar e que esta migration fecha.
INSERT INTO public.documents (id, project_id, title, text) VALUES
  ('62530000-0000-0000-0000-00000000000A',
   '62520000-0000-0000-0000-000000000001', 'documento A', 'texto A'),
  ('62530000-0000-0000-0000-00000000000B',
   '62520000-0000-0000-0000-000000000001', 'documento B', 'texto B');

-- Uma resposta humana e uma LLM por documento.
INSERT INTO public.responses
  (id, project_id, document_id, respondent_type, respondent_id, answers, is_latest)
VALUES
  ('62540000-0000-0000-000a-0000000000aa',
   '62520000-0000-0000-0000-000000000001',
   '62530000-0000-0000-0000-00000000000A',
   'humano', '62510000-0000-0000-0000-000000000002', '{"q1": "a"}'::jsonb, true),
  ('62540000-0000-0000-000b-0000000000aa',
   '62520000-0000-0000-0000-000000000001',
   '62530000-0000-0000-0000-00000000000B',
   'humano', '62510000-0000-0000-0000-000000000002', '{"q1": "b"}'::jsonb, true),
  ('62540000-0000-0000-000a-0000000000cc',
   '62520000-0000-0000-0000-000000000001',
   '62530000-0000-0000-0000-00000000000A',
   'llm', NULL, '{"q1": "a-llm"}'::jsonb, true),
  ('62540000-0000-0000-000b-0000000000cc',
   '62520000-0000-0000-0000-000000000001',
   '62530000-0000-0000-0000-00000000000B',
   'llm', NULL, '{"q1": "b-llm"}'::jsonb, true);

-- ========== reviews.chosen_response_id ======================================

-- O caso da #625/#628: veredito do documento A escolhendo resposta do B.
-- Mesmo projeto, mesma pessoa, mesmo campo — só o documento diverge.
SELECT is(
  pg_temp.rejected_constraint($$
    INSERT INTO public.reviews
      (project_id, document_id, field_name, reviewer_id, verdict, chosen_response_id)
    VALUES
      ('62520000-0000-0000-0000-000000000001',
       '62530000-0000-0000-0000-00000000000A',
       'q1', '62510000-0000-0000-0000-000000000001', 'humano',
       '62540000-0000-0000-000b-0000000000aa')
  $$),
  'reviews_document_chosen_response_fk',
  'review do doc A não pode escolher response do doc B'
);

-- Positivo: sem ele os negativos passariam mesmo com uma FK que recusa tudo.
--
-- `field_name` PRÓPRIO, e não o 'q1' do caso acima, de propósito: reviews tem
-- UNIQUE(project_id, document_id, field_name, reviewer_id), então reusar 'q1'
-- acoplaria este caso ao anterior — no estado SEM a migration o INSERT de cima
-- tem sucesso e este colidiria por unicidade, falhando por um motivo que nada
-- tem a ver com o contrato sob teste. Cada caso responde por si.
SELECT is(
  pg_temp.rejected_constraint($$
    INSERT INTO public.reviews
      (project_id, document_id, field_name, reviewer_id, verdict, chosen_response_id)
    VALUES
      ('62520000-0000-0000-0000-000000000001',
       '62530000-0000-0000-0000-00000000000A',
       'q1_positivo', '62510000-0000-0000-0000-000000000001', 'humano',
       '62540000-0000-0000-000a-0000000000aa')
  $$),
  NULL,
  'review do doc A escolhe response do doc A'
);

-- Veredito sem escolha continua legítimo (294 linhas assim em produção).
SELECT is(
  pg_temp.rejected_constraint($$
    INSERT INTO public.reviews
      (project_id, document_id, field_name, reviewer_id, verdict, chosen_response_id)
    VALUES
      ('62520000-0000-0000-0000-000000000001',
       '62530000-0000-0000-0000-00000000000B',
       'q1', '62510000-0000-0000-0000-000000000001', 'ambiguo', NULL)
  $$),
  NULL,
  'chosen_response_id NULL continua permitido'
);

-- É o NOT NULL que faz a FK valer: com document_id nulo, MATCH SIMPLE não
-- verificaria a chave e a referência cruzada entraria pela porta dos fundos.
SELECT is(
  pg_temp.rejected_sqlstate($$
    INSERT INTO public.reviews
      (project_id, document_id, field_name, reviewer_id, verdict, chosen_response_id)
    VALUES
      ('62520000-0000-0000-0000-000000000001',
       NULL,
       'q1', '62510000-0000-0000-0000-000000000001', 'humano',
       '62540000-0000-0000-000b-0000000000aa')
  $$),
  '23502',
  'review sem document_id é recusada (senão a FK ficaria inerte)'
);

-- UPDATE também é coberto: a FK vale para toda escrita, não só INSERT. Sem
-- este caso, um caminho que repontasse o veredito depois de criado passaria.
INSERT INTO public.reviews
  (id, project_id, document_id, field_name, reviewer_id, verdict, chosen_response_id)
VALUES
  ('62550000-0000-0000-0000-000000000001',
   '62520000-0000-0000-0000-000000000001',
   '62530000-0000-0000-0000-00000000000B',
   'q2', '62510000-0000-0000-0000-000000000001', 'humano',
   '62540000-0000-0000-000b-0000000000aa');

SELECT is(
  pg_temp.rejected_constraint($$
    UPDATE public.reviews
    SET chosen_response_id = '62540000-0000-0000-000a-0000000000aa'
    WHERE id = '62550000-0000-0000-0000-000000000001'
  $$),
  'reviews_document_chosen_response_fk',
  'repontar veredito para response de outro documento é recusado'
);

-- ========== response_equivalences ===========================================
--
-- Aqui a FK é DEFESA EM PROFUNDIDADE, não garantia nova: o trigger
-- `snapshot_response_equivalence_answers` já recusa o par cruzado desde
-- 20260504000000. Por isso são dois casos, e não um.
--
-- O primeiro fixa o comportamento visível hoje (quem recusa é o trigger, que
-- roda antes da checagem da FK). O segundo é o que de fato mede a FK: com o
-- trigger desabilitado dentro desta transação, a FK precisa recusar sozinha.
-- Sem o segundo caso, esta seção passaria idêntica se a FK não existisse — um
-- verde vácuo quanto ao que a migration acrescenta.

SELECT is(
  pg_temp.rejected_sqlstate($$
    INSERT INTO public.response_equivalences
      (project_id, document_id, field_name, response_a_id, response_b_id, reviewer_id)
    VALUES
      ('62520000-0000-0000-0000-000000000001',
       '62530000-0000-0000-0000-00000000000A',
       'q1',
       '62540000-0000-0000-000a-0000000000aa',
       '62540000-0000-0000-000b-0000000000cc',
       '62510000-0000-0000-0000-000000000001')
  $$),
  'P0001',
  'equivalência cruzada é recusada pelo trigger (comportamento vigente)'
);

ALTER TABLE public.response_equivalences
  DISABLE TRIGGER snapshot_response_equivalence_answers;

SELECT is(
  pg_temp.rejected_constraint($$
    INSERT INTO public.response_equivalences
      (project_id, document_id, field_name, response_a_id, response_b_id, reviewer_id)
    VALUES
      ('62520000-0000-0000-0000-000000000001',
       '62530000-0000-0000-0000-00000000000A',
       'q1',
       '62540000-0000-0000-000a-0000000000aa',
       '62540000-0000-0000-000b-0000000000cc',
       '62510000-0000-0000-0000-000000000001')
  $$),
  'response_equivalences_document_response_b_fk',
  'sem o trigger, a FK recusa a equivalência cruzada sozinha'
);

ALTER TABLE public.response_equivalences
  ENABLE TRIGGER snapshot_response_equivalence_answers;

SELECT is(
  pg_temp.rejected_constraint($$
    INSERT INTO public.response_equivalences
      (project_id, document_id, field_name, response_a_id, response_b_id, reviewer_id)
    VALUES
      ('62520000-0000-0000-0000-000000000001',
       '62530000-0000-0000-0000-00000000000A',
       'q1',
       '62540000-0000-0000-000a-0000000000aa',
       '62540000-0000-0000-000a-0000000000cc',
       '62510000-0000-0000-0000-000000000001')
  $$),
  NULL,
  'equivalência entre responses do mesmo documento passa'
);

-- ========== field_reviews ===================================================

-- Aqui a amarra vale dobrado: um par (humano, LLM) cruzando documento faria a
-- arbitragem comparar respostas de textos diferentes, e o veredito seria
-- gravado como se fosse do documento da linha.
--
-- Mesma estrutura de dois casos da seção anterior, e pelo mesmo motivo: o
-- trigger `snapshot_field_review_cycle` já recusa o par cruzado ("field review
-- responses must match its project, document, and reviewer"), então só com ele
-- desabilitado é possível provar que a FK morde por conta própria.
SELECT is(
  pg_temp.rejected_sqlstate($$
    INSERT INTO public.field_reviews
      (project_id, document_id, field_name, human_response_id, llm_response_id,
       self_reviewer_id)
    VALUES
      ('62520000-0000-0000-0000-000000000001',
       '62530000-0000-0000-0000-00000000000A',
       'q1',
       '62540000-0000-0000-000b-0000000000aa',
       '62540000-0000-0000-000a-0000000000cc',
       '62510000-0000-0000-0000-000000000002')
  $$),
  'P0001',
  'field_review cruzado é recusado pelo trigger (comportamento vigente)'
);

ALTER TABLE public.field_reviews DISABLE TRIGGER snapshot_field_review_cycle;

SELECT is(
  pg_temp.rejected_constraint($$
    INSERT INTO public.field_reviews
      (project_id, document_id, field_name, human_response_id, llm_response_id,
       self_reviewer_id)
    VALUES
      ('62520000-0000-0000-0000-000000000001',
       '62530000-0000-0000-0000-00000000000A',
       'q1',
       '62540000-0000-0000-000b-0000000000aa',
       '62540000-0000-0000-000a-0000000000cc',
       '62510000-0000-0000-0000-000000000002')
  $$),
  'field_reviews_document_human_response_fk',
  'sem o trigger, a FK recusa human_response de outro documento'
);

SELECT is(
  pg_temp.rejected_constraint($$
    INSERT INTO public.field_reviews
      (project_id, document_id, field_name, human_response_id, llm_response_id,
       self_reviewer_id)
    VALUES
      ('62520000-0000-0000-0000-000000000001',
       '62530000-0000-0000-0000-00000000000A',
       'q2',
       '62540000-0000-0000-000a-0000000000aa',
       '62540000-0000-0000-000b-0000000000cc',
       '62510000-0000-0000-0000-000000000002')
  $$),
  'field_reviews_document_llm_response_fk',
  'sem o trigger, a FK recusa llm_response de outro documento'
);

ALTER TABLE public.field_reviews ENABLE TRIGGER snapshot_field_review_cycle;

SELECT is(
  pg_temp.rejected_constraint($$
    INSERT INTO public.field_reviews
      (project_id, document_id, field_name, human_response_id, llm_response_id,
       self_reviewer_id)
    VALUES
      ('62520000-0000-0000-0000-000000000001',
       '62530000-0000-0000-0000-00000000000A',
       'q3',
       '62540000-0000-0000-000a-0000000000aa',
       '62540000-0000-0000-000a-0000000000cc',
       '62510000-0000-0000-0000-000000000002')
  $$),
  NULL,
  'field_review com os dois lados do mesmo documento passa'
);

SELECT * FROM finish();

ROLLBACK;
