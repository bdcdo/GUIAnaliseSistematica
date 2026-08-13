import { Suspense } from "react";
import { createSupabaseServer } from "@/lib/supabase/server";
import {
  getProjectAccessContext,
  resolveProjectQueueIdentity,
} from "@/lib/auth";
import { requirePageAuthUser } from "@/lib/page-auth";
import { requireResolvedProjectAccess } from "@/lib/project-access";
import { ComparePage } from "@/components/compare/ComparePage";
import {
  readCompareFilters,
  compareDefaultsForMode,
  assignedCompareDocIds,
  resolveShowAllQueue,
} from "@/lib/compare-filters";
import {
  deriveProjectVersionContext,
  resolveMinVersion,
  latestMajorAnchor,
  formatVersion,
} from "@/lib/compare-version";
import {
  buildEquivalenceMap,
  indexResponsesByDoc,
  extractRespondentNames,
  buildAvailableVersions,
  buildCodingAssignedByDoc,
  buildCompareAssignmentStatusByDoc,
  qualifyDocumentsForCompare,
  buildDocumentsForCompare,
  buildReviewsAndReviewedCounts,
  buildCountsByKey,
  sortDocumentsByPendingDivergence,
  serializeEquivalencesForClient,
} from "@/lib/compare-queue";
import type { PydanticField } from "@/lib/types";

export type { DocCoverage } from "@/lib/compare-queue";

export default async function ComparePageRoute({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const [{ id }, sp, user, supabase] = await Promise.all([
    params,
    searchParams,
    requirePageAuthUser(),
    createSupabaseServer(),
  ]);

  const [
    { data: project },
    { data: allResponses, error: responsesError },
    { data: versionLog },
    { data: allAssignments },
    { data: allEquivalences },
    rawAccess,
  ] = await Promise.all([
    supabase
      .from("projects")
      .select(
        "pydantic_hash, pydantic_fields, min_responses_for_comparison, schema_version_major, schema_version_minor, schema_version_patch, automation_mode",
      )
      .eq("id", id)
      .single(),
    supabase
      .from("responses")
      // `documents!inner` + filtro excluded_at: documentos arquivados não
      // entram na fila de comparação (consistente com a contagem de B4).
      .select(
        "id, document_id, respondent_type, respondent_name, respondent_id, answers, justifications, is_latest, is_partial, pydantic_hash, answer_field_hashes, schema_version_major, schema_version_minor, schema_version_patch, created_at, documents!inner(id, title, external_id)",
      )
      .eq("project_id", id)
      .is("documents.excluded_at", null)
      .is("documents.exclusion_pending_at", null)
      .limit(5000),
    supabase
      .from("schema_change_log")
      .select("version_major, version_minor, version_patch")
      .eq("project_id", id)
      .not("version_major", "is", null)
      .order("created_at", { ascending: false }),
    supabase
      .from("assignments")
      .select("document_id, user_id, type, status")
      .eq("project_id", id),
    supabase
      .from("response_equivalences")
      // Project-scoped fetch (RLS filters anyway). For very large projects
      // it might be worth gating by `qualifiedDocIds` in a 2-phase fetch,
      // but volume should stay low — pairs are only created on free-text
      // divergences. Revisit if it becomes a bottleneck.
      .select(
        "id, document_id, field_name, response_a_id, response_b_id, reviewer_id, response_a_answer_snapshot, response_b_answer_snapshot",
      )
      .eq("project_id", id)
      .is("superseded_at", null),
    getProjectAccessContext(id, user),
  ]);
  const access = requireResolvedProjectAccess(rawAccess);

  // Fila pessoal pertence à identidade canônica; a impersonação master
  // (?viewAsUser=, mesmo param do Codificar) tem precedência. Uma falha na
  // resolução interrompe a rota em vez de parecer uma fila vazia.
  const { ownMemberUserId, queueUserId, isImpersonating } =
    resolveProjectQueueIdentity(access, sp.viewAsUser);

  // Build (docId, fieldName) -> EquivalencePair[] map. Used both for divergence
  // detection on the server and for fusing answer cards on the client.
  const equivByDocField = buildEquivalenceMap(allEquivalences);

  // Fail-CLOSED (ao contrario de comments/llm-insights): showAllQueue decide
  // quais documentos aparecem na fila — quem não pediu "todos" ve so os
  // atribuidos a si (compareAssignedDocIds). A policy RLS deixa qualquer
  // membro ler todas as responses, entao esse recorte e so aplicacional;
  // fail-open exporia documentos/respostas de terceiros em erro transitorio.
  const { isCoordinator } = access;

  // Coordenador também compara documentos (não só supervisiona) — por isso o
  // padrão é a fila pessoal dele, igual pesquisador. "Todos" é uma escolha
  // explícita via aba/param `queue=all`, só alcançável por coordenador (um
  // não-coordenador nunca chega a showAllQueue=true, mesmo editando a URL).
  // resolveShowAllQueue é testada isoladamente (ver compare-filters.test.ts) —
  // é a mesma classe de expressão que já causou o bug original desta página.
  const showAllQueue = resolveShowAllQueue(isCoordinator, sp.queue);

  const fields = (project?.pydantic_fields || []) as PydanticField[];

  if (responsesError) {
    console.error("Failed to fetch responses for compare:", responsesError.message);
    return (
      <div className="flex h-full items-center justify-center text-destructive">
        Erro ao carregar respostas. Tente novamente.
      </div>
    );
  }

  // Defaults da fila derivados do modo de automação do projeto. Em compare_llm
  // o piso de humanos cai para 1 (a 2ª resposta exigida por minTotal é o LLM) —
  // sem isso a aba ficaria vazia para documentos de 1 codificador + LLM. A
  // revisora ainda pode estreitar a lente via o filtro `min_humans` na URL.
  const compareDefaults = compareDefaultsForMode(
    project?.automation_mode,
    project?.min_responses_for_comparison ?? 2,
  );
  const filters = readCompareFilters(sp, compareDefaults);

  // Contexto de versão do helper compartilhado (compare-version.ts) — a MESMA
  // fonte e fallback {0,1,0} do fecho (compare-sync.ts) e do gatilho
  // (auto-comparison.ts). A página resolve seu `minVersion` a partir da URL
  // (`filters.version`, que pode ser uma lente manual), não da constante.
  const { version: projectVersion, ctx: projectVersionCtx } =
    deriveProjectVersionContext(project ?? {});
  const minVersion = resolveMinVersion(filters.version, projectVersion);
  const sinceMs = filters.since ? new Date(filters.since).getTime() : null;

  // Build distinct ordered version list desc — une versões do schema_change_log
  // com as efetivamente gravadas em responses (cobre respostas cuja versão
  // veio do backfill por hashes/created_at e não tem entry classificada no log).
  const availableVersions = buildAvailableVersions(versionLog, allResponses);
  const latestMajorLabel = formatVersion(latestMajorAnchor(projectVersion));

  // Compare-type assignments filter (ver assignedCompareDocIds).
  const compareAssignedDocIds = assignedCompareDocIds(
    showAllQueue,
    allAssignments,
    queueUserId,
  );

  // Distingue "sem nada atribuído" de "tem atribuído, mas foi filtrado por
  // cobertura/divergência" — usado só pela mensagem de estado vazio em
  // ComparePage (trocar de aba não resolve o segundo caso). Só é não-null
  // quando showAllQueue=false (aba "Meus"), que é justamente quando a
  // mensagem é exibida.
  const hasAssignedDocs = (compareAssignedDocIds?.size ?? 0) > 0;

  // Coding-type assignments map per doc (denominator for % atribuídos)
  const codingAssignedByDoc = buildCodingAssignedByDoc(allAssignments);

  // Status per user-doc for compare assignment (used in list and panel)
  const compareAssignmentStatusByDoc = buildCompareAssignmentStatusByDoc(
    allAssignments,
    showAllQueue,
    queueUserId,
  );

  const { responsesByDoc, docsMetaMap } = indexResponsesByDoc(allResponses);

  // Respondent names list (do conjunto todo, antes de filtrar)
  const respondentNames = extractRespondentNames(allResponses);

  const { qualifiedDocIds, divergentFields, responsesMap, coverageByDoc } =
    qualifyDocumentsForCompare(responsesByDoc, docsMetaMap, {
      compareAssignedDocIds,
      codingAssignedByDoc,
      compareAssignmentStatusByDoc,
      filters,
      minVersion,
      projectVersionCtx,
      sinceMs,
      fields,
      equivByDocField,
    });

  // Fetch text + reviews + comment counts
  const [{ data: docTexts }, { data: reviews }, { data: commentCounts }, { data: suggestionCounts }] =
    await Promise.all([
      qualifiedDocIds.length > 0
        ? supabase
            .from("documents")
            .select("id, text")
            .in("id", qualifiedDocIds)
            .is("excluded_at", null)
            .is("exclusion_pending_at", null)
        : Promise.resolve({ data: [] as { id: string; text: string }[] }),
      // Só os reviews da identidade efetiva: a revisão é por revisor e este
      // fetch alimenta exclusivamente existingReviews/reviewedCount (ver
      // buildReviewsAndReviewedCounts). Vereditos de terceiros contaminavam o
      // estado "já revisado" da tela e travavam o fecho do parecer.
      supabase
        .from("reviews")
        .select("document_id, field_name, verdict, chosen_response_id, comment, reviewer_id")
        .eq("project_id", id)
        .eq("reviewer_id", queueUserId),
      supabase
        .from("project_comments")
        .select("document_id, field_name")
        .eq("project_id", id)
        .is("resolved_at", null),
      supabase
        .from("schema_suggestions")
        .select("field_name")
        .eq("project_id", id)
        .eq("status", "pending"),
    ]);

  const textMap = new Map((docTexts || []).map((d) => [d.id, d.text]));

  // textMap so contem docs com excluded_at IS NULL (filtro acima). Usar como
  // gate final garante que docs soft-deletados saiam da comparacao por
  // completo, nao apenas com texto vazio.
  const documentsForCompareUnsorted = buildDocumentsForCompare(qualifiedDocIds, textMap, docsMetaMap);

  // Track reviews da identidade efetiva para preencher reviewedCount — na
  // impersonação, o progresso exibido é o do dono da fila, não o do master.
  const { existingReviews, reviewedCountByDoc } = buildReviewsAndReviewedCounts(
    reviews,
    queueUserId,
    qualifiedDocIds,
    divergentFields,
  );
  for (const docId of qualifiedDocIds) {
    coverageByDoc[docId].reviewedCount = reviewedCountByDoc[docId] ?? 0;
  }

  // Build comment+suggestion counts by (doc, field)
  const { commentCountsByKey, suggestionCountsByField } = buildCountsByKey(
    commentCounts,
    suggestionCounts,
  );

  // Sort docs: most unreviewed divergences first
  const documentsForCompare = sortDocumentsByPendingDivergence(
    documentsForCompareUnsorted,
    coverageByDoc,
  );

  // Serialize equivalences for the client component (Maps don't cross the
  // RSC boundary). Only ship pairs for documents in the qualified list.
  const equivalencesByDocField = serializeEquivalencesForClient(equivByDocField, qualifiedDocIds);

  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Carregando…</div>}>
      <ComparePage
        projectId={id}
        documents={documentsForCompare}
        responses={responsesMap}
        divergentFields={divergentFields}
        fields={fields}
        existingReviews={existingReviews}
        projectPydanticHash={project?.pydantic_hash ?? null}
        respondentNames={respondentNames}
        defaultMinHumans={compareDefaults.minHumans}
        defaultVersion={compareDefaults.version}
        coverageByDoc={coverageByDoc}
        commentCountsByKey={commentCountsByKey}
        suggestionCountsByField={suggestionCountsByField}
        availableVersions={availableVersions}
        latestMajorLabel={latestMajorLabel}
        currentProjectVersion={`${projectVersion.major}.${projectVersion.minor}.${projectVersion.patch}`}
        equivalencesByDocField={equivalencesByDocField}
        currentUserId={ownMemberUserId}
        canManageAnyPair={isCoordinator}
        isCoordinator={isCoordinator}
        queueContext={{
          showingAll: showAllQueue,
          hasAssignedDocs,
          isImpersonating,
        }}
      />
    </Suspense>
  );
}
