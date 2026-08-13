-- #678: `lottery_doc_stats.human_coding_count` contava rascunho nunca
-- submetido como codificação.
--
-- `is_partial` tem duas semânticas conforme o respondente. Para humano
-- significa "nunca submetida": o valor sai do botão, não do preenchimento
-- (`actions/responses.ts`, `isAutoSave`), com cliquet — uma vez enviada,
-- auto-save posterior não rebaixa o sinal. Para LLM significa "cobertura
-- abaixo do limiar da run", e a CHECK `responses_partial_llm_not_latest` já
-- garante que uma resposta LLM parcial nunca seja `is_latest`.
--
-- Daí a assimetria que produziu o defeito: `is_latest` equivale a "publicada"
-- para LLM, mas para humano significa apenas "a mais recente", submetida ou
-- não. A LATERAL abaixo usava `is_latest` como proxy de "codificou", então um
-- auto-save bastava para o documento sair da fila de codificação (o sorteio o
-- considerava coberto) e entrar na de comparação. Medido em 2026-08-10 sobre
-- dump de produção: 21 dos 194 documentos ativos do projeto Zolgensma.
--
-- A regra correta já existia no projeto — a auto-revisão exige
-- `is_partial = false` em seis camadas independentes. Era a comparação/sorteio
-- que não a aplicava.
--
-- O predicado equivalente no lado TypeScript é a regra 2 de
-- `responseQualifiesForVersion` (`lib/compare-version.ts`), que este PR
-- introduz na mesma passagem. São duas cópias da mesma regra em fronteiras
-- diferentes (SQL e TS), então cada uma tem teste próprio — prática 4 de
-- `docs/VERIFICATION.md`.
--
-- Único delta em relação a 20260803204000: a cláusula `is_partial = false` na
-- LATERAL de responses. O filtro atinge as duas agregações da LATERAL, mas é
-- no-op para `has_llm_response`, porque a CHECK acima impede que exista linha
-- LLM com `is_latest = true AND is_partial = true`.

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
      AND response.is_partial = false
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
