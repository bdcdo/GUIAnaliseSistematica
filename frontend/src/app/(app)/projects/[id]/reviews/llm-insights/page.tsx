import { createSupabaseServer } from "@/lib/supabase/server";
import { getProjectAccessContext } from "@/lib/auth";
import { requirePageAuthUser } from "@/lib/page-auth";
import { coordinatorGate } from "@/lib/project-access";
import { LlmInsightsView } from "@/components/stats/LlmInsightsView";
import { fetchAllPaged } from "@/lib/supabase/fetch-all-paged";
import {
  computeLlmErrorMetrics,
  type MetricsEquivalence,
  type MetricsFinalAnswer,
  type MetricsResponse,
  type MetricsReview,
} from "@/lib/llm-error-metrics";
import type { PydanticField } from "@/lib/types";

// Carga de dados da página. Fora do componente porque o RSC fica ilegível com
// sete queries inline — e porque a lista de colunas é o contrato real com
// `computeLlmErrorMetrics`.
async function loadInsightsData(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  id: string,
  user: Awaited<ReturnType<typeof requirePageAuthUser>>,
) {
  const [
    { data: project },
    { data: responses },
    { data: reviews },
    { data: documents },
    { data: errorResolutions },
    { data: equivalencePairs },
    { data: finalAnswers, error: finalAnswersError },
    accessResult,
  ] = await Promise.all([
    supabase
      .from("projects")
      .select(
        "pydantic_fields, schema_revision, automation_mode",
      )
      .eq("id", id)
      .single(),
    // Todas as responses, de todas as rodadas e dos dois tipos de respondente:
    // o union-find de equivalência precisa dos dois endpoints de cada par, e
    // `chosen_response_id` pode apontar para uma resposta que não é mais
    // `is_latest`. Paginado — um projeto grande passa de 1000 responses.
    fetchAllPaged<MetricsResponse>(() =>
      supabase
        .from("responses")
        .select(
          "id, document_id, respondent_type, is_latest, answers, justifications, answer_field_hashes, created_at, schema_version_major, schema_version_minor, schema_version_patch",
        )
        .eq("project_id", id),
    ),
    fetchAllPaged<MetricsReview>(() =>
      supabase
        .from("reviews")
        .select(
          "document_id, field_name, verdict, chosen_response_id, comment, created_at",
        )
        .eq("project_id", id)
        .not("chosen_response_id", "is", null),
    ),
    supabase
      .from("documents")
      .select("id, title, external_id")
      .eq("project_id", id)
      .is("excluded_at", null)
      .is("exclusion_pending_at", null),
    supabase
      .from("error_resolutions")
      .select("document_id, field_name, resolved_at")
      .eq("project_id", id),
    // As colunas de snapshot são obrigatórias: `filterCurrentEquivalencePairs`
    // é fail-closed e descarta todo par que venha sem elas.
    fetchAllPaged<MetricsEquivalence>(() =>
      supabase
        .from("response_equivalences")
        .select(
          "document_id, field_name, response_a_id, response_b_id, response_a_answer_snapshot, response_b_answer_snapshot",
        )
        .eq("project_id", id)
        .is("superseded_at", null),
    ),
    // Fonte de veredito do fluxo de auto-revisão. A RPC desse fluxo grava em
    // `field_reviews` e nunca em `reviews`, então sem esta query os projetos
    // em `automation_mode = 'auto_review_llm'` não teriam taxa nenhuma.
    fetchAllPaged<MetricsFinalAnswer>(() =>
      supabase
        .from("final_answers")
        .select(
          "document_id, field_name, provenance, final_verdict, self_reviewed_at, final_decided_at, human_response_id, llm_response_id, human_answer_snapshot, llm_answer_snapshot",
        )
        .eq("project_id", id),
    ),
    getProjectAccessContext(id, user),
  ]);

  return {
    project,
    responses,
    reviews,
    documents,
    errorResolutions,
    equivalencePairs,
    finalAnswers,
    finalAnswersError,
    accessResult,
  };
}

// Documentos que o LLM respondeu e que a métrica ainda não alcançou — o
// rodapé dos cards avisa que a taxa não cobre o projeto inteiro.
function buildSummary(
  responses: MetricsResponse[],
  reviewedEntries: { documentId: string }[],
): { totalLlmDocs: number; unreviewedLlmDocs: number } {
  const llmDocIds = new Set(
    responses
      .filter((r) => r.respondent_type === "llm" && r.is_latest)
      .map((r) => r.document_id),
  );
  const measuredDocIds = new Set(reviewedEntries.map((e) => e.documentId));
  return {
    totalLlmDocs: llmDocIds.size,
    unreviewedLlmDocs: [...llmDocIds].filter((id) => !measuredDocIds.has(id)).length,
  };
}

export default async function LlmInsightsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, user, supabase] = await Promise.all([
    params,
    requirePageAuthUser(),
    createSupabaseServer(),
  ]);

  const {
    project,
    responses,
    reviews,
    documents,
    errorResolutions,
    equivalencePairs,
    finalAnswers,
    finalAnswersError,
    accessResult,
  } = await loadInsightsData(supabase, id, user);

  // A fonte de auto-revisão some sem quebrar a página se a query falhar — o
  // que aconteceria numa janela de deploy em que o código já subiu mas a
  // migration que expõe os vereditos em `final_answers` ainda não foi
  // aplicada. Silêncio aqui seria uma taxa incompleta sem aviso nenhum.
  if (finalAnswersError) {
    console.error(
      `[llm-insights] projeto ${id}: fonte de auto-revisão indisponível, taxa calculada só com a Comparação —`,
      finalAnswersError.message,
    );
  }

  // Fail-open em contexto de acesso indisponível (erro transitório de query):
  // não rebaixa um coordenador legítimo a não-coordenador por falha transiente.
  // Seguro aqui porque isCoordinator só liga affordances no LlmInsightsView
  // (a view não recorta dados por papel) e as mutações por trás delas
  // re-checam via requireCoordinator (fail-closed).
  // NB: ao contrário de config/rounds, o layout-pai reviews/layout.tsx NÃO
  // gateia coordenador (só exige usuário autenticado) — a segurança do
  // fail-open aqui depende inteiramente do affordance-only acima, não de um
  // backstop no layout.
  const isCoordinator = coordinatorGate(accessResult, { failOpen: true });

  const allFields = (project?.pydantic_fields || []) as PydanticField[];
  const schemaBaseline = {
    revision: project?.schema_revision ?? 0,
  };

  const { errors, reviewedEntries } = computeLlmErrorMetrics({
    fields: allFields,
    automationMode: project?.automation_mode ?? null,
    documentTitles: new Map(
      documents?.map((d) => [d.id, d.title || d.external_id || d.id]) || [],
    ),
    responses,
    reviews,
    finalAnswers,
    equivalences: equivalencePairs,
    errorResolutions: new Map(
      errorResolutions?.map((r) => [
        `${r.document_id}:${r.field_name}`,
        r.resolved_at,
      ]) || [],
    ),
  });

  const summary = buildSummary(responses, reviewedEntries);

  // Visible fields for the dropdown filter (same criteria as the error suppression).
  const visibleFields = allFields.filter(
    (f) => f.target !== "llm_only" && f.target !== "none",
  );

  return (
    <div className="mx-auto max-w-4xl p-6">
      <LlmInsightsView
        projectId={id}
        errors={errors}
        reviewedEntries={reviewedEntries}
        fields={visibleFields}
        schemaEditor={{ fields: allFields, baseline: schemaBaseline }}
        isCoordinator={isCoordinator}
        summary={summary}
      />
    </div>
  );
}
