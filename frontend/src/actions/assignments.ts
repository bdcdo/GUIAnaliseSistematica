"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser, requireCoordinator } from "@/lib/auth";
import { revalidatePath, revalidateTag } from "next/cache";
import {
  createRng,
  distributeDocs,
  filterComparisonEligible,
  filterEligibleDocs,
  shuffleWithRng,
  computeCapacity,
  resolveWeight,
  resolveCap,
  resolveResearchersPerDoc,
  type LotteryBalancing,
  type LotteryDocStats,
  type LotteryFilters,
  type LotteryMode,
  type LotteryParticipant,
} from "@/lib/lottery-utils";
import { MEMBERS_TAG_PROFILE, membersTag } from "@/lib/cache";
import { errorMessage } from "@/lib/utils";
import {
  resolveInitialCodingStatus,
  type InitialCodingStatus,
} from "@/lib/coding-initial-status";
import type { ResponseRoundFields, RoundContext } from "@/lib/rounds";
import type { SupabaseServerClient } from "@/lib/supabase/server";
import type { AnswerFieldHashes, PydanticField, Round } from "@/lib/types";

// --- Status inicial do assignment de codificação (issue #521) ---

/**
 * Response humana `is_latest` de um par (documento, codificador), sem o jsonb
 * pesado de `answers`: identifica quem codificou o quê e a que rodada aquilo
 * pertence. Serve a dois consumidores — o veto de par do sorteio de comparação
 * e a fase 1 do status inicial de codificação, que só busca `answers` dos pares
 * que a criação vai de fato tocar.
 */
interface HumanCoderRow extends ResponseRoundFields {
  id: string;
  document_id: string;
  respondent_id: string;
  updated_at: string | null;
}

const pairKey = (documentId: string, userId: string) => `${documentId}:${userId}`;

/**
 * Teto de ids por `.in()`: PostgREST recebe a lista na URL, e um sorteio de
 * projeto inteiro pode ter centenas de pares já codificados — uma única query
 * estouraria o limite de URI e derrubaria o sorteio todo. Fatiar mantém a
 * leitura barata sem depender do tamanho do lote.
 */
const RESPONSE_ID_CHUNK = 100;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Fase 2 do status inicial: dadas as responses leves dos pares que serão
 * criados, carrega o que falta para julgar — `answers`/`answer_field_hashes`
 * das responses relevantes, o schema e a rodada corrente do projeto — e devolve
 * o status por par. Sem candidatos, não faz I/O nenhum.
 *
 * A régua vive em `resolveInitialCodingStatus` (lib/coding-initial-status);
 * aqui só se junta o insumo. `rounds` só é lido na estratégia manual, que é a
 * única em que `classifyDocStatus` consulta o mapa.
 */
interface InitialStatusInputs {
  ctx: RoundContext;
  fields: PydanticField[];
  /** answers por id de response — só das que interessam ao lote */
  answersById: Map<
    string,
    { answers: Record<string, unknown> | null; answer_field_hashes?: AnswerFieldHashes }
  >;
}

/**
 * Falha alto em vez de degradar para 'pendente': o silêncio aqui reintroduz
 * exatamente o bug que esta feature existe para impedir, e sem sinal nenhum
 * para quem sorteou. Os dois chamadores traduzem o throw em { error } antes de
 * qualquer escrita.
 */
function requireData<T>(
  result: { data: T | null; error: { message: string } | null },
  context: string,
): T {
  if (result.error || !result.data) {
    throw new Error(`${context}: ${result.error?.message ?? "resposta vazia"}`);
  }
  return result.data;
}

async function loadRounds(
  supabase: SupabaseServerClient,
  projectId: string,
): Promise<Round[]> {
  const result = await supabase.from("rounds").select("id, label").eq("project_id", projectId);
  if (result.error) throw new Error(`Erro ao ler as rodadas do projeto: ${result.error.message}`);
  return (result.data ?? []) as Round[];
}

async function loadInitialStatusInputs(
  supabase: SupabaseServerClient,
  projectId: string,
  responseIds: string[],
): Promise<InitialStatusInputs> {
  const [projectResult, ...answerResults] = await Promise.all([
    supabase
      .from("projects")
      .select("pydantic_fields, current_round_id")
      .eq("id", projectId)
      .single(),
    ...chunk(responseIds, RESPONSE_ID_CHUNK).map((ids) =>
      supabase.from("responses").select("id, answers, answer_field_hashes").in("id", ids),
    ),
  ]);

  const project = requireData(
    projectResult,
    "Erro ao ler o schema do projeto para o status inicial",
  );
  const answerRows = answerResults.flatMap((result) =>
    requireData(result, "Erro ao ler as codificações existentes"),
  );

  return {
    ctx: buildRoundContext(project, await loadRounds(supabase, projectId)),
    fields: (project.pydantic_fields as PydanticField[]) ?? [],
    answersById: indexAnswers(answerRows),
  };
}

function buildRoundContext(
  project: Record<string, unknown>,
  rounds: Round[],
): RoundContext {
  return {
    strategy: "manual",
    currentRoundId: (project.current_round_id as string | null) ?? null,
    currentVersion: { major: 0, minor: 0, patch: 0 },
    rounds,
  };
}

function indexAnswers(rows: Record<string, unknown>[]): InitialStatusInputs["answersById"] {
  return new Map(
    rows.map((a) => [
      a.id as string,
      {
        answers: a.answers as Record<string, unknown> | null,
        answer_field_hashes: a.answer_field_hashes as AnswerFieldHashes | undefined,
      },
    ]),
  );
}

async function resolveInitialCodingStatuses(
  supabase: SupabaseServerClient,
  projectId: string,
  candidates: HumanCoderRow[],
): Promise<Map<string, InitialCodingStatus>> {
  const statuses = new Map<string, InitialCodingStatus>();
  if (!candidates.length) return statuses;

  const { ctx, fields, answersById } = await loadInitialStatusInputs(
    supabase,
    projectId,
    candidates.map((c) => c.id),
  );
  const roundsById = new Map(ctx.rounds.map((r) => [r.id, r]));

  for (const candidate of candidates) {
    const payload = answersById.get(candidate.id);
    const response = {
      ...candidate,
      round_id: candidate.round_id ?? ctx.currentRoundId,
      answers: payload?.answers ?? null,
      answer_field_hashes: payload?.answer_field_hashes,
    };
    statuses.set(
      pairKey(candidate.document_id, candidate.respondent_id),
      resolveInitialCodingStatus(ctx, roundsById, response, fields),
    );
  }
  return statuses;
}

/**
 * Cria o assignment de codificação de um par. O status NÃO é o default
 * 'pendente' da coluna: se este pesquisador já codificou o documento
 * (tipicamente pelo Explorar, antes de existir atribuição), a linha nasce
 * refletindo esse trabalho — nada a promoveria depois, porque
 * `syncCodingAssignmentStatus` só roda no save (#521).
 */
async function insertCodingAssignment(
  supabase: SupabaseServerClient,
  projectId: string,
  documentId: string,
  // Falso positivo: `userId` é o dono da atribuição criada, não um campo de
  // autorização — quem autoriza é a policy de coordenador em assignments.
  // react-doctor-disable-next-line react-doctor/supabase-client-owned-authz-field
  userId: string,
): Promise<{ error?: string }> {
  const { data: existingResponse, error: responseError } = await supabase
    .from("responses")
    .select(
      "id, document_id, respondent_id, updated_at, round_id, is_partial, schema_version_major, schema_version_minor, schema_version_patch",
    )
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .eq("respondent_id", userId)
    .eq("respondent_type", "humano")
    .eq("is_latest", true)
    // `is_latest` único por par é invariante de trigger (20260716160100), não de
    // índice: sem o order+limit, uma duplicata faria o `maybeSingle` devolver
    // PGRST116 e a atribuição manual daquele par ficaria IMPOSSÍVEL — trocar um
    // status errado por um bloqueio de operação é pior que o bug original.
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (responseError) return { error: responseError.message };

  const statuses = await resolveInitialCodingStatuses(
    supabase,
    projectId,
    existingResponse ? [existingResponse as HumanCoderRow] : [],
  );
  const initial = statuses.get(pairKey(documentId, userId));

  const { error } = await supabase.from("assignments").insert({
    project_id: projectId,
    document_id: documentId,
    user_id: userId,
    type: "codificacao",
    status: initial?.status ?? "pendente",
    completed_at: initial?.completed_at ?? null,
  });
  return error ? { error: error.message } : {};
}

/**
 * codificacao → comparacao por UPDATE atômico (preserva id e metadados).
 *
 * Este ciclo enxerga só o par (documento, usuário) — não sabe de comparações de
 * OUTROS usuários no mesmo documento. Quem barra é o índice
 * assignments_one_active_comparacao_per_doc (um revisor por documento); o
 * 23505 vira mensagem em português em vez de vazar o texto do Postgres para o
 * toast do coordenador. `conflict` distingue essa recusa esperada de uma falha
 * real, que o chamador propaga como exceção.
 */
async function promoteToComparison(
  supabase: SupabaseServerClient,
  assignmentId: string,
): Promise<{ error?: string; conflict?: boolean }> {
  const { error } = await supabase
    .from("assignments")
    .update({ type: "comparacao" })
    .eq("id", assignmentId);
  if (error?.code === "23505") {
    return { error: "Este documento já tem um revisor de comparação atribuído.", conflict: true };
  }
  return error ? { error: error.message } : {};
}

async function getCurrentRoundId(
  supabase: SupabaseServerClient,
  projectId: string,
): Promise<string | null> {
  const { data: project } = await supabase
    .from("projects")
    .select("current_round_id")
    .eq("id", projectId)
    .single();
  return project?.current_round_id ?? null;
}

async function insertCodingAssignmentOrThrow(
  supabase: SupabaseServerClient,
  projectId: string,
  documentId: string,
  userId: string,
): Promise<void> {
  const { error } = await insertCodingAssignment(
    supabase,
    projectId,
    documentId,
    userId,
  );
  if (error) throw new Error(error);
}

async function promoteToComparisonOrThrow(
  supabase: SupabaseServerClient,
  assignmentId: string,
): Promise<string | undefined> {
  const { error, conflict } = await promoteToComparison(supabase, assignmentId);
  if (conflict) return error;
  if (error) throw new Error(error);
  return undefined;
}

async function deleteAssignmentsOrThrow(
  supabase: SupabaseServerClient,
  assignmentIds: string[],
): Promise<void> {
  const { error } = await supabase.from("assignments").delete().in("id", assignmentIds);
  if (error) throw new Error(error.message);
}

async function applyPendingAssignmentTransition(
  supabase: SupabaseServerClient,
  projectId: string,
  documentId: string,
  userId: string,
  pendingCoding: { id: string } | undefined,
  pendingComparison: { id: string } | undefined,
): Promise<string | undefined> {
  const transition = `${Number(Boolean(pendingCoding))}${Number(Boolean(pendingComparison))}`;
  switch (transition) {
    case "00":
      await insertCodingAssignmentOrThrow(supabase, projectId, documentId, userId);
      return undefined;
    case "10":
      return promoteToComparisonOrThrow(supabase, pendingCoding!.id);
    case "01":
      await deleteAssignmentsOrThrow(supabase, [pendingComparison!.id]);
      return undefined;
    case "11":
      await deleteAssignmentsOrThrow(supabase, [pendingCoding!.id, pendingComparison!.id]);
      return undefined;
    default:
      throw new Error("Transição de atribuição inválida");
  }
}

/**
 * Cicla a atribuição de um par (documento, pesquisador) por três estados:
 *   vazio → codificacao → comparacao → vazio
 *
 * Assignments em_andamento/concluido de qualquer tipo bloqueiam o ciclo.
 * Só atribuições pendentes podem ser modificadas/removidas.
 */
export async function cycleAssignment(
  projectId: string,
  documentId: string,
  userId: string,
): Promise<{ error?: string }> {
  const gate = await requireCoordinator(projectId, "Apenas coordenadores podem alterar atribuições.");
  if (!gate.ok) return { error: gate.error };
  const supabase = await createSupabaseServer();
  const currentRoundId = await getCurrentRoundId(supabase, projectId);
  if (!currentRoundId) return { error: "O projeto não possui uma rodada atual." };

  const { data: existing } = await supabase
    .from("assignments")
    .select("id, status, type")
    .eq("document_id", documentId)
    .eq("user_id", userId)
    .eq("project_id", projectId)
    .eq("round_id", currentRoundId);

  const rows = existing || [];

  // Bloquear ciclo se houver assignment não-pendente de qualquer tipo
  const hasNonPending = rows.some((r) => r.status !== "pendente");
  if (hasNonPending) return {};

  const pendingCod = rows.find((r) => r.type === "codificacao");
  const pendingComp = rows.find((r) => r.type === "comparacao");

  try {
    const conflictError = await applyPendingAssignmentTransition(
      supabase,
      projectId,
      documentId,
      userId,
      pendingCod,
      pendingComp,
    );
    if (conflictError) return { error: conflictError };
  } catch (e) {
    return { error: errorMessage(e) || "Erro ao alterar a atribuição" };
  }

  revalidatePath(`/projects/${projectId}/analyze/assignments`);
  revalidatePath(`/projects/${projectId}/analyze/code`);
  revalidatePath(`/projects/${projectId}/analyze/compare`);
  return {};
}

export async function clearPendingAssignments(
  projectId: string,
  type: "codificacao" | "comparacao" = "codificacao"
): Promise<{ deleted?: number; error?: string }> {
  const gate = await requireCoordinator(projectId, "Apenas coordenadores podem limpar atribuições.");
  if (!gate.ok) return { error: gate.error };
  const supabase = await createSupabaseServer();
  const currentRoundId = await getCurrentRoundId(supabase, projectId);
  if (!currentRoundId) return { error: "O projeto não possui uma rodada atual." };

  const { count, error } = await supabase
    .from("assignments")
    .delete({ count: "exact" })
    .eq("project_id", projectId)
    .eq("status", "pendente")
    .eq("type", type)
    .eq("round_id", currentRoundId);

  if (error) {
    return { error: error.message || "Erro ao limpar as atribuições pendentes" };
  }

  revalidatePath(`/projects/${projectId}/analyze/assignments`);
  revalidatePath(`/projects/${projectId}/analyze/code`);
  revalidatePath(`/projects/${projectId}/analyze/compare`);
  return { deleted: count ?? 0 };
}

// --- Smart Lottery (spec 001) ---

interface LotteryParamsBase {
  projectId: string;
  mode: LotteryMode;
  balancing: LotteryBalancing;
  /** semente da prévia (research D13); ausente = gerar nova */
  seed?: number;
  docsPerResearcher?: number;
  docSubsetSize?: number;
  label?: string;
  filters?: LotteryFilters;
  participantIds: string[];
  /**
   * Peso e limite por participante (spec: carga desigual). weight escala a
   * carga na distribuição (default 1); cap é o teto absoluto de docs novos do
   * participante (null/ausente = sem limite individual). Persistido em
   * project_members ao sortear para pré-preencher o próximo sorteio.
   */
  participantSettings?: Record<string, { weight?: number; cap?: number | null }>;
  target?:
    | { kind: "current"; expectedRoundId: string }
    | {
        kind: "new";
        expectedRoundId: string;
        roundLabel: string;
        confirmOpenWork: boolean;
      };
}

/**
 * União discriminada por `type`: "comparação com 2 revisores" deixa de ser
 * construível — o braço `comparacao` não tem o campo. A regra é um revisor de
 * comparação por documento (ver COMPARISON_REVIEWERS_PER_DOC, issue #490).
 *
 * ATENÇÃO: isto é garantia de COMPILAÇÃO, para o client. Server Action é
 * endpoint HTTP público e o projeto não valida com zod — um payload forjado
 * chega com `{ type: "comparacao", researchersPerDoc: 5 }` sem passar por
 * type-check nenhum. As garantias de runtime são `resolveResearchersPerDoc` em
 * computeLottery (que ignora o valor recebido) e, no banco, o índice
 * assignments_one_active_comparacao_per_doc. O `researchersPerDoc?: never`
 * existe só para o excess property check pegar o literal no client.
 */
export type LotteryParams =
  | (LotteryParamsBase & { type: "codificacao"; researchersPerDoc: number })
  | (LotteryParamsBase & { type: "comparacao"; researchersPerDoc?: never });

interface LotteryAssignment {
  document_id: string;
  user_id: string;
}

export interface LotteryPreview {
  participants: { userId: string; existing: number; newDocs: number }[];
  totalNew: number;
  totalPreserved: number;
  /** nº de docs elegíveis pós-filtros (pré-subset) */
  eligibleDocs: number;
  /** semente usada; o dialog a reenvia em smartRandomize (research D13) */
  seed: number;
  targetRoundLabel?: string;
}

interface LotteryDocStatsResult {
  docs: LotteryDocStats[];
  batches: { id: string; label: string | null; createdAt: string }[];
  minResponsesForComparison: number;
  /** modo de automação do projeto — governa o gate de comparação */
  automationMode: string | null;
  currentRoundId: string | null;
  currentRoundLabel: string | null;
  openAssignmentCount: number;
}

interface LotteryData extends LotteryDocStatsResult {
  assignmentRows: {
    document_id: string;
    user_id: string;
    status: string;
    type: string;
    round_id: string;
  }[];
  humanCoderRows: HumanCoderRow[];
}

/**
 * Stats por documento a partir da view `lottery_doc_stats` (issue #182):
 * agrega humanCodingCount/hasLlmResponse/activeAssignments/hasAnyAssignmentEver/
 * batchIds em Postgres, bounded pelo nº de documentos ativos do projeto — sem
 * tocar responses/assignments crus.
 */
async function fetchLotteryDocStats(projectId: string): Promise<LotteryDocStatsResult> {
  const supabase = await createSupabaseServer();

  const [{ data: docs }, { data: batches }, { data: project }, { data: rounds }] = await Promise.all([
    supabase
      .from("lottery_doc_stats")
      .select(
        "id, external_id, title, human_coding_count, has_llm_response, active_codificacao, active_comparacao, has_any_assignment_ever, batch_ids"
      )
      .eq("project_id", projectId),
    supabase
      .from("assignment_batches")
      .select("id, label, created_at, round_id")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false }),
    supabase
      .from("projects")
      .select("min_responses_for_comparison, automation_mode, current_round_id")
      .eq("id", projectId)
      .single(),
    supabase
      .from("rounds")
      .select("id, label")
      .eq("project_id", projectId)
  ]);
  const currentRound = (rounds ?? []).find((round) => round.id === project?.current_round_id);

  return {
    docs: (docs || []).map((d) => ({
      id: d.id,
      externalId: d.external_id,
      title: d.title,
      humanCodingCount: d.human_coding_count,
      hasLlmResponse: d.has_llm_response,
      activeAssignments: {
        codificacao: d.active_codificacao,
        comparacao: d.active_comparacao,
      },
      hasAnyAssignmentEver: d.has_any_assignment_ever,
      batchIds: d.batch_ids || [],
    })),
    batches: (batches || []).filter((b) => b.round_id === project?.current_round_id).map((b) => ({
      id: b.id,
      label: b.label,
      createdAt: b.created_at,
    })),
    minResponsesForComparison: project?.min_responses_for_comparison ?? 2,
    automationMode: project?.automation_mode ?? null,
    currentRoundId: project?.current_round_id ?? null,
    currentRoundLabel: currentRound?.label ?? null,
    openAssignmentCount: (docs || []).reduce(
      (total, d) => total + d.active_codificacao + d.active_comparacao,
      0,
    ),
  };
}

/**
 * Stats agregadas (via fetchLotteryDocStats) + linhas brutas de assignments,
 * necessárias em computeLottery para o conjunto preservado e a matriz de
 * coocorrência entre participantes — aritmética por par documento×usuário
 * que a view não resolve. Esse fetch bruto segue sem teto (issue de
 * acompanhamento da #182).
 */
async function fetchLotteryData(projectId: string): Promise<LotteryData> {
  const supabase = await createSupabaseServer();

  const [stats, { data: assignments }, { data: humanCoders }] = await Promise.all([
    fetchLotteryDocStats(projectId),
    supabase
      .from("assignments")
      .select("document_id, user_id, status, type, round_id")
      .eq("project_id", projectId),
    // Mesmo predicado do trigger enforce_comparison_assignment_actor
    // (20260716160100): resposta humana is_latest define quem codificou.
    // Colunas de rodada e `updated_at` entram para o status inicial (#521); o
    // jsonb `answers` continua FORA daqui — é o fetch bruto do projeto inteiro
    // que a issue #182 tirou deste caminho, e só os pares efetivamente
    // sorteados precisam dele (fase 2, em resolveInitialCodingStatuses).
    supabase
      .from("responses")
      .select(
        "id, document_id, respondent_id, updated_at, round_id, is_partial, schema_version_major, schema_version_minor, schema_version_patch",
      )
      .eq("project_id", projectId)
      .eq("respondent_type", "humano")
      .eq("is_latest", true)
      .not("respondent_id", "is", null),
  ]);

  return {
    ...stats,
    assignmentRows: (assignments || []).map((a) => ({
      document_id: a.document_id,
      user_id: a.user_id,
      status: a.status,
      type: a.type,
      round_id: a.round_id ?? stats.currentRoundId ?? "",
    })),
    humanCoderRows: (humanCoders || []).flatMap((r) =>
      r.respondent_id
        ? [
            {
              id: r.id,
              document_id: r.document_id,
              respondent_id: r.respondent_id,
              updated_at: r.updated_at,
              round_id: r.round_id ?? stats.currentRoundId,
              is_partial: r.is_partial,
              schema_version_major: r.schema_version_major,
              schema_version_minor: r.schema_version_minor,
              schema_version_patch: r.schema_version_patch,
            },
          ]
        : [],
    ),
  };
}

/**
 * Stats leves por documento, carregadas uma vez na abertura do dialog.
 * O client reaplica filterEligibleDocs sobre elas para contagem ao vivo.
 */
export async function getLotteryDocStats(
  projectId: string,
): Promise<Partial<LotteryDocStatsResult> & { error?: string }> {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado" };

  try {
    return await fetchLotteryDocStats(projectId);
  } catch (e) {
    return { error: errorMessage(e) || "Erro ao carregar as estatísticas do sorteio" };
  }
}

async function computeLottery(params: LotteryParams): Promise<{
  newAssignments: LotteryAssignment[];
  preservedCount: number;
  preservedByUser: Record<string, number>;
  eligibleCount: number;
  seed: number;
  batchData: Record<string, unknown>;
  /** tipo normalizado aqui — quem grava reusa em vez de renormalizar */
  assignmentType: "codificacao" | "comparacao";
  /** fase 1 do status inicial (#521): responses humanas leves do projeto */
  humanCoderRows: HumanCoderRow[];
  target: NonNullable<LotteryParams["target"]>;
}> {
  const supabase = await createSupabaseServer();
  // Normaliza em vez de confiar no literal: o payload chega por HTTP e não passa
  // por zod. Qualquer coisa que não seja "comparacao" é codificação.
  const assignmentType =
    params.type === "comparacao" ? "comparacao" : "codificacao";
  // Para comparação o valor pedido é ignorado (sempre 1) — a união discriminada
  // já proíbe o campo no client, e este é o guard para quem vem de fora dela.
  const researchersPerDoc = resolveResearchersPerDoc(
    assignmentType,
    (params as { researchersPerDoc?: number }).researchersPerDoc,
  );
  const filters = params.filters || {};

  if (filters.batchFilter?.only && filters.batchFilter?.exclude?.length) {
    throw new Error("Os filtros de lote são mutuamente exclusivos.");
  }

  const [{ data: members }, data] = await Promise.all([
    supabase
      .from("project_members")
      .select("user_id")
      .eq("project_id", params.projectId),
    fetchLotteryData(params.projectId),
  ]);

  const target = params.target ?? {
    kind: "current" as const,
    expectedRoundId: data.currentRoundId ?? "",
  };
  if (!data.currentRoundId || target.expectedRoundId !== data.currentRoundId) {
    throw new Error("A rodada atual mudou. Reabra o sorteio e tente novamente.");
  }
  const startsNewRound = target.kind === "new";
  if (startsNewRound && assignmentType !== "codificacao") {
    throw new Error("Uma nova rodada só pode ser iniciada pelo sorteio de codificação.");
  }
  if (target.kind === "new" && !target.roundLabel.trim()) {
    throw new Error("Informe o nome da nova rodada.");
  }

  // Pool de participantes: deduplicado e validado contra project_members
  // (qualquer role) — defesa em profundidade além do RLS (research D5)
  const memberIds = new Set((members || []).map((m) => m.user_id));
  const uniqueIds = [...new Set(params.participantIds)];
  const participantIds = uniqueIds.filter((id) => memberIds.has(id));
  if (!participantIds.length || participantIds.length !== uniqueIds.length) {
    throw new Error("Necessário ter ao menos um participante válido.");
  }

  if (!data.docs.length) {
    throw new Error("Necessário ter documentos.");
  }

  // Gate de comparação derivado do modo de automação — compõe com os filtros.
  // compare_llm exige 1 humano + LLM; demais modos exigem N humanos.
  let candidateDocs = startsNewRound
    ? data.docs.map((doc) => ({
        ...doc,
        humanCodingCount: 0,
        hasLlmResponse: false,
        activeAssignments: { codificacao: 0, comparacao: 0 },
        hasAnyAssignmentEver: false,
        batchIds: [],
      }))
    : data.docs;
  if (assignmentType === "comparacao") {
    candidateDocs = filterComparisonEligible(
      candidateDocs,
      data.automationMode,
      data.minResponsesForComparison,
    );
    if (!candidateDocs.length) {
      throw new Error(
        data.automationMode === "compare_llm"
          ? "Nenhum documento tem resposta humana e do LLM para comparação."
          : "Nenhum documento tem respostas humanas suficientes para comparação.",
      );
    }
  }

  const filteredDocs = filterEligibleDocs(candidateDocs, assignmentType, filters);
  if (!filteredDocs.length) {
    throw new Error("Nenhum documento passa nos filtros atuais.");
  }

  // Conjunto preservado conforme o modo (research D4): append preserva
  // todas as atribuições do tipo (inclusive pendentes); replace só as que
  // o sorteio nunca toca (em_andamento/concluido)
  const preservedStatuses = new Set(
    params.mode === "append"
      ? ["pendente", "em_andamento", "concluido"]
      : ["em_andamento", "concluido"]
  );
  const currentRoundRows = startsNewRound
    ? []
    : data.assignmentRows.filter((a) => a.round_id === data.currentRoundId);
  const preserved = currentRoundRows.filter(
    (a) => a.type === assignmentType && preservedStatuses.has(a.status),
  );

  // Anti-duplicidade de par: continua derivando de `preserved` (dependente do
  // modo) — em replace as pendentes são deletadas na mesma transação do RPC,
  // então o par pode voltar a ser sorteado sem violar UNIQUE(doc, user, type).
  const preservedSet = new Set(preserved.map((a) => `${a.document_id}:${a.user_id}`));

  // O trigger enforce_comparison_assignment_actor (20260716160100) rejeita
  // comparação atribuída a quem tem resposta humana is_latest no documento, e
  // apply_lottery_assignments é uma transação única: um único par
  // codificador×próprio-doc abortaria o LOTE inteiro com 23514. O caminho
  // automático já exclui codificadores (loadEligibleReviewerIds); aqui o
  // mesmo invariante entra como par vetado do sorteio manual — veto de par,
  // não de vaga: o codificador continua elegível para outros documentos.
  if (assignmentType === "comparacao") {
    for (const row of data.humanCoderRows.filter(
      (candidate) => candidate.round_id === data.currentRoundId,
    )) {
      preservedSet.add(`${row.document_id}:${row.respondent_id}`);
    }
  }

  // Ocupação de vaga ≠ anti-duplicidade de par. Para comparação a vaga só é
  // ocupada por uma atribuição ATIVA: o invariante é "no máximo 1 comparação
  // ativa por documento" (o mesmo do guard do gatilho automático e do índice
  // assignments_one_active_comparacao_per_doc), não "1 comparação na história do
  // documento". Sem isto, com um revisor por doc, um documento com parecer
  // concluído jamais voltaria ao sorteio — impedindo a re-rodada por versão de
  // schema que o índice existe para permitir. Para codificação, `occupying` é o
  // próprio `preserved`: comportamento idêntico ao anterior (duas codificações
  // concluídas seguem ocupando o documento).
  const occupying =
    assignmentType === "comparacao"
      ? preserved.filter((a) => a.status !== "concluido")
      : preserved;

  const docAssignedCount: Record<string, number> = {};
  const docAssignedUsers: Record<string, Set<string>> = {};
  for (const a of occupying) {
    docAssignedCount[a.document_id] = (docAssignedCount[a.document_id] || 0) + 1;
    (docAssignedUsers[a.document_id] ??= new Set()).add(a.user_id);
  }

  // Carga acumulada segue em `preserved`: uma comparação concluída é trabalho
  // feito — conta para o equilíbrio `history` e é o "existing" da prévia, ainda
  // que não ocupe mais a vaga do documento.
  const loadRows =
    params.balancing === "history"
      ? data.assignmentRows.filter((a) => a.type === assignmentType)
      : preserved;
  const preservedByUser: Record<string, number> = {};
  for (const a of loadRows) {
    preservedByUser[a.user_id] = (preservedByUser[a.user_id] || 0) + 1;
  }

  // Toda a aleatoriedade deriva do PRNG seedado (research D13)
  const seed = params.seed ?? Math.floor(Math.random() * 2 ** 31);
  const rng = createRng(seed);

  // Docs com vaga, considerando o conjunto preservado do modo
  let eligibleDocIds = filteredDocs
    .filter((d) => (docAssignedCount[d.id] || 0) < researchersPerDoc)
    .map((d) => d.id);
  const eligibleCount = eligibleDocIds.length;

  if (params.docSubsetSize && params.docSubsetSize < eligibleDocIds.length) {
    eligibleDocIds = shuffleWithRng(eligibleDocIds, rng).slice(0, params.docSubsetSize);
  }

  // Matriz de co-ocorrência a partir do conjunto preservado
  const coOccurrence: Record<string, Record<string, number>> = {};
  for (const pId of participantIds) {
    coOccurrence[pId] = {};
    for (const pId2 of participantIds) {
      coOccurrence[pId][pId2] = 0;
    }
  }
  for (const users of Object.values(docAssignedUsers)) {
    if (users.size < 2) continue;
    const userArr = Array.from(users);
    for (let i = 0; i < userArr.length; i++) {
      for (let j = i + 1; j < userArr.length; j++) {
        if (coOccurrence[userArr[i]]) coOccurrence[userArr[i]][userArr[j]] = (coOccurrence[userArr[i]][userArr[j]] || 0) + 1;
        if (coOccurrence[userArr[j]]) coOccurrence[userArr[j]][userArr[i]] = (coOccurrence[userArr[j]][userArr[i]] || 0) + 1;
      }
    }
  }

  // Carga acumulada (conjunto preservado do modo) + capacidade + peso.
  // capacity é o teto de docs NOVOS: o limite individual (cap, teto direto de
  // novos) compõe com o global docsPerResearcher (teto total) — vence o menor
  // (ver computeCapacity). O peso escala a chave de distribuição (load/weight).
  const settings = params.participantSettings ?? {};
  const participants: LotteryParticipant[] = participantIds.map((pId) => {
    const accumulatedLoad = preservedByUser[pId] || 0;
    const cfg = settings[pId] ?? {};
    return {
      id: pId,
      accumulatedLoad,
      capacity: computeCapacity({
        accumulatedLoad,
        docsPerResearcher: params.docsPerResearcher,
        cap: cfg.cap,
      }),
      weight: resolveWeight(cfg.weight),
    };
  });

  const newAssignments: LotteryAssignment[] = distributeDocs(
    eligibleDocIds,
    participants,
    {
      researchersPerDoc,
      balancing: params.balancing,
      preservedPairs: preservedSet,
      docAssignedUsers: Object.fromEntries(
        Object.entries(docAssignedUsers).map(([docId, users]) => [
          docId,
          Array.from(users),
        ])
      ),
      coOccurrence,
      rng,
    }
  );

  const batchData = {
    project_id: params.projectId,
    // O lote registra o que aconteceu (o efetivo), não o que foi pedido.
    researchers_per_doc: researchersPerDoc,
    docs_per_researcher: params.docsPerResearcher || null,
    doc_subset_size: params.docSubsetSize || null,
    label: params.label || null,
    mode: params.mode,
    balancing: params.balancing,
    filters: {
      ...filters,
      participantIds,
      participantSettings: settings,
      docSubsetSize: params.docSubsetSize ?? null,
      seed,
    },
  };

  return {
    newAssignments,
    preservedCount: preserved.length,
    preservedByUser,
    eligibleCount,
    seed,
    batchData,
    assignmentType,
    humanCoderRows: data.humanCoderRows,
    target,
  };
}

export async function previewLottery(
  params: LotteryParams,
): Promise<{ preview?: LotteryPreview; error?: string }> {
  const gate = await requireCoordinator(
    params.projectId,
    "Apenas coordenadores podem sortear atribuições.",
  );
  if (!gate.ok) return { error: gate.error };

  try {
    const { newAssignments, preservedCount, preservedByUser, eligibleCount, seed, target } =
      await computeLottery(params);

    const newCounts: Record<string, number> = {};
    for (const a of newAssignments) {
      newCounts[a.user_id] = (newCounts[a.user_id] || 0) + 1;
    }

    return {
      preview: {
        participants: [...new Set(params.participantIds)].map((userId) => ({
          userId,
          existing: preservedByUser[userId] || 0,
          newDocs: newCounts[userId] || 0,
        })),
        totalNew: newAssignments.length,
        totalPreserved: preservedCount,
        eligibleDocs: eligibleCount,
        seed,
        targetRoundLabel:
          target.kind === "new"
            ? target.roundLabel.trim()
            : "Rodada atual",
      },
    };
  } catch (e) {
    return { error: errorMessage(e) || "Erro ao calcular a prévia" };
  }
}

export async function smartRandomize(
  params: LotteryParams,
): Promise<{ count?: number; preserved?: number; error?: string }> {
  const gate = await requireCoordinator(
    params.projectId,
    "Apenas coordenadores podem sortear atribuições.",
  );
  if (!gate.ok) return { error: gate.error };

  const supabase = await createSupabaseServer();

  let count: number;
  let preserved: number;

  // Operação crítica: computeLottery + registro do lote + RPC transacional. Só
  // um erro aqui (nada gravado, ou gravação abortada) deve virar { error }.
  try {
    const { newAssignments, preservedCount, batchData, assignmentType, humanCoderRows, target } =
      await computeLottery(params);

    // Status inicial por linha (#521): um documento já codificado por completo
    // pelo próprio sorteado nasce 'concluido', não 'pendente'. Calculado ANTES
    // do registro do lote — uma falha de leitura aqui aborta o sorteio sem
    // deixar lote órfão. Só codificação: no sorteio de comparação o mapa fica
    // vazio, as chaves não vão no payload e o COALESCE da RPC aplica o default.
    const responsesByPair =
      assignmentType === "codificacao"
        ? new Map(humanCoderRows.map((r) => [pairKey(r.document_id, r.respondent_id), r]))
        : new Map<string, HumanCoderRow>();
    const initialStatuses =
      target.kind === "new"
        ? new Map<string, InitialCodingStatus>()
        : await resolveInitialCodingStatuses(
            supabase,
            params.projectId,
            newAssignments.flatMap((a) => {
              const response = responsesByPair.get(pairKey(a.document_id, a.user_id));
              return response ? [response] : [];
            }),
          );

    // Descarte das pendentes (modo substituir) + gravação das novas numa
    // transação única via RPC (issue #181): uma falha entre o delete e o insert
    // não perde mais as pendentes. SECURITY INVOKER — a RLS do coordenador vale
    // dentro da função. Dispensa o chunk de 100 (era limite de payload PostgREST).
    const assignmentRows = newAssignments.map((a) => {
      const initial = initialStatuses.get(pairKey(a.document_id, a.user_id));
      return {
        document_id: a.document_id,
        user_id: a.user_id,
        ...(initial
          ? { status: initial.status, completed_at: initial.completed_at }
          : {}),
      };
    });
    const { data: result, error: rpcError } = await supabase.rpc(
      "apply_lottery_assignments",
      {
        p_project_id: params.projectId,
        p_type: assignmentType,
        p_expected_round_id: target.expectedRoundId,
        p_new_round_label:
          target.kind === "new" ? target.roundLabel.trim() : null,
        p_confirm_open_work:
          target.kind === "new" && target.confirmOpenWork,
        p_batch: batchData,
        p_assignments: assignmentRows,
        p_replace: params.mode === "replace",
      },
    );
    if (rpcError) {
      throw new Error(`Erro ao gravar as atribuições do sorteio: ${rpcError.message}`);
    }

    // Contagem REAL do RPC, não o tamanho do que se pretendia gravar: o
    // ON CONFLICT DO NOTHING pula linhas quando o gatilho automático cria a
    // comparação do documento entre a leitura do computeLottery (fora da
    // transação) e este INSERT. Reportar o pretendido faria o coordenador ver
    // um número que não está no banco.
    const rpcResult = result as { inserted?: number } | null;
    count = rpcResult?.inserted ?? newAssignments.length;
    preserved = preservedCount;
  } catch (e) {
    return { error: errorMessage(e) || "Erro ao sortear" };
  }

  // Pós-commit best-effort: as atribuições já foram gravadas pelo RPC. Uma falha
  // daqui pra baixo NÃO pode virar { error } — reportar levaria o coordenador a
  // re-sortear em modo "replace" e reescrever o que já foi gravado com sucesso.
  try {
    // Persiste o peso/limite usado por participante (decisão: editar no diálogo,
    // mas assumir continuidade no próximo sorteio). Uma falha aqui só afeta o
    // default da próxima vez.
    const settingsEntries = Object.entries(params.participantSettings ?? {});
    if (settingsEntries.length > 0) {
      const results = await Promise.all(
        settingsEntries.map(([userId, cfg]) =>
          supabase
            .from("project_members")
            .update({
              assignment_weight: resolveWeight(cfg.weight),
              assignment_cap: resolveCap(cfg.cap),
            })
            .eq("project_id", params.projectId)
            .eq("user_id", userId),
        ),
      );
      const failed = results.find((r) => r.error);
      if (failed?.error) {
        console.error(
          `[lottery] falha ao persistir peso/limite por membro: ${failed.error.message}`,
        );
      }
      revalidateTag(membersTag(params.projectId), MEMBERS_TAG_PROFILE);
    }

    revalidatePath(`/projects/${params.projectId}/analyze/assignments`);
    revalidatePath(`/projects/${params.projectId}/analyze/code`);
    revalidatePath(`/projects/${params.projectId}/analyze/compare`);
  } catch (e) {
    console.error(`[lottery] falha nos efeitos pós-sorteio: ${errorMessage(e)}`);
  }

  return { count, preserved };
}
