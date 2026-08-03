import { useMemo, useState } from "react";
import { smartRandomize, previewLottery } from "@/actions/assignments";
import type { LotteryParams } from "@/actions/assignments";
import {
  filterComparisonEligible,
  filterEligibleDocs,
  resolveWeight,
  resolveCap,
  resolveResearchersPerDoc,
  LOTTERY_EMPTY_MESSAGES,
  type LotteryEmptyReason,
  type LotteryFilters,
} from "@/lib/lottery-utils";
import { toast } from "sonner";
import type { LotteryMember, LotteryStats } from "./lottery-dialog-types";
import type { LotteryParamsState } from "./useLotteryParams";
import {
  capValue,
  isParticipant,
  weightValue,
} from "./lottery-participant-values";

function countEligibleDocs({
  stats,
  type,
  targetKind,
  filters,
}: {
  stats: LotteryStats | null;
  type: "codificacao" | "comparacao";
  targetKind: "current" | "new";
  filters: LotteryFilters;
}): number | null {
  if (!stats) return null;
  let candidates = targetKind === "new"
    ? stats.docs.map((doc) => ({
        ...doc,
        humanCodingCount: 0,
        hasLlmResponse: false,
        activeAssignments: { codificacao: 0, comparacao: 0 },
        hasAssignmentInCurrentRound: false,
        batchIds: [],
      }))
    : stats.docs;
  if (type === "comparacao") {
    candidates = filterComparisonEligible(
      candidates,
      stats.automationMode,
      stats.minResponsesForComparison,
    );
  }
  return filterEligibleDocs(candidates, type, filters).length;
}

function getOpenWorkBlockedMessage({
  stats,
  confirmActiveWork,
  confirmPendingScopeWork,
}: {
  stats: LotteryStats | null;
  confirmActiveWork: boolean;
  confirmPendingScopeWork: boolean;
}): string | null {
  const hasActiveWork = (stats?.activeOpenAssignmentCount ?? 0) > 0;
  if (hasActiveWork && !confirmActiveWork) {
    return "Confirme a abertura da nova rodada com trabalho ativo ainda aberto.";
  }
  const hasPendingScope = (stats?.pendingScopeAssignmentCount ?? 0) > 0;
  if (hasPendingScope && !confirmPendingScopeWork) {
    return "Confirme a abertura da nova rodada com documentos ainda em revisão de escopo.";
  }
  return null;
}

function getNewRoundBlockedMessage({
  stats,
  type,
  targetKind,
  roundLabel,
  confirmActiveWork,
  confirmPendingScopeWork,
}: {
  stats: LotteryStats | null;
  type: "codificacao" | "comparacao";
  targetKind: "current" | "new";
  roundLabel: string;
  confirmActiveWork: boolean;
  confirmPendingScopeWork: boolean;
}): string | null {
  if (targetKind !== "new") return null;
  if (type !== "codificacao") {
    return "Uma nova rodada começa com um sorteio de codificação.";
  }
  if (!roundLabel.trim()) return "Informe o nome da nova rodada.";
  return getOpenWorkBlockedMessage({
    stats,
    confirmActiveWork,
    confirmPendingScopeWork,
  });
}

function getLotteryConfigBlockedMessage({
  stats,
  newRoundMessage,
  participantCount,
  eligibleCount,
}: {
  stats: LotteryStats | null;
  newRoundMessage: string | null;
  participantCount: number;
  eligibleCount: number | null;
}): string | null {
  if (stats !== null && !stats.currentRoundId) {
    return "O projeto não tem uma rodada atual.";
  }
  if (newRoundMessage) return newRoundMessage;
  if (participantCount === 0) {
    return "Nenhum participante selecionado.";
  }
  if (eligibleCount === 0) {
    return "Nenhum documento passa nos filtros atuais.";
  }
  return null;
}

function isLotteryPreviewEnabled(
  stats: LotteryStats | null,
  configBlockedMessage: string | null,
): boolean {
  return stats !== null && configBlockedMessage === null;
}

function getLotteryBlockedMessage(
  configBlockedMessage: string | null,
  emptyReason: LotteryEmptyReason | undefined,
): string | null {
  if (configBlockedMessage) return configBlockedMessage;
  return emptyReason ? LOTTERY_EMPTY_MESSAGES[emptyReason] : null;
}

function isLotterySubmitEnabled(
  stats: LotteryStats | null,
  blockedMessage: string | null,
  previewTotal: number | undefined,
): boolean {
  if (!stats || blockedMessage) return false;
  return previewTotal !== 0;
}

async function runLotteryAction({
  enabled,
  blockedMessage,
  setRunning,
  action,
}: {
  enabled: boolean;
  blockedMessage: string | null;
  setRunning: (running: boolean) => void;
  action: () => Promise<void>;
}): Promise<void> {
  if (!enabled) {
    if (blockedMessage) toast.error(blockedMessage);
    return;
  }
  setRunning(true);
  try {
    await action();
  } finally {
    setRunning(false);
  }
}

// Derivações e ações do sorteio (elegibilidade, prévia, submit) sobre o
// estado do formulário (useLotteryParams). Lê os campos de `params`
// desestruturados — nunca o objeto inteiro em deps de memo, que é recriado
// a cada render do dialog.
export function useLotteryRun({
  projectId,
  members,
  stats,
  params,
  onLotteryDone,
}: {
  projectId: string;
  members: LotteryMember[];
  stats: LotteryStats | null;
  params: LotteryParamsState;
  // Chamado no sucesso do sorteio (fecha o dialog); a limpeza da prévia é
  // feita aqui dentro.
  onLotteryDone: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  const {
    type,
    targetKind,
    roundLabel,
    confirmActiveWork,
    confirmPendingScopeWork,
    researchersPerDoc,
    docsPerResearcherEnabled,
    docsPerResearcher,
    docSubsetEnabled,
    docSubsetSize,
    balancing,
    mode,
    codingsFilterMode,
    maxCodingsValue,
    assignmentFilter,
    batchFilterMode,
    batchExclude,
    batchOnly,
    manualEnabled,
    manualDocIds,
    participantOverrides,
    weightInputs,
    capInputs,
    label,
    previewState,
    setPreviewState,
  } = params;

  const participantIds = useMemo(
    () =>
      members
        .filter((m) => isParticipant(m, participantOverrides))
        .map((m) => m.userId),
    [members, participantOverrides],
  );

  // Peso/limite resolvido por participante ativo. Inclui TODOS os participantes
  // (peso 1 / sem limite explícito) para que o server persista o reset de quem
  // voltou ao default — não só quem está fora do padrão.
  const participantSettings = useMemo(() => {
    const out: Record<string, { weight: number; cap: number | null }> = {};
    for (const m of members) {
      if (!isParticipant(m, participantOverrides)) continue;
      const cStr = capValue(m, capInputs);
      out[m.userId] = {
        // Mesma coerção do server (resolveWeight/resolveCap) — fonte única.
        weight: resolveWeight(parseFloat(weightValue(m, weightInputs))),
        cap: resolveCap(cStr.trim() === "" ? null : parseInt(cStr, 10)),
      };
    }
    return out;
  }, [members, participantOverrides, weightInputs, capInputs]);

  const isComparacao = type === "comparacao";

  // Derivado no render, nunca por effect: o state segue 2 (o default correto da
  // codificação) e é simplesmente ignorado em comparação. Trocar de tipo não
  // "herda" valor porque nada é herdado — e voltar para codificação restaura o
  // que o coordenador tinha digitado. Mesma função pura do server (#490).
  const researchersPerDocEffective = resolveResearchersPerDoc(
    type,
    researchersPerDoc,
  );

  const filters = useMemo<LotteryFilters>(() => {
    const f: LotteryFilters = {};
    if (codingsFilterMode === "none") f.maxHumanCodings = 0;
    else if (codingsFilterMode === "atMost") f.maxHumanCodings = maxCodingsValue;
    if (assignmentFilter !== "any") f.assignmentFilter = assignmentFilter;
    if (batchFilterMode === "only" && batchOnly) {
      f.batchFilter = { only: batchOnly };
    } else if (batchFilterMode === "exclude" && batchExclude.length) {
      f.batchFilter = { exclude: batchExclude };
    }
    if (manualEnabled) f.manualDocIds = Array.from(manualDocIds);
    return f;
  }, [
    codingsFilterMode,
    maxCodingsValue,
    assignmentFilter,
    batchFilterMode,
    batchOnly,
    batchExclude,
    manualEnabled,
    manualDocIds,
  ]);

  // Prévia + semente (research D13): a seed da última prévia é reaproveitada
  // ao sortear; a prévia é guardada junto da configuração que a gerou, então
  // qualquer mudança de configuração a invalida (e à seed) por derivação.
  // O rótulo do lote fica de fora: não afeta o resultado e é lido em
  // buildParams. O alvo e o nome da rodada entram porque mudam a operação.
  const configKey = JSON.stringify({
    type,
    targetKind,
    currentRoundId: stats?.currentRoundId ?? null,
    roundLabel: targetKind === "new" ? roundLabel.trim() : null,
    researchersPerDoc: researchersPerDocEffective,
    docsPerResearcherEnabled,
    docsPerResearcher,
    docSubsetEnabled,
    docSubsetSize,
    mode,
    balancing,
    filters,
    participantIds,
    participantSettings,
  });
  const preview = previewState?.key === configKey ? previewState.preview : null;
  const seed = preview?.seed ?? null;

  // Contagem de elegíveis ao vivo, com a mesma função pura do server
  const eligibleCount = useMemo(
    () => countEligibleDocs({ stats, type, targetKind, filters }),
    [stats, type, filters, targetKind],
  );

  const newRoundMessage = getNewRoundBlockedMessage({
    stats,
    type,
    targetKind,
    roundLabel,
    confirmActiveWork,
    confirmPendingScopeWork,
  });
  const configBlockedMessage = getLotteryConfigBlockedMessage({
    stats,
    newRoundMessage,
    participantCount: participantIds.length,
    eligibleCount,
  });
  const blockedMessage = getLotteryBlockedMessage(
    configBlockedMessage,
    preview?.emptyReason,
  );

  const canPreview = isLotteryPreviewEnabled(stats, configBlockedMessage);
  const canSubmit = isLotterySubmitEnabled(
    stats,
    blockedMessage,
    preview?.totalNew,
  );

  const buildParams = (withSeed: boolean): LotteryParams => {
    const base = {
      projectId,
      mode,
      balancing,
      seed: withSeed && seed !== null ? seed : undefined,
      docsPerResearcher: docsPerResearcherEnabled
        ? docsPerResearcher
        : undefined,
      docSubsetSize: docSubsetEnabled ? docSubsetSize : undefined,
      label: label || undefined,
      filters,
      participantIds,
      participantSettings,
      target: targetKind === "new"
        ? {
            kind: "new" as const,
            expectedRoundId: stats?.currentRoundId ?? "",
            roundLabel: roundLabel.trim(),
            confirmActiveWork,
            confirmPendingScopeWork,
          }
        : {
            kind: "current" as const,
            expectedRoundId: stats?.currentRoundId ?? "",
          },
    };
    // A união discriminada não tem researchersPerDoc no braço de comparação —
    // um revisor por documento é a regra, não uma configuração.
    return type === "comparacao"
      ? { ...base, type: "comparacao" }
      : { ...base, type: "codificacao", researchersPerDoc: researchersPerDocEffective };
  };

  const handlePreview = () =>
    runLotteryAction({
      enabled: canPreview,
      blockedMessage: configBlockedMessage,
      setRunning: setPreviewing,
      action: async () => {
        const result = await previewLottery(buildParams(false));
        if (result.error) {
          toast.error(result.error);
        } else if (result.preview) {
          setPreviewState({ key: configKey, preview: result.preview });
        }
      },
    });

  const handleRandomize = () =>
    runLotteryAction({
      enabled: canSubmit,
      blockedMessage,
      setRunning: setLoading,
      action: async () => {
        const result = await smartRandomize(buildParams(true));
        if (result.error) {
          toast.error(result.error);
        } else {
          toast.success(
            `${result.count} novas atribuições criadas! (${result.preserved} preservadas)`
          );
          setPreviewState(null);
          onLotteryDone();
        }
      },
    });

  const docsConsidered =
    eligibleCount === null
      ? null
      : docSubsetEnabled
        ? Math.min(docSubsetSize, eligibleCount)
        : eligibleCount;

  const estimatedPerParticipant =
    docsConsidered !== null && participantIds.length > 0
      ? Math.ceil(
          (docsConsidered * researchersPerDocEffective) / participantIds.length,
        )
      : 0;

  return {
    isComparacao,
    participantCount: participantIds.length,
    eligibleCount,
    blockedMessage,
    canPreview,
    canSubmit,
    preview,
    estimatedPerParticipant,
    previewing,
    loading,
    handlePreview,
    handleRandomize,
  };
}
