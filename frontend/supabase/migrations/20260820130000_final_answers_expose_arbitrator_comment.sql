-- Acrescenta `arbitrator_comment` a `final_answers`.
--
-- A 20260820120000 expôs os vereditos do ciclo de auto-revisão para a métrica
-- de erro do LLM, mas deixou de fora o comentário que o arbitrador escreve ao
-- decidir (`field_reviews.arbitrator_comment`, gravado em
-- `submit_final_verdicts` e nas RPCs de arbitragem). O consumidor já o lia, e
-- por isso todo erro vindo da auto-revisão chegava à UI com "Comentário do
-- revisor" vazio mesmo havendo texto no banco — perda silenciosa de contexto
-- justamente no caso em que houve desacordo entre humano e LLM.
--
-- Migration separada, e não edição da anterior, porque aquela já foi aplicada
-- no remoto: reescrever um arquivo de migration já registrado não o reaplica.

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
  fr.llm_answer_snapshot,
  fr.arbitrator_comment
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

-- CREATE OR REPLACE VIEW preserva os grants existentes, mas reafirmamos o
-- estado desejado. REVOKE ALL (e não apenas SELECT) para não reabrir a brecha
-- fechada em 20260724140000_revoke_anon_from_public_views: `final_answers`
-- carregava bits de INSERT/UPDATE/DELETE para anon que um REVOKE restrito a
-- SELECT deixaria intactos.
-- Mesmo racional de grants da 20260820120000: REVOKE ALL, não apenas SELECT.
REVOKE ALL ON public.final_answers FROM anon;
GRANT SELECT ON public.final_answers TO authenticated, service_role;

COMMIT;
