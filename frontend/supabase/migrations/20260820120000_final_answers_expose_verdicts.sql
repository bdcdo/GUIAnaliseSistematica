-- Expõe em `final_answers` os vereditos crus e os snapshots do ciclo de
-- auto-revisão, para que a métrica de erro do LLM (LLM Insights) possa
-- classificar cada (documento, campo) sem reimplementar em TypeScript o mapa
-- de proveniência que já vive nesta view — inclusive o estado
-- `aguarda_reconciliacao`, derivado de `is_auto_review_reconciliation_pending`.
--
-- `provenance` sozinho não basta: 'arbitrado' cobre tanto "o LLM errou"
-- (final_verdict = 'humano') quanto "o LLM acertou" (final_verdict = 'llm'),
-- e a métrica precisa separar os dois. Os timestamps servem à deduplicação
-- contra a tabela `reviews`, que registra o veredito do fluxo de Comparação —
-- um projeto que trocou de `automation_mode` tem histórico nas duas tabelas
-- para o mesmo (documento, campo), sem constraint cruzada que o impeça.
--
-- Os snapshots são os valores exatos sobre os quais o veredito foi dado, e por
-- isso descrevem o erro melhor que a resposta atual, que pode ter sido
-- revisada depois. São NULL em 'consenso' (não há linha em `field_reviews`),
-- caso que nunca é erro.
--
-- Colunas são acrescentadas ao FINAL: é o que CREATE OR REPLACE VIEW permite
-- sem DROP, preservando os grants e quaisquer dependências existentes.

BEGIN;

CREATE OR REPLACE VIEW public.final_answers
WITH (security_invoker = true) AS
SELECT
  r_llm.project_id,
  r_llm.document_id,
  fld.field_name,
  CASE
    WHEN reconciliation.pending THEN NULL
    WHEN fr.id IS NULL THEN r_llm.answers -> fld.field_name
    WHEN fr.self_verdict IS NULL THEN NULL
    WHEN fr.self_verdict = 'admite_erro' THEN fr.llm_answer_snapshot
    WHEN fr.self_verdict = 'equivalente' THEN fr.human_answer_snapshot
    WHEN fr.self_verdict = 'ambiguo' THEN NULL
    WHEN fr.final_verdict IS NULL THEN NULL
    WHEN fr.final_verdict = 'humano' THEN fr.human_answer_snapshot
    WHEN fr.final_verdict = 'llm' THEN fr.llm_answer_snapshot
    ELSE NULL
  END AS answer,
  CASE
    WHEN reconciliation.pending THEN 'aguarda_reconciliacao'
    WHEN fr.id IS NULL THEN 'consenso'
    WHEN fr.self_verdict IS NULL THEN 'aguarda_auto_revisao'
    WHEN fr.self_verdict = 'admite_erro' THEN 'auto_corrigido'
    WHEN fr.self_verdict = 'equivalente' THEN 'equivalente'
    WHEN fr.self_verdict = 'ambiguo' THEN 'ambiguo'
    WHEN fr.final_verdict IS NULL THEN 'aguarda_arbitragem'
    ELSE 'arbitrado'
  END AS provenance,
  fr.id AS field_review_id,
  fr.changed_after_justification,
  fr.cycle_no,
  fr.self_verdict,
  fr.final_verdict,
  fr.self_reviewed_at,
  fr.final_decided_at,
  fr.human_response_id,
  fr.llm_response_id,
  fr.human_answer_snapshot,
  fr.llm_answer_snapshot
FROM public.responses AS r_llm
JOIN public.projects AS project ON project.id = r_llm.project_id
CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
  COALESCE(project.pydantic_fields, '[]'::JSONB)
) AS field_raw
CROSS JOIN LATERAL (SELECT field_raw->>'name' AS field_name) AS fld
LEFT JOIN public.field_reviews AS fr
  ON fr.document_id = r_llm.document_id
  AND fr.field_name = fld.field_name
  AND fr.superseded_at IS NULL
CROSS JOIN LATERAL (
  SELECT public.is_auto_review_reconciliation_pending(
    r_llm.project_id, r_llm.document_id, r_llm.id
  ) AS pending
) AS reconciliation
WHERE r_llm.respondent_type = 'llm'
  AND r_llm.is_latest = true;

REVOKE SELECT ON public.final_answers FROM anon;
GRANT SELECT ON public.final_answers TO authenticated, service_role;

COMMIT;
