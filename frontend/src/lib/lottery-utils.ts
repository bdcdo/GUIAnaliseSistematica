// Primitivas puras do sorteio de atribuições (spec 001), compartilhadas
// entre o client (contagem ao vivo no LotteryDialog) e o server
// (computeLottery) — fonte única de verdade da elegibilidade, no padrão
// anti-drift de schema-utils.ts (cf. #63).

export type LotteryMode = "append" | "replace";
export type LotteryBalancing = "round" | "history";
export type AssignmentFilter = "any" | "noActiveOfType" | "neverAssigned";
export type LotteryEmptyReason =
  | "all_slots_filled"
  | "capacity_exhausted"
  | "no_available_pairs";

export const LOTTERY_EMPTY_MESSAGES: Record<LotteryEmptyReason, string> = {
  all_slots_filled:
    "Todos os documentos selecionados já têm o número solicitado de atribuições nesta rodada. Para redistribuir o trabalho, inicie uma nova rodada.",
  capacity_exhausted:
    "Os participantes selecionados atingiram os limites de documentos configurados. Aumente ou remova os limites para continuar.",
  no_available_pairs:
    "Não há novos pares possíveis entre os documentos e participantes selecionados. Revise os participantes ou inicie uma nova rodada.",
};

export interface LotteryFilters {
  /** undefined = todos; 0 = sem nenhuma codificação; N = no máximo N */
  maxHumanCodings?: number;
  /** default "any" */
  assignmentFilter?: AssignmentFilter;
  batchFilter?: { exclude?: string[]; only?: string };
  manualDocIds?: string[];
}

export interface LotteryDocStats {
  id: string;
  externalId: string | null;
  title: string | null;
  /** respondentes humanos distintos com resposta is_latest */
  humanCodingCount: number;
  /** existe ao menos uma resposta LLM is_latest para o doc */
  hasLlmResponse: boolean;
  /** pendente + em_andamento, por tipo */
  activeAssignments: { codificacao: number; comparacao: number };
  /** existe ao menos uma atribuição do documento na rodada atual */
  hasAssignmentInCurrentRound: boolean;
  batchIds: string[];
}

export interface LotteryParticipant {
  id: string;
  /** atribuições do tipo no conjunto preservado do modo */
  accumulatedLoad: number;
  /** teto de docs NOVOS neste sorteio (ver computeCapacity), ou Infinity */
  capacity: number;
  /**
   * Peso relativo de carga (default 1). A chave de distribuição é load/weight,
   * então peso 0.5 recebe ~metade dos docs de um peso 1. Ausente/≤0 → 1.
   */
  weight?: number;
}

/**
 * Peso efetivo de carga: ausente, NaN, zero ou negativo caem para 1 (neutro).
 * Centraliza a regra usada no cliente (LotteryDialog), no server
 * (computeLottery e persistência) e em distributeDocs — evita drift (#63).
 */
export function resolveWeight(weight?: number | null): number {
  return weight != null && Number.isFinite(weight) && weight > 0 ? weight : 1;
}

/**
 * Limite efetivo de docs NOVOS por participante: ausente, NaN, zero ou
 * negativo → null (sem limite individual). Caso contrário, truncado para
 * inteiro — a coluna assignment_cap é INTEGER.
 */
export function resolveCap(cap?: number | null): number | null {
  return cap != null && Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : null;
}

/**
 * Capacidade de docs NOVOS de um participante neste sorteio (o teto duro de
 * distributeDocs). Compõe dois limites e vence o menor:
 *  - docsPerResearcher é teto TOTAL (acumulado + novos) — convertido aqui em
 *    slots novos restantes (`docsPerResearcher - accumulatedLoad`);
 *  - cap é teto direto de docs NOVOS, independente da carga acumulada.
 * Ausência de ambos → Infinity (sem limite). Pura.
 */
export function computeCapacity(opts: {
  accumulatedLoad: number;
  docsPerResearcher?: number | null;
  cap?: number | null;
}): number {
  const { accumulatedLoad, docsPerResearcher, cap } = opts;
  const limits: number[] = [];
  if (docsPerResearcher) {
    limits.push(Math.max(0, docsPerResearcher - accumulatedLoad));
  }
  const resolvedCap = resolveCap(cap);
  if (resolvedCap != null) limits.push(resolvedCap);
  return limits.length ? Math.min(...limits) : Infinity;
}

/**
 * Gate de elegibilidade do sorteio de COMPARAÇÃO, derivado do modo de
 * automação do projeto (projects.automation_mode). Espelha o *critério de
 * elegibilidade* do gatilho que cria a comparação automática
 * (createAutoComparisonIfDiverges em lib/auto-comparison.ts) — quem é candidato
 * a virar comparação — mas NÃO a condição de divergência: o sorteio manual
 * libera por presença de respostas, de propósito, justamente para distribuir a
 * revisão que a automação não cobriu (não exige que os codificadores divirjam).
 *   - compare_llm    → 1 humano + resposta do LLM (a 2ª resposta é o LLM)
 *   - demais modos   → min_responses_for_comparison humanos (piso de 1)
 * Compõe ANTES de filterEligibleDocs (que não recebe esse limiar). `mode` é
 * string solta de propósito: tolera o valor null/legado de projetos antes da
 * migration do automation_mode, sem depender de types.ts.
 */
export function filterComparisonEligible(
  docs: LotteryDocStats[],
  mode: string | null | undefined,
  minResponsesForComparison: number,
): LotteryDocStats[] {
  if (mode === "compare_llm") {
    return docs.filter((d) => d.humanCodingCount >= 1 && d.hasLlmResponse);
  }
  // Piso de 1 humano mesmo se min_responses for 0/inválido — simetria com
  // compareDefaultsForMode (compare-filters.ts, #219): comparação sem nenhum
  // humano não faz sentido.
  const minHumans = Math.max(1, minResponsesForComparison);
  return docs.filter((d) => d.humanCodingCount >= minHumans);
}

/**
 * Um revisor de comparação por documento: o veredito é ato de desempate único,
 * não codificação em dupla (a dupla independente é da CODIFICAÇÃO). Dois
 * revisores no mesmo documento não seriam dupla checagem, e sim um segundo
 * desempate sem regra de precedência (issue #490).
 */
const COMPARISON_REVIEWERS_PER_DOC = 1;

/**
 * Revisores/pesquisadores por documento EFETIVO do sorteio. Fonte única da
 * regra, compartilhada pelo client (estimativa/configKey/buildParams) e pelo
 * server (computeLottery) para que os dois não possam divergir — mesmo motivo
 * das primitivas puras de schema-utils.ts (#63).
 *
 * Para comparação o valor pedido é IGNORADO, não validado: a Server Action é
 * endpoint HTTP público e este projeto não valida payload com zod, então o
 * server não pode confiar no client. Espelhado no banco pelo índice
 * assignments_one_active_comparacao_per_doc.
 */
export function resolveResearchersPerDoc(
  type: "codificacao" | "comparacao",
  requested?: number | null,
): number {
  if (type === "comparacao") return COMPARISON_REVIEWERS_PER_DOC;
  return requested != null && Number.isFinite(requested) && requested >= 1
    ? Math.floor(requested)
    : 1;
}

/**
 * Pipeline de elegibilidade — interseção em ordem fixa (data-model.md):
 * ativos (garantido no fetch) → manual → codificações → status de
 * atribuição → lote. A exigência mínima de respostas para comparação é
 * aplicada antes, no server, e compõe com estes filtros (FR-011).
 */
export function filterEligibleDocs(
  docs: LotteryDocStats[],
  type: "codificacao" | "comparacao",
  filters: LotteryFilters,
): LotteryDocStats[] {
  let result = docs;

  if (filters.manualDocIds) {
    const manual = new Set(filters.manualDocIds);
    result = result.filter((d) => manual.has(d.id));
  }

  if (filters.maxHumanCodings !== undefined) {
    result = result.filter((d) => d.humanCodingCount <= filters.maxHumanCodings!);
  }

  const assignmentFilter = filters.assignmentFilter ?? "any";
  if (assignmentFilter === "noActiveOfType") {
    result = result.filter((d) => d.activeAssignments[type] === 0);
  } else if (assignmentFilter === "neverAssigned") {
    result = result.filter((d) => !d.hasAssignmentInCurrentRound);
  }

  if (filters.batchFilter?.only) {
    const only = filters.batchFilter.only;
    result = result.filter((d) => d.batchIds.includes(only));
  } else if (filters.batchFilter?.exclude?.length) {
    const excluded = new Set(filters.batchFilter.exclude);
    result = result.filter((d) => !d.batchIds.some((b) => excluded.has(b)));
  }

  return result;
}

/**
 * PRNG seedado (mulberry32) — toda a aleatoriedade do sorteio deriva dele,
 * permitindo que a prévia e a execução compartilhem a semente e produzam
 * o mesmo resultado (research D13, FR-013/SC-005).
 */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates com RNG injetável; não muta o array de entrada. */
export function shuffleWithRng<T>(arr: T[], rng: () => number): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Núcleo da distribuição do sorteio (research D12). Para cada documento
 * (em ordem embaralhada), cada vaga é dada ao candidato de menor chave
 * composta: carga corrente do modo de equilíbrio dividida pelo peso do
 * participante (`round`: só as novas deste sorteio; `history`: acumulada +
 * novas) → co-ocorrência com quem já está no documento (variação de duplas,
 * FR-014) → aleatório (candidatos embaralhados antes do sort estável — a
 * ordem do array de participantes nunca decide, FR-019). O peso (default 1)
 * escala a carga: quem tem peso 0.5 atinge a mesma chave com metade dos docs,
 * recebendo ~metade; o teto duro continua sendo `capacity`. Carga e
 * co-ocorrência são atualizadas a cada atribuição. Pura: não muta os inputs.
 */
export function distributeDocs(
  eligibleDocIds: string[],
  participants: LotteryParticipant[],
  options: {
    researchersPerDoc: number;
    balancing: LotteryBalancing;
    /** pares "docId:userId" já existentes (anti-duplicidade) */
    preservedPairs: Set<string>;
    /** usuários preservados por doc */
    docAssignedUsers: Record<string, string[]>;
    coOccurrence: Record<string, Record<string, number>>;
    rng: () => number;
  },
): { document_id: string; user_id: string }[] {
  const { researchersPerDoc, balancing, preservedPairs, docAssignedUsers, rng } = options;

  const accumulated: Record<string, number> = {};
  const newLoad: Record<string, number> = {};
  const remaining: Record<string, number> = {};
  const weight: Record<string, number> = {};
  for (const p of participants) {
    accumulated[p.id] = p.accumulatedLoad;
    newLoad[p.id] = 0;
    remaining[p.id] = p.capacity;
    // Peso ausente, zero ou negativo cai para 1 (neutro) — a UI valida > 0;
    // deselecionar o participante é o caminho para "peso zero".
    weight[p.id] = resolveWeight(p.weight);
  }

  // Cópia local da matriz para preservar a pureza da função
  const coOccurrence: Record<string, Record<string, number>> = {};
  for (const p of participants) {
    coOccurrence[p.id] = { ...(options.coOccurrence[p.id] || {}) };
  }

  const result: { document_id: string; user_id: string }[] = [];

  for (const docId of shuffleWithRng(eligibleDocIds, rng)) {
    const preservedOnDoc = docAssignedUsers[docId] || [];
    // Set para lookup O(1) no filtro do while (preservedOnDoc é constante no
    // escopo deste docId).
    const preservedSet = new Set(preservedOnDoc);
    const newOnDoc = new Set<string>();
    let need = researchersPerDoc - preservedOnDoc.length;

    while (need > 0) {
      const alreadyOnDoc = [...preservedOnDoc, ...newOnDoc];
      const candidates = participants.filter(
        (p) =>
          remaining[p.id] > 0 &&
          !newOnDoc.has(p.id) &&
          !preservedSet.has(p.id) &&
          !preservedPairs.has(`${docId}:${p.id}`),
      );
      if (!candidates.length) break;

      const scored = shuffleWithRng(candidates, rng).map((p) => ({
        id: p.id,
        load:
          (balancing === "round"
            ? newLoad[p.id]
            : accumulated[p.id] + newLoad[p.id]) / weight[p.id],
        coScore: alreadyOnDoc.reduce(
          (sum, uid) => sum + (coOccurrence[p.id]?.[uid] || 0),
          0,
        ),
      }));
      scored.sort((a, b) => a.load - b.load || a.coScore - b.coScore);

      const chosen = scored[0].id;
      result.push({ document_id: docId, user_id: chosen });
      newLoad[chosen]++;
      remaining[chosen]--;
      for (const uid of alreadyOnDoc) {
        if (coOccurrence[chosen]) coOccurrence[chosen][uid] = (coOccurrence[chosen][uid] || 0) + 1;
        if (coOccurrence[uid]) coOccurrence[uid][chosen] = (coOccurrence[uid][chosen] || 0) + 1;
      }
      newOnDoc.add(chosen);
      need--;
    }
  }

  return result;
}
