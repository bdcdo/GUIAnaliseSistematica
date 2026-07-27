"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import {
  queueChangeNotice,
  type QueueChangeInput,
} from "./compare-queue-change";

/** A metade "agora" do input: o hook guarda a metade "antes" sozinho. */
export type QueueChangeCurrent = Pick<
  QueueChangeInput,
  "currentFields" | "currentDocId" | "currentFilter" | "reviewedFields"
> & { currentFieldName: string | undefined };

/**
 * Rastreia a fila do render anterior e emite o aviso quando ela muda de
 * composição.
 *
 * Mora aqui, e não dentro de `useCompareNavigation`, por medição: aquele hook já
 * estava acima do limiar de complexidade do fallow antes da #613 (cognitive 21
 * em `origin/main`, severidade moderate) e embutir o ref + effect o levava a 25,
 * cruzando para HIGH. E mora aqui, e não em `compare-queue-change.ts`, para que
 * a decisão continue sendo um módulo PURO — testável sem React nem sonner no
 * ambiente, que é o que aquele arquivo declara no próprio cabeçalho.
 *
 * O ref é atualizado no topo do effect, antes de decidir: assim uma rajada de
 * revalidates compara sempre contra o render imediatamente anterior, e não
 * contra o último que gerou aviso.
 */
export function useQueueChangeNotice({
  currentFields,
  currentFieldName,
  currentDocId,
  currentFilter,
  reviewedFields,
}: QueueChangeCurrent): void {
  const prevRef = useRef<{
    fields: readonly string[] | null;
    fieldName: string | undefined;
    docId: string | undefined;
    filter: string;
  }>({
    fields: null,
    fieldName: undefined,
    docId: undefined,
    filter: currentFilter,
  });

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = {
      fields: currentFields,
      fieldName: currentFieldName,
      docId: currentDocId,
      filter: currentFilter,
    };
    const notice = queueChangeNotice({
      previousFields: prev.fields,
      currentFields,
      previousFieldName: prev.fieldName,
      previousDocId: prev.docId,
      currentDocId,
      previousFilter: prev.filter,
      currentFilter,
      reviewedFields,
    });
    if (notice) toast.info(notice.message, { id: notice.id });
  }, [
    currentFields,
    currentFieldName,
    currentDocId,
    currentFilter,
    reviewedFields,
  ]);
}
