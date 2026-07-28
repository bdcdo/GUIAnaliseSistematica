"use client";

import { useState, useTransition } from "react";

/** O mínimo que a seleção precisa saber de um grupo renderizado. */
interface SelectableGroup {
  groupKey: string;
  displayAnswer: string;
  responses: { id: string }[];
}

/**
 * Estado de "quais cards estão marcados como equivalentes e qual deles é o
 * gabarito", com as duas escritas que dele decorrem (confirmar a fusão, desfazer
 * um par).
 *
 * Vive fora do `AgreementGroup` porque é um assunto inteiro — ordem de seleção,
 * override de gabarito, transição de submissão — que não tem relação com o
 * render dos cards nem com o veredito do campo. O componente ficava carregando
 * três peças de estado e quatro handlers que nunca consultava diretamente.
 *
 * A ordem de seleção é preservada de propósito: o PRIMEIRO card marcado é o
 * gabarito padrão, e o override só vale enquanto o card apontado continuar
 * selecionado.
 */
export function useEquivalenceSelection<G extends SelectableGroup>({
  groups,
  onConfirmEquivalent,
  onUnmarkPair,
}: {
  groups: G[];
  onConfirmEquivalent?: (
    responseIds: string[],
    gabaritoId: string,
    verdictDisplay: string,
  ) => Promise<void>;
  onUnmarkPair?: (pairId: string) => Promise<void>;
}) {
  const [selectionOrder, setSelectionOrder] = useState<string[]>([]);
  const [gabaritoOverride, setGabaritoOverride] = useState<string | null>(null);
  const [isSubmitting, startTransition] = useTransition();

  // Entradas obsoletas (grupos que sumiram após navegação ou fusão no servidor)
  // são filtradas aqui, em silêncio: não precisam de efeito de limpeza porque
  // nunca chegam a ser visíveis. O pai keya este componente por campo+documento,
  // então navegar também remonta e zera a seleção naturalmente.
  const selectedGroups = selectionOrder
    .map((key) => groups.find((g) => g.groupKey === key))
    .filter((g): g is G => !!g);

  // Consultado uma vez por grupo renderizado; como array seria O(grupos²).
  const selectionSet = new Set(selectionOrder);
  const effectiveGabarito =
    gabaritoOverride && selectionOrder.includes(gabaritoOverride)
      ? gabaritoOverride
      : (selectionOrder[0] ?? null);

  // Os dois setters ficam no nível do handler: um `setGabaritoOverride` aninhado
  // no updater de `setSelectionOrder` seria efeito colateral dentro de função
  // que React pode reexecutar. `selectionOrder` do closure basta para decidir o
  // ramo — só o clique altera a seleção.
  function toggleSelection(groupKey: string) {
    if (selectionOrder.includes(groupKey)) {
      setSelectionOrder((prev) => prev.filter((k) => k !== groupKey));
      if (gabaritoOverride === groupKey) setGabaritoOverride(null);
      return;
    }
    setSelectionOrder((prev) => [...prev, groupKey]);
  }

  function confirmEquivalence() {
    const gabaritoGroup = selectedGroups.find(
      (g) => g.groupKey === effectiveGabarito,
    );
    if (!onConfirmEquivalent || selectedGroups.length < 2 || !gabaritoGroup) {
      return;
    }
    // Um representante por grupo: respostas com o mesmo texto literal já foram
    // fundidas no servidor, então pares intragrupo só criariam linhas inúteis.
    const responseIds = selectedGroups.map((g) => g.responses[0].id);
    startTransition(async () => {
      await onConfirmEquivalent(
        responseIds,
        gabaritoGroup.responses[0].id,
        gabaritoGroup.displayAnswer,
      );
      setSelectionOrder([]);
      setGabaritoOverride(null);
    });
  }

  // "Todas são similares" (issue #247, ponto 5): pré-seleciona TODOS os grupos
  // de uma vez, em vez de o revisor marcar par a par. A persistência continua no
  // botão explícito de confirmação, inclusive quando há maioria clara.
  function selectAll() {
    if (!onConfirmEquivalent || groups.length < 2) return;
    setSelectionOrder(groups.map((g) => g.groupKey));
    setGabaritoOverride(null);
  }

  function unmarkPair(pairId: string) {
    if (!onUnmarkPair) return;
    startTransition(async () => {
      await onUnmarkPair(pairId);
    });
  }

  return {
    selectedGroups,
    selectionSet,
    effectiveGabarito,
    // O gabarito só faz sentido quando há mais de um card na fusão: com um só,
    // não há escolha a fazer.
    showGabarito: selectedGroups.length >= 2,
    isSubmitting,
    toggleSelection,
    setGabarito: setGabaritoOverride,
    confirmEquivalence,
    selectAll,
    unmarkPair,
  };
}
