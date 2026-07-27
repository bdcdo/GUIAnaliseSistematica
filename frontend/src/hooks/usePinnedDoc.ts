"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

const PINNED_DOC_EVENT = "pinneddoc:change";

// Função estável (módulo) para o `useSyncExternalStore`. Ouve um custom event
// para mudanças na mesma aba (sessionStorage NÃO dispara "storage" same-tab) e
// o evento "storage" nativo para mudanças cross-tab.
function subscribe(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(PINNED_DOC_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(PINNED_DOC_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

/**
 * Seleção de documento persistida em `sessionStorage`, com limpeza de órfão.
 *
 * Lê o valor durante o render via `useSyncExternalStore` (React 19) em vez de um
 * `useEffect` de restore — isso elimina de verdade o
 * `eslint-disable react-hooks/set-state-in-effect` do padrão antigo (não apenas
 * silencia). `getServerSnapshot` retorna `null`, então a hidratação é segura por
 * design. O snapshot é a string crua do storage (primitivo → referencialmente
 * estável, sem loop de render).
 *
 * `options.validIds`: quando o id fixado deixa de estar entre os válidos (ex.:
 * doc resolvido saiu da fila), um effect só-`removeItem` limpa o storage. Sem
 * `setState` no effect → sem disable; o valor reativo se atualiza pelo evento
 * disparado.
 */
function usePinnedDoc(
  storageKey: string,
  options?: { validIds?: readonly string[] },
): [string | null, (id: string | null) => void] {
  const getSnapshot = useCallback(
    () =>
      typeof window === "undefined"
        ? null
        : window.sessionStorage.getItem(storageKey),
    [storageKey],
  );
  const pinnedDocId = useSyncExternalStore(subscribe, getSnapshot, () => null);

  const setPinnedDocId = useCallback(
    (id: string | null) => {
      if (typeof window === "undefined") return;
      if (id === null) window.sessionStorage.removeItem(storageKey);
      else window.sessionStorage.setItem(storageKey, id);
      window.dispatchEvent(new Event(PINNED_DOC_EVENT));
    },
    [storageKey],
  );

  const validIds = options?.validIds;
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (pinnedDocId && validIds && !validIds.includes(pinnedDocId)) {
      window.sessionStorage.removeItem(storageKey);
      window.dispatchEvent(new Event(PINNED_DOC_EVENT));
    }
  }, [pinnedDocId, validIds, storageKey]);

  return [pinnedDocId, setPinnedDocId];
}

/**
 * Índice do item fixado numa lista de identificadores, com fallback ao topo:
 * quando o pin é `null` ou não está na lista (inclui lista vazia), retorna 0 —
 * a posição exibida por padrão. Derivação compartilhada por todos os
 * consumidores de seleção fixada (Comparação, Auto-revisão, Arbitragem) para
 * não triplicar o memo.
 *
 * Genérica quanto ao que é fixado: os identificadores são ids de documento na
 * maioria dos casos e NOMES DE CAMPO na navegação de campos da Comparação
 * (#613) — daí o nome não mencionar documento.
 */
export function pinnedIndex(
  ids: readonly string[],
  pinnedId: string | null,
): number {
  const i = ids.findIndex((id) => id === pinnedId);
  return i >= 0 ? i : 0;
}

/**
 * Combina persistência, índice atual e navegação limitada de uma fila de docs.
 * Concentra também a derivação dos ids para que todas as filas transformem um
 * índice solicitado em um pin válido do mesmo modo.
 */
export function usePinnedDocNavigation(
  storageKey: string,
  documents: readonly { docId: string }[],
) {
  const validDocIds = useMemo(
    () => documents.map((document) => document.docId),
    [documents],
  );
  const [pinnedDocId, setPinnedDocId] = usePinnedDoc(storageKey, {
    validIds: validDocIds,
  });
  const docIndex = pinnedIndex(validDocIds, pinnedDocId);
  const navigateToIndex = useCallback(
    (requestedIndex: number) => {
      const lastIndex = validDocIds.length - 1;
      const targetId =
        validDocIds[Math.max(0, Math.min(requestedIndex, lastIndex))];
      if (targetId) setPinnedDocId(targetId);
    },
    [setPinnedDocId, validDocIds],
  );
  return { docIndex, navigateToIndex };
}
