// Tipos compartilhados entre o LotteryDialog, seus hooks e as seções
// extraídas — módulo próprio para evitar import circular (padrão
// compare-types.ts).

import type { LotteryDocStats } from "@/lib/lottery-utils";

export interface LotteryMember {
  userId: string;
  name: string;
  role: "pesquisador" | "coordenador";
  // Pré-registrado (spec 002): ainda não criou conta.
  pending?: boolean;
  // Defaults de carga persistidos (último sorteio): peso relativo e limite
  // individual de docs. Pré-preenchem os campos por participante.
  weight?: number;
  cap?: number | null;
}

export interface LotteryStats {
  docs: LotteryDocStats[];
  batches: { id: string; label: string | null; createdAt: string }[];
  minResponsesForComparison: number;
  automationMode: string | null;
  currentRoundId?: string | null;
  currentRoundLabel?: string | null;
  openAssignmentCount?: number;
}

export type CodingsFilterMode = "all" | "none" | "atMost";
