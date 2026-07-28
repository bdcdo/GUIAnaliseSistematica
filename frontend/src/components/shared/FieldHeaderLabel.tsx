"use client";

import type { ReactNode } from "react";
import { HelpCircle } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Como o cabeçalho ocupa espaço.
 *
 * - `flow`: o enunciado cresce quantas linhas precisar e o `help_text` vem num
 *   bloco abaixo. É o default e o certo quando o cabeçalho está DENTRO de uma
 *   área rolável — a altura extra é amortizada pelo scroll, e o enunciado é o
 *   objeto da tarefa (codificação).
 * - `fixed`: altura reservada e constante, `help_text` sob demanda. É o certo
 *   quando o cabeçalho é chrome `shrink-0` ACIMA da área rolável: ali cada
 *   linha a mais empurra o conteúdo, e como a altura variava por campo os
 *   cards saltavam de posição ao navegar com `n`/`p` (#610).
 *
 * `fullText` é obrigatório em `fixed` — não é conveniência. Clampar sem uma via
 * para o texto integral é perda de informação, então o tipo torna esse estado
 * irrepresentável em vez de deixá-lo à disciplina do call site.
 */
// Não exportado: os call sites passam o literal direto, e um export sem
// consumidor é código morto que o gate de grafo acusa.
type FieldHeaderDensity =
  | { kind: "flow" }
  | { kind: "fixed"; clampLines: 2; fullText: string };

interface FieldHeaderLabelProps {
  prefix: ReactNode;
  children: ReactNode;
  helpText?: string | null;
  density?: FieldHeaderDensity;
  className?: string;
  labelClassName?: string;
  /** Só tem efeito em `flow`; em `fixed` o help_text não vive no fluxo. */
  helpTextClassName?: string;
}

// Prefixo + descrição de um campo (ex.: "Campo 1/5: Data do parecer"), com o
// help_text opcional. Compartilhado entre Codificação (SortableQuestion),
// Comparação (ComparisonPanel) e Revisão Automática (AutoReviewFieldPanel) —
// as três telas mostravam essa dupla de formas levemente divergentes e apenas
// uma exibia help_text (#373/#365).
//
// O default é `flow`, e isso é deliberado: a Codificação usa este componente
// como item de lista rolável, onde o enunciado é justamente a pergunta que se
// está respondendo — clampá-lo lá seria regressão. Só quem é chrome de altura
// fixa pede `fixed`, tela a tela. Não uniformizar sem medir a tela alvo.
export function FieldHeaderLabel({
  prefix,
  children,
  helpText,
  density = { kind: "flow" },
  className,
  labelClassName,
  helpTextClassName,
}: FieldHeaderLabelProps) {
  const isFixed = density.kind === "fixed";
  const trimmedHelp = helpText?.trim();

  return (
    <div className={cn("min-w-0", className)}>
      <p
        className={cn(
          "text-sm font-medium",
          isFixed
            ? // `line-clamp-2` corta o excesso; o `min-h-10` (2 × leading-5 do
              // text-sm) é o que RESERVA as duas linhas mesmo em enunciado
              // curto. Sem ele o clamp não zera a variação de altura — apenas
              // limita o teto. Nota: `line-clamp-*` implica
              // `display:-webkit-box`, que anula qualquer `flex` aqui; por isso
              // prefixo e ícone são inline dentro da caixa, não flex-items.
              "line-clamp-2 min-h-10"
            : "flex items-center gap-1.5",
          labelClassName,
        )}
        // Texto integral do enunciado clampado. `title` nativo em vez de
        // Tooltip do Radix de propósito: o alvo desta tela é mouse/desktop, e
        // um TooltipTrigger focável acrescentaria uma parada de Tab por campo
        // numa fila percorrida inteiramente por teclado (`n`/`p`/`Enter`).
        title={density.kind === "fixed" ? density.fullText : undefined}
      >
        <span className={cn("text-muted-foreground", isFixed && "mr-1.5")}>
          {prefix}
        </span>
        {children}
        {isFixed && trimmedHelp && <FieldHelpPopover helpText={trimmedHelp} />}
      </p>

      {!isFixed && helpText && (
        <p
          className={cn(
            "mt-1 whitespace-pre-line text-xs text-muted-foreground",
            helpTextClassName,
          )}
        >
          {helpText}
        </p>
      )}
    </div>
  );
}

/**
 * Instrução de preenchimento sob demanda. Popover, e não tooltip, porque o
 * texto chega a ~900 caracteres nos projetos reais: precisa rolar, ser
 * selecionável e fechar por teclado.
 *
 * O gatilho é inline dentro da caixa clampada — logo sua presença ou ausência
 * não move nada, que é a propriedade de que o cabeçalho depende.
 */
function FieldHelpPopover({ helpText }: { helpText: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Instruções de preenchimento do campo"
          className="ml-1 inline-flex translate-y-px cursor-help align-text-bottom text-muted-foreground hover:text-foreground"
        >
          <HelpCircle className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-64 w-80 overflow-y-auto p-3 text-xs whitespace-pre-line"
      >
        {helpText}
      </PopoverContent>
    </Popover>
  );
}
