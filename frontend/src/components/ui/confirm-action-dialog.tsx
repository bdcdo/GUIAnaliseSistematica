"use client";

import type { ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

// Esqueleto compartilhado dos AlertDialogs de confirmação (título, descrição,
// footer Cancelar/Ação com troca de texto + spinner enquanto isPending).
// `children` é o slot para conteúdo extra entre a descrição e o footer (ex:
// o textarea de motivo do ExcludeDocumentsDialog).
//
// O par `isPending`/`pendingLabel` é uma união discriminada, não duas props
// opcionais soltas: confirmações síncronas (o aviso de saída do #608 decide na
// hora, sem ida ao servidor) não têm o que rotular enquanto pendem, e um
// `pendingLabel` que caísse no `confirmLabel` seria um default silencioso para
// um estado que aquele caller não consegue alcançar. Ou vêm os dois, ou nenhum.
type PendingProps =
  | { isPending: boolean; pendingLabel: string }
  | { isPending?: never; pendingLabel?: never };

export function ConfirmActionDialog({
  open,
  onClose,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = "Cancelar",
  pendingLabel,
  destructive = false,
  isPending = false,
  disabled = false,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
} & PendingProps) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        // Enquanto a ação corre, o fechamento é do pai — mesma razão do
        // Cancelar desabilitado. Radix fecha no Esc e no clique fora sem
        // consultar o estado do footer; sem o !isPending, essas duas saídas
        // descartariam a confirmação em voo e o erro que chegasse depois
        // viraria só um toast, sem a confirmação em cena para tentar de novo.
        if (!nextOpen && !isPending) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>

        {children}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            // AlertDialogAction fecha o diálogo por padrão. Quem confirma é que
            // decide se o fluxo terminou: sem o preventDefault o diálogo sai de
            // cena antes de `isPending` renderizar, e uma confirmação recusada
            // (ExcludeDocumentsDialog sem motivo) descartaria o que já foi
            // digitado em vez de deixar o usuário corrigir.
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
            disabled={isPending || disabled}
            className={cn(
              destructive &&
                "bg-destructive text-destructive-foreground hover:bg-destructive/90",
            )}
          >
            {isPending ? (
              <>
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                {pendingLabel}
              </>
            ) : (
              confirmLabel
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
