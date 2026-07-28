"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  CircleDot,
  Maximize2,
  RotateCcw,
  Shuffle,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { CopyLinkButton } from "@/components/ui/CopyLinkButton";
import { RunLlmButton } from "@/components/shared/RunLlmButton";
import { CURRENT_FILTER_VALUE, isCurrentFilter, type DocRoundStatus } from "@/lib/rounds";
import { cn } from "@/lib/utils";
import type { RoundFilterData, CodingSortMode } from "./CodingPage";

export type DocSection =
  | {
      variant: "assigned";
      title: string;
      index: number;
      total: number;
      onNavigate: (index: number) => void;
      parecerUrl?: string;
      /** Por que este documento está na fila — ver `RoundStatusTag`. Status
       *  inteiro (não só o `kind`) porque `previous` carrega o rótulo da rodada. */
      roundStatus: DocRoundStatus | undefined;
    }
  | {
      variant: "browse";
      title: string;
      responseCount: number;
      onBack: () => void;
      onRandom: () => void;
      /** Save em voo: desabilita Voltar/Sortear para evitar disparo duplo. */
      submitting?: boolean;
      parecerUrl?: string;
      projectId: string;
      documentId: string;
    };

interface CodingHeaderProps {
  mode: "assigned" | "browse";
  onModeChange: (mode: "assigned" | "browse") => void;
  assignedCount: number;
  sortMode: CodingSortMode;
  onSortChange: (mode: CodingSortMode) => void;
  roundFilter?: RoundFilterData;
  doc?: DocSection;
  onToggleFullscreen: () => void;
  /** Coordenador do projeto? Gate do botão "Rodar LLM" (#195). */
  canRunLlm?: boolean;
}

export function CodingHeader({
  mode,
  onModeChange,
  assignedCount,
  sortMode,
  onSortChange,
  roundFilter,
  doc,
  onToggleFullscreen,
  canRunLlm = false,
}: CodingHeaderProps) {
  const showRound = mode === "assigned" && roundFilter !== undefined;

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-sm">
      <Tabs
        value={mode}
        onValueChange={(v) => onModeChange(v as "assigned" | "browse")}
      >
        <TabsList className="h-7">
          <TabsTrigger value="assigned" className="h-6 text-xs">
            Atribuídos ({assignedCount})
          </TabsTrigger>
          <TabsTrigger value="browse" className="h-6 text-xs">
            Explorar
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {mode === "assigned" && (
        <>
          <Separator orientation="vertical" className="h-4" />
          <SortSelect value={sortMode} onChange={onSortChange} />
        </>
      )}

      {showRound && (
        <>
          <Separator orientation="vertical" className="h-4" />
          <RoundSelect data={roundFilter!} />
        </>
      )}

      {doc && (
        <>
          <Separator orientation="vertical" className="h-4" />
          {doc.variant === "assigned" ? (
            <AssignedDocSection
              doc={doc}
              onToggleFullscreen={onToggleFullscreen}
            />
          ) : (
            <BrowseDocSection
              doc={doc}
              onToggleFullscreen={onToggleFullscreen}
              canRunLlm={canRunLlm}
            />
          )}
        </>
      )}
    </div>
  );
}

function SortSelect({
  value,
  onChange,
}: {
  value: CodingSortMode;
  onChange: (mode: CodingSortMode) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <span className="text-xs text-muted-foreground">Ordenar:</span>
      <Select
        value={value}
        onValueChange={(v) => onChange(v as CodingSortMode)}
      >
        <SelectTrigger size="sm" className="h-6 w-auto min-w-[150px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="recent">Codificados recentemente</SelectItem>
          <SelectItem value="default">Ordem de atribuição</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function RoundSelect({ data }: { data: RoundFilterData }) {
  const { replace } = useRouter();
  const [isPending, startTransition] = useTransition();

  const normalizedSelected = isCurrentFilter(data.selected)
    ? CURRENT_FILTER_VALUE
    : data.selected;

  const handleChange = (value: string) => {
    const url = new URL(window.location.href);
    if (isCurrentFilter(value)) {
      url.searchParams.delete("round");
    } else {
      url.searchParams.set("round", value);
    }
    startTransition(() => {
      replace(`${url.pathname}${url.search}`, { scroll: false });
    });
  };

  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <span className="text-xs text-muted-foreground">Rodada:</span>
      <Select
        value={normalizedSelected}
        onValueChange={handleChange}
        disabled={isPending}
      >
        <SelectTrigger size="sm" className="h-6 w-auto min-w-[140px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={CURRENT_FILTER_VALUE}>
            Atual ({data.currentRoundLabel}): pendentes
          </SelectItem>
          <SelectItem value="all">Todas as rodadas</SelectItem>
          {data.strategy === "manual"
            ? data.rounds
                .filter((r) => r.id !== data.currentRoundKey)
                .map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.label}
                  </SelectItem>
                ))
            : data.previousVersions.map((v) => (
                <SelectItem key={v} value={v}>
                  Versão {v}
                </SelectItem>
              ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// Por que este documento está na fila. A pesquisadora abria um formulário já
// preenchido sem nada na tela explicando se aquilo era uma codificação dela pela
// metade ou uma resposta completa que voltou porque pertence a outra rodada — e
// lia as duas como "o sistema não salvou o que eu respondi" (#608).
//
// `current_done` não aparece: o filtro de rodada padrão o exclui server-side, e
// no `?round=all` ele chega aqui como o único estado sem pendência — daí o
// rótulo neutro. Ícone + texto, nunca só cor (WCAG 1.4.1).
const ROUND_STATUS_TAG: Record<
  DocRoundStatus["kind"],
  { label: string; Icon: typeof CircleDashed; className: string } | null
> = {
  no_response: {
    label: "Nunca respondido",
    Icon: CircleDashed,
    className: "text-muted-foreground",
  },
  current_pending: {
    label: "Incompleto",
    Icon: CircleDot,
    className: "text-amber-700 dark:text-amber-500",
  },
  // O motivo de `previous` depende da estratégia de rodadas do projeto: em
  // `schema_version` a resposta voltou porque o schema mudou, mas em `manual`
  // ela pertence a uma rodada que o coordenador definiu, sem schema nenhum
  // envolvido. Cravar "mudança no schema" mentiria na metade dos projetos, então
  // o enunciado fica no fato comum às duas e o `label` que `classifyDocStatus`
  // já produz (rótulo da rodada ou semver) entra como identificação.
  previous: {
    label: "Respondido em rodada anterior",
    Icon: RotateCcw,
    className: "text-muted-foreground",
  },
  current_done: null,
};

function RoundStatusTag({ status }: { status: DocRoundStatus | undefined }) {
  const tag = status ? ROUND_STATUS_TAG[status.kind] : null;
  if (!tag) return null;
  const { label, Icon, className } = tag;
  const detail = status?.kind === "previous" ? status.label : undefined;
  return (
    <span className={cn("flex shrink-0 items-center gap-1 text-xs", className)}>
      <Icon className="size-3.5" aria-hidden />
      {detail ? `${label} (${detail})` : label}
    </span>
  );
}

function AssignedDocSection({
  doc,
  onToggleFullscreen,
}: {
  doc: Extract<DocSection, { variant: "assigned" }>;
  onToggleFullscreen: () => void;
}) {
  return (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate font-medium">{doc.title}</span>
        {doc.parecerUrl && <CopyLinkButton url={doc.parecerUrl} />}
        <RoundStatusTag status={doc.roundStatus} />
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="size-6 disabled:opacity-50"
          onClick={() => doc.onNavigate(doc.index - 1)}
          disabled={doc.index === 0}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span className="tabular-nums text-muted-foreground text-xs">
          {doc.index + 1}/{doc.total}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 disabled:opacity-50"
          onClick={() => doc.onNavigate(doc.index + 1)}
          disabled={doc.index === doc.total - 1}
        >
          <ChevronRight className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 ml-1"
          onClick={onToggleFullscreen}
        >
          <Maximize2 className="size-3.5" />
        </Button>
      </div>
    </>
  );
}

function BrowseDocSection({
  doc,
  onToggleFullscreen,
  canRunLlm,
}: {
  doc: Extract<DocSection, { variant: "browse" }>;
  onToggleFullscreen: () => void;
  canRunLlm: boolean;
}) {
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 shrink-0"
        onClick={doc.onBack}
        disabled={doc.submitting}
      >
        <ArrowLeft className="size-4" />
      </Button>
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <span className="truncate font-medium">{doc.title}</span>
        {doc.parecerUrl && <CopyLinkButton url={doc.parecerUrl} />}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <Badge variant="secondary" className="text-xs">
          {doc.responseCount}{" "}
          {doc.responseCount === 1 ? "resposta" : "respostas"}
        </Badge>
        <RunLlmButton
          projectId={doc.projectId}
          documentId={doc.documentId}
          canRunLlm={canRunLlm}
        />
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={doc.onRandom}
          disabled={doc.submitting}
        >
          <Shuffle className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={onToggleFullscreen}
        >
          <Maximize2 className="size-3.5" />
        </Button>
      </div>
    </>
  );
}
