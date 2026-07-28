"use client";

import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";

/**
 * Rastreamento de documentos "sujos" (editados sem enviar) por id.
 *
 * O conjunto vive num `useRef` e as mutações não passam por `setState`: marcar
 * e limpar acontecem em tempo de evento, e um `useState<Set>` aqui disparava o
 * `rerender-state-only-in-handlers` no `CodingPage`. `isDirty` continua sendo
 * uma **função** lida em tempo de evento, nunca durante o render — os callers
 * imperativos (guards de navegação, handlers) seguem inalterados.
 *
 * O que mudou com o #608: a tela passou a precisar EXIBIR "há alterações não
 * enviadas", e isso exige um sinal reativo. Em vez de duplicar o conjunto num
 * estado paralelo — duas fontes para o mesmo fato, que divergem —, o ref ganhou
 * um `subscribe` e um contador de versão, e a leitura reativa sai de
 * `useSyncExternalStore` sobre esse contador. O estado passa a ser genuinamente
 * renderizado, então o diagnóstico que motivou o ref não se aplica à leitura.
 *
 * Este é deliberadamente o sinal que alimenta o indicador de "não enviado", e
 * NÃO o resultado da persistência local: sujeira é um fato da memória, gravar é
 * best-effort. Com o localStorage bloqueado (janela anônima) ou a quota
 * estourada, um indicador derivado do storage diria "tudo enviado" enquanto há
 * edição pendente no reducer — exatamente a classe de mentira que o #608 existe
 * para eliminar. Os dois sinais são distintos e ambos visíveis.
 */
export interface DirtyDocsStore {
  markDirty: (docId: string) => void;
  markClean: (docId: string) => void;
  isDirty: (docId: string | null | undefined) => boolean;
  subscribe: (listener: () => void) => () => void;
  getVersion: () => number;
  getDirtyCount: () => number;
  // Quais documentos estão sujos. Getter imperativo, lido em tempo de evento —
  // deliberadamente NÃO exposto por `useSyncExternalStore`: o snapshot lá precisa
  // ser primitivo (o array seria recriado a cada leitura e re-renderizaria em
  // loop). Quem precisa reagir usa `useDirtyDocsCount`; quem precisa da lista a
  // consulta no momento em que decide algo.
  getDirtyDocIds: () => string[];
}

export function useDirtyDocs(): DirtyDocsStore {
  const ref = useRef<Set<string> | null>(null);
  const listenersRef = useRef<Set<() => void> | null>(null);
  // Snapshot primitivo. Devolver o próprio `Set` faria `useSyncExternalStore`
  // comparar por identidade e re-renderizar em loop a cada mutação in-place.
  const versionRef = useRef(0);

  const emit = useCallback(() => {
    versionRef.current += 1;
    listenersRef.current?.forEach((listener) => listener());
  }, []);

  const markDirty = useCallback(
    (docId: string) => {
      const set = (ref.current ??= new Set());
      if (set.has(docId)) return;
      set.add(docId);
      emit();
    },
    [emit],
  );

  const markClean = useCallback(
    (docId: string) => {
      const set = (ref.current ??= new Set());
      if (!set.delete(docId)) return;
      emit();
    },
    [emit],
  );

  const isDirty = useCallback(
    (docId: string | null | undefined) => !!docId && (ref.current ??= new Set()).has(docId),
    [],
  );

  const subscribe = useCallback((listener: () => void) => {
    const listeners = (listenersRef.current ??= new Set());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const getVersion = useCallback(() => versionRef.current, []);
  const getDirtyCount = useCallback(() => ref.current?.size ?? 0, []);
  const getDirtyDocIds = useCallback(() => [...(ref.current ?? [])], []);

  return useMemo(
    () => ({
      markDirty,
      markClean,
      isDirty,
      subscribe,
      getVersion,
      getDirtyCount,
      getDirtyDocIds,
    }),
    [
      markDirty,
      markClean,
      isDirty,
      subscribe,
      getVersion,
      getDirtyCount,
      getDirtyDocIds,
    ],
  );
}

// Leitura reativa por documento. O snapshot é o próprio booleano — primitivo,
// portanto estável por valor: devolver o `Set` faria o React comparar por
// identidade e re-renderizar em loop, já que o conjunto é mutado in-place.
export function useIsDocDirty(
  store: DirtyDocsStore,
  docId: string | null | undefined,
): boolean {
  const getSnapshot = useCallback(() => store.isDirty(docId), [store, docId]);
  return useSyncExternalStore(
    store.subscribe,
    getSnapshot,
    // No servidor não há sujeira: o valor precisa casar com o primeiro render do
    // cliente, senão o React acusa mismatch de hidratação.
    () => false,
  );
}

// Quantos documentos têm alterações não enviadas. Existia antes como superfície
// só do teste e foi removida por isso; volta porque o aviso de saída (#608) a
// consome de fato — quem editou três documentos e clica em "Revisar" precisa
// saber dos três, não só do que está aberto.
export function useDirtyDocsCount(store: DirtyDocsStore): number {
  return useSyncExternalStore(store.subscribe, store.getDirtyCount, () => 0);
}
