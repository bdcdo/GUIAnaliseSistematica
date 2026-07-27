"use client";

import { useState } from "react";
import { AlertTriangle, FileClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CODING_DRAFT_NOTES_KEY, type CodingDraftRecovery } from "@/lib/coding-draft";
import type { PydanticField } from "@/lib/types";

// Faixa de recuperação do rascunho local (#608).
//
// É uma faixa, e não um toast, de propósito: o requisito é que a oferta continue
// disponível até ser resolvida. Um toast some sozinho, e um rascunho que a
// pesquisadora não viu passar é indistinguível de rascunho nenhum.
//
// O formulário abaixo dela mostra os valores DO SERVIDOR. Nada é aplicado até
// que "Retomar" seja clicado — é o que separa esta feature do auto-save que ela
// substitui, que gravava sem pedir e sem avisar.

function fieldLabel(name: string, fields: PydanticField[]): string {
  if (name === CODING_DRAFT_NOTES_KEY) return "Notas e sugestões";
  const field = fields.find((f) => f.name === name);
  return field?.description?.trim() || name;
}

// "há N minutos/horas/dias". O instante exato não ajuda a decidir; a ordem de
// grandeza sim — um rascunho de dez minutos atrás é a sessão interrompida, um de
// duas semanas provavelmente já foi superado.
function humanizeAge(updatedAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - updatedAt) / 60_000);
  if (minutes < 1) return "agora há pouco";
  if (minutes < 60) return `há ${minutes} minuto${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} hora${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `há ${days} dia${days === 1 ? "" : "s"}`;
}

interface CodingDraftBannerProps {
  recovery: CodingDraftRecovery;
  fields: PydanticField[];
  onRestore: () => void;
  onDiscard: () => void;
  /** Instante de referência da idade do rascunho. Injetável para o teste não
   *  depender do relógio real; omitido, é capturado no mount. */
  now?: number;
}

export function CodingDraftBanner({
  recovery,
  fields,
  onRestore,
  onDiscard,
  now,
}: CodingDraftBannerProps) {
  // `Date.now()` no corpo do componente é impuro no render. A idade exibida é
  // uma ordem de grandeza ("há 2 horas"), não um cronômetro: capturar o instante
  // no mount, num inicializador lazy, dá o mesmo texto sem a impureza.
  const [mountedAt] = useState(() => Date.now());
  const reference = now ?? mountedAt;

  if (recovery.kind !== "resumable" && recovery.kind !== "diverged") return null;

  const overwritten =
    recovery.kind === "diverged" ? recovery.overwrittenFields : [];

  return (
    <div
      role="status"
      className="flex flex-col gap-2 border-b bg-amber-50 px-4 py-2.5 text-sm dark:bg-amber-950/30"
    >
      <div className="flex items-center gap-2">
        <FileClock className="size-4 shrink-0 text-amber-600" aria-hidden />
        <span className="flex-1">
          Você tem alterações não enviadas neste documento, salvas neste navegador{" "}
          {humanizeAge(recovery.updatedAt, reference)}.
        </span>
        <Button size="sm" variant="default" onClick={onRestore}>
          Retomar rascunho
        </Button>
        <Button size="sm" variant="ghost" onClick={onDiscard}>
          Descartar
        </Button>
      </div>

      {overwritten.length > 0 && (
        // Só o que retomar de fato sobrescreve — ver `overwrittenFields`, que é
        // a interseção e não tudo que o servidor mudou.
        <div className="flex items-start gap-2 text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            Este documento foi salvo depois que o rascunho foi criado. Retomar
            substitui{" "}
            {overwritten.length === 1
              ? "a resposta de "
              : `as respostas de ${overwritten.length} perguntas: `}
            <strong>
              {overwritten.map((name) => fieldLabel(name, fields)).join(", ")}
            </strong>
            .
          </span>
        </div>
      )}
    </div>
  );
}

// Aviso separado, e permanente enquanto durar: o rascunho local não está
// funcionando neste navegador. Distinto do indicador de "não enviado", que vem
// da sujeira em memória — a tela precisa poder dizer "há trabalho pendente" E
// "não consegui guardá-lo aqui" ao mesmo tempo.
export function CodingDraftUnavailableBanner({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div
      role="alert"
      className="flex items-center gap-2 border-b bg-destructive/10 px-4 py-2 text-sm"
    >
      <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden />
      <span>
        Não foi possível guardar uma cópia local das suas respostas neste
        navegador. Envie o documento antes de fechar a aba.
      </span>
    </div>
  );
}

// Indicador permanente de "há alterações não enviadas" (#608). Fica aqui, junto
// das outras superfícies do rascunho local, e não inline no `QuestionsPanel`:
// esse painel já é grande e o JSX condicional a mais o empurrava sobre o limiar
// de complexidade do gate.
//
// O sinal que o alimenta vem da sujeira em memória, nunca do storage — ver
// `useDirtyDocs`.
export function UnsentChangesBadge({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <span
      role="status"
      className="flex items-center gap-1.5 whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200"
    >
      <span className="size-1.5 rounded-full bg-amber-500" aria-hidden />
      Alterações não enviadas
    </span>
  );
}
