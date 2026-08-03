import { useEffect, useState } from "react";
import { getLotteryDocStats } from "@/actions/assignments";
import type { LotteryStats } from "./lottery-dialog-types";

// Stats de elegibilidade, recarregadas a cada abertura do dialog —
// um sorteio muda atribuições/lotes, então reabrir com stats da
// abertura anterior mentiria na contagem de elegíveis. Os dois campos
// (dados + erro) vivem num único objeto de estado para que o effect
// faça uma única chamada de setter por branch (evita cascading set-state).
export function useLotteryStats(projectId: string, open: boolean) {
  const [statsState, setStatsState] = useState<{
    data: LotteryStats | null;
    error: boolean;
  }>({ data: null, error: false });
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getLotteryDocStats(projectId)
      .then((s) => {
        if (cancelled) return;
        if (s.error || !s.docs) {
          setStatsState((prev) => ({ ...prev, error: true }));
        } else {
          setStatsState({
            data: {
              docs: s.docs,
              batches: s.batches ?? [],
              minResponsesForComparison: s.minResponsesForComparison ?? 2,
              automationMode: s.automationMode ?? null,
              currentRoundId: s.currentRoundId ?? null,
              currentRoundLabel: s.currentRoundLabel ?? null,
              activeOpenAssignmentCount: s.activeOpenAssignmentCount ?? 0,
              pendingScopeAssignmentCount: s.pendingScopeAssignmentCount ?? 0,
            },
            error: false,
          });
        }
      })
      .catch(() => {
        if (!cancelled) setStatsState((prev) => ({ ...prev, error: true }));
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);
  return { stats: statsState.data, statsError: statsState.error };
}
