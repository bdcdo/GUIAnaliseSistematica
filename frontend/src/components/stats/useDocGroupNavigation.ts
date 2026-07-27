import { useMemo, useState } from "react";
import { pinnedIndex } from "@/hooks/usePinnedDoc";
import type { ReviewComment } from "./comment-card-utils";

interface DocGroup {
  docId: string;
  title: string;
  comments: ReviewComment[];
}

export function useDocGroupNavigation(
  comments: ReviewComment[],
  initialDocId: string,
) {
  // Group comments by document, preserving order of first occurrence
  const docGroups = useMemo<DocGroup[]>(() => {
    const map = new Map<string, { title: string; comments: ReviewComment[] }>();
    for (const c of comments) {
      if (!map.has(c.documentId)) {
        map.set(c.documentId, { title: c.documentTitle, comments: [] });
      }
      map.get(c.documentId)!.comments.push(c);
    }
    return [...map.entries()].map(([docId, data]) => ({
      docId,
      ...data,
    }));
  }, [comments]);

  // Fixa o documento atual por id (não por índice): `comments` é reordenado
  // pelo servidor a cada resolve/reopen (buildOrderedComments), o que pode
  // mudar qual doc ocupa a posição N — pinnedIndex recalcula o índice a
  // cada render em vez de confiar num índice preso desde o mount.
  const [currentDocId, setCurrentDocId] = useState(initialDocId);
  const docIds = useMemo(() => docGroups.map((g) => g.docId), [docGroups]);
  const docIndex = pinnedIndex(docIds, currentDocId);
  const currentGroup = docGroups[docIndex];

  const setDocIndex = (updater: number | ((prev: number) => number)) => {
    const nextIndex = typeof updater === "function" ? updater(docIndex) : updater;
    const target = docGroups[nextIndex];
    if (target) setCurrentDocId(target.docId);
  };

  return {
    docGroups,
    docIndex,
    setDocIndex,
    currentGroup,
    currentDocId: currentGroup?.docId,
  };
}
