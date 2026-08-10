"use server";

import { createSupabaseServer, type SupabaseServerClient } from "@/lib/supabase/server";
import {
  getAuthUser,
  getProjectAccessContext,
  requireCoordinator,
  resolveProjectMemberActor,
} from "@/lib/auth";
import { revalidatePath, revalidateTag } from "next/cache";
import { createHash } from "crypto";
import { sanitizeStoredAnswers } from "@/lib/response-snapshot";
import type { DocumentMetadata, PydanticField } from "@/lib/types";

export interface DocumentRow {
  external_id?: string;
  title?: string;
  text: string;
  metadata?: DocumentMetadata | null;
}

// Single source of truth for the CSV-upload row shape (subset of DocumentRow).
// Inclui `metadata` (linha original do CSV) desde a feature 004 — o client
// monta a partir do buildDocs e flui até o INSERT/RPC sem transformação.
export type UploadDoc = Pick<
  DocumentRow,
  "text" | "title" | "external_id" | "metadata"
>;

function md5(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

export interface DuplicateMatch {
  csvIndex: number;
  existingDocId: string;
  matchType: "external_id" | "text_hash";
}

export async function checkDuplicates(
  projectId: string,
  documents: { external_id?: string; text_hash: string; csvIndex?: number }[]
): Promise<{
  duplicates: DuplicateMatch[];
  duplicatesWithResponses: number;
}> {
  const supabase = await createSupabaseServer();

  // Hash is computed client-side to keep payload small (Vercel ~4.5MB limit).
  // csvIndex maps back to the full CSV array when caller chunks the check.
  const hashes = documents.map((d) => d.text_hash);
  const indexFor = (i: number) => documents[i].csvIndex ?? i;

  // Collect external_ids that are present
  const externalIds = documents.flatMap((d, i) =>
    d.external_id ? [{ id: d.external_id, index: i }] : [],
  );

  const duplicates: DuplicateMatch[] = [];
  const matchedCsvIndices = new Set<number>();

  // 1. Match by external_id (excluidos sao ignorados — re-upload de doc
  //    excluido por engano cria um novo registro normal)
  if (externalIds.length > 0) {
    const { data: byExtId, error: byExtIdErr } = await supabase
      .from("documents")
      .select("id, external_id")
      .eq("project_id", projectId)
      .is("excluded_at", null)
      .in(
        "external_id",
        externalIds.map((e) => e.id!)
      );
    if (byExtIdErr)
      throw new Error(
        `Falha ao verificar duplicatas por ID externo: ${byExtIdErr.message}`,
      );

    if (byExtId) {
      const extIdMap = new Map(byExtId.map((d) => [d.external_id, d.id]));
      for (const { id, index } of externalIds) {
        const existingId = extIdMap.get(id!);
        if (existingId) {
          duplicates.push({
            csvIndex: indexFor(index),
            existingDocId: existingId,
            matchType: "external_id",
          });
          matchedCsvIndices.add(index);
        }
      }
    }
  }

  // 2. Match remaining by text_hash
  const unmatchedHashes = hashes.flatMap((h, i) =>
    matchedCsvIndices.has(i) ? [] : [{ hash: h, index: i }],
  );

  if (unmatchedHashes.length > 0) {
    const uniqueHashes = [...new Set(unmatchedHashes.map((h) => h.hash))];
    const { data: byHash, error: byHashErr } = await supabase
      .from("documents")
      .select("id, text_hash")
      .eq("project_id", projectId)
      .is("excluded_at", null)
      .in("text_hash", uniqueHashes);
    if (byHashErr)
      throw new Error(
        `Falha ao verificar duplicatas por hash de conteúdo: ${byHashErr.message}`,
      );

    if (byHash) {
      const hashMap = new Map(byHash.map((d) => [d.text_hash, d.id]));
      for (const { hash, index } of unmatchedHashes) {
        const existingId = hashMap.get(hash);
        if (existingId) {
          duplicates.push({
            csvIndex: indexFor(index),
            existingDocId: existingId,
            matchType: "text_hash",
          });
        }
      }
    }
  }

  // 3. Count duplicates that have responses
  let duplicatesWithResponses = 0;
  if (duplicates.length > 0) {
    const docIds = duplicates.map((d) => d.existingDocId);
    const { data: responses, error: responsesErr } = await supabase
      .from("responses")
      .select("document_id")
      .eq("project_id", projectId)
      .in("document_id", docIds);
    if (responsesErr)
      throw new Error(
        `Falha ao verificar respostas das duplicatas: ${responsesErr.message}`,
      );

    if (responses) {
      const docsWithResponses = new Set(responses.map((r) => r.document_id));
      duplicatesWithResponses = docIds.filter((id) =>
        docsWithResponses.has(id)
      ).length;
    }
  }

  return { duplicates, duplicatesWithResponses };
}

export interface UploadOptions {
  mode: "add_all" | "add_new_only" | "replace_and_add";
  duplicateMap?: DuplicateMatch[];
  deleteResponses?: boolean;
}

/**
 * Remove as linhas que violariam o indice unico parcial
 * documents_project_external_id_active_uniq — UNIQUE(project_id, external_id)
 * WHERE external_id IS NOT NULL AND excluded_at IS NULL (migration
 * 20260623130000). Dois conflitos possiveis num INSERT em lote, ambos abortariam
 * a operacao inteira (perdendo tambem as linhas novas validas):
 *   1. external_id ja ATIVO no projeto (re-import — a causa raiz das duplicatas);
 *   2. external_id repetido dentro do proprio lote (CSV com linhas duplicadas).
 * Linhas sem external_id nunca sao filtradas (varios docs sem external_id sao
 * validos). Retorna as linhas seguras + contagem do que foi pulado.
 */
async function filterActiveExternalIdConflicts<
  T extends { external_id: string | null },
>(
  supabase: SupabaseServerClient,
  projectId: string,
  rows: T[],
): Promise<{ rows: T[]; skippedExisting: number; skippedInBatch: number }> {
  const ids = [
    ...new Set(rows.map((r) => r.external_id).filter((id): id is string => !!id)),
  ];

  const existing = new Set<string>();
  if (ids.length > 0) {
    const { data } = await supabase
      .from("documents")
      .select("external_id")
      .eq("project_id", projectId)
      .is("excluded_at", null)
      .in("external_id", ids);
    for (const d of data ?? []) {
      if (d.external_id) existing.add(d.external_id);
    }
  }

  const seen = new Set<string>();
  let skippedExisting = 0;
  let skippedInBatch = 0;
  const safe = rows.filter((r) => {
    if (!r.external_id) return true;
    if (existing.has(r.external_id)) {
      skippedExisting++;
      return false;
    }
    if (seen.has(r.external_id)) {
      skippedInBatch++;
      return false;
    }
    seen.add(r.external_id);
    return true;
  });

  return { rows: safe, skippedExisting, skippedInBatch };
}

// Revalida o cache de documentos do projeto: o path dinâmico de config, a tag
// da página cacheada de assignments e a tag de progresso (contagens de docs) —
// o mesmo conjunto que excludeDocuments/restoreDocuments/hardDeleteDocuments
// revalidam. Fonte única usada tanto pelo último chunk de uploadDocuments quanto
// pelo recovery do hook quando um upload em chunks falha no meio.
// Best-effort: uma falha de revalidação de cache não pode propagar como erro da
// action (caso contrário um INSERT já commitado seria reportado como falha, ou o
// catch do hook ficaria preso). Um cache stale é recuperável; um upload "perdido"
// não.
//
// Exportada (não client-callable — é uma "use server" function, mas seu uso
// pretendido é só server-to-server) para outras actions deste app que já
// fizeram o próprio gate de autorização (ex: project-comments.ts) reusarem a
// mesma invalidação em vez de duplicar revalidatePath/revalidateTag. Chamadas
// client-side desautenticadas ainda passam pelo wrapper `revalidateProjectDocuments`
// abaixo, que faz o gate de acesso antes de delegar aqui.
export async function revalidateProjectDocumentsCache(projectId: string) {
  try {
    revalidatePath(`/projects/${projectId}/config/documents`);
    // A tag `project-${projectId}-documents` saiu junto com o unstable_cache da
    // página de Atribuições (#664): sem produtor, revalidá-la seria invalidar
    // nada e sugerir uma garantia que não existe.
    revalidateTag(`project-${projectId}-progress`, { expire: 60 });
  } catch (e) {
    console.error("[revalidateProjectDocuments] falha ao revalidar cache", e);
  }
}

// Server action client-callable (o hook de upload chama no recovery de falha
// parcial). Diferente dos chamadores internos — que já passaram pelo RLS de
// escrita — esta é exposta ao client, então gateia por acesso de leitura ao
// projeto antes de revalidar: sem o gate, qualquer usuário autenticado poderia
// invalidar o cache de um projeto alheio. Gate permissivo (qualquer membro que
// enxerga o projeto via RLS, não só coordenador) e fail-closed (sem acesso →
// não revalida).
export async function revalidateProjectDocuments(projectId: string) {
  const user = await getAuthUser();
  if (!user) return;
  const access = await getProjectAccessContext(projectId, user);
  if (access.status === "unavailable" || !access.project) return;
  await revalidateProjectDocumentsCache(projectId);
}

export async function uploadDocuments(
  projectId: string,
  documents: DocumentRow[],
  revalidate: boolean = true,
  options?: UploadOptions
) {
  const supabase = await createSupabaseServer();
  const mode = options?.mode ?? "add_all";
  const duplicateMap = options?.duplicateMap ?? [];

  const duplicateIndices = new Set(duplicateMap.map((d) => d.csvIndex));

  if (mode === "add_new_only") {
    // Filter out duplicates, only insert new ones
    const newDocs = documents.filter((_, i) => !duplicateIndices.has(i));
    // Duplicatas descartadas aqui (detectadas pelo duplicateMap) ja contam como
    // ignoradas — mantem a invariante count + skipped == documents.length para
    // o toast reportar o numero correto.
    const skippedDuplicates = documents.length - newDocs.length;
    if (newDocs.length === 0) return { count: 0, skipped: skippedDuplicates };

    const baseRows = newDocs.map((doc) => ({
      project_id: projectId,
      external_id: doc.external_id || null,
      title: doc.title || null,
      text: doc.text,
      text_hash: md5(doc.text),
      metadata: doc.metadata || null,
    }));
    // Defesa extra contra o indice unico: duplicateMap pode estar stale e o
    // proprio lote pode repetir external_id.
    const { rows, skippedExisting, skippedInBatch } =
      await filterActiveExternalIdConflicts(supabase, projectId, baseRows);

    if (rows.length > 0) {
      const { error } = await supabase.from("documents").insert(rows);
      if (error) return { error: error.message };
    }

    if (revalidate) await revalidateProjectDocumentsCache(projectId);
    return {
      count: rows.length,
      skipped: skippedDuplicates + skippedExisting + skippedInBatch,
    };
  }

  if (mode === "replace_and_add") {
    // Update existing duplicates + insert new ones
    const existingDocIds = duplicateMap.map((d) => d.existingDocId);

    // Payload de atualização dos duplicados (text_hash precomputado, igual ao
    // INSERT abaixo). Setar external_id num doc casado por text_hash pode colidir
    // com outro doc ativo e violar o indice unico parcial (23505) — dentro da
    // transação isso faz ROLLBACK de tudo, em vez de deixar estado parcial.
    const duplicateUpdates = duplicateMap.map((dup) => {
      const doc = documents[dup.csvIndex];
      return {
        id: dup.existingDocId,
        text: doc.text,
        title: doc.title || null,
        external_id: doc.external_id || null,
        text_hash: md5(doc.text),
        metadata: doc.metadata || null,
      };
    });

    // Novos (não-duplicados) + defesa read-only contra o indice unico parcial
    // (duplicateMap stale / repeticao no lote). O filtro roda no TS por ser só
    // leitura; o rollback atômico continua dentro da RPC.
    const newDocs = documents.filter((_, i) => !duplicateIndices.has(i));
    const baseRows = newDocs.map((doc) => ({
      external_id: doc.external_id || null,
      title: doc.title || null,
      text: doc.text,
      text_hash: md5(doc.text),
      metadata: doc.metadata || null,
    }));
    const { rows, skippedExisting, skippedInBatch } =
      await filterActiveExternalIdConflicts(supabase, projectId, baseRows);
    const skipped = skippedExisting + skippedInBatch;

    // Transação única (issue #284): delete reviews/responses + reset assignments
    // + update duplicados + insert novos. Falha em qualquer passo faz ROLLBACK
    // de tudo — respostas/revisões não ficam apagadas sem o upload concluir.
    // SECURITY INVOKER: a RLS do coordenador (braço coordinator_or_creator nas
    // policies de responses/reviews) continua valendo dentro da função.
    const { error } = await supabase.rpc("replace_and_add_documents", {
      p_project_id: projectId,
      p_existing_doc_ids: existingDocIds,
      p_delete_responses: !!options?.deleteResponses,
      p_duplicate_updates: duplicateUpdates,
      p_new_documents: rows,
    });
    if (error) return { error: error.message };

    if (revalidate) await revalidateProjectDocumentsCache(projectId);
    return { count: documents.length - skipped, skipped };
  }

  // Default: add_all — insere tudo, exceto o que violaria o indice unico
  // (external_id ja ativo no projeto ou repetido no proprio lote). Sem o filtro,
  // o INSERT em lote falharia inteiro no primeiro conflito.
  const allRows = documents.map((doc) => ({
    project_id: projectId,
    external_id: doc.external_id || null,
    title: doc.title || null,
    text: doc.text,
    text_hash: md5(doc.text),
    metadata: doc.metadata || null,
  }));
  const { rows, skippedExisting, skippedInBatch } =
    await filterActiveExternalIdConflicts(supabase, projectId, allRows);

  if (rows.length > 0) {
    const { error } = await supabase.from("documents").insert(rows);
    if (error) return { error: error.message };
  }

  if (revalidate) await revalidateProjectDocumentsCache(projectId);
  return { count: rows.length, skipped: skippedExisting + skippedInBatch };
}

export interface BrowseDocument {
  id: string;
  external_id: string | null;
  title: string | null;
  created_at: string;
  responseCount: number;
  userAlreadyResponded: boolean;
  /** Sinalização "fora do escopo" pendente do PRÓPRIO usuário — o doc fica
   *  visível (bloqueado) para ele poder desfazer; pendências de outros somem
   *  da lista. */
  exclusionPendingMine: boolean;
}

export async function getDocumentsForBrowse(projectId: string): Promise<BrowseDocument[]> {
  const [supabase, actor] = await Promise.all([
    createSupabaseServer(),
    resolveProjectMemberActor(projectId),
  ]);
  if (!actor.ok) throw new Error(actor.error);
  const { user, memberUserId } = actor;

  const [{ data: docs }, { data: responses }, { data: myPending }] =
    await Promise.all([
      supabase
        .from("documents")
        .select("id, external_id, title, created_at, exclusion_pending_at")
        .eq("project_id", projectId)
        .is("excluded_at", null)
        .order("created_at", { ascending: true }),
      // Get human response counts
      supabase
        .from("responses")
        .select("document_id, respondent_id")
        .eq("project_id", projectId)
        .eq("respondent_type", "humano"),
      supabase
        .from("project_comments")
        .select("document_id")
        .eq("project_id", projectId)
        .eq("author_id", user.id)
        .eq("kind", "exclusion_request")
        .is("resolved_at", null)
        .is("rejected_at", null),
    ]);

  if (!docs || docs.length === 0) return [];

  const countMap = new Map<string, Set<string>>();
  const userRespondedSet = new Set<string>();

  responses?.forEach((r) => {
    if (!countMap.has(r.document_id)) countMap.set(r.document_id, new Set());
    countMap.get(r.document_id)!.add(r.respondent_id);
    if (r.respondent_id === memberUserId) userRespondedSet.add(r.document_id);
  });

  const minePendingSet = new Set(
    (myPending ?? []).map((p) => p.document_id as string),
  );

  return docs
    // Doc em revisão de escopo some da lista, exceto para quem sinalizou
    // (que precisa vê-lo bloqueado para poder desfazer).
    .filter((d) => !d.exclusion_pending_at || minePendingSet.has(d.id))
    .map((d) => ({
      id: d.id,
      external_id: d.external_id,
      title: d.title,
      created_at: d.created_at,
      responseCount: countMap.get(d.id)?.size ?? 0,
      userAlreadyResponded: userRespondedSet.has(d.id),
      exclusionPendingMine:
        !!d.exclusion_pending_at && minePendingSet.has(d.id),
    }));
}

export interface DocumentExclusionPending {
  /** O pedido pendente é do próprio usuário? (permite desfazer) */
  mine: boolean;
  /** Justificativa do próprio usuário (null quando o pedido é de outro). */
  reason: string | null;
}

export async function getDocumentForCoding(
  projectId: string,
  documentId: string
): Promise<{ document: { id: string; external_id: string | null; title: string | null; text: string; exclusionPending: DocumentExclusionPending | null }; existingAnswers: Record<string, unknown> | null; existingJustifications: Record<string, unknown> | null }> {
  const [supabase, actor] = await Promise.all([
    createSupabaseServer(),
    resolveProjectMemberActor(projectId),
  ]);
  if (!actor.ok) throw new Error(actor.error);
  const { user, memberUserId } = actor;

  // Sem filtro de exclusion_pending_at: quem sinalizou precisa continuar
  // abrindo o doc (bloqueado) para poder desfazer; deep-link de terceiro
  // mostra o estado "pendente por outro".
  const [{ data: rawDoc }, { data: project }, { data: myPending }] =
    await Promise.all([
      supabase
        .from("documents")
        .select("id, external_id, title, text, exclusion_pending_at")
        .eq("id", documentId)
        .eq("project_id", projectId)
        .is("excluded_at", null)
        .single(),
      supabase
        .from("projects")
        .select("pydantic_fields")
        .eq("id", projectId)
        .single(),
      supabase
        .from("project_comments")
        .select("body")
        .eq("project_id", projectId)
        .eq("document_id", documentId)
        .eq("author_id", user.id)
        .eq("kind", "exclusion_request")
        .is("resolved_at", null)
        .is("rejected_at", null)
        .maybeSingle(),
    ]);

  if (!rawDoc) throw new Error("Documento não encontrado");

  const exclusionPending: DocumentExclusionPending | null =
    rawDoc.exclusion_pending_at
      ? myPending
        ? { mine: true, reason: myPending.body as string }
        : { mine: false, reason: null }
      : null;
  const doc = {
    id: rawDoc.id,
    external_id: rawDoc.external_id,
    title: rawDoc.title,
    text: rawDoc.text,
    exclusionPending,
  };

  // O filtro is_latest e o maybeSingle espelham fetchSaveContext em
  // actions/responses.ts: depois de uma unificação de membros, o conjunto
  // fundido pode ter respostas antigas (is_latest=false) do mesmo respondente
  // no mesmo documento. Sem o filtro, .single() erra com múltiplas linhas e o
  // formulário abriria em branco — e o save seguinte gravaria o branco por
  // cima da resposta vigente.
  const { data: response, error: responseError } = await supabase
    .from("responses")
    .select("answers, justifications")
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .eq("respondent_id", memberUserId)
    .eq("respondent_type", "humano")
    .eq("is_latest", true)
    .maybeSingle();

  // Uma leitura falha não pode virar "ainda não respondeu": o formulário em
  // branco que ela produziria é indistinguível de um documento novo.
  if (responseError) {
    throw new Error(responseError.message);
  }

  // Fronteira de leitura do modo Explorar — mesma primitiva do modo Atribuídos
  // (analyze/code/page.tsx), que lê o mesmo dado por outro caminho.
  const existingAnswers = sanitizeStoredAnswers(
    (project?.pydantic_fields as PydanticField[]) ?? [],
    response?.answers as Record<string, unknown> | null,
  );

  return {
    document: doc,
    existingAnswers,
    existingJustifications: (response?.justifications as Record<string, unknown>) ?? null,
  };
}

export async function getDocumentText(
  projectId: string,
  documentId: string,
): Promise<{ text: string; title: string } | null> {
  const supabase = await createSupabaseServer();
  // Busca o texto de um doc por id (RLS aplica). Nao filtra excluded_at de
  // proposito: a visibilidade de soft-deleted e decidida nas queries de lista
  // (getDocumentsForBrowse, a pagina de documentos via ?show=excluded), nao no
  // fetch de texto por id. Quem chega a pedir o texto ja escolheu o doc na lista.
  const { data, error } = await supabase
    .from("documents")
    .select("title, text")
    .eq("id", documentId)
    .eq("project_id", projectId)
    .maybeSingle();
  // Distingue erro real (RLS/transporte/schema) de doc inexistente: sem isto,
  // um doc que existe mas falhou na query viraria "(nao encontrado)" silencioso.
  if (error) {
    console.error("[getDocumentText] erro de query", { projectId, documentId, error });
    throw error;
  }
  if (!data) return null;
  return { text: data.text, title: data.title || documentId };
}

// Rodapé comum às mutações de exclusão/restauração de documents: as 3 funções
// abaixo só divergem na query em si (update com payloads opostos vs delete),
// não no que fazem depois dela.
// Sem anotação de retorno explícita (de propósito): os 3 callers dependem da
// inferência "solta" que o TS produz a partir de returns de object literal
// (equivalente a {error?, count?}), não de uma união discriminada estrita —
// os call sites em useDocumentActions.ts fazem `result?.error` sem narrowing.
async function finishDocumentsMutation(
  projectId: string,
  error: { message: string } | null,
  count: number,
) {
  if (error) return { error: error.message };
  await revalidateProjectDocumentsCache(projectId);
  return { count };
}

// Soft delete: marca documents.excluded_at. Reads default filtram excluidos.
// Coordenador pode visualizar/restaurar via toggle "Mostrar excluidos".
export async function excludeDocuments(
  projectId: string,
  documentIds: string[],
  reason: string,
) {
  // Nota: o gate de coordenador roda antes da validação de `reason` (antes
  // era auth → reason → coordenador). requireCoordinator empacota auth+
  // coordenador como unidade atômica; checar permissão antes de validar
  // input é ordem defensável e o caminho só é alcançável via chamada direta
  // da action (a UI já esconde a ação de não-coordenadores).
  const gate = await requireCoordinator(
    projectId,
    "Apenas coordenador pode excluir documentos",
  );
  if (!gate.ok) return { error: gate.error };
  if (!reason?.trim()) return { error: "Motivo da exclusão é obrigatório" };

  const supabase = await createSupabaseServer();

  const { error } = await supabase
    .from("documents")
    .update({
      excluded_at: new Date().toISOString(),
      excluded_reason: reason.trim(),
      excluded_by: gate.user.id,
    })
    .eq("project_id", projectId)
    .in("id", documentIds);

  return finishDocumentsMutation(projectId, error, documentIds.length);
}

export async function restoreDocuments(
  projectId: string,
  documentIds: string[],
) {
  const gate = await requireCoordinator(
    projectId,
    "Apenas coordenador pode restaurar documentos",
  );
  if (!gate.ok) return { error: gate.error };

  const supabase = await createSupabaseServer();

  const { error } = await supabase
    .from("documents")
    .update({
      excluded_at: null,
      excluded_reason: null,
      excluded_by: null,
    })
    .eq("project_id", projectId)
    .in("id", documentIds);

  return finishDocumentsMutation(projectId, error, documentIds.length);
}

// Hard delete: remove DB permanente (CASCADE em responses/reviews/assignments).
// So usar quando coordenador confirma que o doc nao deve voltar nem manter
// historico — tipicamente apos soft delete + revisao.
export async function hardDeleteDocuments(
  projectId: string,
  documentIds: string[],
) {
  const gate = await requireCoordinator(
    projectId,
    "Apenas coordenador pode apagar documentos permanentemente",
  );
  if (!gate.ok) return { error: gate.error };

  const supabase = await createSupabaseServer();

  const { error } = await supabase
    .from("documents")
    .delete()
    .eq("project_id", projectId)
    .in("id", documentIds);

  return finishDocumentsMutation(projectId, error, documentIds.length);
}
