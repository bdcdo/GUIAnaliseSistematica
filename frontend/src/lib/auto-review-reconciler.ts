import "server-only";

import { computeBacklogRows, type HumanResponseRow, type LlmResponseRow } from "@/lib/auto-review-backlog";
import { buildEquivalenceMap, type EquivalenceRow } from "@/lib/compare-queue";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { fetchAllPaged } from "@/lib/supabase/paginate";
import type { PydanticField } from "@/lib/types";

interface ReconciliationRequest {
  project_id: string;
  document_id: string;
  llm_response_id: string | null;
  allow_new_cycles: boolean;
}

interface ReconciliationGroup {
  human_response_id: string;
  llm_response_id: string;
  field_names: string[];
  divergent_field_names: string[];
  expected_human_updated_at: string;
  expected_llm_updated_at: string;
  expected_project_pydantic_hash: string | null;
  expected_equivalence_ids: string[];
}

type AdminClient = ReturnType<typeof createSupabaseAdmin>;
type VersionedHumanResponse = HumanResponseRow & { updated_at: string };
type VersionedLlmResponse = LlmResponseRow & { updated_at: string };
type ReconciliationOutcome = "processed" | "stale" | "deferred" | "failed";

interface ReconciliationInputs {
  fields: PydanticField[];
  pydanticHash: string | null;
  humans: VersionedHumanResponse[];
  llm: VersionedLlmResponse | null;
  equivalences: EquivalenceRow[];
}

export interface ReconciliationDrainResult {
  processed: number;
  stale: number;
  deferred: number;
  failed: number;
  remaining: number;
}

class DeferredReconciliation extends Error {}

function firstError(
  results: Array<{ error: { message: string } | null }>,
): { message: string } | null {
  return results.find((result) => result.error)?.error ?? null;
}

async function acknowledge(
  admin: AdminClient,
  request: ReconciliationRequest,
): Promise<void> {
  let query = admin
    .from("auto_review_reconciliation_requests")
    .delete()
    .eq("document_id", request.document_id);
  query = request.llm_response_id === null
    ? query.is("llm_response_id", null)
    : query.eq("llm_response_id", request.llm_response_id);
  const { error } = await query;
  if (error) throw new Error(error.message);
}

async function recordFailure(
  admin: AdminClient,
  request: ReconciliationRequest,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const { error: updateError } = await admin.rpc(
    "record_auto_review_reconciliation_failure",
    {
      p_document_id: request.document_id,
      p_llm_response_id: request.llm_response_id,
      p_error: message,
    },
  );
  if (updateError) {
    console.error(
      `[auto-review] ${JSON.stringify({
        event: "reconciliation_failure_record_failed",
        projectId: request.project_id,
        documentId: request.document_id,
        llmResponseId: request.llm_response_id,
        error: updateError.message,
      })}`,
    );
  }
}

function collectDependencyIds(
  currentRows: Array<{ self_reviewer_id: string }>,
  historyRows: Array<{ self_reviewer_id: string }>,
  aliases: Array<{ member_user_id: string; linked_user_id: string }>,
): Set<string> {
  const dependencyIds = new Set(
    [...currentRows, ...historyRows].map((row) => row.self_reviewer_id),
  );
  for (const alias of aliases) {
    if (dependencyIds.has(alias.member_user_id)) {
      dependencyIds.add(alias.linked_user_id);
    }
    if (dependencyIds.has(alias.linked_user_id)) {
      dependencyIds.add(alias.member_user_id);
    }
  }
  return dependencyIds;
}

async function eligibleHumanResponses(
  admin: AdminClient,
  request: ReconciliationRequest,
  humans: VersionedHumanResponse[],
): Promise<VersionedHumanResponse[]> {
  // Paginado: este Set é o universo de quem ainda é membro. Truncado no teto do
  // PostgREST, um membro legítimo seria lido como ex-membro e sua resposta
  // sairia da reconciliação sem erro nenhum.
  const membersResult = await fetchAllPaged<{ user_id: string }>(
    () =>
      admin
        .from("project_members")
        .select("user_id")
        .eq("project_id", request.project_id),
    "user_id",
  );
  if (membersResult.error) throw new Error(membersResult.error.message);
  const memberIds = new Set(
    (membersResult.data ?? []).map((member) => member.user_id),
  );
  const currentHumans = humans.filter((human) =>
    memberIds.has(human.respondent_id)
  );
  if (request.allow_new_cycles) return currentHumans;

  const [currentResult, historyResult, aliasesResult] = await Promise.all([
    admin
      .from("field_reviews")
      .select("self_reviewer_id")
      .eq("project_id", request.project_id)
      .eq("document_id", request.document_id),
    admin
      .from("field_review_cycle_history_entries")
      .select("self_reviewer_id")
      .eq("project_id", request.project_id)
      .eq("document_id", request.document_id),
    admin
      .from("member_email_links")
      .select("member_user_id, linked_user_id")
      .eq("project_id", request.project_id),
  ]);
  const readError = firstError([currentResult, historyResult, aliasesResult]);
  if (readError) throw new Error(readError.message);

  const dependencyIds = collectDependencyIds(
    currentResult.data ?? [],
    historyResult.data ?? [],
    aliasesResult.data ?? [],
  );
  return currentHumans.filter((human) => dependencyIds.has(human.respondent_id));
}

async function readReconciliationInputs(
  admin: AdminClient,
  request: ReconciliationRequest,
): Promise<ReconciliationInputs> {
  const [projectResult, humansResult, llmResult, equivalencesResult] =
    await Promise.all([
      admin
        .from("projects")
        .select("pydantic_fields, pydantic_hash")
        .eq("id", request.project_id)
        .single(),
      admin
        .from("responses")
        .select("id, document_id, respondent_id, answers, answer_field_hashes, updated_at")
        .eq("project_id", request.project_id)
        .eq("document_id", request.document_id)
        .eq("respondent_type", "humano")
        .eq("is_latest", true)
        .eq("is_partial", false),
      (() => {
        let query = admin
          .from("responses")
          .select("id, document_id, answers, answer_field_hashes, updated_at")
          .eq("project_id", request.project_id)
          .eq("document_id", request.document_id)
          .eq("respondent_type", "llm")
          .eq("is_latest", true)
          .eq("is_partial", false);
        if (request.llm_response_id !== null) {
          query = query.eq("id", request.llm_response_id);
        }
        return query.maybeSingle();
      })(),
      admin
        .from("response_equivalences")
        .select(
          "id, document_id, field_name, response_a_id, response_b_id, reviewer_id, response_a_answer_snapshot, response_b_answer_snapshot",
        )
        .eq("project_id", request.project_id)
        .eq("document_id", request.document_id)
        .is("superseded_at", null),
    ]);
  const readError = firstError([
    projectResult,
    humansResult,
    llmResult,
    equivalencesResult,
  ]);
  if (readError) throw new Error(readError.message);

  return {
    fields: (projectResult.data?.pydantic_fields ?? []) as PydanticField[],
    pydanticHash: projectResult.data?.pydantic_hash ?? null,
    humans: (humansResult.data ?? []) as VersionedHumanResponse[],
    llm: llmResult.data as VersionedLlmResponse | null,
    equivalences: (equivalencesResult.data ?? []) as EquivalenceRow[],
  };
}

function divergentFieldsByHuman(
  fieldReviewRows: Array<{ human_response_id: string; field_name: string }>,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of fieldReviewRows) {
    const names = result.get(row.human_response_id) ?? [];
    names.push(row.field_name);
    result.set(row.human_response_id, names);
  }
  return result;
}

function directEquivalenceIds(
  equivalences: EquivalenceRow[],
  humanId: string,
  llmId: string,
): string[] {
  return equivalences
    .filter((equivalence) => {
      const ids = new Set([equivalence.response_a_id, equivalence.response_b_id]);
      return ids.has(humanId) && ids.has(llmId);
    })
    .map((equivalence) => equivalence.id)
    .sort();
}

function buildReconciliationGroups(
  inputs: Omit<ReconciliationInputs, "llm"> & { llm: VersionedLlmResponse },
  humans: VersionedHumanResponse[],
  fieldReviewRows: Array<{ human_response_id: string; field_name: string }>,
): ReconciliationGroup[] {
  const divergentFields = divergentFieldsByHuman(fieldReviewRows);
  const fieldNames = inputs.fields.map((field) => field.name);
  return humans.map((human) => ({
    human_response_id: human.id,
    llm_response_id: inputs.llm.id,
    field_names: fieldNames,
    divergent_field_names: divergentFields.get(human.id) ?? [],
    expected_human_updated_at: human.updated_at,
    expected_llm_updated_at: inputs.llm.updated_at,
    expected_project_pydantic_hash: inputs.pydanticHash,
    expected_equivalence_ids: directEquivalenceIds(
      inputs.equivalences,
      human.id,
      inputs.llm.id,
    ),
  }));
}

async function reconcileRequest(
  admin: AdminClient,
  request: ReconciliationRequest,
): Promise<"processed" | "stale"> {
  const inputs = await readReconciliationInputs(admin, request);
  const llm = inputs.llm;
  if (!llm) {
    if (request.llm_response_id !== null) {
      await acknowledge(admin, request);
      return "stale";
    }
    throw new DeferredReconciliation("current complete LLM response is not visible yet");
  }

  const humans = await eligibleHumanResponses(
    admin,
    request,
    inputs.humans,
  );
  const llmByDocument = new Map([[request.document_id, llm]]);
  const equivalencesByDocument = buildEquivalenceMap(inputs.equivalences);
  const { fieldReviewRows } = computeBacklogRows(
    request.project_id,
    humans,
    llmByDocument,
    equivalencesByDocument,
    inputs.fields,
  );
  const groups = buildReconciliationGroups({ ...inputs, llm }, humans, fieldReviewRows);

  if (groups.length > 0) {
    const { error } = await admin.rpc("reconcile_auto_review_cycles", {
      p_groups: groups,
    });
    if (error) throw new Error(error.message);
  }
  await acknowledge(admin, request);
  return "processed";
}

function logReconciliationFailure(
  request: ReconciliationRequest,
  error: unknown,
): void {
  console.error(
    `[auto-review] ${JSON.stringify({
      event: "reconciliation_failed",
      projectId: request.project_id,
      documentId: request.document_id,
      llmResponseId: request.llm_response_id,
      error: error instanceof Error ? error.message : String(error),
    })}`,
  );
}

async function processRequest(
  admin: AdminClient,
  request: ReconciliationRequest,
): Promise<ReconciliationOutcome> {
  try {
    return await reconcileRequest(admin, request);
  } catch (requestError) {
    await recordFailure(admin, request, requestError);
    if (requestError instanceof DeferredReconciliation) return "deferred";
    logReconciliationFailure(request, requestError);
    return "failed";
  }
}

async function fetchDueRequests(
  admin: AdminClient,
  batchSize: number,
  projectId?: string,
): Promise<ReconciliationRequest[]> {
  let query = admin
    .from("auto_review_reconciliation_requests")
    .select("project_id, document_id, llm_response_id, allow_new_cycles")
    .lte("next_attempt_at", new Date().toISOString())
    .order("next_attempt_at", { ascending: true })
    .order("requested_at", { ascending: true })
    .limit(batchSize);
  if (projectId) query = query.eq("project_id", projectId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as ReconciliationRequest[];
}

async function countDueRequests(
  admin: AdminClient,
  projectId?: string,
): Promise<number> {
  let query = admin
    .from("auto_review_reconciliation_requests")
    .select("document_id", { count: "exact", head: true })
    .lte("next_attempt_at", new Date().toISOString());
  if (projectId) query = query.eq("project_id", projectId);
  const { count, error } = await query;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

function processedRequestCount(result: ReconciliationDrainResult): number {
  return result.processed + result.stale + result.deferred + result.failed;
}

export async function drainAutoReviewReconciliationRequests(
  options: { batchSize?: number; maxRequests?: number; projectId?: string } = {},
): Promise<ReconciliationDrainResult> {
  const admin = createSupabaseAdmin();
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 100, 100));
  const maxRequests = Math.max(batchSize, Math.min(options.maxRequests ?? 500, 2_000));
  const result: ReconciliationDrainResult = {
    processed: 0,
    stale: 0,
    deferred: 0,
    failed: 0,
    remaining: 0,
  };

  while (processedRequestCount(result) < maxRequests) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const requests = await fetchDueRequests(admin, batchSize, options.projectId);

    for (const request of requests) {
      // Sequential processing bounds DB pressure. Duplicate workers remain
      // safe because reconciliation and ACK use the exact response generation.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const outcome = await processRequest(admin, request);
      result[outcome] += 1;
    }
    if (requests.length < batchSize) break;
  }

  result.remaining = await countDueRequests(admin, options.projectId);
  return result;
}
