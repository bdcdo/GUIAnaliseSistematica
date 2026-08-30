"use client";

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2,
  RotateCcw,
  Pencil,
  FileText,
  Equal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/date-format";
import { formatVerdictDisplay } from "@/lib/verdict-display";
import type { LlmError } from "@/lib/llm-error-metrics";

interface LlmErrorCardProps {
  error: LlmError;
  projectId: string;
  isPending: boolean;
  isCoordinator?: boolean;
  onResolve: () => void;
  onReopen: () => void;
  onEditField?: () => void;
  onMarkEquivalent?: () => void;
}

function formatReviewedAt(iso: string): string {
  try {
    return formatDate(iso);
  } catch {
    return iso;
  }
}

export function LlmErrorCard({
  error,
  projectId,
  isPending,
  isCoordinator,
  onResolve,
  onReopen,
  onEditField,
  onMarkEquivalent,
}: LlmErrorCardProps) {
  return (
    <Card className={cn(error.resolvedAt && "opacity-60")}>
      <CardContent className="space-y-2 pt-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium">{error.documentTitle}</p>
            <div className="flex items-center gap-1.5">
              <code className="text-xs font-mono text-muted-foreground/70">
                {error.fieldName}
              </code>
              {isCoordinator && onEditField && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-5 p-0"
                  onClick={onEditField}
                  title="Editar campo"
                >
                  <Pencil className="size-3" />
                </Button>
              )}
            </div>
            {error.fieldDescription && error.fieldDescription !== error.fieldName && (
              <p className="text-xs text-muted-foreground">
                {error.fieldDescription}
              </p>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground/70">
              <span>Revisado em {formatReviewedAt(error.reviewedAt)}</span>
              {error.schemaVersion && (
                <span>· schema v{error.schemaVersion}</span>
              )}
            </div>
          </div>
          {error.resolvedAt && (
            <Badge variant="secondary">Resolvido</Badge>
          )}
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="rounded-md bg-red-500/5 px-3 py-2">
            <p className="text-xs font-medium text-red-700">LLM respondeu:</p>
            <p className="text-sm">{error.llmAnswer || "(vazio)"}</p>
          </div>
          <div className="rounded-md bg-green-500/5 px-3 py-2">
            <p className="text-xs font-medium text-green-700">Escolhido:</p>
            <p className="text-sm">
              {formatVerdictDisplay(error.chosenVerdict)}
            </p>
          </div>
        </div>

        {error.llmJustification && (
          <div className="rounded-md bg-muted/40 px-3 py-2">
            <p className="text-xs font-medium text-muted-foreground">
              Justificativa do LLM:
            </p>
            <p className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">
              {error.llmJustification}
            </p>
          </div>
        )}

        {error.reviewerComment && (
          <blockquote className="border-l-2 border-amber-500/50 pl-3 text-xs text-muted-foreground">
            <span className="font-medium">Comentário do revisor:</span>{" "}
            {error.reviewerComment}
          </blockquote>
        )}

        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" asChild title="Ver documento">
            <Link href={`/projects/${projectId}/analyze/code?doc=${error.documentId}`}>
              <FileText className="size-3.5" />
            </Link>
          </Button>
          {/* Só na Comparação: `markLlmEquivalent` grava em
              `response_equivalences`, e a classificação da auto-revisão lê
              apenas `provenance`/`final_verdict` de `field_reviews`. Ali o
              botão salvaria o par, mostraria o toast de sucesso e devolveria o
              mesmo erro intacto. O análogo correto naquele fluxo é um
              `self_verdict = 'equivalente'` — ver bdcdo/dataframeitGUI#705. */}
          {error.source === "comparacao" &&
            !error.resolvedAt &&
            onMarkEquivalent &&
            error.chosenResponseId && (
              <Button
                variant="ghost"
                size="sm"
                disabled={isPending}
                onClick={onMarkEquivalent}
                title="Marcar respostas como equivalentes"
              >
                <Equal className="size-3.5" />
              </Button>
            )}
          {error.resolvedAt ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={isPending}
              onClick={onReopen}
              title="Reabrir"
            >
              <RotateCcw className="size-3.5" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={isPending}
              onClick={onResolve}
              title="Resolver"
            >
              <CheckCircle2 className="size-3.5" />
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
