"use client";

import { useMemo } from "react";
import {
  AnswerCard,
  type EquivalenceMode,
  type EquivalentVariant,
} from "./AnswerCard";
import { PendingConfirmBar } from "./PendingConfirmBar";
import { useEquivalenceSelection } from "./useEquivalenceSelection";
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
 * Os cards a renderizar: respostas presentes agrupadas por equivalência, com as
 * variantes fundidas de cada grupo anexadas, e os grupos maiores primeiro — a
 * resposta majoritária no topo é o que a revisora lê antes de tudo.
 *
 * Respostas com `answer === undefined` ficam de fora: quem não respondeu aparece
 * no `UnansweredNotice`, não como card vazio.
 */
function buildRenderedGroups(
  responses: AgreementResponse[],
  equivalences: FieldEquivalencePair[],
): RenderedGroup[] {
  const present = responses.filter((r) => r.answer !== undefined);
  const groups = groupByEquivalenceKey(present, equivalences);
  for (const group of groups) {
    group.variants = variantsWithinGroup(group, equivalences);
  }
  return groups.toSorted((a, b) => b.responses.length - a.responses.length);
}

/**
 * Agrupa as respostas presentes pela chave de equivalência. Respostas sem par
 * caem num grupo próprio (a chave é o próprio id), e o texto exibido é o da
 * PRIMEIRA resposta a entrar no grupo — as demais são equivalentes a ela por
 * construção.
 */
function groupByEquivalenceKey(
  present: AgreementResponse[],
  equivalences: FieldEquivalencePair[],
): RenderedGroup[] {
  const groupKeys = buildResponseGroupKeys(present, equivalences, (r) =>
    normalizeForComparison(r.answer),
  );
  const map = new Map<string, RenderedGroup>();
  for (const r of present) {
    const key = groupKeys.get(r.id) ?? r.id;
    const existing = map.get(key);
    if (existing) {
      existing.responses.push(r);
      continue;
    }
    map.set(key, {
      groupKey: key,
      displayAnswer: formatAnswer(r.answer),
      responses: [r],
      variants: [],
    });
  }
  return Array.from(map.values());
}

/**
 * Os pares de equivalência cujas DUAS pontas caíram neste grupo — são eles que o
 * card exibe como "N variantes". Um par com uma ponta fora do grupo pertence a
 * outra fusão e não tem o que dizer aqui.
 */
function variantsWithinGroup(
  group: RenderedGroup,
  equivalences: FieldEquivalencePair[],
): EquivalentVariant[] {
  const byId = new Map(group.responses.map((r) => [r.id, r] as const));
  const variants: EquivalentVariant[] = [];
  for (const p of equivalences) {
    const a = byId.get(p.response_a_id);
    const b = byId.get(p.response_b_id);
    if (!a || !b) continue;
    variants.push({
      pairId: p.id,
      reviewerId: p.reviewer_id,
      respondentName: `${a.respondent_name} ↔ ${b.respondent_name}`,
      answerDisplay: `${formatAnswer(a.answer)} · ${formatAnswer(b.answer)}`,
    });
  }
  return variants;
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
  const groups = useMemo<RenderedGroup[]>(
    () => buildRenderedGroups(responses, equivalences),
    [responses, equivalences],
  );

  const equivalence = useEquivalenceSelection({
    groups,
    onConfirmEquivalent,
    onUnmarkPair,
  });

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
          <EquivalenceHint
            disabled={readOnly || equivalence.isSubmitting}
            onMarkAll={equivalence.selectAll}
          />
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
                      isSelected: equivalence.selectionSet.has(group.groupKey),
                      showGabarito: equivalence.showGabarito,
                      isGabarito:
                        equivalence.effectiveGabarito === group.groupKey,
                      onToggle: () =>
                        equivalence.toggleSelection(group.groupKey),
                      onSetGabarito: () =>
                        equivalence.setGabarito(group.groupKey),
                    })
                  : undefined
              }
              equivalentVariants={
                group.variants.length > 0 ? group.variants : undefined
              }
              onUnmarkPair={onUnmarkPair ? equivalence.unmarkPair : undefined}
              canUnmarkPair={(v) =>
                canManageAnyPair || v.reviewerId === currentUserId
              }
            />
          );
        })}

        {allowEquivalence && equivalence.selectedGroups.length >= 2 && (
          <EquivalenceConfirmBar
            selectedGroups={equivalence.selectedGroups}
            effectiveGabarito={equivalence.effectiveGabarito}
            disabled={readOnly || equivalence.isSubmitting}
            onConfirm={equivalence.confirmEquivalence}
          />
        )}
      </div>
    </TooltipProvider>
  );
}

/**
 * Convite à equivalência, mostrado quando há mais de um grupo para comparar.
 *
 * Uma linha, não três: a explicação completa (o exemplo de equivalência e o que
 * "gabarito" significa) vive no popover ao lado. O texto curto permanece visível
 * porque é ele que revela a affordance para quem entra na tela pela primeira
 * vez — o que sai do fluxo é a prosa, não a descoberta (#610).
 */
function EquivalenceHint({
  disabled,
  onMarkAll,
}: {
  disabled: boolean;
  onMarkAll: () => void;
}) {
  return (
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
            informado&rdquo;) e indique qual fica como <strong>gabarito</strong>{" "}
            — a resposta que será registrada.
          </PopoverContent>
        </Popover>
      </p>
      {/*
        "Todas são similares" (issue #247, ponto 5): pré-seleciona TODOS os
        grupos de uma vez, em vez de o revisor marcar par a par. A persistência
        continua no botão explícito de confirmação abaixo, inclusive quando há
        maioria clara.
      */}
      <Button
        size="sm"
        variant="outline"
        className="h-7 shrink-0 gap-1"
        disabled={disabled}
        onClick={onMarkAll}
        title="Pré-seleciona todas as respostas como equivalentes; a mais comum fica como gabarito sugerido. Revise o gabarito e aplique no botão de confirmação abaixo."
      >
        <Link2 className="size-3.5" />
        Todas são similares
      </Button>
    </div>
  );
}

/**
 * Confirmação da fusão por equivalência: qual resposta fica como gabarito e
 * quantas respostas serão fundidas nela. Diferente da confirmação de veredito
 * (`PendingConfirmBar`), esta persiste pares em `equivalences` — não decide o
 * campo.
 */
function EquivalenceConfirmBar({
  selectedGroups,
  effectiveGabarito,
  disabled,
  onConfirm,
}: {
  selectedGroups: RenderedGroup[];
  effectiveGabarito: string | null;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const gabaritoLabel =
    selectedGroups.find((g) => g.groupKey === effectiveGabarito)
      ?.displayAnswer ?? "";
  const selectedResponseCount = selectedGroups.reduce(
    (acc, g) => acc + g.responses.length,
    0,
  );
  return (
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
        disabled={disabled || !effectiveGabarito}
        onClick={onConfirm}
      >
        <Link2 className="size-3.5" />
        Confirmar {selectedResponseCount} respostas como equivalentes
      </Button>
    </div>
  );
}
