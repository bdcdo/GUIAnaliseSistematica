"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  Bot,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Link2,
  X,
} from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { readOnlyTitle } from "./compare-types";

export interface EquivalentVariant {
  pairId: string; // response_equivalences.id
  reviewerId: string | null;
  respondentName: string;
  answerDisplay: string;
}

interface GabaritoAffordance {
  isGabarito: boolean;
  onSetGabarito: () => void;
}

// Discriminated union over `selected`: encodes the invariant "gabarito never
// without selection" in the type. The `gabarito` affordance only exists in the
// `selected: true` branch, so an impossible state (gabarito on an unselected
// card) is unrepresentable. `undefined` ⇒ equivalence not allowed (no checkbox).
// Not exported: the sole consumer (AgreementGroup) builds the object inline and
// TS checks it structurally against the prop type — exporting would be dead code.
type EquivalenceMode =
  | { selected: false; onToggle: () => void }
  | {
      selected: true;
      onToggle: () => void;
      gabarito: GabaritoAffordance | null;
    };

interface AnswerCardProps {
  readOnly: boolean;
  index: number;
  displayAnswer: string;
  respondentNames: string[];
  respondentCount: number;
  hasLlm: boolean;
  llmJustification?: string;
  staleCount: number;
  isChosen: boolean;
  isPending: boolean;
  versions: string[];
  onVote: () => void;

  // Confirmação do rascunho, renderizada DENTRO do card quando ele é o que
  // produziu o rascunho — o segundo passo nasce junto do primeiro em vez de no
  // rodapé do painel (#610). Só é consumida quando `isPending`.
  confirmSlot?: ReactNode;

  // Selection / equivalence affordances (only present when allowEquivalence).
  // Discriminated union: `gabarito` is only reachable on the selected branch.
  equivalenceMode?: EquivalenceMode;

  // When this card represents 2+ responses fused via equivalence pairs.
  equivalentVariants?: EquivalentVariant[];
  onUnmarkPair?: (pairId: string) => void;
  canUnmarkPair?: (variant: EquivalentVariant) => boolean;
}

export function AnswerCard({
  readOnly,
  index,
  displayAnswer,
  respondentNames,
  respondentCount,
  hasLlm,
  llmJustification,
  staleCount,
  isChosen,
  isPending,
  versions,
  onVote,
  confirmSlot,
  equivalenceMode,
  equivalentVariants,
  onUnmarkPair,
  canUnmarkPair,
}: AnswerCardProps) {
  const allStale = staleCount > 0 && staleCount === respondentCount;
  const fusedCount = equivalentVariants?.length ?? 0;
  const selected = equivalenceMode?.selected === true;
  // Gabarito radio is only reachable on the selected branch (invariant in type).
  const gabarito = equivalenceMode?.selected ? equivalenceMode.gabarito : null;
  const voteTitle = readOnlyTitle(readOnly);
  const equivalenceTitle = readOnlyTitle(
    readOnly,
    "Selecionar para marcar como equivalente",
  );
  const unmarkTitle = readOnlyTitle(readOnly, "Desfazer equivalência");

  return (
    <div
      data-testid="answer-card"
      // Contrato de teste para "este é o card preparado". A asserção anterior
      // lia `parentElement.className` atrás de uma classe de borda — sobrevivia
      // por acidente da estrutura e quebraria em qualquer wrapper novo.
      data-pending={isPending || undefined}
      className={cn(
        "relative isolate w-full rounded-lg border p-2.5 text-left transition-colors hover:bg-accent/50",
        "has-[[data-vote-target]:focus-visible]:outline-none has-[[data-vote-target]:focus-visible]:ring-2 has-[[data-vote-target]:focus-visible]:ring-ring has-[[data-vote-target]:focus-visible]:ring-offset-2",
        isChosen
          ? "border-green-500/50 bg-green-500/5"
          : isPending
            ? "border-brand bg-brand/10"
            : selected
              ? "border-brand/60 bg-brand/5"
              : "border-muted",
      )}
    >
      {/*
        Vote target: a transparent <button> overlaying the whole card. The card
        itself is a plain <div> so the interactive controls below (checkbox,
        popover, gabarito radio) can be siblings of this button instead of
        nested inside it (nested interactive = invalid HTML, plus the manual
        role="button" that prefer-tag-over-role flagged). Any new interactive or
        hover child must be lifted above this overlay with `relative z-[2]`;
        non-interactive content stays below and clicking it votes
        (stretched-link pattern). The native <button> handles Enter/Space.
      */}
      <button
        type="button"
        data-vote-target
        onClick={onVote}
        disabled={readOnly}
        aria-label={`Selecionar esta resposta para confirmar: ${displayAnswer || "(vazia)"}`}
        title={voteTitle}
        className={cn(
          "absolute inset-0 z-[1] rounded-lg focus:outline-none",
          readOnly ? "cursor-default" : "cursor-pointer",
        )}
      />
      <div className="flex items-start gap-2">
        {equivalenceMode && (
          <div className="relative z-[2] flex h-5 shrink-0 items-center">
            <Checkbox
              checked={equivalenceMode.selected}
              onCheckedChange={() => equivalenceMode.onToggle()}
              disabled={readOnly}
              aria-label="Selecionar para marcar como equivalente"
              title={equivalenceTitle}
            />
          </div>
        )}
        <span className="flex size-5 shrink-0 items-center justify-center rounded bg-muted text-xs font-medium">
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm">{displayAnswer}</p>

          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="relative z-[2] cursor-default underline decoration-dotted underline-offset-2">
                  {respondentCount}{" "}
                  {respondentCount === 1 ? "respondente" : "respondentes"}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                {respondentNames.map((name) => (
                  <div key={name}>{name}</div>
                ))}
              </TooltipContent>
            </Tooltip>

            {hasLlm && (
              <span className="inline-flex items-center gap-1 text-brand">
                <Bot className="size-3" />
                LLM
              </span>
            )}

            {staleCount > 0 && (
              <span className="inline-flex items-center gap-1 text-amber-600">
                <AlertTriangle className="size-3" />
                {allStale
                  ? "desatualizada"
                  : `${staleCount} de ${respondentCount} desatualizadas`}
              </span>
            )}

            {fusedCount > 0 && (
              <FusedVariantsPopover
                variants={equivalentVariants!}
                readOnly={readOnly}
                unmarkTitle={unmarkTitle}
                onUnmarkPair={onUnmarkPair}
                canUnmarkPair={canUnmarkPair}
              />
            )}

            {versions.length === 1 && (
              <span
                className="relative z-[2] font-mono text-[10px] text-muted-foreground"
                title="Versão do schema em que esta resposta foi salva"
              >
                v{versions[0]}
              </span>
            )}
            {versions.length > 1 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="relative z-[2] cursor-default font-mono text-[10px] text-muted-foreground underline decoration-dotted underline-offset-2">
                    {versions.length} versões
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {versions.map((v) => (
                    <div key={v}>v{v}</div>
                  ))}
                </TooltipContent>
              </Tooltip>
            )}
          </div>

          {hasLlm && llmJustification && (
            <LlmJustification text={llmJustification} />
          )}
        </div>

        {gabarito && <GabaritoRadio gabarito={gabarito} readOnly={readOnly} />}
      </div>

      {/*
        `relative z-[2]` pela mesma regra do comentário do overlay acima: filho
        interativo precisa ficar ACIMA do botão de voto que cobre o card
        inteiro. Sem isso, clicar em "Confirmar" acertaria o overlay e apenas
        re-prepararia o rascunho.
      */}
      {isPending && confirmSlot && (
        <div className="relative z-[2]">{confirmSlot}</div>
      )}
    </div>
  );
}

/**
 * Marcador do gabarito de um grupo de respostas equivalentes. Extraído do corpo
 * do card para pagar a complexidade que o `confirmSlot` acrescentou — o
 * `AnswerCard` já estava acima do limiar, então acrescentar sem devolver
 * empurraria o débito adiante.
 */
function GabaritoRadio({
  gabarito,
  readOnly,
}: {
  gabarito: GabaritoAffordance;
  readOnly: boolean;
}) {
  return (
    <label
      className="relative z-[2] flex shrink-0 cursor-pointer items-center gap-1 rounded border border-brand/30 bg-background px-1.5 py-0.5 text-[10px] hover:bg-brand/5"
      title="Esta é a resposta que será registrada como gabarito"
    >
      <input
        type="radio"
        checked={gabarito.isGabarito}
        onChange={() => gabarito.onSetGabarito()}
        disabled={readOnly}
        className="size-3 accent-brand"
      />
      <span className={cn(gabarito.isGabarito && "font-medium text-brand")}>
        Gabarito
      </span>
    </label>
  );
}

/**
 * Variantes que foram marcadas como equivalentes e por isso aparecem fundidas
 * neste card. Extraído junto do `GabaritoRadio` para devolver a complexidade
 * que o `confirmSlot` acrescentou ao corpo do `AnswerCard` — o componente já
 * estava acima do limiar antes desta mudança.
 */
function FusedVariantsPopover({
  variants,
  readOnly,
  unmarkTitle,
  onUnmarkPair,
  canUnmarkPair,
}: {
  variants: EquivalentVariant[];
  readOnly: boolean;
  unmarkTitle: string | undefined;
  onUnmarkPair?: (pairId: string) => void;
  canUnmarkPair?: (variant: EquivalentVariant) => boolean;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative z-[2] inline-flex items-center gap-1 rounded bg-brand/10 px-1.5 py-0.5 text-[10px] text-brand hover:bg-brand/15"
          title="Variantes marcadas como equivalentes"
        >
          <Link2 className="size-3" />
          {variants.length} variante{variants.length === 1 ? "" : "s"}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <p className="px-1 pb-1.5 text-xs font-medium">Respostas equivalentes</p>
        <ul className="space-y-1">
          {variants.map((v) => {
            const showUnmark = !!onUnmarkPair && (canUnmarkPair?.(v) ?? true);
            return (
              <li
                key={v.pairId}
                className="flex items-center justify-between gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate">{v.answerDisplay}</p>
                  <p className="truncate text-[10px] text-muted-foreground">
                    {v.respondentName}
                  </p>
                </div>
                {showUnmark && (
                  <button
                    type="button"
                    onClick={() => onUnmarkPair!(v.pairId)}
                    disabled={readOnly}
                    className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    title={unmarkTitle}
                    aria-label="Desfazer equivalência"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Justificativa do LLM, colapsável. Leva junto o único `useState` que existia no
 * corpo do `AnswerCard`: o estado é local a este trecho e não influencia mais
 * nada do card.
 */
function LlmJustification({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="relative z-[2] text-xs text-muted-foreground hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="inline size-3" />
        ) : (
          <ChevronRight className="inline size-3" />
        )}{" "}
        Justificativa
      </button>
      {open && <p className="mt-1 text-xs text-muted-foreground">{text}</p>}
    </div>
  );
}
