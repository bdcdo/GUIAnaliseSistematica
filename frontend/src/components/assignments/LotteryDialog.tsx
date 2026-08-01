"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import type { LotteryMode } from "@/lib/lottery-utils";
import type { LotteryMember } from "./lottery-dialog-types";
import { useLotteryStats } from "./useLotteryStats";
import { useLotteryParams } from "./useLotteryParams";
import { useLotteryRun } from "./useLotteryRun";
import { LotteryEligibilitySection } from "./LotteryEligibilitySection";
import {
  LotteryDistributionSection,
  type LotterySummary,
} from "./LotteryDistributionSection";
import { LotteryParticipantsSection } from "./LotteryParticipantsSection";
import { LotteryPreviewSection } from "./LotteryPreviewSection";

interface LotteryDialogProps {
  projectId: string;
  members: LotteryMember[];
}

export function LotteryDialog({ projectId, members }: LotteryDialogProps) {
  const [open, setOpen] = useState(false);

  const { stats, statsError } = useLotteryStats(projectId, open);

  const params = useLotteryParams();
  const {
    type, setType, targetKind, setTargetKind, roundLabel, setRoundLabel,
    confirmOpenWork, setConfirmOpenWork, mode, setMode, label, setLabel,
    setPreviewState,
  } = params;

  const {
    isComparacao,
    participantCount,
    eligibleCount,
    blockedMessage,
    canSubmit,
    preview,
    estimatedPerParticipant,
    previewing,
    loading,
    handlePreview,
    handleRandomize,
  } = useLotteryRun({
    projectId,
    members,
    stats,
    params,
    onLotteryDone: () => setOpen(false),
  });

  const summary: LotterySummary = blockedMessage
    ? { kind: "blocked", message: blockedMessage }
    : stats === null
      ? statsError
        ? { kind: "error" }
        : { kind: "loading" }
      : {
          kind: "ready",
          eligibleCount: eligibleCount ?? 0,
          participantCount,
          estimatedPerParticipant,
        };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setPreviewState(null);
      }}
    >
      <DialogTrigger asChild>
        <Button className="bg-brand hover:bg-brand/90 text-brand-foreground">
          Sortear
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Sortear {isComparacao ? "Comparações" : "Atribuições"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          {/* Tipo do sorteio */}
          <div>
            <Label>Tipo</Label>
            <RadioGroup
              value={type}
              onValueChange={(v) => {
                const nextType = v as "codificacao" | "comparacao";
                setType(nextType);
                if (nextType === "comparacao") setTargetKind("current");
              }}
              className="mt-2 flex gap-4"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="codificacao" id="type-cod" />
                <Label htmlFor="type-cod" className="font-normal">
                  Codificação
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="comparacao" id="type-comp" />
                <Label htmlFor="type-comp" className="font-normal">
                  Comparação
                </Label>
              </div>
            </RadioGroup>
            {isComparacao && (
              <p className="mt-2 text-xs text-muted-foreground">
                {stats?.automationMode === "compare_llm"
                  ? "Elegíveis: documentos com ao menos 1 codificação humana e 1 resposta do LLM."
                  : `Elegíveis: documentos com ao menos ${stats?.minResponsesForComparison ?? 2} codificações humanas.`}
              </p>
            )}
          </div>

          <Separator />

          <div className="space-y-2">
            <Label>Rodada</Label>
            <RadioGroup
              value={targetKind}
              onValueChange={(value) => {
                setTargetKind(value as "current" | "new");
                setConfirmOpenWork(false);
              }}
              className="space-y-1"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="current" id="round-current" />
                <Label htmlFor="round-current" className="font-normal">
                  Rodada atual{stats?.currentRoundLabel ? ` — ${stats.currentRoundLabel}` : ""}
                </Label>
              </div>
              {!isComparacao && (
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="new" id="round-new" />
                  <Label htmlFor="round-new" className="font-normal">Iniciar nova rodada</Label>
                </div>
              )}
            </RadioGroup>
            {targetKind === "new" && (
              <div className="space-y-2 pt-1">
                <Input
                  aria-label="Nome da nova rodada"
                  placeholder="Ex: Segunda rodada"
                  value={roundLabel}
                  onChange={(event) => setRoundLabel(event.target.value)}
                />
                {(stats?.openAssignmentCount ?? 0) > 0 && (
                  <div className="flex items-start gap-2 rounded-md border p-3">
                    <Checkbox
                      id="confirm-open-work"
                      checked={confirmOpenWork}
                      onCheckedChange={(checked) => setConfirmOpenWork(checked === true)}
                    />
                    <Label htmlFor="confirm-open-work" className="font-normal leading-snug">
                      Confirmo iniciar a nova rodada apesar de {stats?.openAssignmentCount} atribuições em andamento ou pendentes na rodada atual.
                    </Label>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  As respostas anteriores ficam no histórico; os documentos começam sem respostas nesta rodada.
                </p>
              </div>
            )}
          </div>

          <Separator />

          {/* Label */}
          <div>
            <Label htmlFor="batch-label">Rótulo (opcional)</Label>
            <Input
              id="batch-label"
              placeholder="Ex: Lote 1"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="mt-1"
            />
          </div>

          <Separator />

          <LotteryEligibilitySection params={params} stats={stats} />

          <Separator />

          {/* Section: Pending assignments mode (US2) */}
          <div className="space-y-2">
            <h4 className="text-sm font-semibold">Atribuições pendentes</h4>
            <RadioGroup
              value={mode}
              onValueChange={(v) => setMode(v as LotteryMode)}
              className="space-y-1"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="append" id="mode-append" />
                <Label htmlFor="mode-append" className="font-normal">
                  Acrescentar ao existente
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="replace" id="mode-replace" />
                <Label htmlFor="mode-replace" className="font-normal">
                  Substituir pendentes
                </Label>
              </div>
            </RadioGroup>
            <p className="text-xs text-muted-foreground">
              {mode === "append"
                ? "As atribuições pendentes existentes são preservadas; o sorteio só adiciona novas."
                : `As atribuições pendentes de ${isComparacao ? "comparação" : "codificação"} são descartadas e redistribuídas. Em andamento e concluídas nunca são tocadas.`}
            </p>
          </div>

          <Separator />

          <LotteryDistributionSection
            params={params}
            membersCount={members.length}
            summary={summary}
          />

          {members.length > 0 && (
            <>
              <Separator />
              <LotteryParticipantsSection members={members} params={params} />
            </>
          )}

          <Separator />

          <LotteryPreviewSection
            preview={preview}
            members={members}
            run={{
              previewing,
              loading,
              canSubmit,
              onPreview: () => void handlePreview(),
              onRandomize: () => void handleRandomize(),
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
