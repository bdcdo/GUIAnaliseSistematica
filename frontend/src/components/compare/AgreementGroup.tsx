"use client";

import { useMemo, useState, useTransition } from "react";
import {
  AnswerCard,
  type EquivalenceMode,
  type EquivalentVariant,
} from "./AnswerCard";
import { PendingConfirmBar } from "./PendingConfirmBar";
import type { PendingVerdict } from "./compare-types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { normalizeForComparison } from "@/lib/utils";
import { formatPartialDate } from "@/lib/date-parts";
import {
  buildResponseGroupKeys,
} from "@/lib/equivalence";
import { HelpCircle, Link2 } from "lucide-react";

interface AgreementResponse {
  id: string;
  respondent_type: "humano" | "llm";
  respondent_name: string;
  answer: unknown;
  justification?: string;
  is_latest: boolean;
  isFieldStale: boolean;
  schemaVersion?: string | null;
}

export interface FieldEquivalencePair {
  id: string;
  response_a_id: string;
  response_b_id: string;
  reviewer_id: string | null;
  response_a_answer_snapshot: unknown;
  response_b_answer_snapshot: unknown;
}

function compareVersionsDesc(a: string, b: string): number {
  const [am, an, ap] = a.split(".").map((n) => Number.parseInt(n, 10));
  const [bm, bn, bp] = b.split(".").map((n) => Number.parseInt(n, 10));
  if (am !== bm) return bm - am;
  if (an !== bn) return bn - an;
  return bp - ap;
}

interface ExistingVerdict {
  verdict: string;
  chosenResponseId: string | null;
  comment: string | null;
}

interface AgreementGroupProps {
  readOnly: boolean;
  responses: AgreementResponse[];
  existingVerdict: ExistingVerdict | null;
  pendingVerdict: PendingVerdict | null;
  onVote: (displayAnswer: string, chosenResponseId: string) => void;
  allowEquivalence: boolean;
  equivalences: FieldEquivalencePair[];
  onConfirmEquivalent?: (
    responseIds: string[],
    gabaritoId: string,
    verdictDisplay: string,
  ) => Promise<void>;
  onUnmarkPair?: (pairId: string) => Promise<void>;
  currentUserId: string;
  canManageAnyPair: boolean;
  // Confirmação do rascunho, montada DENTRO do card que o produziu (#610).
  // Obrigatória, não opcional: opcional convida a esquecer a fiação num sítio
  // novo e falhar em silêncio — sem barra em lugar nenhum, com a navegação
  // travada pelo rascunho pendente. Erro de compilação é o modo de falha certo.
  pendingConfirm: {
    onConfirm: () => void;
    onDiscard: () => void;
    isSaving: boolean;
  };
}

function formatAnswer(answer: unknown): string {
  if (answer == null) return "";
  if (typeof answer === "string") return formatPartialDate(answer.trim());
  if (Array.isArray(answer))
    return answer.map((v) => (typeof v === "string" ? v.trim() : v)).join(", ");
  if (typeof answer === "object") {
    const obj = answer as Record<string, unknown>;
    return Object.entries(obj)
      .filter(([, v]) => v != null && String(v).trim() !== "")
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
  }
  return String(answer);
}

interface RenderedGroup {
  groupKey: string;
  displayAnswer: string;
  responses: AgreementResponse[];
  variants: EquivalentVariant[];
}

/**
 * Tudo que um card precisa saber sobre o seu grupo e que não é decisão de
 * interação: quem respondeu, o que está velho, se este é o grupo escolhido no
 * veredito anterior e se é o do rascunho atual.
 *
 * Função pura fora do `.map()` porque o callback do map era o sítio onde essas
 * seis derivações se somavam aos ternários do JSX — e o `confirmSlot` foi a
 * gota que o levou acima do limiar de complexidade. Separa também dois assuntos
 * que só coincidiam por estarem na mesma linha: fatos do grupo aqui,
 * affordances de seleção em `equivalenceModeFor`.
 */
function describeGroup(
  group: RenderedGroup,
  existingVerdict: ExistingVerdict | null,
  pendingVerdict: PendingVerdict | null,
) {
  return {
    hasLlm: group.responses.some((r) => r.respondent_type === "llm"),
    llmJustification: group.responses.find((r) => r.respondent_type === "llm")
      ?.justification,
    staleCount: group.responses.filter((r) => r.isFieldStale).length,
    isChosen: group.responses.some(
      (r) => r.id === existingVerdict?.chosenResponseId,
    ),
    // O rascunho aponta para UMA resposta, mas o card representa o grupo
    // inteiro: respostas fundidas por equivalência compartilham o card, então a
    // pertinência é ao grupo, não à resposta clicada.
    isPending:
      pendingVerdict?.kind === "response" &&
      group.responses.some((r) => r.id === pendingVerdict.chosenResponseId),
    versions: Array.from(
      new Set(
        group.responses
          .map((r) => r.schemaVersion)
          .filter((v): v is string => !!v),
      ),
    ).toSorted(compareVersionsDesc),
  };
}

/**
 * Affordances de equivalência de um card quando o modo está permitido. O tipo
 * de retorno é anotado de propósito: sem ele a inferência alarga `selected: true`
 * para `boolean` e a união discriminada do `AnswerCard` — que torna o gabarito
 * num card não selecionado irrepresentável — deixa de valer aqui.
 */
function equivalenceModeFor({
  isSelected,
  showGabarito,
  isGabarito,
  onToggle,
  onSetGabarito,
}: {
  isSelected: boolean;
  showGabarito: boolean;
  isGabarito: boolean;
  onToggle: () => void;
  onSetGabarito: () => void;
}): EquivalenceMode {
  if (!isSelected) return { selected: false, onToggle };
  return {
    selected: true,
    onToggle,
    gabarito: showGabarito ? { isGabarito, onSetGabarito } : null,
  };
}

export function AgreementGroup({
  readOnly,
  responses,
  existingVerdict,
  pendingVerdict,
  onVote,
  allowEquivalence,
  equivalences,
  onConfirmEquivalent,
  onUnmarkPair,
  currentUserId,
  canManageAnyPair,
  pendingConfirm,
}: AgreementGroupProps) {
  // Track selection order so the first selected card is the default gabarito.
  const [selectionOrder, setSelectionOrder] = useState<string[]>([]);
  const [gabaritoOverride, setGabaritoOverride] = useState<string | null>(null);
  const [isSubmitting, startTransition] = useTransition();

  const groups = useMemo<RenderedGroup[]>(() => {
    const present = responses.filter((r) => r.answer !== undefined);
    const groupKeys = buildResponseGroupKeys(present, equivalences, (r) =>
      normalizeForComparison(r.answer),
    );

    const map = new Map<string, RenderedGroup>();
    for (const r of present) {
      const key = groupKeys.get(r.id) ?? r.id;
      if (!map.has(key)) {
        map.set(key, {
          groupKey: key,
          displayAnswer: formatAnswer(r.answer),
          responses: [],
          variants: [],
        });
      }
      map.get(key)!.responses.push(r);
    }

    for (const group of map.values()) {
      const idsInGroup = new Set(group.responses.map((r) => r.id));
      const respondentById = new Map(
        group.responses.map((r) => [r.id, r] as const),
      );
      for (const p of equivalences) {
        if (idsInGroup.has(p.response_a_id) && idsInGroup.has(p.response_b_id)) {
          const a = respondentById.get(p.response_a_id);
          const b = respondentById.get(p.response_b_id);
          if (a && b) {
            group.variants.push({
              pairId: p.id,
              reviewerId: p.reviewer_id,
              respondentName: `${a.respondent_name} ↔ ${b.respondent_name}`,
              answerDisplay: `${formatAnswer(a.answer)} · ${formatAnswer(b.answer)}`,
            });
          }
        }
      }
    }

    return Array.from(map.values()).toSorted(
      (a, b) => b.responses.length - a.responses.length,
    );
  }, [responses, equivalences]);

  // Stale selection entries (groups that disappeared after a navigation or
  // server-side fusion) are silently filtered out here; we don't need an
  // effect to clear them because they're never visible in the UI.
  // The parent (ComparisonPanel) keys this component by field+doc, so a
  // navigation also remounts and resets selection state naturally.
  const selectedGroups = selectionOrder
    .map((key) => groups.find((g) => g.groupKey === key))
    .filter((g): g is RenderedGroup => !!g);

  // Consultado uma vez por grupo renderizado; como array seria O(grupos²).
  const selectionSet = new Set(selectionOrder);
  const showGabarito = selectedGroups.length >= 2;
  const effectiveGabarito =
    gabaritoOverride && selectionOrder.includes(gabaritoOverride)
      ? gabaritoOverride
      : (selectionOrder[0] ?? null);

  // Os dois setters ficam no nível do handler: um `setGabaritoOverride`
  // aninhado no updater de `setSelectionOrder` seria efeito colateral dentro de
  // função que React pode reexecutar. `selectionOrder` do closure basta para
  // decidir o ramo — só o clique altera a seleção.
  function toggleSelection(groupKey: string) {
    const isDeselecting = selectionOrder.includes(groupKey);
    if (isDeselecting) {
      setSelectionOrder((prev) => prev.filter((k) => k !== groupKey));
      if (gabaritoOverride === groupKey) setGabaritoOverride(null);
      return;
    }
    setSelectionOrder((prev) => [...prev, groupKey]);
  }

  function handleConfirm() {
    if (!onConfirmEquivalent) return;
    if (selectedGroups.length < 2 || !effectiveGabarito) return;
    const gabaritoGroup = selectedGroups.find(
      (g) => g.groupKey === effectiveGabarito,
    );
    if (!gabaritoGroup) return;
    const gabaritoResponseId = gabaritoGroup.responses[0].id;
    // Send only one representative per group: responses sharing the same
    // literal answer are already fused server-side via same-answer fusion,
    // so adding redundant intra-group pairs would just create useless rows.
    const responseIds = selectedGroups.map((g) => g.responses[0].id);
    const verdictDisplay = gabaritoGroup.displayAnswer;
    startTransition(async () => {
      await onConfirmEquivalent(responseIds, gabaritoResponseId, verdictDisplay);
      setSelectionOrder([]);
      setGabaritoOverride(null);
    });
  }

  // "Todas são similares" (issue #247, ponto 5): pré-seleciona TODOS os grupos
  // de uma vez, em vez de o revisor marcar par a par. A persistência continua no
  // botão explícito de confirmação de equivalência abaixo, inclusive quando há
  // maioria clara.
  function handleConfirmAll() {
    if (!onConfirmEquivalent) return;
    if (groups.length < 2) return;
    setSelectionOrder(groups.map((g) => g.groupKey));
    setGabaritoOverride(null);
  }

  function handleUnmark(pairId: string) {
    if (!onUnmarkPair) return;
    startTransition(async () => {
      await onUnmarkPair(pairId);
    });
  }

  const gabaritoLabel = (() => {
    if (!effectiveGabarito) return "";
    const g = selectedGroups.find((s) => s.groupKey === effectiveGabarito);
    return g?.displayAnswer ?? "";
  })();

  const selectedResponseCount = selectedGroups.reduce(
    (acc, g) => acc + g.responses.length,
    0,
  );

  return (
    <TooltipProvider delayDuration={200}>
      {/*
        `data-testid` é contrato de teste, não estilo: a asserção da #613 conta
        quantas raízes de lista de cards existem no DOM após navegar (tem que ser
        sempre 1). Contar por classe Tailwind quebraria no primeiro ajuste de
        layout, silenciosamente e sempre para o lado do verde.
      */}
      <div className="space-y-1.5" data-testid="agreement-group">
        {allowEquivalence && groups.length > 1 && (
          // Uma linha, não três: a explicação completa (o exemplo de
          // equivalência e o que "gabarito" significa) vive no popover ao lado.
          // O texto curto permanece visível porque é ele que revela a
          // affordance para quem entra na tela pela primeira vez — o que sai do
          // fluxo é a prosa, não a descoberta (#610).
          <div className="flex items-center justify-between gap-2 rounded-md border border-dashed border-muted-foreground/20 bg-muted/30 px-2.5 py-1 text-[11px] leading-tight text-muted-foreground">
            <p className="flex min-w-0 flex-1 items-center gap-1">
              <Link2 className="size-3 shrink-0" />
              <span className="truncate">
                Marque os equivalentes e escolha o gabarito.
              </span>
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="Como funciona a equivalência entre respostas"
                    className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
                  >
                    <HelpCircle className="size-3.5" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-80 p-3 text-xs">
                  Marque os cards equivalentes (ex.: NI ≡ N/A ≡ &ldquo;não
                  informado&rdquo;) e indique qual fica como{" "}
                  <strong>gabarito</strong> — a resposta que será registrada.
                </PopoverContent>
              </Popover>
            </p>
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 gap-1"
              disabled={readOnly || isSubmitting}
              onClick={handleConfirmAll}
              title="Pré-seleciona todas as respostas como equivalentes; a mais comum fica como gabarito sugerido. Revise o gabarito e aplique no botão de confirmação abaixo."
            >
              <Link2 className="size-3.5" />
              Todas são similares
            </Button>
          </div>
        )}

        {groups.map((group, i) => {
          const facts = describeGroup(group, existingVerdict, pendingVerdict);
          return (
            <AnswerCard
              key={group.groupKey}
              index={i}
              displayAnswer={group.displayAnswer}
              respondentNames={group.responses.map((r) => r.respondent_name)}
              respondentCount={group.responses.length}
              hasLlm={facts.hasLlm}
              llmJustification={facts.llmJustification}
              staleCount={facts.staleCount}
              isChosen={facts.isChosen}
              isPending={facts.isPending}
              versions={facts.versions}
              readOnly={readOnly}
              onVote={() => onVote(group.displayAnswer, group.responses[0].id)}
              // Montada só no card preparado, e não em todos com o
              // `AnswerCard` decidindo depois: `isPending` é conhecido AQUI, e é
              // este o sítio onde a invariante "exatamente uma barra no DOM"
              // fica visível. O gate lá dentro permanece como defesa em
              // profundidade para quem passar o slot sem esta condição.
              confirmSlot={
                facts.isPending ? (
                  <PendingConfirmBar
                    label={group.displayAnswer}
                    showLabel={false}
                    isSaving={pendingConfirm.isSaving}
                    onConfirm={pendingConfirm.onConfirm}
                    onDiscard={pendingConfirm.onDiscard}
                  />
                ) : undefined
              }
              equivalenceMode={
                allowEquivalence
                  ? equivalenceModeFor({
                      isSelected: selectionSet.has(group.groupKey),
                      showGabarito,
                      isGabarito: effectiveGabarito === group.groupKey,
                      onToggle: () => toggleSelection(group.groupKey),
                      onSetGabarito: () => setGabaritoOverride(group.groupKey),
                    })
                  : undefined
              }
              equivalentVariants={
                group.variants.length > 0 ? group.variants : undefined
              }
              onUnmarkPair={onUnmarkPair ? handleUnmark : undefined}
              canUnmarkPair={(v) =>
                canManageAnyPair || v.reviewerId === currentUserId
              }
            />
          );
        })}

        {allowEquivalence && selectedGroups.length >= 2 && (
          <div className="flex items-center justify-between gap-2 rounded-md border border-brand/30 bg-brand/5 px-2.5 py-1.5 text-xs">
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              Gabarito:{" "}
              <span className="font-medium text-foreground">
                {gabaritoLabel || "—"}
              </span>
            </span>
            <Button
              size="sm"
              className="h-7 gap-1"
              disabled={readOnly || isSubmitting || !effectiveGabarito}
              onClick={handleConfirm}
            >
              <Link2 className="size-3.5" />
              Confirmar {selectedResponseCount} respostas como equivalentes
            </Button>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
