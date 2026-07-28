"use client";

import type { ReactNode } from "react";
import { Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface KeyboardHintsProps {
  readOnly: boolean;
  groupCount: number;
  isMulti?: boolean;
  optionCount?: number;
}

function Key({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
      {children}
    </kbd>
  );
}

function Hint({ keys, children }: { keys: ReactNode; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      {keys} {children}
    </span>
  );
}

/**
 * Legenda dos atalhos, sob demanda.
 *
 * Era um bloco fixo no rodapé do painel: uma faixa permanente de ~44px cujo
 * único conteúdo era um botão que só revelava algo se clicado — a pior razão
 * entre pixels ocupados e informação exibida da tela (#610). Agora é um ícone
 * no cabeçalho, ao lado dos badges do campo, com o mesmo conteúdo dentro de um
 * popover.
 *
 * O rótulo antigo anunciava um atalho `?` que nunca existiu: `useCompareKeyboard`
 * trata `Ctrl+Shift+F`, `Escape`, `n`, `p`, `a`, `s`, `Enter` e dígitos, e nada
 * mais. Anunciar tecla que não responde é pior que não anunciar nenhuma, então
 * o `?` saiu em vez de virar TODO. Ligá-lo de verdade exigiria expor o estado
 * deste popover até o `ComparePage` para alcançar o handler global.
 */
export function KeyboardHints({
  readOnly,
  groupCount,
  isMulti,
  optionCount,
}: KeyboardHintsProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Atalhos de teclado"
          className="size-5 shrink-0 p-0 text-muted-foreground"
        >
          <Keyboard className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="flex w-72 flex-col gap-1.5 p-3 text-xs text-muted-foreground"
      >
        {!readOnly && (
          <>
            {isMulti ? (
              <>
                <Hint
                  keys={
                    <>
                      <Key>1</Key>
                      {(optionCount ?? 0) > 1 && (
                        <>
                          –<Key>{optionCount}</Key>
                        </>
                      )}
                    </>
                  }
                >
                  Marcar/desmarcar
                </Hint>
                <Hint keys={<Key>Enter</Key>}>Confirmar</Hint>
              </>
            ) : (
              <>
                <Hint
                  keys={
                    <>
                      <Key>1</Key>
                      {groupCount > 1 && (
                        <>
                          –<Key>{groupCount}</Key>
                        </>
                      )}
                    </>
                  }
                >
                  Escolher resposta
                </Hint>
                {/* Confirmar também vale em campo simples — o painel só
                    anunciava no ramo multi, e a omissão fazia parecer que o
                    fluxo de teclado terminava na escolha (#614). */}
                <Hint keys={<Key>Enter</Key>}>Confirmar</Hint>
              </>
            )}
            <Hint keys={<Key>A</Key>}>Ambíguo</Hint>
            <Hint keys={<Key>S</Key>}>Pular</Hint>
          </>
        )}
        <Hint keys={<Key>P</Key>}>Anterior</Hint>
        <Hint keys={<Key>N</Key>}>Próximo</Hint>
        <Hint keys={<Key>Ctrl+Shift+F</Key>}>Tela cheia</Hint>
        <Hint keys={<Key>Esc</Key>}>Sair da tela cheia</Hint>
      </PopoverContent>
    </Popover>
  );
}
