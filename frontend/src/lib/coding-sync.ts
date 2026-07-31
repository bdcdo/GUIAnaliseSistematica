import "server-only";

import type { SupabaseServerClient } from "@/lib/supabase/server";
import { isCodingComplete } from "@/lib/coding-completeness";
import { drainAutoReviewReconciliationRequests } from "@/lib/auto-review-reconciler";
import { createAutoComparisonIfDiverges } from "@/lib/auto-comparison";
import type { PydanticField } from "@/lib/types";

async function drainAutoReviewForProject(projectId: string): Promise<void> {
  const result = await drainAutoReviewReconciliationRequests({ projectId });
  if (result.failed > 0) {
    throw new Error(
      `${result.failed} pedido(s) de reconciliação permaneceram na fila`,
    );
  }
}

async function runCodingAutomation(
  mode: string | null | undefined,
  projectId: string,
  documentId: string,
  // Falso positivo: `userId` só restringe SELECT/UPDATE pelas policies RLS;
  // a automação chamada abaixo já audita as escritas via admin client.
  // react-doctor-disable-next-line react-doctor/supabase-client-owned-authz-field
  userId: string,
): Promise<void> {
  // Dispara a automacao do projeto ao submeter, conforme automation_mode.
  // Falhas nao bloqueiam o submit do pesquisador — o coordenador pode
  // regenerar o backlog manualmente (regenerateAutoReviewBacklog /
  // retryPendingComparisons). "none" nao dispara nada.
  try {
    if (mode === "auto_review_llm") {
      await drainAutoReviewForProject(projectId);
    } else if (mode === "compare_humans") {
      await createAutoComparisonIfDiverges(projectId, documentId, "compare_humans");
    } else if (mode === "compare_llm") {
      await createAutoComparisonIfDiverges(projectId, documentId, "compare_llm");
    }
  } catch (err) {
    // Log estruturado JSON — mesmo formato dos demais eventos das libs de
    // automacao, facilita grep "[auto-review]" / "[auto-compare]" nos logs.
    const prefix = mode === "auto_review_llm" ? "[auto-review]" : "[auto-compare]";
    console.error(
      `${prefix} ${JSON.stringify({
        event: "inline_call_failed",
        mode,
        projectId,
        documentId,
        userId,
        error: err instanceof Error ? err.message : String(err),
      })}`,
    );
  }
}

export interface SyncCodingAssignmentParams {
  projectId: string;
  documentId: string;
  userId: string;
  fields: PydanticField[];
  sanitizedAnswers: Record<string, unknown>;
  automationMode: string | null | undefined;
  hadCompletedResponse: boolean;
  roundId: string;
}

async function reconcileEditedResponse(
  params: Pick<SyncCodingAssignmentParams, "projectId" | "documentId" | "userId">,
): Promise<{ error?: string }> {
  try {
    await drainAutoReviewForProject(params.projectId);
    return {};
  } catch (error) {
    console.error(
      `[auto-review] ${JSON.stringify({
        event: "edit_reconcile_failed",
        projectId: params.projectId,
        documentId: params.documentId,
        userId: params.userId,
        error: error instanceof Error ? error.message : String(error),
      })}`,
    );
    return {
      error: "Resposta salva e revisão anterior invalidada, mas a nova fila não pôde ser reconciliada. Tente salvar novamente.",
    };
  }
}

async function completeCodingAssignment(
  supabase: SupabaseServerClient,
  params: SyncCodingAssignmentParams,
): Promise<{ error?: string }> {
  const { error } = await supabase
    .from("assignments")
    .update({ status: "concluido", completed_at: new Date().toISOString() })
    .eq("project_id", params.projectId)
    .eq("document_id", params.documentId)
    .eq("user_id", params.userId)
    .eq("type", "codificacao")
    .eq("round_id", params.roundId);
  if (error) return { error: error.message };

  if (!params.hadCompletedResponse) {
    await runCodingAutomation(
      params.automationMode,
      params.projectId,
      params.documentId,
      params.userId,
    );
  }
  return {};
}

async function keepCodingAssignmentInProgress(
  supabase: SupabaseServerClient,
  params: SyncCodingAssignmentParams,
): Promise<{ error?: string }> {
  const { data: currentAssignment } = await supabase
    .from("assignments")
    .select("status")
    .eq("project_id", params.projectId)
    .eq("document_id", params.documentId)
    .eq("user_id", params.userId)
    .eq("type", "codificacao")
    .eq("round_id", params.roundId)
    .maybeSingle();
  if (!currentAssignment || currentAssignment.status === "concluido") return {};

  const { error } = await supabase
    .from("assignments")
    .update({ status: "em_andamento", completed_at: null })
    .eq("project_id", params.projectId)
    .eq("document_id", params.documentId)
    .eq("user_id", params.userId)
    .eq("type", "codificacao")
    .eq("round_id", params.roundId);
  return error ? { error: error.message } : {};
}

// Recalcula o status do assignment de "codificacao" logo depois de um save:
// conclui (e dispara a automação do projeto) quando todo campo está
// respondido; caso contrário regride para em_andamento — mas nunca para fora
// de concluido. Mesma forma "recalcula + atualiza assignment" já estabelecida
// por syncCompareAssignment (compare-sync.ts) para o tipo "comparacao".
export async function syncCodingAssignmentStatus(
  supabase: SupabaseServerClient,
  params: SyncCodingAssignmentParams,
): Promise<{ error?: string }> {
  // Definição única de "codificação completa" — ver lib/coding-completeness.
  // O mesmo helper gateia o backlog de auto-revisão (issue #174).
  const allAnswered = isCodingComplete(params.fields, params.sanitizedAnswers);

  // A response humana continua sendo a mesma row depois do primeiro submit.
  // Portanto, qualquer save posterior precisa reconciliar imediatamente os
  // ciclos que dependiam do valor anterior.
  if (params.hadCompletedResponse) {
    const reconciliation = await reconcileEditedResponse(params);
    if (reconciliation.error) return reconciliation;
  }

  // Até o #608 a promoção era gateada também pelo canal de escrita
  // (`allAnswered && !isAutoSave`): sair da página disparava
  // visibilitychange -> saveResponse, e sem o gate o documento sumia do filtro
  // padrão por virar current_done sem ninguém ter clicado em Enviar. Removido
  // o auto-save, todo save que chega aqui é submit explícito — a completude
  // voltou a ser a condição inteira.
  if (allAnswered) {
    return completeCodingAssignment(supabase, params);
  }

  // Um submit incompleto sobre um assignment já concluído NÃO o rebaixa: a
  // conclusão foi um ato do pesquisador, e o guard de
  // `keepCodingAssignmentInProgress` é quem sustenta essa invariante agora que
  // o gate por canal saiu.
  return keepCodingAssignmentInProgress(supabase, params);
}
