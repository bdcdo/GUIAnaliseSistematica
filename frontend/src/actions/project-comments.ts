"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser, requireCoordinator } from "@/lib/auth";
import {
  excludeDocuments,
  revalidateProjectDocumentsCache,
} from "@/actions/documents";
import { revalidatePath } from "next/cache";

export async function createProjectComment(
  projectId: string,
  body: string,
  documentId?: string | null,
  fieldName?: string | null,
  parentId?: string | null,
) {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado" };

  const supabase = await createSupabaseServer();

  const { error } = await supabase.from("project_comments").insert({
    project_id: projectId,
    document_id: documentId || null,
    field_name: fieldName || null,
    author_id: user.id,
    body: body.trim(),
    parent_id: parentId || null,
    kind: "note",
  });

  if (error) return { error: error.message };

  revalidatePath(`/projects/${projectId}/reviews/comments`);
  return { success: true };
}

// Pesquisador sinaliza documento como fora de escopo. O pedido pendente já
// esconde o doc das filas de todos (documents.exclusion_pending_at, mantido
// por trigger no banco); o coordenador resolve em /reviews/comments aprovando
// (soft delete) ou rejeitando (doc volta às filas).
export async function requestDocumentExclusion(
  projectId: string,
  documentId: string,
  reason: string,
) {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado" };
  if (!reason?.trim())
    return { error: "Informe o motivo da sugestão de exclusão" };

  const supabase = await createSupabaseServer();

  // Guardas em paralelo: doc já excluído/em revisão, pedido duplicado do
  // mesmo autor e recurso desligado pelo coordenador. O toggle
  // (projects.out_of_scope_enabled) só esconde a pergunta no client — sem
  // este check, a action segue aceitando pedidos por chamada direta mesmo
  // com o recurso desligado no projeto.
  const [{ data: doc }, { data: existing }, { data: project }] =
    await Promise.all([
      supabase
        .from("documents")
        .select("excluded_at, exclusion_pending_at")
        .eq("id", documentId)
        .eq("project_id", projectId)
        .maybeSingle(),
      supabase
        .from("project_comments")
        .select("id")
        .eq("project_id", projectId)
        .eq("document_id", documentId)
        .eq("author_id", user.id)
        .eq("kind", "exclusion_request")
        .is("resolved_at", null)
        .is("rejected_at", null)
        .maybeSingle(),
      supabase
        .from("projects")
        .select("out_of_scope_enabled")
        .eq("id", projectId)
        .maybeSingle(),
    ]);

  if (!project?.out_of_scope_enabled) {
    return {
      error: "Sinalização de documentos fora do escopo está desligada neste projeto",
    };
  }
  if (!doc) return { error: "Documento não encontrado" };
  if (doc.excluded_at)
    return { error: "Documento já foi removido do escopo do projeto" };
  if (existing) {
    return {
      error: "Você já tem uma sugestão pendente para este documento",
    };
  }
  if (doc.exclusion_pending_at) {
    return {
      error:
        "Documento já está em revisão de escopo, sinalizado por outro pesquisador",
    };
  }

  const { error } = await supabase.from("project_comments").insert({
    project_id: projectId,
    document_id: documentId,
    field_name: null,
    author_id: user.id,
    body: reason.trim(),
    parent_id: null,
    kind: "exclusion_request",
  });

  if (error) return { error: error.message };

  revalidatePath(`/projects/${projectId}/reviews/comments`);
  // O doc some imediatamente das filas de codificação e da Comparação.
  revalidatePath(`/projects/${projectId}/analyze/code`);
  revalidatePath(`/projects/${projectId}/analyze/compare`);
  // A fila de Assignments é lida direto do banco (#664), mas a rota continua
  // precisando de revalidatePath para o coordenador não ver o doc como
  // atribuível a partir de uma renderização já em cache do Router.
  await revalidateProjectDocumentsCache(projectId);
  return { success: true };
}

// Autor desfaz o próprio pedido pendente (toggle desligado). DELETE, e não
// auto-resolve: resolved_at setado renderizaria como "aprovado" na fila do
// coordenador. A policy "Authors can delete own pending exclusion requests"
// garante que só o autor apaga, e só enquanto pendente; o trigger de
// recompute devolve o doc às filas.
export async function cancelExclusionRequest(
  projectId: string,
  documentId: string,
) {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado" };

  const supabase = await createSupabaseServer();

  const { data, error } = await supabase
    .from("project_comments")
    .delete()
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .eq("author_id", user.id)
    .eq("kind", "exclusion_request")
    .is("resolved_at", null)
    .is("rejected_at", null)
    .select("id");

  if (error) return { error: error.message };
  if (!data || data.length === 0)
    return { error: "Nenhuma sugestão pendente sua para este documento" };

  revalidatePath(`/projects/${projectId}/reviews/comments`);
  revalidatePath(`/projects/${projectId}/analyze/code`);
  revalidatePath(`/projects/${projectId}/analyze/compare`);
  await revalidateProjectDocumentsCache(projectId);
  return { success: true };
}

// Coordenador aprova: faz soft delete no documento (via excludeDocuments para
// usar o mesmo flow do "Excluir" manual) e marca o pedido como resolvido.
export async function approveExclusionRequest(
  commentId: string,
  projectId: string,
) {
  const gate = await requireCoordinator(
    projectId,
    "Apenas coordenador pode aprovar sugestões de exclusão",
  );
  if (!gate.ok) return { error: gate.error };
  const user = gate.user;

  const supabase = await createSupabaseServer();

  const { data: comment } = await supabase
    .from("project_comments")
    .select("id, document_id, body, kind")
    .eq("id", commentId)
    .eq("project_id", projectId)
    .single();

  if (!comment) return { error: "Sugestão não encontrada" };
  if (comment.kind !== "exclusion_request")
    return { error: "Comentário não é uma sugestão de exclusão" };
  if (!comment.document_id)
    return { error: "Sugestão sem documento associado" };

  const reason = `Aprovada sugestão do pesquisador: ${comment.body}`.slice(
    0,
    1000,
  );

  // 1. soft delete via excludeDocuments — mantem fluxo unificado com o botao
  //    "Excluir" da config de documentos (auditoria e revalidatePath de
  //    config/documents ja saem dele).
  const docResult = await excludeDocuments(
    projectId,
    [comment.document_id],
    reason,
  );
  if ("error" in docResult) return { error: docResult.error };

  // 2. resolver TODOS os pedidos pendentes do doc (não só o commentId) —
  //    a decisão de escopo é do documento; pedidos de outros autores
  //    (legado, anterior à guarda de duplicata) não podem ficar pendentes
  //    para sempre na fila.
  const { error: commentError } = await supabase
    .from("project_comments")
    .update({
      resolved_at: new Date().toISOString(),
      resolved_by: user.id,
    })
    .eq("project_id", projectId)
    .eq("document_id", comment.document_id)
    .eq("kind", "exclusion_request")
    .is("resolved_at", null)
    .is("rejected_at", null);

  if (commentError) return { error: commentError.message };

  revalidatePath(`/projects/${projectId}/reviews/comments`);
  // Pesquisador codificando esse doc precisa ver a atualizacao.
  revalidatePath(`/projects/${projectId}/analyze/code`);
  return { success: true };
}

export async function rejectExclusionRequest(
  commentId: string,
  projectId: string,
  rejectionReason: string,
) {
  // Gate de coordenador roda antes da validação de motivo — mesma ordem
  // adotada em excludeDocuments (documents.ts) ao migrar para
  // requireCoordinator, que empacota auth+coordenador como unidade atômica.
  const gate = await requireCoordinator(
    projectId,
    "Apenas coordenador pode rejeitar sugestões de exclusão",
  );
  if (!gate.ok) return { error: gate.error };
  const user = gate.user;
  if (!rejectionReason?.trim())
    return { error: "Informe o motivo da rejeição" };

  const supabase = await createSupabaseServer();

  // A decisão de escopo é do documento: rejeitar cascateia para todos os
  // pedidos pendentes do mesmo doc (legado pode ter mais de um autor), e o
  // trigger de recompute limpa exclusion_pending_at quando o último some —
  // o doc volta às filas de todos.
  const { data: target } = await supabase
    .from("project_comments")
    .select("id, document_id")
    .eq("id", commentId)
    .eq("project_id", projectId)
    .eq("kind", "exclusion_request")
    .maybeSingle();

  if (!target) return { error: "Sugestão não encontrada" };

  let query = supabase
    .from("project_comments")
    .update({
      rejected_at: new Date().toISOString(),
      rejected_reason: rejectionReason.trim(),
      resolved_by: user.id,
    })
    .eq("project_id", projectId)
    .eq("kind", "exclusion_request")
    .is("resolved_at", null)
    .is("rejected_at", null);
  // Pedido órfão (doc apagado, document_id SET NULL): rejeita só o alvo.
  query = target.document_id
    ? query.eq("document_id", target.document_id)
    : query.eq("id", target.id);
  const { data, error } = await query.select("id");

  if (error) return { error: error.message };
  if (!data || data.length === 0)
    return { error: "Sem permissão para rejeitar esta sugestão" };

  revalidatePath(`/projects/${projectId}/reviews/comments`);
  revalidatePath(`/projects/${projectId}/analyze/code`);
  revalidatePath(`/projects/${projectId}/analyze/compare`);
  await revalidateProjectDocumentsCache(projectId);
  return { success: true };
}

export async function resolveProjectComment(
  commentId: string,
  projectId: string,
) {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado" };

  const supabase = await createSupabaseServer();

  const { data, error } = await supabase
    .from("project_comments")
    .update({ resolved_at: new Date().toISOString(), resolved_by: user.id })
    .eq("id", commentId)
    .eq("project_id", projectId)
    .select("id");

  if (error) return { error: error.message };
  if (!data || data.length === 0) return { error: "Sem permissão para resolver este comentário" };

  revalidatePath(`/projects/${projectId}/reviews/comments`);
  return { success: true };
}

export async function reopenProjectComment(
  commentId: string,
  projectId: string,
) {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado" };

  const supabase = await createSupabaseServer();

  const { data, error } = await supabase
    .from("project_comments")
    .update({ resolved_at: null, resolved_by: null })
    .eq("id", commentId)
    .eq("project_id", projectId)
    .select("id");

  if (error) return { error: error.message };
  if (!data || data.length === 0) return { error: "Sem permissão para reabrir este comentário" };

  revalidatePath(`/projects/${projectId}/reviews/comments`);
  return { success: true };
}
