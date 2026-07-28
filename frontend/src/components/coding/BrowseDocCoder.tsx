"use client";

import { useCallback, useRef, useState } from "react";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { DocumentReader } from "./DocumentReader";
import { QuestionsPanel, type OutOfScopeConfig } from "./QuestionsPanel";
import { FullscreenNav } from "./FullscreenNav";
import { clearHiddenConditionalAnswers } from "@/lib/conditional";
import type { CodingDocument } from "@/hooks/useDocumentForCoding";
import type { PydanticField } from "@/lib/types";

/**
 * Rascunho editável de codificação (respostas + nota), reportado pelo
 * `BrowseDocCoder` para cima e lido pelo autosave-on-exit do container.
 */
export interface CodingDraft {
  answers: Record<string, unknown>;
  notes: string;
}

// Props que o container repassa INALTERADAS ao coder. Declaradas uma vez e
// reusadas por `BrowseCodingView`, que apenas as encaminha: manter as duas
// listas à mão fazia as assinaturas divergirem a cada campo novo, e era
// duplicação real (o gate do fallow a flagrou).
export interface ForwardedCodingProps {
  fields: PydanticField[];
  submitting: boolean;
  readOnly: boolean;
  isFullscreen: boolean;
  /** Título exibido na barra de fullscreen. */
  title: string;
  responseCount: number;
  onToggleFullscreen: () => void;
  onReorder: (newOrder: string[]) => void;
  /** Dispara o envio; o container faz o `saveResponse` + coordenação. */
  onSubmit: (draft: CodingDraft) => void;
  /** Reporta o rascunho atual para cima (autosave-on-exit + dirty tracking). */
  onDraftChange: (draft: CodingDraft) => void;
  outOfScope?: OutOfScopeConfig;
}

interface BrowseDocCoderProps extends ForwardedCodingProps {
  /** Documento já carregado (texto + respostas/notas iniciais). */
  doc: CodingDocument;
}

/**
 * Coder de um único documento do modo Explorar. Filho **keyed por docId** no
 * container: o estado editável é semeado via lazy `useState` a partir do `doc`
 * já carregado (sem `setState` em effect), e remonta limpo a cada doc.
 *
 * Não guarda o doc selecionado em estado no container nem usa effect de
 * deep-link — é o que mantém o `CodingPage` sem estado derivado nem `setState`
 * em effect (o débito de react-doctor que o refactor zera). O rascunho é
 * reportado para cima (`onDraftChange`) para o autosave-on-exit centralizado
 * (#28) ler via ref.
 */
export function BrowseDocCoder({
  doc,
  fields,
  submitting,
  readOnly,
  isFullscreen,
  title,
  responseCount,
  onToggleFullscreen,
  onReorder,
  onSubmit,
  onDraftChange,
  outOfScope,
}: BrowseDocCoderProps) {
  const [answers, setAnswers] = useState<Record<string, unknown>>(
    () => doc.initialAnswers,
  );
  const [notes, setNotes] = useState(() => doc.initialNotes);

  // Espelho do rascunho corrente. Lê/escreve sempre o valor atual (não a
  // closure), então edições no mesmo tick não se sobrescrevem e os callbacks
  // ficam estáveis (deps só do callback do pai). O filho é keyed por docId, então
  // o ref reinicia limpo a cada doc junto com o estado.
  const draftRef = useRef<CodingDraft>({ answers, notes });

  // Durante um save em voo (`submitting`) a edição congela: o container já tirou
  // o snapshot do rascunho que está salvando e, ao concluir, descarta o draftRef
  // e navega. Sem este guard, teclas digitadas no meio do save atualizariam o
  // draftRef tarde demais e seriam perdidas silenciosamente.
  const handleAnswer = useCallback(
    (fieldName: string, value: unknown) => {
      if (submitting) return;
      // Ao mudar uma resposta, limpa as condicionais que ficaram órfãs —
      // mesma invariante do modo Atribuídos (`CodingPage.handleAnswer`, #252).
      const next = clearHiddenConditionalAnswers(fields, {
        ...draftRef.current.answers,
        [fieldName]: value,
      });
      draftRef.current = { answers: next, notes: draftRef.current.notes };
      setAnswers(next);
      onDraftChange(draftRef.current);
    },
    [onDraftChange, submitting, fields],
  );

  const handleNotesChange = useCallback(
    (next: string) => {
      if (submitting) return;
      draftRef.current = { answers: draftRef.current.answers, notes: next };
      setNotes(next);
      onDraftChange(draftRef.current);
    },
    [onDraftChange, submitting],
  );

  const handleSubmit = useCallback(() => {
    onSubmit(draftRef.current);
  }, [onSubmit]);

  return (
    <>
      {isFullscreen && (
        <FullscreenNav
          title={title}
          responseCount={responseCount}
          onExit={onToggleFullscreen}
        />
      )}
      <ResizablePanelGroup className="flex-1">
        <ResizablePanel defaultSize={55} minSize={25}>
          <DocumentReader text={doc.document.text} />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={45} minSize={25}>
          <QuestionsPanel
            fields={fields}
            answers={answers}
            onAnswer={handleAnswer}
            onSubmit={handleSubmit}
            submitting={submitting}
            notes={notes}
            onNotesChange={handleNotesChange}
            readOnly={readOnly}
            onReorder={onReorder}
            outOfScope={outOfScope}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </>
  );
}
