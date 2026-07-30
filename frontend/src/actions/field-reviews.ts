"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { fetchAllPaged } from "@/lib/supabase/paginate";
import {
  getProjectAccessContext,
  requireCoordinator,
  resolveProjectMemberActor,
} from "@/lib/auth";
import { buildLoadMap } from "@/lib/load-balancing";
import { errorMessage } from "@/lib/utils";
import { resolveBlindVerdict } from "@/lib/arbitration-order";
import { verdictRequiresJustification } from "@/lib/auto-review-decided";
import { formatAnswerTechnical } from "@/lib/format-answer";
import { drainAutoReviewReconciliationRequests } from "@/lib/auto-review-reconciler";
import { revalidatePath } from "next/cache";
import type {
  SelfVerdict,
  ArbitrationVerdict,
} from "@/lib/types";

type SupabaseDataClient = ReturnType<typeof createSupabaseAdmin>;

export interface SelfVerdictInput {
  fieldReviewId: string;
  fieldName: string;
  verdict: SelfVerdict;
  // Obrigatoria quando verdict='contesta_llm' ou 'ambiguo'. Em contesta_llm o
  // pesquisador registra por que acha que sua resposta esta correta (exibida ao
  // arbitro na revelacao); em ambiguo registra por que o campo e ambiguo
  // (anexada ao project_comments de discussao).
  justification?: string;
}

interface ReviewAnswerSnapshots {
  id: string;
  field_name: string;
  human_answer_snapshot: unknown;
  llm_answer_snapshot: unknown;
}

function validateSelfVerdictJustifications(
  verdicts: SelfVerdictInput[],
): string | undefined {
  for (const verdict of verdicts) {
    if (!verdictRequiresJustification(verdict.verdict) || verdict.justification?.trim()) {
      continue;
    }
    return verdict.verdict === "ambiguo"
      ? `Campo "${verdict.fieldName}": justificativa obrigatória quando você marca como ambíguo.`
      : `Campo "${verdict.fieldName}": justificativa obrigatória quando você contesta o LLM.`;
  }
  return undefined;
}

function validateRequestedAutoReviewCycles(
  verdicts: SelfVerdictInput[],
  requestedById: Map<string, ReviewAnswerSnapshots>,
): string | undefined {
  for (const verdict of verdicts) {
    if (requestedById.get(verdict.fieldReviewId)?.field_name !== verdict.fieldName) {
      return `Campo "${verdict.fieldName}": ciclo de revisão incompatível.`;
    }
  }
  return undefined;
}

function buildAmbiguityComment(
  verdict: SelfVerdictInput,
  review: ReviewAnswerSnapshots,
): string {
  return [
    `Campo "${verdict.fieldName}" marcado como ambíguo na auto-revisão.`,
    `Humano respondeu: ${formatAnswerTechnical(review.human_answer_snapshot)}`,
    `LLM respondeu: ${formatAnswerTechnical(review.llm_answer_snapshot)}`,
    `Justificativa do pesquisador: ${verdict.justification!.trim()}`,
    "Precisa de discussão para decidir o gabarito.",
  ].join("\n\n");
}

function buildAutoReviewRpcRows(
  verdicts: SelfVerdictInput[],
  requestedById: Map<string, ReviewAnswerSnapshots>,
) {
  return verdicts.map((verdict) => {
    const review = requestedById.get(verdict.fieldReviewId)!;
    return {
      field_review_id: verdict.fieldReviewId,
      field_name: verdict.fieldName,
      verdict: verdict.verdict,
      justification: verdict.justification?.trim() ?? null,
      comment_body:
        verdict.verdict === "ambiguo"
          ? buildAmbiguityComment(verdict, review)
          : null,
    };
  });
}

function buildNoArbitratorWarning(
  noPool: boolean | undefined,
  verdicts: SelfVerdictInput[],
): string | undefined {
  if (!noPool) return undefined;
  const contestedCount = verdicts.filter(
    (verdict) => verdict.verdict === "contesta_llm",
  ).length;
  return `Não há árbitros elegíveis para ${contestedCount} campo(s) contestado(s). Peça ao coordenador para marcar membros como elegíveis em Configuração → Equipe.`;
}

function revalidateAutoReviewSubmission(projectId: string): void {
  revalidatePath(`/projects/${projectId}/analyze/auto-revisao`);
  revalidatePath(`/projects/${projectId}/analyze/arbitragem`);
}

// Humano original conclui sua fase de auto-revisao. Para cada campo:
//   - admite_erro  → gabarito do campo = LLM, fica resolvido
//   - contesta_llm → cai na fila de arbitragem (sorteia arbitro neste mesmo call)
//   - equivalente  → registra o par humano↔LLM em response_equivalences; campo
//                    fica resolvido, sem arbitragem
//   - ambiguo      → gera um project_comments para discussao; campo fica
//                    resolvido, sem arbitragem
//
// Idempotente: a RPC grava vereditos e efeitos na mesma transação e não troca
// decisões nem árbitros já registrados em retries equivalentes.
export async function submitAutoReview(
  projectId: string,
  documentId: string,
  verdicts: SelfVerdictInput[],
): Promise<{
  success: boolean;
  error?: string;
  warning?: string;
  arbitrated?: number;
}> {
  try {
    const actor = await resolveProjectMemberActor(projectId);
    if (!actor.ok) return { success: false, error: actor.error };

    // contesta_llm e ambiguo exigem justificativa — o arbitro precisa do
    // contraponto humano na revelacao; ambiguo leva o porque para a discussao.
    const justificationError = validateSelfVerdictJustifications(verdicts);
    if (justificationError) return { success: false, error: justificationError };

    // Esta action usa service role para materializar efeitos que um pesquisador
    // não pode escrever diretamente (equivalência, comentário e arbitragem).
    // Revalidar o acesso no entrypoint impede que uma linha histórica seja usada
    // para acionar o bypass depois da remoção do projeto.
    const access = await getProjectAccessContext(projectId, actor.user);
    if (access.status !== "resolved" || !access.project) {
      return { success: false, error: "Projeto não encontrado ou inacessível." };
    }
    const effectiveId = actor.memberUserId;

    const admin = createSupabaseAdmin();

    const { data: requestedReviews, error: requestedReviewsError } = await admin
      .from("field_reviews")
      .select("id, field_name, human_answer_snapshot, llm_answer_snapshot")
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .eq("self_reviewer_id", effectiveId)
      .is("superseded_at", null)
      .in("id", verdicts.map((verdict) => verdict.fieldReviewId));
    if (requestedReviewsError) {
      return { success: false, error: requestedReviewsError.message };
    }
    const requestedById = new Map<string, ReviewAnswerSnapshots>(
      (requestedReviews ?? []).map((review) => [review.id, review]),
    );
    const cycleError = validateRequestedAutoReviewCycles(verdicts, requestedById);
    if (cycleError) return { success: false, error: cycleError };

    const rpcRows = buildAutoReviewRpcRows(verdicts, requestedById);
    const { data, error } = await admin.rpc("submit_auto_review_verdicts", {
      p_project_id: projectId,
      p_document_id: documentId,
      p_reviewer_id: effectiveId,
      p_rows: rpcRows,
    });
    if (error) return { success: false, error: error.message };
    const result = (data ?? {}) as { arbitrated?: number; no_pool?: boolean };
    const warning = buildNoArbitratorWarning(result.no_pool, verdicts);

    revalidateAutoReviewSubmission(projectId);
    return { success: true, arbitrated: result.arbitrated ?? 0, warning };
  } catch (e) {
    return { success: false, error: errorMessage(e) || "Erro" };
  }
}

// Escolhe um arbitro elegível com balanceamento por carga; em empate na menor
// carga, sorteia aleatoriamente entre os candidatos para evitar viés
// estrutural em projetos pequenos. Prefere quem NÃO codificou o documento;
// quando isso é impossível, cai para qualquer elegível != auto-revisor.
//
// Granularidade: TODOS os campos contestados deste submit recebem o MESMO
// arbitro (um por documento, nao um por campo). Intencional para coerencia —
// o arbitro ve todos os campos do mesmo doc de uma vez. A tabela
// field_reviews permite arbitros diferentes por campo, mas este caminho
// (submit unico → 1 arbitro por doc) prefere coerencia sobre granularidade.
//
// Dois submits concorrentes ainda podem ler o mesmo `minLoad` e escolher o
// mesmo árbitro — isso só degrada o balanceamento. A correção não depende
// dessa leitura: a RPC final valida can_arbitrate sob lock e grava revisão +
// assignment na mesma transação, serializada com a desabilitação do membro.
//
// Idempotente: arbitrator_id so e gravado em field_reviews que ainda nao
// tem arbitro definido (re-chamadas nao trocam um arbitro ja escolhido).
//
// Retorna:
//  - count: quantidade de field_reviews efetivamente atribuidos
//  - noPool: true se o projeto não tem outros membros disponíveis (chamador
//    usa para alertar o pesquisador; sem esse sinal, o submit completa
//    silenciosamente e os campos ficam presos sem árbitro)
async function assignArbitrator(
  admin: SupabaseDataClient,
  projectId: string,
  documentId: string,
  excludeUserId: string,
  fieldReviewIds: string[],
  precomputedCoderIds?: Set<string>,
): Promise<{ count: number; noPool: boolean }> {
  // Codificadores humanos deste documento — quem já tem resposta registrada
  // para o doc (recurso de comparação N+). Quando o caller pré-buscou em
  // batch (retryPendingArbitrations), reusa o set para evitar N queries.
  let coderIds: Set<string>;
  if (precomputedCoderIds) {
    coderIds = precomputedCoderIds;
  } else {
    const { data: coders } = await admin
      .from("responses")
      .select("respondent_id")
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .eq("respondent_type", "humano");
    coderIds = new Set<string>();
    for (const c of coders ?? []) {
      if (c.respondent_id) coderIds.add(c.respondent_id as string);
    }
  }

  // Elegíveis (can_arbitrate) menos o auto-revisor original — esse nunca
  // arbitra, sob nenhuma circunstância, porque julgaria a própria resposta.
  //
  // Paginado porque este pool é um universo: truncado no teto do PostgREST, um
  // árbitro apto simplesmente não existe para o sorteio. Diferente do sorteio de
  // participantes em computeLottery, um erro aqui NÃO precisa lançar — o pool
  // parcial ainda devolve árbitro válido (a RPC final revalida can_arbitrate sob
  // lock), e uma leitura que falhe inteira cai em noPool=true, que já é sinal
  // visível no banner de pendências. O que se perde é balanceamento, não
  // correção.
  const { data: eligibleMembers } = await fetchAllPaged<{
    user_id: string;
    role: string;
  }>(
    () =>
      admin
        .from("project_members")
        .select("user_id, role")
        .eq("project_id", projectId)
        .eq("can_arbitrate", true),
    "user_id",
  );
  const eligible = (eligibleMembers ?? []).filter(
    (m) => m.user_id !== excludeUserId,
  );

  // Pool ideal: árbitro que NÃO codificou o documento — totalmente neutro na
  // fase cega. Fallback: documentos codificados por toda a equipe elegível
  // (ex.: docs de calibração) não têm terceiro neutro possível; aceita-se
  // então qualquer elegível != auto-revisor — ele não julga a própria
  // resposta, ainda que tenha codificado o mesmo doc. noPool=true só quando
  // nem o fallback tem candidato → o caso cai no banner de pendências.
  const neutral = eligible.filter((m) => !coderIds.has(m.user_id));
  const members = neutral.length > 0 ? neutral : eligible;
  if (members.length === 0) return { count: 0, noPool: true };

  // Conta arbitragens abertas por candidato (balanceamento)
  const { data: openCounts } = await admin
    .from("assignments")
    .select("user_id")
    .eq("project_id", projectId)
    .eq("type", "arbitragem")
    .neq("status", "concluido");

  const loadByUser = buildLoadMap(openCounts ?? []);

  // Carga minima entre candidatos
  let minLoad = Infinity;
  for (const m of members) {
    const l = loadByUser.get(m.user_id) ?? 0;
    if (l < minLoad) minLoad = l;
  }

  // Pesquisador tem prioridade sobre coordenador na menor carga
  const candidatesAtMinLoad = members.filter(
    (m) => (loadByUser.get(m.user_id) ?? 0) === minLoad,
  );
  const researchersAtMinLoad = candidatesAtMinLoad.filter(
    (m) => m.role === "pesquisador",
  );
  const finalPool = researchersAtMinLoad.length > 0
    ? researchersAtMinLoad
    : candidatesAtMinLoad;

  // Sorteio aleatorio entre os empatados
  const arbitratorId =
    finalPool[Math.floor(Math.random() * finalPool.length)].user_id;

  const { data: assigned, error: assignmentError } = await admin.rpc(
    "assign_arbitration_cycles_if_eligible",
    {
      p_project_id: projectId,
      p_document_id: documentId,
      p_user_id: arbitratorId,
      p_field_review_ids: fieldReviewIds,
    },
  );
  if (assignmentError) throw new Error(assignmentError.message);

  return { count: typeof assigned === "number" ? assigned : 0, noPool: false };
}

export interface BlindChoice {
  fieldReviewId: string;
  choice: "a" | "b";
}

// Fase 1 da arbitragem: arbitro escolhe cegamente entre A/B (sem justificativa).
// O cliente envia apenas A/B; o servidor traduz para humano/llm via assignOrder
// (deterministico por fieldReviewId) — assim o mapeamento A/B → humano/llm
// nunca trafega para o navegador na fase cega, eliminando o vetor de
// inspecao via DevTools.
//
// So aceita escrever onde arbitrator_id = current user e blind_verdict IS NULL.
// Retries com mesmo verdict sao tolerados como no-op (idempotente); retries
// com verdict diferente retornam erro descritivo em vez de no-op silencioso.
export async function submitBlindVerdicts(
  projectId: string,
  documentId: string,
  choices: BlindChoice[],
): Promise<{ success: boolean; error?: string }> {
  try {
    const actor = await resolveProjectMemberActor(projectId);
    if (!actor.ok) return { success: false, error: actor.error };
    const effectiveId = actor.memberUserId;

    const supabase = await createSupabaseServer();
    const now = new Date().toISOString();

    const results = await Promise.all(
      choices.map((c) => {
        const verdict = resolveBlindVerdict(c.fieldReviewId, c.choice);
        return supabase
          .from("field_reviews")
          .update({ blind_verdict: verdict, blind_decided_at: now })
          .eq("project_id", projectId)
          .eq("document_id", documentId)
          .eq("id", c.fieldReviewId)
          .eq("arbitrator_id", effectiveId)
          .is("superseded_at", null)
          .is("blind_verdict", null)
          .select("id");
      }),
    );

    // Detecta UPDATE de 0 linhas: pode ser RLS, linha inexistente OU ja
    // decidida. Re-fetch para diferenciar idempotente (mesmo verdict) de
    // conflito real.
    const failedIndices: number[] = [];
    for (let i = 0; i < results.length; i++) {
      const res = results[i];
      if (res.error) return { success: false, error: res.error.message };
      if (!res.data || res.data.length === 0) {
        failedIndices.push(i);
      }
    }

    if (failedIndices.length > 0) {
      const failedIds = failedIndices.map((i) => choices[i].fieldReviewId);
      const { data: existing } = await supabase
        .from("field_reviews")
        .select("id, blind_verdict")
        .in("id", failedIds)
        .eq("arbitrator_id", effectiveId)
        .is("superseded_at", null);
      const existingById = new Map(
        (existing ?? []).map((r) => [
          r.id as string,
          r.blind_verdict as ArbitrationVerdict | null,
        ]),
      );

      for (const i of failedIndices) {
        const c = choices[i];
        const expected = resolveBlindVerdict(c.fieldReviewId, c.choice);
        const current = existingById.get(c.fieldReviewId);
        if (current === undefined) {
          return {
            success: false,
            error: `Linha de revisão não encontrada ou sem permissão (${c.fieldReviewId}).`,
          };
        }
        if (current === expected) {
          continue; // idempotente OK
        }
        return {
          success: false,
          error: `Veredito cego já registrado com valor diferente para ${c.fieldReviewId}.`,
        };
      }
    }

    revalidatePath(`/projects/${projectId}/analyze/arbitragem`);
    return { success: true };
  } catch (e) {
    return { success: false, error: errorMessage(e) || "Erro" };
  }
}

export interface FinalChoice {
  fieldReviewId: string;
  fieldName: string;
  verdict: ArbitrationVerdict;
  questionImprovementSuggestion?: string;
  arbitratorComment?: string;
}

interface FinalReviewState extends ReviewAnswerSnapshots {
  blind_verdict: string | null;
  final_verdict: string | null;
}

function validateFinalChoiceSuggestions(
  choices: FinalChoice[],
): string | undefined {
  for (const choice of choices) {
    if (choice.verdict === "llm" && !choice.questionImprovementSuggestion?.trim()) {
      return `Campo "${choice.fieldName}": sugestão de melhoria obrigatória quando você decide pelo LLM contra o humano.`;
    }
  }
  return undefined;
}

function validateFinalReviewStates(
  choices: FinalChoice[],
  reviewsById: Map<string, FinalReviewState>,
): string | undefined {
  for (const choice of choices) {
    const review = reviewsById.get(choice.fieldReviewId);
    if (!review || review.field_name !== choice.fieldName) {
      return `Campo "${choice.fieldName}": linha de revisão não encontrada ou sem permissão.`;
    }
    if (review.blind_verdict == null) {
      return `Campo "${choice.fieldName}": fase cega ainda não decidida.`;
    }
    if (review.final_verdict != null && review.final_verdict !== choice.verdict) {
      return `Campo "${choice.fieldName}": veredito final já registrado como "${review.final_verdict}".`;
    }
  }
  return undefined;
}

function buildFinalVerdictComment(
  choice: FinalChoice,
  review: FinalReviewState,
): string {
  return [
    `Discordância em "${choice.fieldName}".`,
    `Humano respondeu: ${formatAnswerTechnical(review.human_answer_snapshot)}`,
    `LLM respondeu: ${formatAnswerTechnical(review.llm_answer_snapshot)}`,
    "Árbitro manteve LLM.",
    `Sugestão de melhoria: ${choice.questionImprovementSuggestion}`,
    choice.arbitratorComment ? `Comentário: ${choice.arbitratorComment}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildFinalVerdictRpcRows(
  choices: FinalChoice[],
  reviewsById: Map<string, FinalReviewState>,
) {
  return choices.map((choice) => {
    const review = reviewsById.get(choice.fieldReviewId)!;
    return {
      field_review_id: choice.fieldReviewId,
      field_name: choice.fieldName,
      verdict: choice.verdict,
      question_improvement_suggestion:
        choice.questionImprovementSuggestion?.trim() ?? null,
      arbitrator_comment: choice.arbitratorComment?.trim() ?? null,
      comment_body:
        choice.verdict === "llm" ? buildFinalVerdictComment(choice, review) : null,
    };
  });
}

function revalidateFinalVerdictSubmission(projectId: string): void {
  revalidatePath(`/projects/${projectId}/analyze/arbitragem`);
}

// Fase 2: arbitro confirma/troca veredito apos ver justificativa LLM.
// Se final_verdict='llm' (humano perdeu), exige question_improvement_suggestion
// e cria entry em project_comments com contexto da divergencia.
// Marca assignment arbitragem como concluido se TODOS os field_reviews do doc
// tiverem final_verdict definido.
export async function submitFinalVerdicts(
  projectId: string,
  documentId: string,
  choices: FinalChoice[],
): Promise<{ success: boolean; error?: string }> {
  try {
    const actor = await resolveProjectMemberActor(projectId);
    if (!actor.ok) return { success: false, error: actor.error };
    const effectiveId = actor.memberUserId;

    // Validacao: se humano perdeu (final='llm'), sugestao obrigatoria
    const suggestionError = validateFinalChoiceSuggestions(choices);
    if (suggestionError) return { success: false, error: suggestionError };

    const supabase = await createSupabaseServer();
    // 1) Carrega field_reviews com estado atual (inclui blind/final_verdict).
    // O estado pre-carregado permite que retries apos falha parcial no comentario
    // detectem "ja gravado com mesmo verdict" como sucesso idempotente em vez
    // de erro travante.
    // Os comentários finais usam os mesmos snapshots apresentados ao árbitro;
    // reler responses mutáveis aqui poderia registrar outro valor.
    const { data: frRows, error: frErr } = await supabase
      .from("field_reviews")
      .select(
        "id, field_name, human_answer_snapshot, llm_answer_snapshot, blind_verdict, final_verdict",
      )
      .eq("project_id", projectId)
      .eq("document_id", documentId)
      .in("id", choices.map((choice) => choice.fieldReviewId))
      .eq("arbitrator_id", effectiveId)
      .is("superseded_at", null);
    if (frErr) return { success: false, error: frErr.message };

    const frById = new Map<string, FinalReviewState>(
      (frRows ?? []).map((review) => [review.id as string, review]),
    );

    // Pre-validacao por linha + classificacao (skip idempotente vs erro vs update).
    const stateError = validateFinalReviewStates(choices, frById);
    if (stateError) return { success: false, error: stateError };

    const rpcRows = buildFinalVerdictRpcRows(choices, frById);
    const admin = createSupabaseAdmin();
    const { error: submitError } = await admin.rpc(
      "submit_final_review_verdicts",
      {
        p_project_id: projectId,
        p_document_id: documentId,
        p_arbitrator_id: effectiveId,
        p_rows: rpcRows,
      },
    );
    if (submitError) return { success: false, error: submitError.message };

    revalidateFinalVerdictSubmission(projectId);
    return { success: true };
  } catch (e) {
    return { success: false, error: errorMessage(e) || "Erro" };
  }
}

// Reparo coordenador-only: reenfileira o projeto e usa o mesmo reconciliador
// canônico acionado por saves e reruns LLM. Não há um segundo cálculo de
// divergência neste caminho manual.
export async function regenerateAutoReviewBacklog(
  projectId: string,
): Promise<{
  success: boolean;
  error?: string;
  queued?: number;
  processed?: number;
  deferred?: number;
}> {
  try {
    const gate = await requireCoordinator(
      projectId,
      "Apenas coordenadores podem regenerar o backlog.",
    );
    if (!gate.ok) return { success: false, error: gate.error };

    const admin = createSupabaseAdmin();
    const { data: queued, error: enqueueError } = await admin.rpc(
      "enqueue_auto_review_reconciliation_for_project",
      { p_project_id: projectId },
    );
    if (enqueueError) return { success: false, error: enqueueError.message };

    const drainResult = await drainAutoReviewReconciliationRequests({
      projectId,
      maxRequests: 2_000,
    });
    if (drainResult.failed > 0) {
      return {
        success: false,
        error: `${drainResult.failed} pedido(s) de reconciliação falharam e permaneceram na fila para nova tentativa.`,
      };
    }

    revalidatePath(`/projects/${projectId}/analyze/auto-revisao`);
    revalidatePath(`/projects/${projectId}/analyze/arbitragem`);
    return {
      success: true,
      queued: typeof queued === "number" ? queued : 0,
      processed: drainResult.processed,
      deferred: drainResult.deferred,
    };
  } catch (e) {
    return { success: false, error: errorMessage(e) || "Erro" };
  }
}

// Re-tenta alocar árbitro para todo field_review do projeto que está pendente
// (self_verdict='contesta_llm' AND arbitrator_id IS NULL). Disparada quando o
// coordenador habilita um novo membro como elegível em setCanArbitrate, para
// drenar o backlog acumulado enquanto não havia ninguém.
//
// Agrupa por (document_id, self_reviewer_id) e chama assignArbitrator para
// cada grupo — preserva a regra "todos os campos contestados do mesmo doc
// recebem o MESMO árbitro" e a exclusão do auto-revisor original do pool.
export async function retryPendingArbitrations(
  projectId: string,
): Promise<{
  success: boolean;
  error?: string;
  assigned: number;
  stillNoPool: number;
}> {
  try {
    const gate = await requireCoordinator(
      projectId,
      "Apenas coordenadores podem reprocessar arbitragens.",
    );
    if (!gate.ok)
      return { success: false, error: gate.error, assigned: 0, stillNoPool: 0 };

    const supabase = createSupabaseAdmin();
    const { data: pending, error } = await supabase
      .from("field_reviews")
      .select("id, document_id, self_reviewer_id")
      .eq("project_id", projectId)
      .eq("self_verdict", "contesta_llm")
      .is("superseded_at", null)
      .is("arbitrator_id", null);
    if (error)
      return { success: false, error: error.message, assigned: 0, stillNoPool: 0 };
    if (!pending || pending.length === 0)
      return { success: true, assigned: 0, stillNoPool: 0 };

    const groups = new Map<
      string,
      { documentId: string; selfReviewerId: string; fieldReviewIds: string[] }
    >();
    for (const p of pending) {
      const key = `${p.document_id}|${p.self_reviewer_id}`;
      const g =
        groups.get(key) ??
        {
          documentId: p.document_id as string,
          selfReviewerId: p.self_reviewer_id as string,
          fieldReviewIds: [] as string[],
        };
      g.fieldReviewIds.push(p.id as string);
      groups.set(key, g);
    }

    // Pré-busca em batch: codificadores humanos de todos os docs pendentes
    // de uma vez. assignArbitrator originalmente faz 1 SELECT em responses
    // por chamada — em loop de N groups isso vira N queries. Centralizar
    // num único SELECT mantém a chamada O(1) em queries de responses
    // independente do tamanho do backlog.
    const allDocIds = [
      ...new Set([...groups.values()].map((g) => g.documentId)),
    ];
    const codersByDoc = new Map<string, Set<string>>();
    if (allDocIds.length > 0) {
      const { data: allCoders } = await supabase
        .from("responses")
        .select("document_id, respondent_id")
        .eq("project_id", projectId)
        .in("document_id", allDocIds)
        .eq("respondent_type", "humano");
      for (const c of allCoders ?? []) {
        const docId = c.document_id as string;
        const respId = c.respondent_id as string | null;
        if (!respId) continue;
        let set = codersByDoc.get(docId);
        if (!set) {
          set = new Set<string>();
          codersByDoc.set(docId, set);
        }
        set.add(respId);
      }
    }

    // Sequencial intencionalmente: cada assignArbitrator lê openCounts
    // recalculado, preservando o balanceamento entre grupos. Paralelizar com
    // Promise.all faria todos os groups verem o mesmo minLoad e sortearem
    // dentro do mesmo pool — degrada a distribuição (mesma race tolerada em
    // submitAutoReview concorrente para docs diferentes, mas aqui evitável
    // a custo zero porque o loop está dentro de uma única chamada).
    let assigned = 0;
    let stillNoPool = 0;
    for (const g of groups.values()) {
      // Sequencial intencional (ver comentário acima): cada assignArbitrator lê
      // openCounts recalculado; paralelizar degradaria a distribuição.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const result = await assignArbitrator(
        supabase,
        projectId,
        g.documentId,
        g.selfReviewerId,
        g.fieldReviewIds,
        codersByDoc.get(g.documentId) ?? new Set<string>(),
      );
      assigned += result.count;
      if (result.noPool) stillNoPool++;
    }

    revalidatePath(`/projects/${projectId}/analyze/arbitragem`);
    revalidatePath(`/projects/${projectId}/config/members`);
    return { success: true, assigned, stillNoPool };
  } catch (e) {
    return {
      success: false,
      error: errorMessage(e) || "Erro",
      assigned: 0,
      stillNoPool: 0,
    };
  }
}
