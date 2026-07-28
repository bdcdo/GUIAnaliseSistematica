"use client";

import { cn } from "@/lib/utils";

interface ProgressDotsProps {
  total: number;
  currentIndex: number;
  answered: boolean[];
  concordant?: boolean[];
  /** campo iniciado mas ainda incompleto (ex: contesta_llm sem justificativa) */
  incomplete?: boolean[];
  onNavigate: (index: number) => void;
}

export function ProgressDots({ total, currentIndex, answered, concordant, incomplete, onNavigate }: ProgressDotsProps) {
  return (
    <div className="flex flex-wrap justify-center gap-1.5 px-2 py-1">
      {Array.from({ length: total }).map((_, i) => {
        const isConcordant = concordant?.[i] ?? false;
        const isIncomplete = incomplete?.[i] ?? false;
        return (
          // A CAIXA é sempre `size-3`; só o círculo de dentro muda de tamanho
          // com o índice corrente. O dot ativo ser 4px mais largo que os
          // demais tornava a largura do flex-item função de `currentIndex`:
          // num container `flex-wrap`, isso desloca o ponto de quebra ao
          // navegar e, no limiar, troca 2 fileiras por 3 — variação de altura
          // do cabeçalho ENTRE CAMPOS DO MESMO DOCUMENTO, que faz os cards
          // saltarem a cada `n`/`p` (#610). Com a caixa fixa, o número de
          // fileiras passa a ser função apenas de `total` e da largura
          // disponível. Efeito colateral desejado: o alvo de clique fica
          // constante e maior que os 8px de antes.
          //
          // O círculo mantém a aparência de antes, mas o ESPAÇAMENTO entre
          // pontos aumenta — a caixa dos não-correntes vai de 8px para 12px.
          // Vale também para o AutoReviewFieldPanel, que consome este
          // componente com a mesma forma (cabeçalho `shrink-0` acima do
          // scroller) e herda a invariância de altura sem ter sido medido.
          <button
            type="button"
            key={i}
            aria-label={`Ir para pergunta ${i + 1}`}
            onClick={() => onNavigate(i)}
            className="flex size-3 shrink-0 items-center justify-center"
            title={`Pergunta ${i + 1}${
              isConcordant
                ? " (concordante)"
                : isIncomplete
                  ? " (falta justificativa)"
                  : ""
            }`}
          >
            <span
              className={cn(
                "rounded-full transition-all",
                i === currentIndex ? "size-3" : "size-2",
                isConcordant
                  ? "bg-muted-foreground/30"
                  : answered[i]
                    ? "bg-brand"
                    : isIncomplete
                      ? "border border-amber-500 bg-amber-500/30"
                      : "border border-muted-foreground/40 bg-transparent",
                i === currentIndex && "ring-2 ring-brand/30"
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
