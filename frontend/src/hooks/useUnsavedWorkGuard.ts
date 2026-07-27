"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { registerUnsavedWorkGuard } from "@/lib/unsaved-work-guard";

/**
 * Avisa antes de sair com trabalho não enviado (#608), pelos DOIS canais de
 * saída, num dono só: a navegação interna do app (abas do projeto, via o
 * registro de `lib/unsaved-work-guard`) e o fechamento da janela
 * (`beforeunload`).
 *
 * Ficar junto não é conveniência: são a mesma decisão de produto exposta por
 * mecanismos diferentes, e separá-las produziria duas respostas para a mesma
 * pergunta que passariam a divergir na primeira mudança.
 *
 * O `beforeunload` daqui NÃO é o mesmo de `useCodingDrafts`, que existe para
 * persistir o rascunho antes de a página morrer. Dois listeners no mesmo
 * evento, com donos e propósitos distintos: um grava, o outro avisa. Unificá-los
 * acoplaria o aviso ao resultado da persistência — exatamente o que o #608
 * proíbe, já que numa janela anônima ou com a quota estourada a gravação falha
 * e mesmo assim há trabalho a proteger.
 */
export interface UnsavedWorkGuardState {
  /** Verdadeiro quando uma saída foi interceptada e aguarda decisão. */
  isPrompting: boolean;
  /** Executa a navegação que estava retida. */
  confirmLeave: () => void;
  /** Descarta a navegação retida e mantém a pessoa na tela. */
  cancelLeave: () => void;
}

export function useUnsavedWorkGuard(
  hasUnsavedWork: boolean,
): UnsavedWorkGuardState {
  // A navegação retida vive em estado (a tela precisa reagir abrindo o
  // diálogo), embrulhada porque `useState` trata função como updater.
  const [pending, setPending] = useState<{ proceed: () => void } | null>(null);

  // O predicado é lido em tempo de evento — no clique numa aba ou no unload —,
  // nunca durante o render. Um ref sincronizado mantém os dois listeners
  // registrados uma única vez: reassiná-los a cada mudança de sujeira faria o
  // registro do guard piscar entre desregistrado e registrado, e uma navegação
  // que caísse nessa fresta passaria sem aviso.
  const hasUnsavedRef = useRef(hasUnsavedWork);
  useEffect(() => {
    hasUnsavedRef.current = hasUnsavedWork;
  });

  useEffect(
    () =>
      registerUnsavedWorkGuard((proceed) => {
        if (!hasUnsavedRef.current) return true;
        setPending({ proceed });
        return false;
      }),
    [],
  );

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedRef.current) return;
      // `preventDefault` é o que os navegadores atuais exigem para exibir o
      // aviso nativo; o texto é deles, não nosso.
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  const confirmLeave = useCallback(() => {
    // Limpa ANTES de navegar: `proceed` costuma ser um `router.push`, e deixar
    // a navegação retida no estado durante a transição reabriria o diálogo
    // sobre a tela seguinte se este componente sobrevivesse ao roteamento.
    //
    // O `proceed()` fica FORA do updater de propósito. Updaters de `useState`
    // precisam ser puros e o React os executa duas vezes sob StrictMode —
    // navegar de dentro de um faria a saída disparar em dobro.
    const retained = pending;
    setPending(null);
    retained?.proceed();
  }, [pending]);

  const cancelLeave = useCallback(() => setPending(null), []);

  return { isPrompting: pending !== null, confirmLeave, cancelLeave };
}
