import { createSupabaseServer } from "@/lib/supabase/server";
import { getProjectAccessContext } from "@/lib/auth";
import { requirePageAuthUser } from "@/lib/page-auth";
import { coordinatorGate } from "@/lib/project-access";
import { LlmInsightsView } from "@/components/stats/LlmInsightsView";
import { fetchAllPaged } from "@/lib/supabase/fetch-all-paged";
import {
  computeLlmErrorMetrics,
  isMeasurableField,
  usesAutoReviewSource,
  type MetricsEquivalence,
  type MetricsFinalAnswer,
  type MetricsResponse,
  type MetricsReview,
} from "@/lib/llm-error-metrics";
import type { PydanticField } from "@/lib/types";

interface DocumentRow {
  id: string;
  title: string | null;
  external_id: string | null;
}

interface ErrorResolutionRow {
  document_id: string;
  field_name: string;
  resolved_at: string | null;
}

// Carga de dados da página. Fora do componente porque o RSC fica ilegível com
// sete queries inline — e porque a lista de colunas é o contrato real com
// `computeLlmErrorMetrics`.
//
// Duas fases, e não uma só: `automation_mode` decide se a view `final_answers`
// vale a pena, e ela é a query mais cara da página (`CROSS JOIN LATERAL` de
// `is_auto_review_reconciliation_pending`, SECURITY DEFINER e não-inlinável,
// uma execução por linha documento × campo — 2944 no Zolgensma). Pagar uma ida
// a mais ao banco em série é mais barato que varrer a view inteira para
// descartá-la em todo projeto que não usa auto-revisão.
type SupabaseServer = Awaited<ReturnType<typeof createSupabaseServer>>;

// As seis leituras de dados do projeto, com as colunas explícitas que formam o
// contrato real com `computeLlmErrorMetrics`. Todas paginadas com ordem total:
// ver `fetch-all-paged.ts` para por que a ordem é obrigatória.
function fetchMetricsSources(
  supabase: SupabaseServer,
  id: string,
  automationMode: string | null,
) {
  return Promise.all([
    // Todas as responses, de todas as rodadas e dos dois tipos de respondente:
    // o union-find de equivalência precisa dos dois endpoints de cada par, e
    // `chosen_response_id` pode apontar para uma resposta que não é mais
    // `is_latest`. Paginado — um projeto grande passa de 1000 responses.
    fetchAllPaged<MetricsResponse>(
      () =>
        supabase
          .from("responses")
          .select(
            "id, document_id, respondent_type, is_latest, answers, justifications, answer_field_hashes, created_at, schema_version_major, schema_version_minor, schema_version_patch",
          )
          .eq("project_id", id),
      ["id"],
    ),
    fetchAllPaged<MetricsReview>(
      () =>
        supabase
          .from("reviews")
          .select(
            "document_id, field_name, verdict, chosen_response_id, comment, created_at",
          )
          .eq("project_id", id)
          .not("chosen_response_id", "is", null),
      ["id"],
    ),
    // Só os documentos ativos: a métrica usa as CHAVES deste conjunto para
    // decidir o que medir, então um documento excluído some da taxa junto com
    // o título. Paginado pelo mesmo motivo das responses — sem isso, acima de
    // 1000 documentos o excedente sairia da métrica sem erro nenhum.
    fetchAllPaged<DocumentRow>(
      () =>
        supabase
          .from("documents")
          .select("id, title, external_id")
          .eq("project_id", id)
          .is("excluded_at", null)
          .is("exclusion_pending_at", null),
      ["id"],
    ),
    fetchAllPaged<ErrorResolutionRow>(
      () =>
        supabase
          .from("error_resolutions")
          .select("document_id, field_name, resolved_at")
          .eq("project_id", id),
      ["id"],
    ),
    // As colunas de snapshot são obrigatórias: `filterCurrentEquivalencePairs`
    // é fail-closed e descarta todo par que venha sem elas.
    fetchAllPaged<MetricsEquivalence>(
      () =>
        supabase
          .from("response_equivalences")
          .select(
            "document_id, field_name, response_a_id, response_b_id, response_a_answer_snapshot, response_b_answer_snapshot",
          )
          .eq("project_id", id)
          .is("superseded_at", null),
      ["id"],
    ),
    // Fonte de veredito do fluxo de auto-revisão. A RPC desse fluxo grava em
    // `field_reviews` e nunca em `reviews`, então sem esta query os projetos
    // em `automation_mode = 'auto_review_llm'` não teriam taxa nenhuma.
    // `final_answers` é view: não tem PK, e (documento, campo) é a ordem total
    // que a invariante de uma única resposta LLM `is_latest` por documento
    // sustenta.
    usesAutoReviewSource(automationMode)
      ? fetchAllPaged<MetricsFinalAnswer>(
          () =>
            supabase
              .from("final_answers")
              .select(
                "document_id, field_name, provenance, final_verdict, self_reviewed_at, final_decided_at, human_response_id, llm_response_id, human_answer_snapshot, llm_answer_snapshot, arbitrator_comment",
              )
              .eq("project_id", id),
          ["document_id", "field_name"],
        )
      : { data: [] as MetricsFinalAnswer[], error: null },
  ] as const);
}

// Falha numa fonte ESTRUTURAL não pode virar número: `fetchAllPaged` devolve o
// que já acumulou JUNTO com o erro, então ignorá-lo exibiria uma taxa calculada
// sobre um recorte arbitrário dos dados — ou "0 erros / 0%" sem aviso nenhum.
// As cinco são estruturais: sem `documents` a métrica mede zero documento, e
// sem `error_resolutions` erro já resolvido reaparece como aberto.
//
// `final_answers` fica de fora de propósito, e é a única: é fonte OPCIONAL, e o
// modo de falha esperado dela é a janela de deploy em que o código já subiu mas
// a migration que expõe os vereditos ainda não foi aplicada. Ali degradar para
// a Comparação é melhor que derrubar a página — mas em silêncio, não.
function firstStructuralError(
  results: ReadonlyArray<{ error: { message: string } | null }>,
): { message: string } | null {
  return results.find((result) => result.error)?.error ?? null;
}

async function loadInsightsData(
  supabase: SupabaseServer,
  id: string,
  user: Awaited<ReturnType<typeof requirePageAuthUser>>,
) {
  const [{ data: project }, accessResult] = await Promise.all([
    supabase
      .from("projects")
      .select("pydantic_fields, schema_revision, automation_mode")
      .eq("id", id)
      .single(),
    getProjectAccessContext(id, user),
  ]);

  const [
    responsesResult,
    reviewsResult,
    documentsResult,
    errorResolutionsResult,
    equivalencesResult,
    finalAnswersResult,
  ] = await fetchMetricsSources(supabase, id, project?.automation_mode ?? null);

  return {
    project,
    accessResult,
    responses: responsesResult.data,
    reviews: reviewsResult.data,
    documents: documentsResult.data,
    errorResolutions: errorResolutionsResult.data,
    equivalences: equivalencesResult.data,
    finalAnswers: finalAnswersResult.data,
    structuralError: firstStructuralError([
      responsesResult,
      reviewsResult,
      documentsResult,
      errorResolutionsResult,
      equivalencesResult,
    ]),
    finalAnswersError: finalAnswersResult.error,
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
    accessResult,
    responses,
    reviews,
    documents,
    errorResolutions,
    equivalences,
    finalAnswers,
    structuralError,
    finalAnswersError,
  } = await loadInsightsData(supabase, id, user);

  if (structuralError) {
    console.error(
      `[llm-insights] projeto ${id}: leitura incompleta, taxa não calculada —`,
      structuralError.message,
    );
    return (
      <div className="mx-auto max-w-4xl p-6">
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <p className="font-medium text-destructive">
            Não foi possível carregar a taxa de erro do LLM agora.
          </p>
          <p className="mt-1 text-muted-foreground">
            Parte dos dados não veio, e uma taxa calculada sobre dados
            incompletos seria enganosa. Isso costuma ser temporário — recarregue
            a página em instantes.
          </p>
        </div>
      </div>
    );
  }

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
      documents.map((d) => [d.id, d.title || d.external_id || d.id]),
    ),
    responses,
    reviews,
    finalAnswers,
    equivalences,
    errorResolutions: new Map(
      errorResolutions.map((r) => [
        `${r.document_id}:${r.field_name}`,
        r.resolved_at,
      ]),
    ),
  });

  const summary = buildSummary(responses, reviewedEntries);

  // O dropdown de filtro por campo lista exatamente os campos que a métrica
  // mede — mesmo predicado, não uma cópia dele (um campo `human_only` no filtro
  // seria uma opção que nunca casa com erro nenhum).
  const visibleFields = allFields.filter((f) => isMeasurableField(f));

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
