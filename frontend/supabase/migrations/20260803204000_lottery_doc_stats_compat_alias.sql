-- Mantem o contrato legado durante o deploy em duas etapas: esta migration de
-- compatibilidade entra antes do frontend novo, portanto ambas as versoes
-- precisam ler a mesma informacao de ocupacao da rodada atual.

CREATE OR REPLACE VIEW public.lottery_doc_stats
WITH (security_invoker = true) AS
WITH canonical AS (
  SELECT
    document.id,
    document.project_id,
    document.external_id,
    document.title,
    COALESCE(response_stats.human_coding_count, 0)::integer AS human_coding_count,
    COALESCE(response_stats.has_llm_response, false) AS has_llm_response,
    COALESCE(assignment_stats.active_codificacao, 0)::integer AS active_codificacao,
    COALESCE(assignment_stats.active_comparacao, 0)::integer AS active_comparacao,
    COALESCE(assignment_stats.has_assignment_in_current_round, false)
      AS has_assignment_in_current_round,
    COALESCE(assignment_stats.batch_ids, ARRAY[]::uuid[]) AS batch_ids
  FROM public.documents AS document
  JOIN public.projects AS project ON project.id = document.project_id
  LEFT JOIN LATERAL (
    SELECT
      count(DISTINCT response.respondent_id)
        FILTER (WHERE response.respondent_type = 'humano') AS human_coding_count,
      bool_or(response.respondent_type = 'llm') AS has_llm_response
    FROM public.responses AS response
    WHERE response.document_id = document.id
      AND response.project_id = document.project_id
      AND response.round_id = project.current_round_id
      AND response.is_latest = true
  ) AS response_stats ON true
  LEFT JOIN LATERAL (
    SELECT
      count(*) FILTER (
        WHERE assignment.type = 'codificacao'
          AND assignment.status IN ('pendente', 'em_andamento')
      ) AS active_codificacao,
      count(*) FILTER (
        WHERE assignment.type = 'comparacao'
          AND assignment.status IN ('pendente', 'em_andamento')
      ) AS active_comparacao,
      count(*) > 0 AS has_assignment_in_current_round,
      array_agg(DISTINCT assignment.batch_id)
        FILTER (WHERE assignment.batch_id IS NOT NULL) AS batch_ids
    FROM public.assignments AS assignment
    WHERE assignment.document_id = document.id
      AND assignment.project_id = document.project_id
      AND assignment.round_id = project.current_round_id
  ) AS assignment_stats ON true
  WHERE document.excluded_at IS NULL
    AND document.exclusion_pending_at IS NULL
)
SELECT
  canonical.*,
  canonical.has_assignment_in_current_round AS has_any_assignment_ever
FROM canonical;

REVOKE ALL ON public.lottery_doc_stats FROM PUBLIC, anon;
GRANT SELECT ON public.lottery_doc_stats TO authenticated, service_role;
