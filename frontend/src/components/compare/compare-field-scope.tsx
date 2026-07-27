"use client";

import { createContext, useContext, useMemo } from "react";
import type { VerdictOrigin } from "./compare-types";

const CompareFieldScopeContext = createContext<VerdictOrigin | null>(null);

/**
 * Provê o par (documento, campo) a toda a subárvore que exibe e decide sobre um
 * campo divergente. Montado por `CompareFieldReview`, que é keyed por essa mesma
 * identidade.
 *
 * A garantia que isto carrega: um fiber desmontado nunca re-renderiza, então uma
 * subárvore que sobreviva no DOM (issue #613) continua enxergando a origem do
 * campo em que foi montada — nunca a do campo atual. Um clique nela produz um
 * rascunho carimbado com o campo velho, que a fronteira de escrita recusa. Sem
 * isto, o campo de destino era resolvido pelo container no render CORRENTE, e o
 * clique fantasma gravava silenciosamente no campo errado.
 *
 * Por que contexto e não uma prop encadeada até o `AnswerCard`: a prop obrigaria
 * cada componente novo dentro do painel a lembrar de recebê-la e repassá-la, e o
 * esquecimento seria invisível. O contexto é herdado por construção.
 */
export function CompareFieldScope({
  documentId,
  fieldName,
  children,
}: {
  documentId: string;
  fieldName: string;
  children: React.ReactNode;
}) {
  const origin = useMemo(
    () => ({ documentId, fieldName }),
    [documentId, fieldName],
  );
  return (
    <CompareFieldScopeContext.Provider value={origin}>
      {children}
    </CompareFieldScopeContext.Provider>
  );
}

/**
 * Origem do campo em que este render está. Lança fora do escopo: construir uma
 * decisão de comparação sem saber a que campo ela pertence é erro de
 * programação, não um estado a tratar com fallback.
 */
export function useVerdictOrigin(): VerdictOrigin {
  const origin = useContext(CompareFieldScopeContext);
  if (!origin) {
    throw new Error(
      "useVerdictOrigin exige um <CompareFieldScope> acima na árvore.",
    );
  }
  return origin;
}
