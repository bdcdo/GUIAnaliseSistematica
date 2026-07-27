"use client";

import { useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import { useBrowseDocuments } from "@/hooks/useBrowseDocuments";
import { useDocumentForCoding } from "@/hooks/useDocumentForCoding";
import { saveCodingResponse } from "@/lib/coding-autosave";
import { notifySaved } from "@/lib/coding-save-feedback";
import { type CodingDraft } from "./BrowseDocCoder";
import type { CodingSnapshot } from "@/lib/coding-draft";
import type { AutosavePayload } from "@/hooks/useAutosaveOnExit";
import type { AssignedDoc } from "@/lib/types";

interface UseBrowseCodingParams {
  projectId: string;
  /** Docs atribuídos — usados para excluir da seleção do modo Explorar. */
  documents: AssignedDoc[];
  mode: "assigned" | "browse";
  docParam: string | null;
  setSubmitting: (value: boolean) => void;
  markDirty: (docId: string) => void;
  markClean: (docId: string) => void;
  recordDraft: (docId: string, draft: CodingSnapshot) => void;
  submitConfirmed: (docId: string, saved: CodingSnapshot) => void;
  isDirty: (docId: string | null | undefined) => boolean;
  updateDocParam: (docId: string | null) => void;
}

/**
 * Estado e handlers do modo Explorar. A lista vem de `useBrowseDocuments`, a
 * seleção é derivada do `?doc=` da URL e o conteúdo do doc de
 * `useDocumentForCoding` — nada em `useState`/effect aqui, o que mantém os
 * diagnósticos de browse zerados (PR #257). O estado editável vive no filho
 * keyed `BrowseDocCoder`; este hook só guarda o rascunho num ref para o
 * autosave-on-exit centralizado (#28).
 *
 * Cumpre os contratos da #257: `markResponded(id)` (update otimista do contador
 * pós-save), `invalidate(id)` após salvar (anti-staleness do cache de doc) e
 * exposição de `error`/`retry` da lista.
 */
export function useBrowseCoding({
  projectId,
  documents,
  mode,
  docParam,
  setSubmitting,
  markDirty,
  markClean,
  recordDraft,
  submitConfirmed,
  isDirty,
  updateDocParam,
}: UseBrowseCodingParams) {
  const {
    documents: browseDocuments,
    loading: browseLoading,
    error: browseError,
    retry: retryBrowse,
    markResponded,
  } = useBrowseDocuments(projectId, mode === "browse");

  const browseDocId = useMemo(() => {
    if (mode !== "browse" || !docParam) return null;
    // Só docs não-atribuídos entram no modo Explorar (assigned abre em assigned).
    return documents.some((d) => d.id === docParam) ? null : docParam;
  }, [mode, docParam, documents]);

  const {
    doc: browseDoc,
    loading: browseDocLoading,
    invalidate: invalidateBrowseDoc,
  } = useDocumentForCoding(projectId, browseDocId);

  // Rascunho atual reportado pelo BrowseDocCoder; lido pelo autosave-on-exit.
  // Ref (não estado) para não entrar no render.
  const browseDraftRef = useRef<CodingDraft | null>(null);
  // Guarda de reentrância dos saves de browse: impede que um duplo-clique em
  // "Enviar"/"Voltar" dispare save/markResponded duas vezes antes do
  // setSubmitting re-renderizar e desabilitar os botões.
  const browseSavingRef = useRef(false);

  const browseDocInfo = browseDocId
    ? browseDocuments?.find((d) => d.id === browseDocId) ?? null
    : null;

  // Seleção = escrever o ?doc= (os hooks buscam a lista e o doc). Trocar de doc
  // descarta o rascunho do anterior — comportamento atual do Explorar — e limpa
  // o dirty do doc deixado (senão o id ficaria "sujo" para sempre, disparando o
  // prompt nativo de "alterações não salvas" que nenhum caminho de saída
  // consegue mais persistir).
  const handleBrowseSelect = useCallback(
    (docId: string) => {
      if (browseDocId) markClean(browseDocId);
      browseDraftRef.current = null;
      updateDocParam(docId);
    },
    [browseDocId, markClean, updateDocParam],
  );

  // Descarta o rascunho atual e limpa o dirty do doc selecionado (usado ao SAIR
  // do modo Explorar: o BrowseDocCoder keyed desmonta e re-semeia do cache).
  const discardDraft = useCallback(() => {
    if (browseDocId) markClean(browseDocId);
    browseDraftRef.current = null;
  }, [browseDocId, markClean]);

  // Reportado pelo BrowseDocCoder a cada edição: alimenta o autosave (via ref)
  // e marca o doc como sujo.
  const handleDraftChange = useCallback(
    (draft: CodingDraft) => {
      browseDraftRef.current = draft;
      if (browseDocId) {
        markDirty(browseDocId);
        // Diferente do modo Atribuídos, aqui o conteúdo novo chega pronto no
        // callback (o estado vive no filho keyed), então o registro é direto.
        recordDraft(browseDocId, draft);
      }
    },
    [browseDocId, markDirty],
  );

  const handleBrowseSubmit = useCallback(
    async ({ answers, notes }: CodingDraft) => {
      if (!browseDocId || Object.keys(answers).length === 0) return;
      if (browseSavingRef.current) return;
      browseSavingRef.current = true;
      setSubmitting(true);
      try {
        const result = await saveCodingResponse(projectId, browseDocId, answers, {
          notes,
        });
        if (result.success) {
          markClean(browseDocId);
          submitConfirmed(browseDocId, { answers, notes });
          notifySaved(result.missingRequired);
          markResponded(browseDocId);
          browseDraftRef.current = null;
          // Save com obrigatórias em aberto mantém o doc ABERTO, pelo mesmo
          // motivo do modo Atribuídos (ver useAssignedCoding): fechá-lo tiraria a
          // tela de baixo do aviso que acabou de pedir para completá-lo. Aqui a
          // invalidação vem sem o `updateDocParam(null)` que a precede no caminho
          // normal — o refetch é desejado, porque reassenta o formulário no que
          // acabou de ser gravado em vez de num seed stale.
          if (result.missingRequired) {
            invalidateBrowseDoc(browseDocId);
            return;
          }
          // Zera o ?doc= ANTES de invalidar: com browseDocId já null o hook não
          // refetcha o doc que estamos deixando (evita refetch/flicker). A
          // invalidação garante que reabri-lo na sessão reflita o que foi salvo
          // (sem isto, o seed ficaria stale).
          updateDocParam(null);
          invalidateBrowseDoc(browseDocId);
        } else {
          toast.error(result.error);
        }
      } finally {
        // Mesmo com a rejeição de transporte normalizada pelo adapter, o
        // `finally` evita prender o formulário se um efeito posterior falhar.
        setSubmitting(false);
        browseSavingRef.current = false;
      }
    },
    [
      browseDocId,
      projectId,
      markClean,
      markResponded,
      invalidateBrowseDoc,
      updateDocParam,
      setSubmitting,
    ],
  );

  const handleBrowseBack = useCallback(async () => {
    // Guarda de reentrância no topo: cobre tanto o caminho com autosave quanto o
    // caminho limpo (sem rascunho sujo). Sem ela, um "Voltar" durante um submit
    // em voo zeraria a URL/rascunho no meio do save.
    if (browseSavingRef.current) return;
    const docId = browseDocId;
    let saved = false;
    // Com rascunho sujo, aguarda o autosave ANTES de navegar: se falhar, mantém
    // o doc aberto e o rascunho intacto (em vez de descartá-lo otimisticamente).
    if (docId && isDirty(docId) && browseDraftRef.current) {
      browseSavingRef.current = true;
      const { answers, notes } = browseDraftRef.current;
      setSubmitting(true);
      try {
        const result = await saveCodingResponse(projectId, docId, answers, {
          notes,
          isAutoSave: true,
        });
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        markClean(docId);
        markResponded(docId);
        saved = true;
      } finally {
        setSubmitting(false);
        browseSavingRef.current = false;
      }
    }
    browseDraftRef.current = null;
    // Zera o ?doc= ANTES de invalidar (mesmo motivo do submit: evita
    // refetch/flicker do doc que estamos deixando).
    updateDocParam(null);
    if (saved && docId) invalidateBrowseDoc(docId);
  }, [
    browseDocId,
    projectId,
    updateDocParam,
    isDirty,
    markClean,
    markResponded,
    invalidateBrowseDoc,
    setSubmitting,
  ]);

  const handleBrowseRandom = useCallback(() => {
    if (!browseDocuments || browseDocuments.length === 0) return;
    const notResponded = browseDocuments.filter(
      (d) => !d.userAlreadyResponded && d.id !== browseDocId,
    );
    const pool =
      notResponded.length > 0
        ? notResponded
        : browseDocuments.filter((d) => d.id !== browseDocId);
    if (pool.length === 0) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    handleBrowseSelect(pick.id);
  }, [browseDocuments, browseDocId, handleBrowseSelect]);

  // Retry do doc selecionado (fetch do conteúdo falhou): re-dispara o fetch.
  const retryBrowseDoc = useCallback(() => {
    if (browseDocId) invalidateBrowseDoc(browseDocId);
  }, [browseDocId, invalidateBrowseDoc]);

  const getPayload = useCallback((): AutosavePayload | null => {
    if (browseDocId && browseDraftRef.current) {
      return {
        projectId,
        documentId: browseDocId,
        answers: browseDraftRef.current.answers,
        notes: browseDraftRef.current.notes,
      };
    }
    return null;
  }, [browseDocId, projectId]);

  return {
    browseDocuments,
    browseLoading,
    browseError,
    retryBrowse,
    browseDoc,
    browseDocLoading,
    browseDocId,
    browseDocInfo,
    handleBrowseSelect,
    handleBrowseSubmit,
    handleBrowseBack,
    handleBrowseRandom,
    handleDraftChange,
    discardDraft,
    retryBrowseDoc,
    getPayload,
  };
}
