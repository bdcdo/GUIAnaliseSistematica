"use client";

import { useOptimistic, useTransition } from "react";
import { cycleAssignment } from "@/actions/assignments";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Document, ProjectMember, Assignment } from "@/lib/types";

interface AssignmentTableProps {
  projectId: string;
  documents: Pick<Document, "id" | "external_id">[];
  researchers: (ProjectMember & { profiles: { first_name: string | null; email: string } })[];
  assignments: Assignment[];
  readOnly?: boolean;
}

type CellState = {
  cod?: Assignment;
  comp?: Assignment;
};

type OptimisticAction = { docId: string; userId: string };

/**
 * Calcula a próxima lista de assignments após um ciclo na célula (docId, userId).
 * vazio → codificacao → comparacao → vazio
 * Bloqueia se houver assignment não-pendente.
 */
function cycleOptimistic(
  current: Assignment[],
  projectId: string,
  docId: string,
  userId: string,
): Assignment[] {
  const related = current.filter(
    (a) => a.document_id === docId && a.user_id === userId,
  );
  const others = current.filter(
    (a) => !(a.document_id === docId && a.user_id === userId),
  );

  // Bloquear se algum assignment não-pendente existe
  if (related.some((a) => a.status !== "pendente")) return current;

  const hasCod = related.some((a) => a.type === "codificacao");
  const hasComp = related.some((a) => a.type === "comparacao");

  const stub = (type: "codificacao" | "comparacao"): Assignment => ({
    id: `optimistic-${type}-${docId}-${userId}`,
    project_id: projectId,
    document_id: docId,
    user_id: userId,
    status: "pendente",
    type,
    batch_id: null,
    completed_at: null,
    round_id: "optimistic",
  });

  if (!hasCod && !hasComp) return [...others, stub("codificacao")];
  if (hasCod && !hasComp) return [...others, stub("comparacao")];
  if (hasComp && !hasCod) return others;
  // ambos (sorteio): voltar para vazio
  return others;
}

export function AssignmentTable({ projectId, documents, researchers, assignments, readOnly = false }: AssignmentTableProps) {
  const [isPending, startTransition] = useTransition();

  const [optimisticAssignments, applyOptimistic] = useOptimistic(
    assignments,
    (current: Assignment[], action: OptimisticAction) =>
      cycleOptimistic(current, projectId, action.docId, action.userId),
  );

  const cellMap = new Map<string, CellState>();
  for (const a of optimisticAssignments) {
    const key = `${a.document_id}:${a.user_id}`;
    const entry = cellMap.get(key) || {};
    if (a.type === "codificacao") entry.cod = a;
    else entry.comp = a;
    cellMap.set(key, entry);
  }

  const handleCycle = (documentId: string, userId: string) => {
    startTransition(async () => {
      applyOptimistic({ docId: documentId, userId });
      const result = await cycleAssignment(projectId, documentId, userId);
      if (result?.error) toast.error(result.error);
    });
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-3 py-2 text-left font-medium">Documento</th>
              {researchers.map((r) => (
                <th key={r.user_id} className="px-3 py-2 text-center font-medium">
                  {r.profiles?.first_name || r.profiles?.email?.split("@")[0]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {documents.map((doc) => (
              <tr key={doc.id} className="border-b">
                <td className="px-3 py-1.5 font-mono text-xs">{doc.external_id || doc.id.slice(0, 8)}</td>
                {researchers.map((r) => {
                  const state = cellMap.get(`${doc.id}:${r.user_id}`) || {};
                  const { cod, comp } = state;
                  const hasAny = !!(cod || comp);

                  // Prioridade para status visual: concluído > em_andamento > pendente
                  const statusOrder = { concluido: 3, em_andamento: 2, pendente: 1 } as const;
                  const dominant = [cod, comp]
                    .filter((a): a is Assignment => !!a)
                    .reduce<Assignment | undefined>(
                      (best, a) =>
                        !best ||
                        (statusOrder[a.status] || 0) > (statusOrder[best.status] || 0)
                          ? a
                          : best,
                      undefined,
                    );
                  const status = dominant?.status;

                  const isNonRemovable = status === "concluido" || status === "em_andamento";

                  // Cor base pelo status
                  const baseColor = status === "concluido"
                    ? "bg-green-500 border-green-600 text-white"
                    : status === "em_andamento"
                    ? "bg-yellow-400 border-yellow-500 text-white"
                    : cod && !comp
                    ? "bg-brand border-brand text-brand-foreground"
                    : comp && !cod
                    ? "bg-amber-500 border-amber-600 text-white"
                    : cod && comp
                    ? "bg-brand border-brand text-brand-foreground"
                    : "border-muted-foreground/30 hover:border-brand/50";

                  // Badge de tipo (C / R / C·R)
                  const badgeText =
                    cod && comp ? "C·R" : cod ? "C" : comp ? "R" : null;

                  const statusIcon =
                    status === "concluido" ? "✓" : status === "em_andamento" ? "…" : null;

                  const cell = (
                    <button
                      type="button"
                      onClick={() => handleCycle(doc.id, r.user_id)}
                      disabled={readOnly || isNonRemovable || isPending}
                      className={cn(
                        "relative size-6 rounded border transition-colors",
                        baseColor,
                        (readOnly || isNonRemovable || isPending) && "cursor-default",
                      )}
                      aria-label={
                        !hasAny
                          ? "Atribuir codificação"
                          : cod && !comp
                          ? "Atribuição de codificação (clique para trocar por comparação)"
                          : comp && !cod
                          ? "Atribuição de comparação (clique para remover)"
                          : "Atribuição de codificação e comparação"
                      }
                    >
                      {statusIcon && (
                        <span className="text-xs leading-none">{statusIcon}</span>
                      )}
                      {badgeText && !statusIcon && (
                        <span className="text-[9px] font-semibold leading-none">
                          {badgeText}
                        </span>
                      )}
                      {badgeText && statusIcon && (
                        <span className="absolute -right-1 -top-1 rounded-sm bg-foreground/80 px-0.5 text-[8px] font-semibold leading-tight text-background">
                          {badgeText}
                        </span>
                      )}
                    </button>
                  );

                  const tooltipParts: string[] = [];
                  if (cod) tooltipParts.push(`Codificação (${cod.status})`);
                  if (comp) tooltipParts.push(`Comparação (${comp.status})`);

                  return (
                    <td key={r.user_id} className="px-3 py-1.5 text-center">
                      {tooltipParts.length > 0 ? (
                        <Tooltip>
                          <TooltipTrigger asChild>{cell}</TooltipTrigger>
                          <TooltipContent side="top" className="text-xs">
                            {tooltipParts.map((p, i) => (
                              <div key={i}>{p}</div>
                            ))}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        cell
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-muted/30">
              <td className="px-3 py-1.5 font-medium">Total</td>
              {researchers.map((r) => {
                const forUser = optimisticAssignments.filter((a) => a.user_id === r.user_id);
                const codTotal = forUser.filter((a) => a.type === "codificacao").length;
                const codDone = forUser.filter(
                  (a) => a.type === "codificacao" && a.status === "concluido",
                ).length;
                const compTotal = forUser.filter((a) => a.type === "comparacao").length;
                const compDone = forUser.filter(
                  (a) => a.type === "comparacao" && a.status === "concluido",
                ).length;
                return (
                  <td key={r.user_id} className="px-3 py-1.5 text-center text-xs font-medium">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-brand">
                        C: {codDone}/{codTotal}
                      </span>
                      <span className="text-amber-600">
                        R: {compDone}/{compTotal}
                      </span>
                    </div>
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>
    </TooltipProvider>
  );
}
