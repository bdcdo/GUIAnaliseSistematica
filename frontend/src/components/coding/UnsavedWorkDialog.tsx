"use client";

import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";

/**
 * Aviso de saída com trabalho não enviado (#608).
 *
 * Não é um veto: a pesquisadora sempre consegue sair. O que o #608 remove é o
 * salvamento automático que fingia protegê-la; o que ele põe no lugar é a
 * certeza de que sair é uma escolha, não um acidente.
 *
 * A frase sobre o navegador não é consolo — é o fato que distingue este aviso de
 * um alarme falso. Por isso ela é DERIVADA, e não fixa: `allHaveLocalCopy` vem
 * de consultar, no instante do clique, se cada documento pendente tem envelope
 * gravado. Com o `localStorage` bloqueado (janela anônima), com a quota
 * estourada ou depois de a faixa descartar o rascunho, não há cópia — e prometer
 * uma é a mesma classe de mentira que a #608 existe para eliminar, agora dita
 * pela tela que deveria corrigi-la.
 */
export function UnsavedWorkDialog({
  open,
  unsentDocsCount,
  allHaveLocalCopy,
  onLeave,
  onStay,
}: {
  open: boolean;
  unsentDocsCount: number;
  allHaveLocalCopy: boolean;
  onLeave: () => void;
  onStay: () => void;
}) {
  const edited =
    unsentDocsCount > 1
      ? `Você editou ${unsentDocsCount} documentos e ainda não enviou as respostas.`
      : "Você editou respostas e ainda não as enviou.";
  const fate = allHaveLocalCopy
    ? "Elas ficam salvas neste navegador."
    : "Não foi possível guardar uma cópia neste navegador — se sair, elas se perdem.";
  return (
    <ConfirmActionDialog
      open={open}
      onClose={onStay}
      title="Alterações não enviadas"
      description={`${edited} ${fate}`}
      // Sem cópia local, sair É destrutivo, e o botão passa a dizer isso.
      destructive={!allHaveLocalCopy}
      confirmLabel="Sair sem enviar"
      cancelLabel="Ficar"
      onConfirm={onLeave}
    />
  );
}
