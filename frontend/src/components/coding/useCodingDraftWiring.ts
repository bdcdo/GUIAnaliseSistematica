"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useIsDocDirty, type DirtyDocsStore } from "@/hooks/useDirtyDocs";
import type { CodingDraftsApi } from "@/hooks/useCodingDrafts";
import type { CodingSnapshot } from "@/lib/coding-draft";
import type { CodingDocument } from "@/hooks/useDocumentForCoding";

// Fiação entre o rascunho local (#608) e os dois modos de codificação. Vive
// fora do `CodingPage` porque lá já é o container mais longo da tela, e porque a
// regra de qual snapshot é o baseline se lê melhor isolada.

interface UseCodingDraftWiringParams {
  mode: "assigned" | "browse";
  activeDocId: string | null;
  drafts: CodingDraftsApi;
  dirtyDocs: DirtyDocsStore;
  markDirty: (docId: string) => void;
  /** Aplica o rascunho no reducer do modo Atribuídos. */
  restoreAssignedDraft: () => void;
  browseDocId: string | null;
  browseDoc: CodingDocument | null | undefined;
  existingAnswers: Record<string, Record<string, unknown>>;
  existingJustifications: Record<string, Record<string, unknown>>;
}

export function useCodingDraftWiring({
  mode,
  activeDocId,
  drafts,
  dirtyDocs,
  markDirty,
  restoreAssignedDraft,
  browseDocId,
  browseDoc,
  existingAnswers,
  existingJustifications,
}: UseCodingDraftWiringParams) {
  // O baseline do documento aberto é o que o SERVIDOR entregou, nunca o que está
  // na tela: é contra ele que se decide se o rascunho ainda vale e o que ele
  // sobrescreveria. Em Explorar o conteúdo vem do fetch do doc; em Atribuídos,
  // das props do RSC.
  const remoteSnapshot: CodingSnapshot | null = useMemo(() => {
    if (!activeDocId) return null;
    if (mode === "assigned") {
      const notes = existingJustifications[activeDocId]?._notes;
      return {
        answers: existingAnswers[activeDocId] ?? {},
        notes: typeof notes === "string" ? notes : "",
      };
    }
    if (!browseDoc || browseDoc.document.id !== activeDocId) return null;
    return { answers: browseDoc.initialAnswers, notes: browseDoc.initialNotes };
  }, [activeDocId, mode, existingAnswers, existingJustifications, browseDoc]);

  const openDocument = drafts.openDocument;
  useEffect(() => {
    // Em Explorar o baseline só existe depois do fetch; abrir antes classificaria
    // o rascunho contra um documento vazio e anunciaria como sobrescrita tudo o
    // que o servidor já tinha.
    if (mode === "browse" && activeDocId && !remoteSnapshot) return;
    openDocument(activeDocId, remoteSnapshot);
  }, [openDocument, activeDocId, mode, remoteSnapshot]);

  // Indicador de "não enviado": vem da sujeira em memória, não do storage — ver
  // o comentário em `useDirtyDocs`.
  const activeDocUnsent = useIsDocDirty(dirtyDocs, activeDocId);

  // "Retomar" no modo Explorar entra por REMOUNT do filho keyed, e não por
  // setState: `BrowseDocCoder` é construído sem estado derivado e sem setState em
  // effect, e empurrar valor para dentro dele quebraria essa propriedade.
  const [browseRestoreNonce, setBrowseRestoreNonce] = useState(0);
  // O snapshot retomado carrega o documento de onde veio. Não é metadado
  // decorativo: sem ele o conteúdo fica solto e é aplicado a qualquer doc que a
  // seleção seguinte trouxer — `BrowseDocCoder` é keyed por `docId:nonce`, então
  // remonta semeado pelo que esta fiação entregar. O resultado era a tela do
  // documento B exibindo as respostas de A, sem sujeira e sem sinal, e o próximo
  // "Enviar" gravando as respostas de A no documento B.
  const [browseRestored, setBrowseRestored] = useState<{
    docId: string;
    snapshot: CodingSnapshot;
  } | null>(null);

  const restoreDraft = drafts.restoreDraft;
  const handleRestoreDraft = useCallback(() => {
    if (mode === "assigned") {
      restoreAssignedDraft();
      return;
    }
    if (!browseDocId) return;
    const restored = restoreDraft(browseDocId);
    if (!restored) return;
    setBrowseRestored({ docId: browseDocId, snapshot: restored });
    setBrowseRestoreNonce((n) => n + 1);
    markDirty(browseDocId);
  }, [mode, restoreAssignedDraft, browseDocId, restoreDraft, markDirty]);

  const discardDraft = drafts.discardDraft;
  const handleDiscardDraft = useCallback(() => {
    if (activeDocId) discardDraft(activeDocId);
  }, [activeDocId, discardDraft]);

  // O rascunho retomado entra no Explorar como o documento INICIAL, e não como
  // uma prop de seed do coder: `BrowseDocCoder` é construído sem estado derivado
  // e sem setState em effect, e o remount por `key` já é o mecanismo de aplicação.
  // Resolver aqui mantém aquele componente sem nenhuma decisão nova.
  const browseDocForCoder = useMemo(() => {
    // A checagem de identidade é o que impede a aplicação cruzada: o rascunho só
    // semeia o documento de onde foi retomado. Trocar de doc volta a semear do
    // servidor sem precisar limpar nada — e voltar ao doc de origem reexibe o
    // rascunho, porque a posse continua registrada.
    if (!browseDoc || browseRestored?.docId !== browseDoc.document.id) {
      return browseDoc;
    }
    return {
      ...browseDoc,
      initialAnswers: browseRestored.snapshot.answers,
      initialNotes: browseRestored.snapshot.notes,
    };
  }, [browseDoc, browseRestored]);

  return {
    activeDocUnsent,
    handleRestoreDraft,
    handleDiscardDraft,
    browseDocForCoder,
    browseRestoreNonce,
  };
}
