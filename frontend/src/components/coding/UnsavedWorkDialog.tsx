"use client";

import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog";

/**
 * Aviso de saída com trabalho não enviado (#608).
 *
 * Não é um veto: a pesquisadora sempre consegue sair. O que o #608 remove é o
 * salvamento automático que fingia protegê-la; o que ele põe no lugar é a
 * certeza de que sair é uma escolha, não um acidente.
 *
 * A frase sobre o navegador não é consolo — é o fato que distingue este aviso
 * de um alarme falso, e é verificável: o rascunho local do PR-1 guarda o
 * conteúdo, e a faixa de recuperação o oferece de volta na próxima visita.
 */
export function UnsavedWorkDialog({
  open,
  unsentDocsCount,
  onLeave,
  onStay,
}: {
  open: boolean;
  unsentDocsCount: number;
  onLeave: () => void;
  onStay: () => void;
}) {
  const plural = unsentDocsCount > 1;
  return (
    <ConfirmActionDialog
      open={open}
      onClose={onStay}
      title="Alterações não enviadas"
      description={
        plural
          ? `Você editou ${unsentDocsCount} documentos e ainda não enviou as respostas. Elas ficam salvas neste navegador.`
          : "Você editou respostas e ainda não as enviou. Elas ficam salvas neste navegador."
      }
      confirmLabel="Sair sem enviar"
      cancelLabel="Ficar"
      onConfirm={onLeave}
    />
  );
}
