import { useCallback, useEffect, useState } from "react";
import type { CodingDraftRecovery, CodingSnapshot } from "@/lib/coding-draft";
import {
  createCodingDraftSession,
  type CodingDraftSession,
  type CodingDraftsApi,
  type UseCodingDraftsParams,
} from "@/lib/coding-draft-storage";

export type { CodingDraftsApi, UseCodingDraftsParams };

// Ciclo de vida React do rascunho local de respostas (#608). A máquina de
// estados (debounce, posse do slot, GC, abertura) vive em
// `createCodingDraftSession`, sem React; a lógica pura (envelope, classificação)
// em `lib/coding-draft.ts`. Aqui fica só o que é do React: o estado que a faixa
// de recuperação consome e os listeners de saída.
//
// Instanciado UMA vez, em `CodingPage`, servindo os dois modos. É seguro porque
// o espaço de `docId` é particionado por construção: `useBrowseCoding` devolve
// `browseDocId: null` para documento atribuído, então um mesmo id nunca é
// editado pelos dois modos.
//
// O hook não é dono das respostas — Atribuídos as guarda num reducer e Explorar
// num filho keyed. Ele é armazenamento + política, e recebe conteúdo por chamada.
export function useCodingDrafts(params: UseCodingDraftsParams): CodingDraftsApi {
  const { projectId, userId, enabled, fields } = params;

  const [recovery, setRecovery] = useState<CodingDraftRecovery>({ kind: "none" });
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [staleDiscardedCount, setStaleDiscardedCount] = useState(0);

  // Sessão criada uma única vez, por inicializador lazy de `useState`: um
  // `ref.current ??= ...` no corpo do componente seria acesso a ref durante o
  // render (erro de `react-hooks/refs`). Os callbacks são estáveis porque só
  // usam os setters do React, cuja identidade é garantida.
  const [session] = useState<CodingDraftSession>(() =>
    createCodingDraftSession({
      onRecovery: setRecovery,
      onStorageAvailable: setStorageAvailable,
      onStaleDiscarded: (n) => setStaleDiscardedCount((current) => current + n),
    }),
  );

  // A sessão recebe as chaves e o schema num effect sem deps (roda após cada
  // render), e não no corpo do componente: escrever durante o render quebra o
  // modelo concorrente do React e é erro de lint (`react-hooks/refs`). Quem lê
  // esses valores são handlers e listeners, que rodam sempre após o commit.
  useEffect(() => {
    session.configure({ projectId, userId, enabled }, fields);
  });

  const recordDraft = useCallback(
    (docId: string, draft: CodingSnapshot) => session.recordDraft(docId, draft),
    [session],
  );
  const restoreDraft = useCallback(
    (docId: string) => session.restoreDraft(docId),
    [session],
  );
  const discardDraft = useCallback(
    (docId: string) => session.discardDraft(docId),
    [session],
  );
  const submitConfirmed = useCallback(
    (docId: string, saved: CodingSnapshot) => session.submitConfirmed(docId, saved),
    [session],
  );
  const openDocument = useCallback(
    (docId: string | null, remote: CodingSnapshot | null) =>
      session.openDocument(docId, remote),
    [session],
  );

  // Flush garantido nos três gatilhos que o navegador oferece, mais o unmount.
  // O `beforeunload` aqui só persiste; quem avisa a pesquisadora é o guard de
  // navegação.
  useEffect(() => {
    const flush = () => session.flushAll();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [session]);

  return {
    openDocument,
    recordDraft,
    restoreDraft,
    discardDraft,
    submitConfirmed,
    recovery,
    storageAvailable,
    staleDiscardedCount,
  };
}
