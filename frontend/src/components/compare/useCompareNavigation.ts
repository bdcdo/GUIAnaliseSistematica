"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { isDocComplete } from "@/lib/compare-assignment-status";
import { findNextPendingDocIndex } from "@/lib/compare-queue-navigation";
import { pinnedIndex } from "@/hooks/usePinnedDoc";
import { useQueueChangeNotice } from "./useQueueChangeNotice";
import type { ReviewsByDoc } from "@/lib/compare-reviews";
import type { PydanticField } from "@/lib/types";
import type { CompareDocument } from "./compare-types";

interface UseCompareNavigationParams {
  documents: CompareDocument[];
  divergentFields: Record<string, string[]>;
  fields: PydanticField[];
  localReviews: ReviewsByDoc;
  // Muda quando o usuário troca deliberadamente de ESCOPO de fila (ex.:
  // "Meus atribuídos" ↔ "Todos" na Comparação), não quando um doc some por
  // exclusão/filtro real. Usado só para silenciar o toast de "documento
  // removido" nessa transição específica — ver o useEffect abaixo.
  resetKey: boolean;
}

export interface CompareNavigation {
  docIndex: number;
  currentDoc: CompareDocument | undefined;
  allDocDivergent: string[];
  docFields: string[];
  fieldIndex: number;
  setFieldIndex: (index: number) => void;
  filter: string;
  changeFilter: (value: string) => void;
  currentFieldName: string;
  currentField: PydanticField | undefined;
  isCurrentFieldDivergent: boolean;
  isCurrentDocComplete: boolean;
  reviewedDocsCount: number;
  hasNextDoc: boolean;
  handleDocNavigate: (newIndex: number) => void;
  handleNextDoc: () => void;
  goNextField: () => void;
  goPrevField: () => void;
}

/**
 * Seleção de documento/campo/filtro da Comparação + derivações e navegação.
 * Extraído de `ComparePage` para tirar 3 `useState` do container (mata
 * `prefer-useReducer`) e ~80 linhas de derivação (ajuda `no-giant-component`).
 */
export function useCompareNavigation({
  documents,
  divergentFields,
  fields,
  localReviews,
  resetKey,
}: UseCompareNavigationParams): CompareNavigation {
  // O pin nasce já apontando para o doc exibido: se ficasse `null` até a
  // primeira navegação explícita (bug #73, caso residual), o fallback
  // "posição 0" faria o re-sort do servidor trocar o parecer sob o usuário
  // enquanto ele revisa o primeiro da fila.
  const [pinnedDocId, setPinnedDocId] = useState<string | null>(
    () => documents[0]?.id ?? null,
  );
  // `null` = "nenhum campo escolhido ainda neste recorte"; o guard de render
  // abaixo resolve para o primeiro campo da lista.
  const [pinnedFieldName, setPinnedFieldName] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");

  // O parecer atual é derivado de `pinnedDocId` (o doc exibido, atualizado a
  // cada escolha explícita do usuário). `documents` é reordenado pelo Server
  // Component a cada `revalidatePath` (sort por pendências); rastrear por
  // índice numérico faria o parecer mudar sob o usuário a cada veredito.
  // Quando o ID atual some da lista (filtro mudou, etc.) caímos para
  // `documents[0]`.
  const docIndex = useMemo(
    () =>
      pinnedIndex(
        documents.map((d) => d.id),
        pinnedDocId,
      ),
    [documents, pinnedDocId],
  );

  // Mantém o pin colado no doc exibido quando ele não resolve mais: pin `null`
  // (lista estava vazia na montagem) ou doc pinado sumiu da lista (excluído,
  // filtro) — nos dois casos `docIndex` caiu para o fallback 0 e o doc exibido
  // deixou de ser o pinado. Sem a re-pinagem, esse fallback ficaria exposto ao
  // próximo re-sort e o parecer saltaria de novo. Ajuste condicional de estado
  // durante o render (padrão dos docs do React, "adjusting state when a prop
  // changes") em vez de effect — `set-state-in-effect` proíbe o setState
  // síncrono em effect.
  if (documents.length > 0 && documents[docIndex]?.id !== pinnedDocId) {
    setPinnedDocId(documents[0].id);
  }

  // Avisa quando o doc pinado some da lista. `lastValidPinnedRef` (atualizado
  // só aqui) guarda o último pin válido do render anterior: se ele deixou de
  // existir em `documents` e o pin corrente já é outro (a re-pinagem acima
  // aconteceu), houve a transição "estava lá → sumiu" — toast uma vez.
  //
  // Exceção: se a transição coincide com uma troca de `resetKey` (o usuário
  // trocou de ESCOPO de fila, ex. "Meus atribuídos" → "Todos"), o doc pinado
  // não foi excluído/filtrado de verdade — só saiu do recorte que o usuário
  // estava olhando, e continua visível no outro escopo. `prevResetKeyRef`
  // rastreia essa troca pra silenciar o toast só nesse ciclo específico; uma
  // exclusão real dentro do MESMO escopo continua avisando normalmente.
  const lastValidPinnedRef = useRef<string | null>(null);
  const prevResetKeyRef = useRef(resetKey);
  useEffect(() => {
    const prev = lastValidPinnedRef.current;
    const scopeChanged = prevResetKeyRef.current !== resetKey;
    prevResetKeyRef.current = resetKey;
    if (
      !scopeChanged &&
      prev !== null &&
      prev !== pinnedDocId &&
      documents.length > 0 &&
      !documents.some((d) => d.id === prev)
    ) {
      toast.info("Documento removido da fila — voltando ao topo.");
    }
    lastValidPinnedRef.current = pinnedDocId;
  }, [pinnedDocId, documents, resetKey]);

  const currentDoc = documents[docIndex];
  const allDocDivergent = useMemo(
    () => (currentDoc ? divergentFields[currentDoc.id] || [] : []),
    [currentDoc, divergentFields],
  );
  const divergentSet = useMemo(
    () => new Set(allDocDivergent),
    [allDocDivergent],
  );

  // Memoizado porque alimenta as deps dos callbacks de navegação abaixo: o ramo
  // filtrado produziria array novo a cada render e tiraria a identidade estável
  // de que o effect de teclado (`useCompareKeyboard`) depende.
  const docFields = useMemo(
    () =>
      filter === "all"
        ? allDocDivergent
        : allDocDivergent.filter((fn) => fn === filter),
    [allDocDivergent, filter],
  );

  // O campo atual é derivado do NOME fixado, não de um índice — mesmo motivo do
  // `pinnedDocId` acima, e mesma primitiva. `allDocDivergent` é recomputado no
  // servidor a cada `revalidatePath` (`computeDivergentFieldNames`): a lista
  // encolhe quando uma equivalência funde grupos e cresce quando o snapshot de
  // um par deixa de casar. Com índice, esse encolhimento deslocava a revisora
  // para OUTRO campo em silêncio, sem clique e sem passar por `guardNavigation`
  // — o segundo defeito provado da #613 (caso real: confirmar equivalência em
  // q4 fez o índice apontar de q8 para q14).
  const fieldIndex = pinnedIndex(docFields, pinnedFieldName);
  const currentFieldName = docFields[fieldIndex];

  // Re-pinagem quando o nome fixado não resolve: pin `null` (primeiro render) ou
  // o campo saiu da lista. Ajuste condicional de estado durante o render (padrão
  // "adjusting state when a prop changes" dos docs do React), não effect —
  // `set-state-in-effect` proíbe o setState síncrono em effect, e é o mesmo
  // idioma já usado para o doc logo acima.
  //
  // O que esta linha compra NÃO é o campo exibido: `pinnedIndex` já cai em 0, então
  // `currentFieldName` seria idêntico sem ela. Ela existe para impedir
  // RESSURREIÇÃO — a fila também CRESCE (quando o snapshot de um par deixa de
  // casar), e um pin órfão que voltasse a aparecer teleportaria a revisora para
  // um campo que ela não escolheu, sem clique. Descartar o pin morto no mesmo
  // render em que ele deixa de resolver fecha essa janela.
  if (docFields.length > 0 && docFields[fieldIndex] !== pinnedFieldName) {
    setPinnedFieldName(docFields[0]);
  }

  const currentField = fields.find((f) => f.name === currentFieldName);
  const isCurrentFieldDivergent = divergentSet.has(currentFieldName);

  // Avisa quando a COMPOSIÇÃO da fila de campos muda sob a revisora. Tanto a
  // decisão (com as três supressões que impedem o aviso de virar ruído) quanto o
  // rastreio do render anterior moram em `compare-queue-change`.
  const currentDocId = currentDoc?.id;
  useQueueChangeNotice({
    currentFields: docFields,
    currentFieldName,
    currentDocId,
    currentFilter: filter,
    reviewedFields: currentDocId ? localReviews[currentDocId] : undefined,
  });

  const reviewedDocsCount = useMemo(
    () =>
      documents.filter((doc) =>
        isDocComplete(divergentFields[doc.id], localReviews[doc.id]),
      ).length,
    [documents, divergentFields, localReviews],
  );

  // Documento "concluído" = todos os campos divergentes têm veredito. Quando
  // verdadeiro, a UI mostra o botão "Próximo parecer" (com foco automático) em
  // vez de avançar por timer cego.
  const isCurrentDocComplete = useMemo(
    () =>
      !!currentDoc &&
      isDocComplete(allDocDivergent, localReviews[currentDoc.id]),
    [currentDoc, allDocDivergent, localReviews],
  );

  // `documents` é reordenado pelo servidor a cada revalidate (docs concluídos
  // afundam para o fim da fila), então o "próximo parecer" precisa ser o
  // próximo doc com pendências — não `docIndex + 1`, que apontaria para fora da
  // fila assim que o doc atual fosse concluído.
  const nextPendingDocIndex = useMemo(
    () =>
      findNextPendingDocIndex(
        documents.map((d) => d.id),
        divergentFields,
        localReviews,
        currentDoc?.id,
      ),
    [documents, divergentFields, localReviews, currentDoc],
  );

  const hasNextDoc = nextPendingDocIndex >= 0;

  // Trocar de parecer começa do primeiro campo do novo doc: `null` é resolvido
  // pelo guard de render. Explícito (e não deixado para a re-pinagem automática)
  // porque um doc novo pode ter um campo divergente de MESMO NOME, e herdar a
  // posição nesse caso seria uma continuidade acidental, não uma decisão.
  const handleNextDoc = useCallback(() => {
    if (nextPendingDocIndex >= 0) {
      setPinnedDocId(documents[nextPendingDocIndex].id);
      setPinnedFieldName(null);
    }
  }, [nextPendingDocIndex, documents]);

  const handleDocNavigate = useCallback(
    (newIndex: number) => {
      if (documents.length === 0) return;
      const clamped = Math.max(0, Math.min(newIndex, documents.length - 1));
      setPinnedDocId(documents[clamped].id);
      setPinnedFieldName(null);
    },
    [documents],
  );

  // A API de borda continua por ÍNDICE (ProgressDots navega por posição e o
  // painel exibe "Campo N/M"); a tradução índice → nome vive aqui, para que o
  // estado interno seja sempre o nome.
  const setFieldIndex = useCallback(
    (index: number) => {
      if (docFields.length === 0) return;
      const clamped = Math.max(0, Math.min(index, docFields.length - 1));
      setPinnedFieldName(docFields[clamped]);
    },
    [docFields],
  );

  // Fixa o NOME do vizinho, não a posição dele: é esta linha que fecha o caso
  // real da #613 — o avanço automático após confirmar uma equivalência
  // (`handleConfirmEquivalent` → `goNextField`) deixa de deslocar quando o
  // refresh seguinte chega com a lista já sem o campo fundido.
  const goNextField = useCallback(() => {
    if (fieldIndex < docFields.length - 1) {
      setPinnedFieldName(docFields[fieldIndex + 1]);
    }
  }, [docFields, fieldIndex]);
  const goPrevField = useCallback(() => {
    if (fieldIndex > 0) setPinnedFieldName(docFields[fieldIndex - 1]);
  }, [docFields, fieldIndex]);

  // O pin NÃO é resetado aqui: o guard de render já resolve os dois sentidos, e
  // resolvê-los por omissão dá o comportamento melhor nos dois. Ao filtrar por
  // um campo único, o nome fixado sai do recorte e a re-pinagem aponta para o
  // campo filtrado; ao voltar para "all", o nome continua presente na lista
  // completa e a revisora permanece onde estava — antes, o reset de índice a
  // jogava de volta no campo 1.
  const changeFilter = useCallback((value: string) => {
    setFilter(value);
  }, []);

  return {
    docIndex,
    currentDoc,
    allDocDivergent,
    docFields,
    fieldIndex,
    setFieldIndex,
    filter,
    changeFilter,
    currentFieldName,
    currentField,
    isCurrentFieldDivergent,
    isCurrentDocComplete,
    reviewedDocsCount,
    hasNextDoc,
    handleDocNavigate,
    handleNextDoc,
    goNextField,
    goPrevField,
  };
}
