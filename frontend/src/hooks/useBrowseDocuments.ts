"use client";

import { useCallback, useMemo, useState } from "react";
import { getDocumentsForBrowse, type BrowseDocument } from "@/actions/documents";
import { useCachedResource } from "./useCachedResource";

/**
 * Lazy-load da lista de documentos do modo Explorar, com cache por `projectId`
 * e flag `loading` derivada.
 *
 * Wrapper de `useCachedResource` (cache/loading/erro/retry vêm do genérico, sem
 * `maxEntries` — só há uma entrada, a do projeto). Em falha o `fetcher` rejeita,
 * então o genérico expõe `error=true` SEM cachear (não mascara como "projeto sem
 * documentos"); `retry()` limpa o erro/cache e refaz o fetch.
 *
 * `markResponded` aplica o update otimista pós-envio sobre uma camada local de
 * `overrides` (atualizada em handler, nunca em effect): marca o doc como
 * respondido por este pesquisador e — quando o doc ainda não o contava —
 * incrementa `responseCount` uma única vez. Desde o #608 o único produtor é o
 * envio explícito — "Voltar" deixou de gravar, e com isso deixou de contar. O
 * `retry()` também
 * zera os `overrides`: um refetch traz dados frescos do servidor, e overrides
 * antigos os clobbeariam.
 */
export function useBrowseDocuments(
  projectId: string,
  enabled: boolean,
): {
  documents: BrowseDocument[] | null;
  loading: boolean;
  error: boolean;
  retry: () => void;
  markResponded: (docId: string) => void;
} {
  const fetcher = useCallback(
    (id: string): Promise<BrowseDocument[]> => getDocumentsForBrowse(id),
    [],
  );

  const {
    data: base,
    loading,
    error,
    retry: retryResource,
  } = useCachedResource(projectId, fetcher, { enabled });

  // Override guarda só a INTENÇÃO "este pesquisador respondeu", não o valor
  // absoluto. Assim `markResponded` não precisa ler a lista já carregada — o
  // merge abaixo aplica a intenção sobre a base de forma idempotente quando a
  // base chega (corrige a race de deep-link em que a lista ainda não resolveu).
  const [overrides, setOverrides] = useState<Record<string, true>>({});

  const retry = useCallback(() => {
    retryResource();
    setOverrides({});
  }, [retryResource]);

  const documents = useMemo(() => {
    if (!base) return null;
    return base.map((d) => {
      if (!overrides[d.id]) return d;
      return {
        ...d,
        userAlreadyResponded: true,
        // +1 só quando a base ainda não contava este pesquisador. O envio
        // explícito persiste uma resposta contável (`getDocumentsForBrowse` conta
        // respondentes distintos sem filtrar `is_partial`), então ele bumpa a
        // primeira resposta deste pesquisador. Recomputado de `base` a
        // cada render e gateado por `userAlreadyResponded` → nunca acumula.
        responseCount: d.userAlreadyResponded
          ? d.responseCount
          : d.responseCount + 1,
      };
    });
  }, [base, overrides]);

  // Registra a intenção sem ler `documents`: funciona mesmo com a lista ainda
  // não resolvida. Idempotente — reaplicar é no-op.
  const markResponded = useCallback((docId: string) => {
    setOverrides((prev) => (prev[docId] ? prev : { ...prev, [docId]: true }));
  }, []);

  return { documents, loading, error, retry, markResponded };
}
