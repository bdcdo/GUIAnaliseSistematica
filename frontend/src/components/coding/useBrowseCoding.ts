"use client";

import { useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import { useBrowseDocuments } from "@/hooks/useBrowseDocuments";
import { useDocumentForCoding } from "@/hooks/useDocumentForCoding";
import { saveCodingResponse } from "@/lib/coding-save";
import { notifySaved } from "@/lib/coding-save-feedback";
import { type CodingDraft } from "./BrowseDocCoder";
import type { CodingSnapshot } from "@/lib/coding-draft";
import type { AssignedDoc, PydanticField } from "@/lib/types";

interface UseBrowseCodingParams {
  projectId: string;
  currentRoundId?: string;
  /** Docs atribuídos — usados para excluir da seleção do modo Explorar. */
  documents: AssignedDoc[];
  /** Schema carregado no formulário — resolve o enunciado da pergunta pendente. */
  fields: PydanticField[];
  mode: "assigned" | "browse";
  docParam: string | null;
  setSubmitting: (value: boolean) => void;
  markDirty: (docId: string) => void;
  markClean: (docId: string) => void;
  recordDraft: (docId: string, draft: CodingSnapshot) => void;
  submitConfirmed: (docId: string, saved: CodingSnapshot) => void;
  updateDocParam: (docId: string | null) => void;
}

/**
 * Estado e handlers do modo Explorar. A lista vem de `useBrowseDocuments`, a
 * seleção é derivada do `?doc=` da URL e o conteúdo do doc de
 * `useDocumentForCoding` — nada em `useState`/effect aqui, o que mantém os
 * diagnósticos de browse zerados (PR #257). O estado editável vive no filho
 * keyed `BrowseDocCoder`; este hook só guarda o rascunho num ref, que o envio
 * explícito consome.
 *
 * Cumpre os contratos da #257: `markResponded(id)` (update otimista do contador
 * pós-save), `invalidate(id)` após salvar (anti-staleness do cache de doc) e
 * exposição de `error`/`retry` da lista.
 */
export function useBrowseCoding({
  projectId,
  currentRoundId = "",
  documents,
  fields,
  mode,
  docParam,
  setSubmitting,
  markDirty,
  markClean,
  recordDraft,
  submitConfirmed,
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

  // Rascunho atual reportado pelo BrowseDocCoder. Ref (não estado) para não
  // entrar no render.
  const browseDraftRef = useRef<CodingDraft | null>(null);
  // Guarda de reentrância dos saves de browse: impede que um duplo-clique em
  // "Enviar"/"Voltar" dispare save/markResponded duas vezes antes do
  // setSubmitting re-renderizar e desabilitar os botões.
  const browseSavingRef = useRef(false);

  const browseDocInfo = browseDocId
    ? browseDocuments?.find((d) => d.id === browseDocId) ?? null
    : null;

  // Seleção = escrever o ?doc= (os hooks buscam a lista e o doc). Esquece o
  // rascunho EM MEMÓRIA do doc deixado; o keyed `BrowseDocCoder` desmonta e, ao
  // voltar, re-semeia do cache.
  //
  // Até o #608 isto também chamava `markClean`, e era honesto: o Explorar
  // realmente descartava a edição ao trocar de doc, então apagar o sinal dizia a
  // verdade. Com o rascunho local a edição deixou de se perder — ela está no
  // `localStorage` e a faixa a oferece de volta —, e limpar o dirty passaria a
  // afirmar "tudo enviado" sobre trabalho que ninguém enviou. Desde o #608 o
  // dirty é limpo por UM caminho só: escrita confirmada pelo servidor.
  const handleBrowseSelect = useCallback(
    (docId: string) => {
      browseDraftRef.current = null;
      updateDocParam(docId);
    },
    [updateDocParam],
  );

  // Esquece o rascunho em memória ao SAIR do modo Explorar. Pelo mesmo motivo
  // acima, não limpa o dirty: sair do modo não envia nada.
  const discardDraft = useCallback(() => {
    browseDraftRef.current = null;
  }, []);

  // Reportado pelo BrowseDocCoder a cada edição: guarda o rascunho no ref,
  // registra-o na rede local e marca o doc como não enviado.
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
    [browseDocId, markDirty, recordDraft],
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
          ...(currentRoundId ? { expectedRoundId: currentRoundId } : {}),
        });
        if (result.success) {
          markClean(browseDocId);
          submitConfirmed(browseDocId, { answers, notes });
          notifySaved(result.missingRequiredFields, fields);
          markResponded(browseDocId);
          browseDraftRef.current = null;
          // Save com obrigatórias em aberto mantém o doc ABERTO, pelo mesmo
          // motivo do modo Atribuídos (ver useAssignedCoding): fechá-lo tiraria a
          // tela de baixo do aviso que acabou de pedir para completá-lo. Aqui a
          // invalidação vem sem o `updateDocParam(null)` que a precede no caminho
          // normal — o refetch é desejado, porque reassenta o formulário no que
          // acabou de ser gravado em vez de num seed stale. Devolver a lista é o
          // que faz o painel rolar até a pergunta (#608).
          if (result.missingRequiredFields.length) {
            invalidateBrowseDoc(browseDocId);
            return result.missingRequiredFields;
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
      currentRoundId,
      fields,
      markClean,
      submitConfirmed,
      markResponded,
      invalidateBrowseDoc,
      updateDocParam,
      setSubmitting,
    ],
  );

  // "Voltar" apenas volta. Até o #608 este caminho autosalvava o rascunho sujo
  // antes de navegar; a gravação sumia junto com o resto do autosave, e com ela
  // saíram `markResponded` e `invalidateBrowseDoc` — ambos existiam só para
  // reagir a essa escrita. Manter qualquer um dos dois aqui seria mentir sobre o
  // servidor: o doc NÃO foi respondido e o cache NÃO ficou stale, porque nada
  // foi gravado. O conteúdo continua no rascunho local e o doc segue marcado
  // como não enviado.
  //
  // A guarda de reentrância permanece: um "Voltar" durante um submit em voo
  // ainda zeraria a URL e o rascunho no meio do save.
  const handleBrowseBack = useCallback(() => {
    if (browseSavingRef.current) return;
    browseDraftRef.current = null;
    updateDocParam(null);
  }, [updateDocParam]);

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
  };
}
