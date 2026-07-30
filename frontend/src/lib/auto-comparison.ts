import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { fetchAllPaged } from "@/lib/supabase/paginate";
import { buildLoadMap } from "@/lib/load-balancing";
import { computeDivergentFieldNames } from "@/lib/compare-divergence";
import { isCodingComplete } from "@/lib/coding-completeness";
import {
  responseQualifiesForVersion,
  versionGate,
  type ProjectVersionRow,
  type VersionedResponse,
} from "@/lib/compare-version";
import type { EquivalencePair } from "@/lib/equivalence";
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";

// Both factories return the same data-client shape. Coordinator flows pass an
// authenticated reader; automatic writes pass a service-role client.
type SupabaseDataClient = ReturnType<typeof createSupabaseAdmin>;

interface QueryResult<T> {
  data: T;
  error: { message: string } | null;
}

function queryData<T>(result: QueryResult<T>): T {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

// Modos de automação que materializam uma comparação (assignment type=comparacao)
// para um revisor terceiro. auto_review_llm e none não passam por aqui.
export type ComparisonMode = "compare_humans" | "compare_llm";

// Log estruturado JSON com prefixo "[auto-compare]" — pesquisavel em logs
// Vercel/Fly via `grep '[auto-compare]'`. Espelha o logger de lib/auto-review.ts.
function log(
  event: string,
  fields: Record<string, unknown>,
  level: "info" | "warn" | "error" = "info",
) {
  const payload = JSON.stringify({ event, ...fields });
  const line = `[auto-compare] ${payload}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

interface ResponseRow {
  id: string;
  respondent_id?: string | null;
  answers: Record<string, unknown> | null;
  answer_field_hashes: AnswerFieldHashes | null;
  // Campos de versão: necessários para aplicar o piso `latest_major` (#247),
  // o MESMO que a fila (compare/page.tsx) e o fecho (compare-sync.ts) usam.
  is_latest?: boolean;
  pydantic_hash?: string | null;
  schema_version_major?: number | null;
  schema_version_minor?: number | null;
  schema_version_patch?: number | null;
}

function toResponseLike(r: ResponseRow) {
  return {
    id: r.id,
    answers: (r.answers as Record<string, unknown>) ?? {},
    answerFieldHashes: r.answer_field_hashes as AnswerFieldHashes,
  };
}

// Colunas SELECT comuns para as queries de `responses` do gatilho: além de
// answers/hashes, traz os campos de versão para o piso `latest_major` E
// `is_latest`. O `is_latest` é redundante com o filtro `.eq("is_latest", true)`
// das queries, mas selecioná-lo deixa a regra 1 de `responseQualifiesForVersion`
// (superseded → fora) ser defesa REAL no dado, não só uma garantia implícita do
// WHERE: se um caller futuro relaxar/copiar a query sem o filtro, o predicado
// ainda exclui superseded em vez de contá-los (regressão #213).
const RESPONSE_VERSION_COLS =
  "is_latest, pydantic_hash, schema_version_major, schema_version_minor, schema_version_patch";

// Monta o shape `VersionedResponse` a partir de uma linha de `responses`.
// `is_latest` vem do SELECT (ver RESPONSE_VERSION_COLS), mas a coluna é
// nullable com DEFAULT true: o `?? true` decide que linha antiga sem o flag
// conta como corrente, e não é um mero guarda de tipo — mudá-lo desqualifica
// respostas legadas da comparação. `respondent_type` é fixado pela query
// (humano/llm), irrelevante para a decisão de versão, entra só para o tipo.
function toVersioned(
  r: Pick<
    ResponseRow,
    | "is_latest"
    | "pydantic_hash"
    | "schema_version_major"
    | "schema_version_minor"
    | "schema_version_patch"
  >,
  respondentType: "humano" | "llm",
): VersionedResponse {
  return {
    respondent_type: respondentType,
    is_latest: r.is_latest ?? true,
    pydantic_hash: r.pydantic_hash ?? null,
    schema_version_major: r.schema_version_major ?? null,
    schema_version_minor: r.schema_version_minor ?? null,
    schema_version_patch: r.schema_version_patch ?? null,
  };
}

function buildEquivByField(
  rows: Array<{
    field_name: string;
    response_a_id: string;
    response_b_id: string;
    response_a_answer_snapshot: unknown;
    response_b_answer_snapshot: unknown;
  }> | null,
): Map<string, EquivalencePair[]> {
  const map = new Map<string, EquivalencePair[]>();
  for (const eq of rows ?? []) {
    const list = map.get(eq.field_name) ?? [];
    list.push({
      response_a_id: eq.response_a_id,
      response_b_id: eq.response_b_id,
      response_a_answer_snapshot: eq.response_a_answer_snapshot,
      response_b_answer_snapshot: eq.response_b_answer_snapshot,
    });
    map.set(eq.field_name, list);
  }
  return map;
}

export async function loadOpenComparisonLoad(
  admin: SupabaseDataClient,
  projectId: string,
): Promise<Map<string, number>> {
  const result = await admin
    .from("assignments")
    .select("user_id")
    .eq("project_id", projectId)
    .eq("type", "comparacao")
    .neq("status", "concluido");
  return buildLoadMap(queryData(result) ?? []);
}

async function loadEligibleReviewerIds(
  admin: SupabaseDataClient,
  projectId: string,
  documentId: string,
  coderIds: Set<string>,
): Promise<string[]> {
  const [membersResult, previousAssignmentsResult] = await Promise.all([
    // Paginado: o pool elegível é um universo. Truncado, um revisor apto ficaria
    // permanentemente fora do sorteio de comparação, sem erro.
    fetchAllPaged<{ user_id: string }>(
      () =>
        admin
          .from("project_members")
          .select("user_id")
          .eq("project_id", projectId)
          .eq("can_compare", true),
      "user_id",
    ),
    admin
      .from("assignments")
      .select("user_id")
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .eq("type", "comparacao"),
  ]);
  const members = queryData(membersResult) ?? [];
  const previousReviewerIds = new Set(
    (queryData(previousAssignmentsResult) ?? []).map(
      (assignment) => assignment.user_id,
    ),
  );

  // A UNIQUE de assignments não permite reutilizar a mesma pessoa no mesmo
  // documento. Excluí-la antes do sorteio evita que uma comparação concluída
  // transforme divergências posteriores num retry impossível e silencioso.
  return members
    .map((member) => member.user_id)
    .filter(
      (userId) => !coderIds.has(userId) && !previousReviewerIds.has(userId),
    );
}

function chooseLeastLoadedReviewer(
  eligibleReviewerIds: string[],
  loadByUser: Map<string, number>,
): string {
  const minLoad = Math.min(
    ...eligibleReviewerIds.map((userId) => loadByUser.get(userId) ?? 0),
  );
  const candidates = eligibleReviewerIds.filter(
    (userId) => (loadByUser.get(userId) ?? 0) === minLoad,
  );
  return candidates[Math.floor(Math.random() * candidates.length)];
}

async function commitComparisonAssignment(
  admin: SupabaseDataClient,
  projectId: string,
  documentId: string,
  reviewerId: string,
): Promise<boolean> {
  // A RPC revalida can_compare sob lock e insere na mesma transação. Assim um
  // disable concorrente ou limpa a atribuição já criada, ou vence o lock e
  // impede a gravação posterior.
  const result = await admin.rpc("assign_comparison_if_eligible", {
    p_project_id: projectId,
    p_document_id: documentId,
    p_user_id: reviewerId,
  });
  return queryData(result) === true;
}

// Sorteia UM revisor de comparação para o documento e cria o assignment
// (type=comparacao) idempotente. Espelha assignArbitrator (actions/field-reviews.ts):
//   - Pool = membros can_compare=true MENOS todos os codificadores (coderIds) —
//     sem fallback: um codificador comparando o próprio doc julgaria a própria
//     codificação. Pool vazio → noPool=true (banner de pendência ao coordenador).
//   - Balanceia por menor carga de comparações abertas; desempate aleatório.
//   - precomputedOpenLoad: quando passado (batch do retry), evita N queries de
//     carga e é incrementado a cada atribuição para balancear entre docs.
export async function assignComparisonReviewer(
  admin: SupabaseDataClient,
  projectId: string,
  documentId: string,
  coderIds: Set<string>,
  precomputedOpenLoad?: Map<string, number>,
  writeClient?: SupabaseDataClient,
): Promise<{ assigned: boolean; noPool: boolean }> {
  const eligibleReviewerIds = await loadEligibleReviewerIds(
    admin,
    projectId,
    documentId,
    coderIds,
  );
  if (eligibleReviewerIds.length === 0) {
    return { assigned: false, noPool: true };
  }

  const loadByUser =
    precomputedOpenLoad ?? (await loadOpenComparisonLoad(admin, projectId));
  // Desempate aleatorio entre os de menor carga (sem preferencia de role).
  const reviewerId = chooseLeastLoadedReviewer(eligibleReviewerIds, loadByUser);
  const assigned = await commitComparisonAssignment(
    writeClient ?? createSupabaseAdmin(),
    projectId,
    documentId,
    reviewerId,
  );
  if (!assigned) return { assigned: false, noPool: false };

  // Mantem a carga in-memory coerente para o proximo doc do batch (retry).
  if (precomputedOpenLoad) {
    precomputedOpenLoad.set(reviewerId, (loadByUser.get(reviewerId) ?? 0) + 1);
  }

  return { assigned: true, noPool: false };
}

interface ComparisonProjectSettings extends ProjectVersionRow {
  min_responses_for_comparison: number | null;
  comparison_includes_llm: boolean | null;
}

interface ComparisonAnalysisInput {
  fields: PydanticField[];
  project: ComparisonProjectSettings;
  humanResponses: ResponseRow[];
  llmResponse: ResponseRow | null | undefined;
  equivalencesByField?: Map<string, EquivalencePair[]>;
  mode: ComparisonMode;
}

type ComparisonAnalysis =
  | {
      kind: "insufficient";
      logFields: Record<string, unknown>;
    }
  | {
      kind: "consensus";
    }
  | {
      kind: "divergent";
      divergentFields: string[];
      coderIds: Set<string>;
    };

function collectRespondentIds(responses: ResponseRow[]): Set<string> {
  const ids = responses
    .map((response) => response.respondent_id)
    .filter((id): id is string => Boolean(id));
  return new Set(ids);
}

type ComparisonVersionGate = ReturnType<typeof versionGate>;

function completeQualifyingHumans(
  fields: PydanticField[],
  responses: ResponseRow[],
  gate: ComparisonVersionGate,
): ResponseRow[] {
  return responses
    .filter((response) => isCodingComplete(fields, response.answers ?? {}))
    .filter((response) =>
      responseQualifiesForVersion(
        toVersioned(response, "humano"),
        gate.minVersion,
        gate.ctx,
      ),
    );
}

function qualifyingLlmResponse(
  response: ResponseRow | null | undefined,
  gate: ComparisonVersionGate,
): ResponseRow | null {
  if (!response) return null;
  return responseQualifiesForVersion(
    toVersioned(response, "llm"),
    gate.minVersion,
    gate.ctx,
  )
    ? response
    : null;
}

function minimumHumanResponses(
  mode: ComparisonMode,
  configuredMinimum: number | null | undefined,
): number {
  return mode === "compare_humans" ? (configuredMinimum ?? 2) : 1;
}

function divergenceResponses(
  completeHumans: ResponseRow[],
  llmResponse: ResponseRow | null,
  includeLlm: boolean,
) {
  const responses = completeHumans.map(toResponseLike);
  if (includeLlm && llmResponse) responses.push(toResponseLike(llmResponse));
  return responses;
}

function analyzeComparison({
  fields,
  project,
  humanResponses,
  llmResponse,
  equivalencesByField,
  mode,
}: ComparisonAnalysisInput): ComparisonAnalysis {
  const gate = versionGate(project);

  // Só codificações humanas completas e no piso `latest_major` contam para o
  // mínimo e para a divergência. Todos os respondentes continuam excluídos do
  // pool, inclusive quando a resposta está incompleta ou abaixo desse piso.
  const completeHumans = completeQualifyingHumans(fields, humanResponses, gate);
  const minHumans = minimumHumanResponses(
    mode,
    project.min_responses_for_comparison,
  );
  if (completeHumans.length < minHumans) {
    return {
      kind: "insufficient",
      logFields: { completeHumans: completeHumans.length, minHumans },
    };
  }

  // LLM também passa pelo piso de versão: uma resposta de schema antigo não
  // conta para comparação nem para o mínimo do modo compare_llm.
  const qualifyingLlm = qualifyingLlmResponse(llmResponse, gate);
  if (mode === "compare_llm" && !qualifyingLlm) {
    return { kind: "insufficient", logFields: { reason: "no_llm" } };
  }

  const responsesForDivergence = divergenceResponses(
    completeHumans,
    qualifyingLlm,
    mode === "compare_llm" || project.comparison_includes_llm === true,
  );
  if (responsesForDivergence.length < 2) {
    return {
      kind: "insufficient",
      logFields: { reason: "needs_two_responses" },
    };
  }

  const divergentFields = computeDivergentFieldNames(
    fields,
    responsesForDivergence,
    equivalencesByField,
  );
  if (divergentFields.length === 0) return { kind: "consensus" };
  return {
    kind: "divergent",
    divergentFields,
    coderIds: collectRespondentIds(humanResponses),
  };
}

async function loadAutoComparisonContext(
  admin: SupabaseDataClient,
  projectId: string,
  documentId: string,
) {
  const [
    projectResult,
    documentResult,
    humanResponsesResult,
    llmResponseResult,
    equivalencesResult,
    activeAssignmentsResult,
  ] = await Promise.all([
    admin
      .from("projects")
      .select(
        `pydantic_fields, min_responses_for_comparison, comparison_includes_llm, pydantic_hash, schema_version_major, schema_version_minor, schema_version_patch`,
      )
      .eq("id", projectId)
      .single(),
    admin
      .from("documents")
      .select("excluded_at, exclusion_pending_at")
      .eq("id", documentId)
      .eq("project_id", projectId)
      .maybeSingle(),
    admin
      .from("responses")
      .select(
        `id, respondent_id, answers, answer_field_hashes, ${RESPONSE_VERSION_COLS}`,
      )
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .eq("respondent_type", "humano")
      .eq("is_latest", true),
    admin
      .from("responses")
      .select(`id, answers, answer_field_hashes, ${RESPONSE_VERSION_COLS}`)
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .eq("respondent_type", "llm")
      .eq("is_latest", true)
      .maybeSingle(),
      admin
        .from("response_equivalences")
        .select(
          "field_name, response_a_id, response_b_id, response_a_answer_snapshot, response_b_answer_snapshot",
        )
        .eq("project_id", projectId)
        .eq("document_id", documentId)
        .is("superseded_at", null),
    admin
      .from("assignments")
      .select("id")
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .eq("type", "comparacao")
      .neq("status", "concluido")
      .limit(1),
  ]);

  return {
    project: queryData(projectResult),
    document: queryData(documentResult),
    humanResponses: (queryData(humanResponsesResult) ?? []) as ResponseRow[],
    llmResponse: queryData(llmResponseResult) as ResponseRow | null,
    equivalences: queryData(equivalencesResult),
    activeAssignments: queryData(activeAssignmentsResult) ?? [],
  };
}

// Detecta divergencia segundo o modo e, se houver, materializa um assignment
// comparacao para um revisor terceiro. Chamado de saveResponse() apos a
// codificacao virar "concluido". Usa admin client porque a policy de assignments
// restringe INSERT a coordenadores; aqui o pesquisador precisa criar a fila.
//
// "o minimo necessario para liberar a revisao":
//   compare_humans → >= min_responses_for_comparison humanos completos
//   compare_llm    → >= 1 humano completo + resposta LLM
// comparison_includes_llm (so compare_humans) decide se o LLM entra no calculo
// de divergencia que dispara.
export async function createAutoComparisonIfDiverges(
  projectId: string,
  documentId: string,
  mode: ComparisonMode,
): Promise<{ assigned: boolean; noPool: boolean }> {
  const admin = createSupabaseAdmin();
  const context = await loadAutoComparisonContext(admin, projectId, documentId);

  if (!context.project?.pydantic_fields) {
    log("skip_no_data", { projectId, documentId, mode }, "warn");
    return { assigned: false, noPool: false };
  }
  const fields = context.project.pydantic_fields as PydanticField[];

  // Doc arquivado ou em revisão de escopo não dispara comparação — alinha o
  // gatilho automático com a fila (compare/page.tsx), que filtra ambos.
  if (
    !context.document ||
    context.document.excluded_at ||
    context.document.exclusion_pending_at
  ) {
    log("skip_doc_out_of_scope", { projectId, documentId, mode });
    return { assigned: false, noPool: false };
  }

  // Idempotencia: ja existe comparacao ativa para este doc → nao re-sorteia.
  if (context.activeAssignments.length > 0) {
    log("skip_active_assignment", { projectId, documentId, mode });
    return { assigned: false, noPool: false };
  }

  const analysis = analyzeComparison({
    fields,
    project: context.project,
    humanResponses: context.humanResponses,
    llmResponse: context.llmResponse,
    equivalencesByField: buildEquivByField(context.equivalences),
    mode,
  });
  if (analysis.kind === "insufficient") {
    log("skip_insufficient", {
      projectId,
      documentId,
      mode,
      ...analysis.logFields,
    });
    return { assigned: false, noPool: false };
  }
  if (analysis.kind === "consensus") {
    log("consensus", {
      projectId,
      documentId,
      mode,
      totalFields: fields.length,
    });
    return { assigned: false, noPool: false };
  }

  const result = await assignComparisonReviewer(
    admin,
    projectId,
    documentId,
    analysis.coderIds,
    undefined,
    admin,
  );
  log(result.assigned ? "created" : "no_pool", {
    projectId,
    documentId,
    mode,
    divergentCount: analysis.divergentFields.length,
    divergentFields: analysis.divergentFields,
  });
  return result;
}

interface ComparisonProjectRow extends ComparisonProjectSettings {
  pydantic_fields: PydanticField[];
}

interface HumanResponseMeta extends Pick<
  ResponseRow,
  | "is_latest"
  | "pydantic_hash"
  | "schema_version_major"
  | "schema_version_minor"
  | "schema_version_patch"
> {
  document_id: string;
  respondent_id: string | null;
}

interface DocumentResponseRow extends ResponseRow {
  document_id: string;
}

interface DocumentEquivalenceRow {
  document_id: string;
  field_name: string;
  response_a_id: string;
  response_b_id: string;
  response_a_answer_snapshot: unknown;
  response_b_answer_snapshot: unknown;
}

function candidateDocumentIds(
  project: ComparisonProjectRow,
  humanMeta: HumanResponseMeta[],
  activeDocumentIds: Set<string>,
  mode: ComparisonMode,
): string[] {
  const gate = versionGate(project);
  const humansByDoc = new Map<string, Set<string>>();
  for (const response of humanMeta) {
    if (!response.respondent_id) continue;
    if (
      !responseQualifiesForVersion(
        toVersioned(response, "humano"),
        gate.minVersion,
        gate.ctx,
      )
    ) {
      continue;
    }
    const respondents =
      humansByDoc.get(response.document_id) ?? new Set<string>();
    respondents.add(response.respondent_id);
    humansByDoc.set(response.document_id, respondents);
  }

  const minHumans = minimumHumanResponses(
    mode,
    project.min_responses_for_comparison,
  );
  return [...humansByDoc.entries()]
    .filter(
      ([documentId, respondents]) =>
        respondents.size >= minHumans && !activeDocumentIds.has(documentId),
    )
    .map(([documentId]) => documentId);
}

async function loadBacklogCandidates(
  admin: SupabaseDataClient,
  projectId: string,
  mode: ComparisonMode,
): Promise<{
  project: ComparisonProjectRow;
  documentIds: string[];
} | null> {
  const [projectResult, humanMetaResult, activeAssignmentsResult] =
    await Promise.all([
      admin
        .from("projects")
        .select(
          `pydantic_fields, min_responses_for_comparison, comparison_includes_llm, pydantic_hash, schema_version_major, schema_version_minor, schema_version_patch`,
        )
        .eq("id", projectId)
        .single(),
      // O inner join exclui documentos arquivados ou em revisão de escopo já
      // na fase leve, antes de buscar answers e equivalências.
      admin
        .from("responses")
        .select(
          `document_id, respondent_id, ${RESPONSE_VERSION_COLS}, documents!inner(id)`,
        )
        .eq("project_id", projectId)
        .eq("respondent_type", "humano")
        .eq("is_latest", true)
        .is("documents.excluded_at", null)
        .is("documents.exclusion_pending_at", null),
      admin
        .from("assignments")
        .select("document_id")
        .eq("project_id", projectId)
        .eq("type", "comparacao")
        .neq("status", "concluido"),
    ]);

  const rawProject = queryData(projectResult);
  const humanMeta = (queryData(humanMetaResult) ?? []) as HumanResponseMeta[];
  const activeAssignments = queryData(activeAssignmentsResult) ?? [];
  if (!rawProject?.pydantic_fields) return null;

  const project = rawProject as unknown as ComparisonProjectRow;
  if (project.pydantic_fields.length === 0) return null;
  const activeDocumentIds = new Set(
    activeAssignments.map((assignment) => assignment.document_id),
  );
  const documentIds = candidateDocumentIds(
    project,
    humanMeta,
    activeDocumentIds,
    mode,
  );
  return documentIds.length > 0 ? { project, documentIds } : null;
}

function groupHumanResponsesByDocument(
  responses: DocumentResponseRow[],
): Map<string, DocumentResponseRow[]> {
  const byDocument = new Map<string, DocumentResponseRow[]>();
  for (const response of responses) {
    const documentResponses = byDocument.get(response.document_id) ?? [];
    documentResponses.push(response);
    byDocument.set(response.document_id, documentResponses);
  }
  return byDocument;
}

function groupEquivalencesByDocument(
  equivalences: DocumentEquivalenceRow[],
): Map<string, Map<string, EquivalencePair[]>> {
  const byDocument = new Map<string, Map<string, EquivalencePair[]>>();
  for (const equivalence of equivalences) {
    const byField =
      byDocument.get(equivalence.document_id) ??
      new Map<string, EquivalencePair[]>();
    const fieldEquivalences = byField.get(equivalence.field_name) ?? [];
    fieldEquivalences.push({
      response_a_id: equivalence.response_a_id,
      response_b_id: equivalence.response_b_id,
      response_a_answer_snapshot: equivalence.response_a_answer_snapshot,
      response_b_answer_snapshot: equivalence.response_b_answer_snapshot,
    });
    byField.set(equivalence.field_name, fieldEquivalences);
    byDocument.set(equivalence.document_id, byField);
  }
  return byDocument;
}

async function loadBacklogComparisonData(
  admin: SupabaseDataClient,
  projectId: string,
  documentIds: string[],
) {
  const [humanResponsesResult, llmResponsesResult, equivalencesResult] =
    await Promise.all([
      admin
        .from("responses")
        .select(
          `id, document_id, respondent_id, answers, answer_field_hashes, ${RESPONSE_VERSION_COLS}`,
        )
        .eq("project_id", projectId)
        .eq("respondent_type", "humano")
        .eq("is_latest", true)
        .in("document_id", documentIds),
      admin
        .from("responses")
        .select(
          `id, document_id, answers, answer_field_hashes, ${RESPONSE_VERSION_COLS}`,
        )
        .eq("project_id", projectId)
        .eq("respondent_type", "llm")
        .eq("is_latest", true)
        .in("document_id", documentIds),
      admin
        .from("response_equivalences")
        .select(
          "document_id, field_name, response_a_id, response_b_id, response_a_answer_snapshot, response_b_answer_snapshot",
        )
        .eq("project_id", projectId)
        .in("document_id", documentIds)
        .is("superseded_at", null),
    ]);

  const humans = (queryData(humanResponsesResult) ??
    []) as DocumentResponseRow[];
  const llms = (queryData(llmResponsesResult) ?? []) as DocumentResponseRow[];
  const equivalences = (queryData(equivalencesResult) ??
    []) as DocumentEquivalenceRow[];
  return {
    humansByDocument: groupHumanResponsesByDocument(humans),
    llmByDocument: new Map(
      llms.map((response) => [response.document_id, response]),
    ),
    equivalencesByDocument: groupEquivalencesByDocument(equivalences),
  };
}

// Varre o projeto e devolve os documentos que DIVERGEM (segundo o modo) e ainda
// nao tem comparacao ativa — o "backlog" sem revisor. Usado pelo retry
// (atribui) e pelo banner de pendencia (conta). Varredura em 2 fases para nao
// puxar `answers` de todo doc: fase 1 acha candidatos por metadado leve, fase 2
// busca answers so deles e recomputa divergencia.
export async function scanComparisonBacklog(
  admin: SupabaseDataClient,
  projectId: string,
  mode: ComparisonMode,
): Promise<Array<{ documentId: string; coderIds: Set<string> }>> {
  const candidates = await loadBacklogCandidates(admin, projectId, mode);
  if (!candidates) return [];
  const comparisonData = await loadBacklogComparisonData(
    admin,
    projectId,
    candidates.documentIds,
  );
  const result: Array<{ documentId: string; coderIds: Set<string> }> = [];
  for (const documentId of candidates.documentIds) {
    const analysis = analyzeComparison({
      fields: candidates.project.pydantic_fields,
      project: candidates.project,
      humanResponses: comparisonData.humansByDocument.get(documentId) ?? [],
      llmResponse: comparisonData.llmByDocument.get(documentId),
      equivalencesByField:
        comparisonData.equivalencesByDocument.get(documentId),
      mode,
    });
    if (analysis.kind !== "divergent") continue;
    result.push({ documentId, coderIds: analysis.coderIds });
  }

  return result;
}
