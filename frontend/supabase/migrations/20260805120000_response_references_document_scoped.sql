-- Toda referência a `responses` passa a carregar o documento (issues #625, #628).
--
-- Quatro colunas apontam para uma resposta sem dizer de qual documento ela é:
-- reviews.chosen_response_id, response_equivalences.response_a_id/_b_id e
-- field_reviews.human_response_id/llm_response_id. A FK de coluna única garante
-- que a resposta EXISTE; não garante que ela pertence ao documento da linha que
-- a referencia. O estado "veredito do documento A escolhendo resposta do
-- documento B" era construível, e foi construído: a #623 reparou 3 vereditos
-- gravados no campo/documento errado, produzidos em 27/07 com o defeito ativo.
--
-- A #603 (FKs compostas project-scoped) NÃO fecha isso. Duas respostas do mesmo
-- projeto e de documentos diferentes satisfazem qualquer FK que só carregue
-- project_id — que é exatamente a forma do bug. O escopo certo é o documento,
-- que é estritamente mais estreito e já implica o projeto.
--
-- A invariante `review-chosen-response-do-mesmo-documento`
-- (frontend/scripts/invariants/check-invariants.ts) existe justamente porque
-- "FK garante existência, não coerência". Ela continua valendo como detector do
-- histórico; daqui para a frente o estado deixa de ser construível.
--
-- Medição em produção (2026-08-04, harness/2026-08-04-fk-document-scoped/,
-- read-only, 1.179 responses / 1.482 reviews / 325 equivalences / 535
-- field_reviews): ZERO violações vivas nas cinco colunas, zero document_id nulo
-- em responses e reviews, com controle provando que o detector acusaria um par
-- forjado. Ou seja: o resíduo da #628 já foi reparado pela #623 — esta migration
-- fecha uma garantia ausente, não conserta estrago em curso. Por isso as
-- restrições entram VALIDADAS, e não NOT VALID: não há histórico a tolerar.

BEGIN;

-- Estabiliza o conjunto entre o preflight e as restrições, fechando a janela
-- entre medir e restringir. Mesmo protocolo de
-- 20260727120000_responses_one_latest_human_per_document.sql.
LOCK TABLE
  public.responses,
  public.reviews,
  public.response_equivalences,
  public.field_reviews
IN SHARE ROW EXCLUSIVE MODE;

-- ========== Preflight: abortar nomeando o resíduo, nunca sanear =============
--
-- Não há reparo automático possível aqui, e a diferença importa: repontar a
-- referência para uma resposta "parecida" do documento certo é inventar qual
-- resposta a revisora quis escolher — falsificação de veredito. Apagar a linha
-- destrói revisão humana. Ambos exigem decisão caso a caso, que foi como a #623
-- tratou os 3 vereditos: identificados um a um, com a autora consultada.
--
-- Demover/apagar linha destas tabelas também não é inerte: o trigger
-- archive_review_dependencies_on_response_change (20260717120000) APAGA
-- field_reviews e response_equivalences cujo snapshot ficou obsoleto. Sanear
-- dentro de um `db push` esconderia isso.
DO $preflight$
DECLARE
  v_offenders TEXT;
BEGIN
  SELECT pg_catalog.string_agg(offender.descricao, '; ' ORDER BY offender.descricao)
    INTO v_offenders
  FROM (
    SELECT pg_catalog.format(
             'reviews %s (doc %s) escolhe response %s do doc %s',
             review.id, review.document_id, review.chosen_response_id,
             chosen.document_id) AS descricao
    FROM public.reviews AS review
    JOIN public.responses AS chosen ON chosen.id = review.chosen_response_id
    WHERE review.chosen_response_id IS NOT NULL
      AND review.document_id IS DISTINCT FROM chosen.document_id

    UNION ALL

    SELECT pg_catalog.format(
             'response_equivalences %s (doc %s) une responses dos docs %s e %s',
             equivalence.id, equivalence.document_id,
             side_a.document_id, side_b.document_id) AS descricao
    FROM public.response_equivalences AS equivalence
    JOIN public.responses AS side_a ON side_a.id = equivalence.response_a_id
    JOIN public.responses AS side_b ON side_b.id = equivalence.response_b_id
    WHERE equivalence.document_id IS DISTINCT FROM side_a.document_id
       OR equivalence.document_id IS DISTINCT FROM side_b.document_id

    UNION ALL

    SELECT pg_catalog.format(
             'field_reviews %s (doc %s, campo %s) aponta responses dos docs %s e %s',
             field_review.id, field_review.document_id, field_review.field_name,
             human.document_id, llm.document_id) AS descricao
    FROM public.field_reviews AS field_review
    JOIN public.responses AS human ON human.id = field_review.human_response_id
    JOIN public.responses AS llm ON llm.id = field_review.llm_response_id
    WHERE field_review.document_id IS DISTINCT FROM human.document_id
       OR field_review.document_id IS DISTINCT FROM llm.document_id
  ) AS offender;

  IF v_offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'referência a response cruzando documento: %', v_offenders
      USING ERRCODE = '23503',
            HINT = 'Não há reparo automático: repontar inventa a escolha da revisora e apagar destrói revisão humana. Decidir caso a caso, como na issue #623.';
  END IF;
END;
$preflight$;

-- reviews.document_id nulo tornaria a FK composta abaixo inerte para a linha:
-- FK MATCH SIMPLE (o default) não verifica NADA quando QUALQUER coluna da chave
-- é nula. Sem esta guarda a restrição existiria sem restringir — o mesmo modo de
-- falha que o CHECK de autoria de 20260727120000:117-128 evita no índice único.
-- Produção mede 0 nulos em 1.482 linhas. As demais tabelas já nascem NOT NULL.
DO $preflight_null$
DECLARE
  v_offenders TEXT;
BEGIN
  SELECT pg_catalog.string_agg(review.id::text, ', ' ORDER BY review.id)
    INTO v_offenders
  FROM public.reviews AS review
  WHERE review.document_id IS NULL;

  IF v_offenders IS NOT NULL THEN
    RAISE EXCEPTION 'reviews sem document_id: %', v_offenders
      USING ERRCODE = '23502',
            HINT = 'Um veredito sem documento não tem escopo; identifique o documento antes de aplicar.';
  END IF;
END;
$preflight_null$;

ALTER TABLE public.reviews ALTER COLUMN document_id SET NOT NULL;

-- ========== O alvo composto ================================================
--
-- Redundante em teoria — `id` já é PK, então (document_id, id) é único por
-- construção. Existe porque o Postgres exige que as colunas referenciadas por
-- uma FK sejam cobertas por uma restrição única; é o preço de expressar "esta
-- resposta, deste documento" como chave.
ALTER TABLE public.responses
  ADD CONSTRAINT responses_document_id_id_key UNIQUE (document_id, id);

-- ========== reviews ========================================================
--
-- DROP e ADD no MESMO ALTER TABLE, deliberadamente: duas FKs entre o mesmo par
-- de tabelas fazem o PostgREST devolver PGRST201 (relacionamento ambíguo) em
-- qualquer embed que passe a existir. Hoje `chosen_response_id` é lida só como
-- coluna crua (5 páginas, verificado), então nenhum embed quebra — mas deixar a
-- FK antiga viva plantaria a ambiguidade para o primeiro embed futuro.
--
-- Sem ON DELETE: preserva o NO ACTION original de 001_initial_schema.sql:161. O
-- contrato está documentado em 20260629120000:94 e 20260716120000:101 ("FK
-- chosen_response_id -> responses sem CASCADE"), e as RPCs de replace apagam
-- reviews ANTES de responses justamente por causa dele. Trocar para CASCADE aqui
-- faria vereditos sumirem em silêncio quando uma resposta é substituída.
ALTER TABLE public.reviews
  DROP CONSTRAINT IF EXISTS reviews_chosen_response_id_fkey,
  ADD CONSTRAINT reviews_document_chosen_response_fk
    FOREIGN KEY (document_id, chosen_response_id)
    REFERENCES public.responses (document_id, id);

-- ========== response_equivalences ==========================================
--
-- ON DELETE CASCADE preservado das FKs originais (20260504000000:20-21): apagar
-- uma resposta dissolve os pares que a incluíam.
ALTER TABLE public.response_equivalences
  DROP CONSTRAINT IF EXISTS response_equivalences_response_a_id_fkey,
  DROP CONSTRAINT IF EXISTS response_equivalences_response_b_id_fkey,
  ADD CONSTRAINT response_equivalences_document_response_a_fk
    FOREIGN KEY (document_id, response_a_id)
    REFERENCES public.responses (document_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT response_equivalences_document_response_b_fk
    FOREIGN KEY (document_id, response_b_id)
    REFERENCES public.responses (document_id, id) ON DELETE CASCADE;

-- ========== field_reviews ==================================================
--
-- ON DELETE CASCADE preservado de 20260513000001:23-24. Aqui a amarra vale
-- dobrado: field_reviews é a tabela da arbitragem, onde um par (humano, LLM)
-- cruzando documento faria a arbitragem comparar respostas de textos diferentes
-- — e o veredito resultante seria gravado como se fosse do documento da linha.
ALTER TABLE public.field_reviews
  DROP CONSTRAINT IF EXISTS field_reviews_human_response_id_fkey,
  DROP CONSTRAINT IF EXISTS field_reviews_llm_response_id_fkey,
  ADD CONSTRAINT field_reviews_document_human_response_fk
    FOREIGN KEY (document_id, human_response_id)
    REFERENCES public.responses (document_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT field_reviews_document_llm_response_fk
    FOREIGN KEY (document_id, llm_response_id)
    REFERENCES public.responses (document_id, id) ON DELETE CASCADE;

COMMIT;
