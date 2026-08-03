"use client";

import { Button } from "@/components/ui/button";
import type { LotteryPreview } from "@/actions/assignments";
import { LOTTERY_EMPTY_MESSAGES } from "@/lib/lottery-utils";
import type { LotteryMember } from "./lottery-dialog-types";

// Seção "Prévia + Confirmar" do LotteryDialog: botão de prévia, tabela de
// distribuição por participante e o submit do sorteio. O objeto `run`
// agrupa o estado/ações vindos do useLotteryRun.
export function LotteryPreviewSection({
  preview,
  members,
  run,
}: {
  preview: LotteryPreview | null;
  members: LotteryMember[];
  run: {
    previewing: boolean;
    loading: boolean;
    canPreview: boolean;
    canSubmit: boolean;
    onPreview: () => void;
    onRandomize: () => void;
  };
}) {
  const memberName = (userId: string) =>
    members.find((m) => m.userId === userId)?.name ?? userId.slice(0, 8);

  return (
    <div className="space-y-3">
      <Button
        variant="outline"
        onClick={run.onPreview}
        disabled={run.previewing || !run.canPreview}
        className="w-full"
      >
        {run.previewing ? "Calculando..." : "Visualizar prévia"}
      </Button>

      {preview && (
        <div className="rounded-lg border p-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            {preview.totalNew} novas atribuições ·{" "}
            {preview.totalPreserved} preservadas
          </p>
          {preview.emptyReason && (
            <p className="text-xs text-destructive" role="alert">
              {LOTTERY_EMPTY_MESSAGES[preview.emptyReason]}
            </p>
          )}
          {!preview.emptyReason && preview.unfilledSlots > 0 && (
            <p className="text-xs text-muted-foreground">
              {preview.unfilledSlots} vagas não puderam ser preenchidas com os participantes e limites atuais.
            </p>
          )}
          <div className="max-h-40 overflow-y-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left">
                  <th className="pb-1">Participante</th>
                  <th className="pb-1 text-center">Existentes</th>
                  <th className="pb-1 text-center">Novos</th>
                </tr>
              </thead>
              <tbody>
                {preview.participants.map((r) => (
                  <tr key={r.userId} className="border-b last:border-0">
                    <td className="py-1">{memberName(r.userId)}</td>
                    <td className="py-1 text-center">{r.existing}</td>
                    <td className="py-1 text-center">{r.newDocs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Button
        onClick={run.onRandomize}
        disabled={run.loading || !run.canSubmit}
        className="w-full bg-brand hover:bg-brand/90 text-brand-foreground"
      >
        {run.loading ? "Sorteando..." : "Sortear"}
      </Button>
    </div>
  );
}
