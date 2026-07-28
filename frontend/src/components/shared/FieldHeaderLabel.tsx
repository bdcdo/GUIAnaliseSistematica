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
 */
// Não exportados: os call sites passam o literal direto, e um export sem
// consumidor é código morto que o gate de grafo acusa.
interface FieldHeaderLabelBaseProps {
  prefix: ReactNode;
  helpText?: string | null;
  className?: string;
  labelClassName?: string;
  /** Só tem efeito em `flow`; em `fixed` o help_text não vive no fluxo. */
  helpTextClassName?: string;
}

// Clampar sem uma via para o texto integral seria perda de informação, e a via
// é o `title` — atributo, que só aceita texto. Daí a união: em `fixed` o
// enunciado É uma string, e o próprio `children` vira o texto completo. Uma
// prop `fullText` separada resolveria o mesmo, mas declararia duas vezes o
// mesmo fato no call site, livre para divergir; aqui o tipo torna a divergência
// inexprimível em vez de confiá-la à disciplina de quem chama.
type FieldHeaderLabelProps = FieldHeaderLabelBaseProps &
  (
    | { density?: { kind: "flow" }; children: ReactNode }
    | { density: { kind: "fixed"; clampLines: 2 }; children: string }
  );

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

  const label = (
    <p
      className={cn(
        "text-sm font-medium",
        isFixed
          ? // `line-clamp-2` corta o excesso; o `min-h-10` (2 × leading-5 do
            // text-sm) é o que RESERVA as duas linhas mesmo em enunciado
            // curto. Sem ele o clamp não zera a variação de altura — apenas
            // limita o teto. `min-w-0 flex-1` porque em `fixed` este parágrafo
            // é flex-item ao lado do gatilho de ajuda.
            "line-clamp-2 min-h-10 min-w-0 flex-1"
          : "flex items-center gap-1.5",
        labelClassName,
      )}
      // Texto integral do enunciado clampado. `title` nativo em vez de
      // Tooltip do Radix de propósito: o alvo desta tela é mouse/desktop, e
      // um TooltipTrigger focável acrescentaria uma parada de Tab por campo
      // numa fila percorrida inteiramente por teclado (`n`/`p`/`Enter`).
      //
      // Vai sempre, mesmo em enunciado curto que não trunca — a alternativa
      // seria medir `scrollHeight` no cliente por campo, reintroduzindo
      // trabalho de layout justamente no bloco cuja invariância é o objetivo.
      // O custo é um tooltip nativo redundante ao pousar o mouse.
      title={isFixed && typeof children === "string" ? children : undefined}
    >
      <span className={cn("text-muted-foreground", isFixed && "mr-1.5")}>
        {prefix}
      </span>
      {children}
    </p>
  );

  return (
    <div className={cn("min-w-0", className)}>
      {isFixed ? (
        // O gatilho é IRMÃO do parágrafo clampado, nunca filho: `line-clamp-*`
        // implica `display:-webkit-box` com `overflow:hidden`, então um botão
        // inline depois do texto sumiria — recortado e inalcançável por mouse,
        // ainda que focável por Tab — exatamente nos campos de enunciado longo,
        // que são os que mais precisam da instrução. `items-start` alinha o
        // ícone à primeira linha; a altura da faixa continua vindo do `min-h-10`
        // do parágrafo, logo a presença ou ausência do gatilho não move nada.
        <div className="flex items-start gap-1">
          {label}
          {trimmedHelp && <FieldHelpPopover helpText={trimmedHelp} />}
        </div>
      ) : (
        label
      )}

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
 */
function FieldHelpPopover({ helpText }: { helpText: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Instruções de preenchimento do campo"
          className="mt-0.5 shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
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
