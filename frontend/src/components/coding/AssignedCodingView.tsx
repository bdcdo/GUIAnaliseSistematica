"use client";

import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { Button } from "@/components/ui/button";
import { useDocumentText } from "@/hooks/useDocumentText";
import { DocumentReader } from "./DocumentReader";
import { QuestionsPanel, type QuestionsPanelProps } from "./QuestionsPanel";
import { FullscreenNav } from "./FullscreenNav";
import { CodingEmptyStates } from "./CodingEmptyStates";
import type { RoundFilterData } from "./CodingPage";
import type { AssignedDoc } from "@/lib/types";

interface AssignedCodingViewProps
  extends Omit<QuestionsPanelProps, "submitting" | "notes" | "onNotesChange" | "readOnly" | "onReorder"> {
  /** Doc atribuído atual — `undefined` quando não há nenhum a mostrar
   *  (lista vazia ou filtro de rodada sem pendências). */
  doc: AssignedDoc | undefined;
  /** Projeto do doc — o texto não vem mais na fila; é buscado por id. */
  projectId: string;
  title: string;
  docIndex: number;
  total: number;
  isFullscreen: boolean;
  onNavigate: (index: number) => void;
  onExitFullscreen: () => void;
  submitting: boolean;
  notes: string;
  onNotesChange: (notes: string) => void;
  readOnly: boolean;
  onReorder: (newOrder: string[]) => void;
  /** Todos os docs atribuídos foram codificados nesta sessão. */
  allDone: boolean;
  onExploreMore: () => void;
  hasAssignments: boolean;
  roundFilter?: RoundFilterData;
}

/**
 * Corpo do modo Atribuídos: cascata de estados (tudo concluído / sem doc /
 * leitor + perguntas), espelhando o padrão já usado por `BrowseCodingView`
 * para o modo Explorar — decidir aqui em vez de no container (#389).
 */
export function AssignedCodingView({
  doc,
  projectId,
  title,
  docIndex,
  total,
  isFullscreen,
  onNavigate,
  onExitFullscreen,
  fields,
  answers,
  onAnswer,
  onSubmit,
  submitting,
  notes,
  onNotesChange,
  readOnly,
  onReorder,
  outOfScope,
  allDone,
  onExploreMore,
  hasAssignments,
  roundFilter,
}: AssignedCodingViewProps) {
  // Antes de qualquer early-return: a ordem dos hooks precisa ser estável entre
  // os estados da cascata abaixo. `useDocumentText` aceita id nulo, então
  // `doc?.id` cobre os casos allDone/sem-doc sem disparar busca.
  const { text, loading: textLoading, error: textError, retry: retryText } =
    useDocumentText(projectId, doc?.id);

  // Diferente do container anterior (#389), este componente agora fica montado
  // o tempo todo em mode==="assigned" — a cascata abaixo decide o retorno via
  // early-return, em vez de o pai desmontar/remontar `AssignedCodingView` entre
  // os estados. Hoje isso não tem efeito porque o componente não guarda estado
  // próprio (sem useState/useRef/useEffect aqui). Se algum for adicionado
  // diretamente neste componente, ele sobreviverá indevidamente entre as
  // transições allDone -> no-doc -> doc normal — revisar este ponto nesse caso.
  if (allDone) {
    return (
      <CodingEmptyStates
        kind="all-done"
        count={total}
        onExploreMore={onExploreMore}
      />
    );
  }
  if (!doc) {
    return (
      <CodingEmptyStates
        kind="no-doc"
        hasAssignments={hasAssignments}
        roundFilter={roundFilter}
      />
    );
  }
  return (
    <>
      {isFullscreen && (
        <FullscreenNav
          title={title}
          currentIndex={docIndex}
          total={total}
          onNavigate={onNavigate}
          onExit={onExitFullscreen}
        />
      )}
      <ResizablePanelGroup className="flex-1">
        <ResizablePanel defaultSize={55} minSize={25}>
          {/* Só este painel alterna entre carregando/erro/texto. O
              QuestionsPanel ao lado fica montado de propósito: ele guarda o
              rascunho em andamento, e um early-return da tela inteira o
              desmontaria a cada navegação entre documentos. */}
          {textLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Carregando documento…
            </div>
          ) : textError ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <p className="text-sm text-muted-foreground">
                Não foi possível carregar o documento.
              </p>
              <Button variant="outline" size="sm" onClick={retryText}>
                Tentar novamente
              </Button>
            </div>
          ) : (
            <DocumentReader text={text ?? ""} />
          )}
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={45} minSize={25}>
          <QuestionsPanel
            key={doc.id}
            fields={fields}
            answers={answers}
            onAnswer={onAnswer}
            onSubmit={onSubmit}
            submitting={submitting}
            notes={notes}
            onNotesChange={onNotesChange}
            readOnly={readOnly}
            onReorder={onReorder}
            outOfScope={outOfScope}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </>
  );
}
