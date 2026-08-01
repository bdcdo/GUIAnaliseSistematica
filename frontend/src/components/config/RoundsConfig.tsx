"use client";

import { Badge } from "@/components/ui/badge";
import type { Round } from "@/lib/types";

interface Props {
  currentRoundId: string | null;
  rounds: Round[];
}

export function RoundsConfig({ currentRoundId, rounds }: Props) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Rodadas</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Cada resposta, atribuição e revisão pertence a uma rodada nomeada. A
          versão do formulário continua registrada apenas para auditoria.
        </p>
      </div>

      <div className="rounded-lg border p-4 space-y-4">
        <div>
          <p className="text-sm font-medium">Histórico do projeto</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Uma nova rodada é criada junto com o sorteio de codificação. Rodadas
            anteriores permanecem disponíveis para consulta e não podem ser
            reativadas ou excluídas.
          </p>
        </div>

        {rounds.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            Nenhuma rodada registrada.
          </p>
        ) : (
          <ol className="space-y-1.5">
            {rounds.map((round) => (
              <li
                key={round.id}
                className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
              >
                <span className="truncate text-sm">{round.label}</span>
                {round.id === currentRoundId && (
                  <Badge variant="default" className="text-xs">
                    Atual
                  </Badge>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
