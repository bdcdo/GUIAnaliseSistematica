"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { sortByRecent } from "@/lib/coding-sort";
import {
  autosaveDirtyDoc,
  saveCodingResponse,
} from "@/lib/coding-autosave";
import { clearHiddenConditionalAnswers } from "@/lib/conditional";
import { notifySaved } from "@/lib/coding-save-feedback";
import type { CodingSnapshot } from "@/lib/coding-draft";
import { toast } from "sonner";
import type { AutosavePayload } from "@/hooks/useAutosaveOnExit";
import type { CodingSortMode } from "./CodingPage";
import type { AssignedDoc, PydanticField } from "@/lib/types";

interface AssignedState {
  docIndex: number;
  allAnswers: Record<string, Record<string, unknown>>;
  allNotes: Record<string, string>;
  allDone: boolean;
}

type AssignedAction =
  | { type: "answer"; docId: string; field: string; value: unknown; fields: PydanticField[] }
  | { type: "notes"; docId: string; notes: string }
  | { type: "index"; index: number }
  | { type: "allDone"; value: boolean }
  // Aplicação EXPLÍCITA de um rascunho local (#608). Nunca entra pelo seed do
  // reducer: semear a partir do rascunho seria aplicá-lo em silêncio, e o
  // requisito é o oposto — a faixa oferece, a pesquisadora decide.
  | { type: "restoreDraft"; docId: string; answers: Record<string, unknown>; notes: string };

function reducer(state: AssignedState, action: AssignedAction): AssignedState {
  switch (action.type) {
    case "answer": {
      // Ao mudar uma resposta, limpa as condicionais que ficaram órfãs —
      // invariante mantida aqui (no dono do estado) em vez de num useEffect do
      // filho (ver #252). `fields` viaja na action para o reducer continuar
      // puro; `clearHiddenConditionalAnswers` preserva a identidade quando
      // nada muda.
      const updated = {
        ...state.allAnswers[action.docId],
        [action.field]: action.value,
      };
      return {
        ...state,
        allAnswers: {
          ...state.allAnswers,
          [action.docId]: clearHiddenConditionalAnswers(action.fields, updated),
        },
      };
    }
    case "notes":
      return {
        ...state,
        allNotes: { ...state.allNotes, [action.docId]: action.notes },
      };
    case "index":
      // Zerar `allDone` ao mudar de índice é intencional: navegar (◀ ▶) ou
      // trocar a ordenação a partir da tela "Parabéns!" sai dela e reabre o
      // doc para edição (no fluxo antigo o usuário ficava preso até clicar
      // "Explorar mais documentos").
      return { ...state, docIndex: action.index, allDone: false };
    case "allDone":
      return { ...state, allDone: action.value };
    case "restoreDraft":
      return {
        ...state,
        allAnswers: { ...state.allAnswers, [action.docId]: action.answers },
        allNotes: { ...state.allNotes, [action.docId]: action.notes },
      };
  }
}

function notesFromJustifications(
  existingJustifications: Record<string, Record<string, unknown>>,
): Record<string, string> {
  const notes: Record<string, string> = {};
  for (const [docId, justifications] of Object.entries(existingJustifications)) {
    if (typeof justifications?._notes === "string") {
      notes[docId] = justifications._notes;
    }
  }
  return notes;
}

interface UseAssignedCodingParams {
  projectId: string;
  documents: AssignedDoc[];
  /** Schema completo — usado para limpar condicionais órfãs ao responder (#252). */
  fields: PydanticField[];
  sortedDocuments: AssignedDoc[];
  codedAtByDoc: Record<string, string>;
  existingAnswers: Record<string, Record<string, unknown>>;
  existingJustifications: Record<string, Record<string, unknown>>;
  initialDocIndex: number;
  setSubmitting: (value: boolean) => void;
  markDirty: (docId: string) => void;
  markClean: (docId: string) => void;
  isDirty: (docId: string | null | undefined) => boolean;
  /** Rede local do #608: registra a edição corrente para o rascunho em
   *  localStorage. O baseline é do hook de rascunho, não daqui. */
  recordDraft: (docId: string, draft: CodingSnapshot) => void;
  /** Devolve o rascunho oferecido para aplicação explícita. */
  restoreDraft: (docId: string) => CodingSnapshot | null;
  /** Chamado quando o servidor confirmou a ESCRITA, inclusive com obrigatória
   *  em aberto — ver `submitConfirmed`. */
  submitConfirmed: (docId: string, saved: CodingSnapshot) => void;
  updateDocParam: (docId: string | null) => void;
  setParams: (
    updates: Record<string, string | null>,
    opts?: { scroll?: boolean },
  ) => void;
}

/**
 * Estado e handlers do modo Atribuídos. Vive no container (chamado por
 * `CodingPage`), então sobrevive à troca de modo Atribuídos↔Explorar.
 *
 * Consolida `docIndex`/`allAnswers`/`allNotes`/`allDone` num `useReducer` com
 * init lazy semeado das props — zera `prefer-useReducer` e `no-derived-useState`
 * (que disparavam com os `useState` separados, em especial
 * `useState(existingAnswers)`). Preserva o autosave-on-navigate (#28): navegar
 * ou trocar a ordenação salva o doc sujo antes de mudar.
 */
export function useAssignedCoding({
  projectId,
  documents,
  fields,
  sortedDocuments,
  codedAtByDoc,
  existingAnswers,
  existingJustifications,
  initialDocIndex,
  setSubmitting,
  markDirty,
  markClean,
  isDirty,
  recordDraft,
  restoreDraft,
  submitConfirmed,
  updateDocParam,
  setParams,
}: UseAssignedCodingParams) {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    docIndex: initialDocIndex,
    allAnswers: existingAnswers,
    allNotes: notesFromJustifications(existingJustifications),
    allDone: false,
  }));

  const { docIndex, allAnswers, allNotes, allDone } = state;
  const currentDoc = sortedDocuments[docIndex];
  const docAnswers = useMemo(
    () => allAnswers[currentDoc?.id] || {},
    [allAnswers, currentDoc?.id],
  );
  const docNotes = allNotes[currentDoc?.id] ?? "";

  // Guarda de reentrância dos saves: liga antes do await e desliga no `finally`.
  // Espelha o `browseSavingRef` do modo Explorar, mas serve a dois
  // propósitos com um só ref síncrono: (1) impede que um duplo-clique em "Enviar"
  // dispare save/toast duas vezes antes do re-render desabilitar o
  // botão; (2) congela a edição enquanto o save está em voo — o container já tirou
  // o snapshot das respostas que está salvando e, ao concluir, navega para o
  // próximo doc; sem o guard, teclas digitadas durante o save editariam o doc já
  // salvo com o snapshot antigo e seriam descartadas na navegação.
  const savingRef = useRef(false);

  // O rascunho local é registrado a partir do estado já reduzido, não de dentro
  // dos handlers: `handleAnswer` despacha e não vê o resultado, e recompor o
  // valor novo no call site duplicaria `clearHiddenConditionalAnswers` — a
  // limpeza de condicionais órfãs (#252) que o reducer faz. O guard de sujeira é
  // o que impede que abrir um documento limpo registre o conteúdo do servidor
  // como se fosse edição (o que apagaria um rascunho ainda não retomado).
  const docId = currentDoc?.id;
  useEffect(() => {
    if (!docId || !isDirty(docId)) return;
    recordDraft(docId, { answers: docAnswers, notes: docNotes });
  }, [docId, docAnswers, docNotes, isDirty, recordDraft]);

  const handleAnswer = useCallback(
    (fieldName: string, value: unknown) => {
      if (savingRef.current) return;
      const docId = currentDoc?.id;
      if (!docId) return;
      dispatch({ type: "answer", docId, field: fieldName, value, fields });
      markDirty(docId);
    },
    [currentDoc?.id, markDirty, fields],
  );

  const handleNotesChange = useCallback(
    (notes: string) => {
      if (savingRef.current) return;
      const docId = currentDoc?.id;
      if (!docId) return;
      dispatch({ type: "notes", docId, notes });
      markDirty(docId);
    },
    [currentDoc?.id, markDirty],
  );

  // Aplica o rascunho oferecido pela faixa. Marca sujo porque o conteúdo passa a
  // divergir do servidor — é justamente o que o indicador de "não enviado" e o
  // aviso de saída precisam enxergar.
  const handleRestoreDraft = useCallback(() => {
    const id = currentDoc?.id;
    if (!id) return;
    const restored = restoreDraft(id);
    if (!restored) return;
    dispatch({
      type: "restoreDraft",
      docId: id,
      answers: restored.answers,
      notes: restored.notes,
    });
    markDirty(id);
  }, [currentDoc?.id, restoreDraft, markDirty]);

  const handleSubmit = useCallback(async () => {
    if (!currentDoc || Object.keys(docAnswers).length === 0) return;
    if (savingRef.current) return;
    savingRef.current = true;
    setSubmitting(true);
    try {
      const result = await saveCodingResponse(projectId, currentDoc.id, docAnswers, {
        notes: docNotes,
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      markClean(currentDoc.id);
      // A escrita aconteceu: o rascunho local virou redundante e o baseline
      // passa a ser o que foi gravado. Vem ANTES do early-return abaixo de
      // propósito — um envio que deixou obrigatória em aberto também gravou.
      submitConfirmed(currentDoc.id, { answers: docAnswers, notes: docNotes });
      notifySaved(result.missingRequired);
      // Save com obrigatórias em aberto mantém o pesquisador NO documento:
      // avançar tiraria a tela de baixo do aviso que acabou de pedir para
      // completá-lo, e o doc reapareceria na fila depois — o sintoma que o #519
      // descreve. Só alcançável quando o schema cresceu entre o carregamento do
      // formulário e o envio; fora disso o SubmitBar já cobra a pendência antes
      // do clique, pela mesma régua.
      if (result.missingRequired) return;
      if (docIndex < sortedDocuments.length - 1) {
        const nextIndex = docIndex + 1;
        dispatch({ type: "index", index: nextIndex });
        // Mantem a URL em sincronia com o doc exibido — sem isso, um refresh
        // apos enviar cai no doc recem-enviado (que no modo "recent" pula para
        // o topo da lista), nao no proximo.
        updateDocParam(sortedDocuments[nextIndex]?.id ?? null);
      } else {
        dispatch({ type: "allDone", value: true });
      }
    } finally {
      // O `finally` garante que `submitting`/o ref não fiquem presos `true` se
      // qualquer efeito posterior ao save falhar. Como `submitting` é estado
      // compartilhado com o modo Explorar, isso congelaria a edição lá até um
      // reload.
      setSubmitting(false);
      savingRef.current = false;
    }
  }, [
    currentDoc,
    docAnswers,
    docNotes,
    projectId,
    docIndex,
    sortedDocuments,
    updateDocParam,
    markClean,
    submitConfirmed,
    setSubmitting,
  ]);

  const handleDocNavigate = useCallback(
    (newIndex: number) => {
      if (currentDoc && isDirty(currentDoc.id)) {
        autosaveDirtyDoc({
          projectId,
          docId: currentDoc.id,
          answers: docAnswers,
          notes: docNotes,
          markClean,
        });
      }
      const clampedIndex = Math.max(
        0,
        Math.min(newIndex, sortedDocuments.length - 1),
      );
      dispatch({ type: "index", index: clampedIndex });
      updateDocParam(sortedDocuments[clampedIndex]?.id ?? null);
    },
    [
      currentDoc,
      docAnswers,
      docNotes,
      projectId,
      sortedDocuments,
      updateDocParam,
      isDirty,
      markClean,
    ],
  );

  // Troca o criterio de ordenacao da navegacao de atribuidos. Ao mudar para
  // "recent", salta direto para o documento codificado mais recentemente — o
  // objetivo da issue #108 e achar em 1 clique o ultimo que o pesquisador
  // mexeu. Ao voltar para "default", mantem o documento atual selecionado.
  const handleSortChange = useCallback(
    (nextSort: CodingSortMode) => {
      if (currentDoc && isDirty(currentDoc.id)) {
        autosaveDirtyDoc({
          projectId,
          docId: currentDoc.id,
          answers: docAnswers,
          notes: docNotes,
          markClean,
        });
      }
      const nextDocs =
        nextSort === "recent"
          ? sortByRecent(documents, codedAtByDoc)
          : documents;
      const targetId = nextSort === "recent" ? nextDocs[0]?.id : currentDoc?.id;
      const targetIndex = targetId
        ? nextDocs.findIndex((d) => d.id === targetId)
        : 0;
      dispatch({ type: "index", index: Math.max(0, targetIndex) });

      const updates: Record<string, string | null> = {
        sort: nextSort === "default" ? "default" : null,
      };
      if (targetId) updates.doc = targetId;
      setParams(updates, { scroll: false });
    },
    [
      currentDoc,
      docAnswers,
      docNotes,
      projectId,
      documents,
      codedAtByDoc,
      isDirty,
      markClean,
      setParams,
    ],
  );

  const resetAllDone = useCallback(
    () => dispatch({ type: "allDone", value: false }),
    [],
  );

  const getPayload = useCallback((): AutosavePayload | null => {
    if (!currentDoc) return null;
    return {
      projectId,
      documentId: currentDoc.id,
      answers: docAnswers,
      notes: docNotes,
    };
  }, [currentDoc, docAnswers, docNotes, projectId]);

  return {
    docIndex,
    currentDoc,
    docAnswers,
    docNotes,
    allDone,
    handleAnswer,
    handleNotesChange,
    handleSubmit,
    handleRestoreDraft,
    handleDocNavigate,
    handleSortChange,
    resetAllDone,
    getPayload,
  };
}
