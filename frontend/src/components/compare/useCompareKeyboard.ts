"use client";

import { useEffect } from "react";
import type { PydanticField } from "@/lib/types";
import type {
  FieldResponse,
  PendingVerdict,
  VerdictOrigin,
} from "./compare-types";

interface UseCompareKeyboardParams {
  readOnly: boolean;
  isFullscreen: boolean;
  isCurrentDocComplete: boolean;
  isCurrentFieldDivergent: boolean;
  currentField: PydanticField | undefined;
  answerGroups: FieldResponse[][];
  // Campo a que pertencem as decisões tomadas pelo teclado. `null` quando não há
  // doc/campo resolvido — os atalhos de decisão então não fazem nada, em vez de
  // produzir um rascunho sem dono. O teclado sempre lê `answerGroups` frescos, e
  // por isso NÃO era o vetor da #613; carimbar a origem aqui é o que mantém os
  // dois caminhos (mouse e teclado) sob a mesma regra.
  origin: VerdictOrigin | null;
  onToggleFullscreen: () => void;
  onExitFullscreen: () => void;
  onNextField: () => void;
  onPrevField: () => void;
  onPrepareVerdict: (pending: PendingVerdict) => void;
  onSubmitSpecialVerdict: (verdict: "ambiguo" | "pular") => void;
  onConfirmPendingVerdict: () => void;
  hasPendingVerdict: boolean;
}

/**
 * Atalhos de teclado da Comparação. Extraído de `ComparePage`: o corpo do
 * effect só chama callbacks recebidos por prop (`onToggleFullscreen`,
 * `onNextField`, `onPrepareVerdict`, …) — nenhum `setState` léxico —, o que zera o
 * `no-cascading-set-state` que o effect inline disparava sem precisar de
 * `useReducer`. `onNextField`/`onPrevField` já fazem o clamp de limite
 * internamente e chegam embrulhados no gate de navegação do container
 * (`guardNavigation`: in-flight e rascunho pendente — issue #430), então as
 * teclas `n`/`p` chamam incondicionalmente.
 */
export function useCompareKeyboard({
  readOnly,
  isFullscreen,
  isCurrentDocComplete,
  isCurrentFieldDivergent,
  currentField,
  answerGroups,
  origin,
  onToggleFullscreen,
  onExitFullscreen,
  onNextField,
  onPrevField,
  onPrepareVerdict,
  onSubmitSpecialVerdict,
  onConfirmPendingVerdict,
  hasPendingVerdict,
}: UseCompareKeyboardParams): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)
      )
        return;

      if (e.key === "F" && e.ctrlKey && e.shiftKey) {
        e.preventDefault();
        onToggleFullscreen();
        return;
      }
      if (e.key === "Escape" && isFullscreen) {
        onExitFullscreen();
        return;
      }

      if (e.key === "n") {
        onNextField();
        return;
      }
      if (e.key === "p") {
        onPrevField();
        return;
      }

      // `n`/`p` e fullscreen são navegação/leitura e continuam ativos. Todos
      // os atalhos abaixo preparam ou persistem uma decisão e, portanto,
      // param aqui durante a impersonação master (issue #428) e quando não há
      // campo a que atribuir a decisão.
      if (readOnly || !isCurrentFieldDivergent || !origin) return;

      const isMultiField =
        currentField?.type === "multi" && currentField.options?.length;
      if (isMultiField) {
        if (e.key === "a") onSubmitSpecialVerdict("ambiguo");
        if (e.key === "s") onSubmitSpecialVerdict("pular");
        return;
      }

      if (e.key === "Enter" && hasPendingVerdict) {
        e.preventDefault();
        onConfirmPendingVerdict();
        return;
      }

      const num = parseInt(e.key);
      if (num >= 1 && num <= answerGroups.length) {
        const group = answerGroups[num - 1];
        const answer = group[0].answer;
        const displayAnswer =
          answer == null
            ? ""
            : Array.isArray(answer)
              ? answer.join(", ")
              : String(answer);
        onPrepareVerdict({
          kind: "response",
          verdict: displayAnswer,
          chosenResponseId: group[0].id,
          origin,
        });
        return;
      }

      if (e.key === "a")
        onPrepareVerdict({ kind: "ambiguous", verdict: "ambiguo", origin });
      if (e.key === "s")
        onPrepareVerdict({ kind: "skip", verdict: "pular", origin });
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    readOnly,
    answerGroups,
    currentField,
    isCurrentDocComplete,
    isCurrentFieldDivergent,
    isFullscreen,
    origin,
    hasPendingVerdict,
    onConfirmPendingVerdict,
    onExitFullscreen,
    onNextField,
    onPrepareVerdict,
    onPrevField,
    onSubmitSpecialVerdict,
    onToggleFullscreen,
  ]);
}
