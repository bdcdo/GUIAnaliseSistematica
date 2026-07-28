"use client";

import { useEffect, useRef } from "react";

export interface AutosavePayload {
  projectId: string;
  documentId: string;
  answers: Record<string, unknown>;
  notes: string;
}

interface UseAutosaveOnExitParams {
  /** id do documento ativo (assigned ou browse), ou null se nenhum. */
  activeDocId: string | null;
  /**
   * Lê se o documento ativo tem alterações não salvas. É um getter (não um
   * boolean) para o consumidor poder ler um `useRef` em tempo de evento sem
   * acessar o ref durante o render (proibido por react-hooks/refs).
   */
  getIsDirty: () => boolean;
  /** Snapshot do payload no momento do unload (chamado lazy). */
  getPayload: () => AutosavePayload | null;
  endpoint?: string;
}

/**
 * Auto-save ao sair da página (#28). LOAD-BEARING: preserva o comportamento
 * exato do mecanismo original de `CodingPage`.
 *
 * - `beforeunload`: exibe o aviso nativo do browser quando há doc ativo sujo.
 * - `visibilitychange` (hidden): salva via `navigator.sendBeacon` →, em falha
 *   (indisponível, fila cheia que lança, ou retorno `false`), fallback para
 *   `fetch(..., { keepalive: true })`. Ambos sobrevivem ao fechamento da aba,
 *   onde uma Server Action (POST comum) poderia ser abortada.
 *
 * Os listeners são registrados uma vez só (`[endpoint]`); `activeDocId`,
 * `getIsDirty` e `getPayload` são lidos via refs sempre atualizados, evitando
 * re-registrar o listener a cada keystroke.
 *
 * Diferente dos autosaves de navegação, este caminho **não** rebaseia o
 * baseline do rascunho local (#608) e nem poderia: o beacon é fire-and-forget
 * por construção — a aba está sendo fechada e não existe resposta para
 * confirmar a escrita. Não é um buraco: o envelope sobrevive no `localStorage`
 * e, na reabertura, é classificado contra o que o servidor ENTÃO devolve; se o
 * beacon chegou, rascunho e servidor coincidem e o slot é limpo como
 * `redundant`. Se não chegou, a oferta de recuperação aparece — que é
 * exatamente o desfecho desejado.
 */
export function useAutosaveOnExit({
  activeDocId,
  getIsDirty,
  getPayload,
  endpoint = "/api/autosave",
}: UseAutosaveOnExitParams): void {
  const activeDocIdRef = useRef(activeDocId);
  const getIsDirtyRef = useRef(getIsDirty);
  const getPayloadRef = useRef(getPayload);

  // Mantém os refs com os valores mais recentes (atualizados após cada render,
  // antes de qualquer evento de unload disparar).
  useEffect(() => {
    activeDocIdRef.current = activeDocId;
    getIsDirtyRef.current = getIsDirty;
    getPayloadRef.current = getPayload;
  });

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (activeDocIdRef.current && getIsDirtyRef.current()) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  useEffect(() => {
    const beaconSave = (payload: AutosavePayload) => {
      const body = JSON.stringify(payload);
      const blob = new Blob([body], { type: "application/json" });
      // sendBeacon pode lancar sincronamente em alguns browsers (ex.: payload
      // acima do limite da fila). Tratamos como "nao enfileirado" para cair no
      // fallback fetch keepalive em vez de estourar o handler de evento.
      let queued = false;
      try {
        queued =
          typeof navigator.sendBeacon === "function" &&
          navigator.sendBeacon(endpoint, blob);
      } catch (err) {
        console.error("[auto-save] sendBeacon falhou:", err);
      }
      if (!queued) {
        // Fallback: sendBeacon indisponivel ou fila cheia. keepalive tem o
        // mesmo efeito (sobrevive ao unload) mas permite headers.
        fetch(endpoint, {
          method: "POST",
          keepalive: true,
          headers: { "Content-Type": "application/json" },
          body,
        }).catch((err) => console.error("[auto-save] exceção:", err));
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "hidden") return;
      if (!getIsDirtyRef.current()) return;
      const payload = getPayloadRef.current();
      if (payload) beaconSave(payload);
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [endpoint]);
}
