"use client";

import { Button } from "@/components/ui/button";

interface PendingConfirmBarProps {
  /**
   * `null` quando a barra está ancorada num card: o card já exibe a resposta, e
   * repetir "Selecionado: Deferido" dentro dele é ruído. Não-nulo quando está
   * ancorada nas ações da divergência (Ambíguo / Pular / resposta nova), onde o
   * rótulo carrega informação que não está em nenhum outro lugar da tela — o
   * texto que a revisora digitou, por exemplo.
   */
  label: string | null;
  /**
   * Sempre presente, independentemente de `label`: é o contrato de teste
   * (`data-pending-label`) que substituiu o `getByText("Selecionado:")` como
   * prova de que existe rascunho. Casar por copy quebrava ao mudar o texto e,
   * pior, ficava vácuo quando o rótulo simplesmente não era renderizado.
   */
  pendingLabel: string;
  isSaving: boolean;
  onConfirm: () => void;
  onDiscard: () => void;
}

/**
 * Confirmação do veredito, ancorada ao elemento que produziu o rascunho.
 *
 * O #417 trocou "clica e salva" por "prepara e confirma" para que nenhuma linha
 * de `reviews` nasça sem um ato deliberado DISTINTO do ato de escolher — e essa
 * garantia não está em discussão. O que custava caro era o SÍTIO da confirmação:
 * uma barra fixa no rodapé, a algumas centenas de pixels do ponto do clique,
 * obrigando um deslocamento de olhar a cada campo (#610).
 *
 * Aqui a barra nasce a poucos pixels de onde a revisora acabou de clicar, e não
 * existe quando não há rascunho. A garantia é idêntica: continuam sendo dois
 * atos, em controles diferentes, com saída explícita pelo "Descartar".
 *
 * `readOnly` não é prop de propósito: em somente-leitura nenhum rascunho pode
 * ser criado (overlay do card desabilitado, botões desabilitados, o hook de
 * teclado retorna antes), logo esta barra nunca chega a renderizar. Um "modo
 * somente leitura" aqui seria um estado inalcançável convidando a divergir da
 * regra real.
 *
 * O `aria-label` explícito mantém o nome acessível exatamente "Confirmar" /
 * "Salvando..." apesar do `<kbd>` decorativo — é o que as asserções existentes
 * consultam, e mudá-lo silenciosamente as tornaria vácuas.
 */
export function PendingConfirmBar({
  label,
  pendingLabel,
  isSaving,
  onConfirm,
  onDiscard,
}: PendingConfirmBarProps) {
  return (
    <div
      data-testid="pending-confirm"
      data-pending-label={pendingLabel}
      className="mt-2 flex items-center justify-end gap-2 border-t pt-2"
    >
      {label && (
        <span className="mr-auto min-w-0 truncate text-xs text-muted-foreground">
          Selecionado:{" "}
          <span className="font-medium text-foreground">{label}</span>
        </span>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-7"
        disabled={isSaving}
        onClick={onDiscard}
      >
        Descartar
      </Button>
      <Button
        size="sm"
        className="h-7 gap-1.5"
        disabled={isSaving}
        onClick={onConfirm}
        aria-label={isSaving ? "Salvando..." : "Confirmar"}
      >
        {isSaving ? (
          "Salvando..."
        ) : (
          <>
            Confirmar
            <kbd
              aria-hidden
              className="rounded bg-primary-foreground/20 px-1 py-0.5 font-mono text-[10px]"
            >
              Enter
            </kbd>
          </>
        )}
      </Button>
    </div>
  );
}
