"use client";

import { useMemo, useRef } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { SortableQuestion } from "./SortableQuestion";
import { SubmitBar } from "./SubmitBar";
import { OutOfScopeToggle } from "./OutOfScopeToggle";
import { useOutOfScopeState, type OutOfScopeConfig } from "./useOutOfScopeState";
import { useScrollToRevealedField } from "./useScrollToRevealedField";
import { useQuestionReorder } from "./useQuestionReorder";
import { useQuestionValidation } from "./useQuestionValidation";
import { MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { isFieldVisible } from "@/lib/conditional";
import type { PydanticField } from "@/lib/types";
import { DndContext, closestCenter } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";

export type { OutOfScopeConfig };

export interface QuestionsPanelProps {
  fields: PydanticField[];
  answers: Record<string, unknown>;
  onAnswer: (fieldName: string, value: unknown) => void;
  onSubmit: () => void;
  submitting?: boolean;
  notes?: string;
  onNotesChange?: (notes: string) => void;
  readOnly?: boolean;
  onReorder?: (newOrder: string[]) => void;
  /** Presente = renderiza a pergunta "Documento fora do escopo?" primeiro. */
  outOfScope?: OutOfScopeConfig;
}

export function QuestionsPanel({ fields, answers, onAnswer, onSubmit, submitting = false, notes = "", onNotesChange, readOnly = false, onReorder, outOfScope }: QuestionsPanelProps) {
  const questionRefs = useRef<(HTMLDivElement | null)[]>([]);

  const { outOfScopeState, setOutOfScopeState, outOfScopeBlocked } = useOutOfScopeState(outOfScope);

  const visibleFields = useMemo(
    () =>
      fields.filter(
        (f) => f.target !== "none" && isFieldVisible(f, answers),
      ),
    [fields, answers],
  );
  const visibleNames = useMemo(
    () => new Set(visibleFields.map((f) => f.name)),
    [visibleFields],
  );
  const allNamesKey = useMemo(
    () => fields.map((f) => f.name).sort().join(","),
    [fields],
  );

  // A limpeza de respostas órfãs de condicionais que ficaram invisíveis vive no
  // pai (`CodingPage`), aplicada no updater de `answers` ao mudar uma resposta
  // (ver #252) — não mais num effect que empurrava dado de volta via `onAnswer`.
  useScrollToRevealedField(visibleFields, visibleNames, allNamesKey, readOnly, questionRefs);

  const {
    highlightedFields,
    isAnswered,
    handleAnswerWithClear,
    handleSubmitWithValidation,
    requiredFields,
    answeredRequiredCount,
    missingRequiredCount,
  } = useQuestionValidation(
    visibleFields,
    answers,
    onAnswer,
    onSubmit,
    submitting,
    outOfScopeBlocked,
    questionRefs,
  );

  const { dragEnabled, sensors, handleDragEnd } = useQuestionReorder(
    fields,
    visibleFields,
    onReorder,
    readOnly,
  );

  const questionItems = (
    <>
      {visibleFields.map((field, i) => (
        <SortableQuestion
          key={field.name}
          field={field}
          index={i}
          isHighlighted={highlightedFields.has(field.name)}
          isAnswered={isAnswered(field)}
          answerValue={answers[field.name]}
          onAnswerChange={(val) => handleAnswerWithClear(field.name, val)}
          setRef={(el) => {
            questionRefs.current[i] = el;
          }}
          draggable={dragEnabled}
        />
      ))}
    </>
  );

  return (
    <div className="flex h-full flex-col bg-card">
      <div className="border-b px-4 py-2.5 shrink-0">
        <p className="text-xs font-medium text-muted-foreground">
          Perguntas ({answeredRequiredCount}/{requiredFields.length} obrigatórias respondidas)
        </p>
      </div>

      <div
        // Durante um save em voo a edição congela (os handlers a montante
        // descartam as teclas). Sem pista visual o usuário digitaria no vazio;
        // aqui o bloco fica esmaecido e sem resposta a mouse — `aria-busy`
        // anuncia o estado a leitores de tela. O teclado segue barrado pelos
        // guards a montante (`FieldRenderer` não aceita `disabled`).
        aria-busy={submitting}
        className={cn(
          "flex-1 overflow-y-auto p-4 space-y-2.5",
          submitting && "pointer-events-none opacity-60",
        )}
      >
        {outOfScope && (
          <OutOfScopeToggle
            projectId={outOfScope.projectId}
            documentId={outOfScope.documentId}
            documentTitle={outOfScope.documentTitle}
            state={outOfScopeState}
            onStateChange={setOutOfScopeState}
            disabled={readOnly}
          />
        )}

        {/* Doc sinalizado: perguntas esmaecidas e inertes, mas o toggle acima
            fica FORA do bloco — quem sinalizou precisa conseguir desfazer. */}
        <div
          aria-disabled={outOfScopeBlocked}
          className={cn(
            "space-y-2.5",
            outOfScopeBlocked && "pointer-events-none opacity-60",
          )}
        >
          {dragEnabled ? (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={visibleFields.map((f) => f.name)}
                strategy={verticalListSortingStrategy}
              >
                {questionItems}
              </SortableContext>
            </DndContext>
          ) : (
            questionItems
          )}

          {onNotesChange && (
            <Collapsible defaultOpen={!!notes}>
              <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
                <MessageSquare className="size-3.5" />
                Notas e sugestões (opcional)
                {notes && <span className="size-1.5 rounded-full bg-brand" />}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <Textarea
                  value={notes}
                  onChange={(e) => onNotesChange(e.target.value)}
                  disabled={submitting || readOnly || outOfScopeBlocked}
                  placeholder="Anotações, dúvidas ou sugestões sobre este documento..."
                  className="mt-2 text-sm min-h-[80px] resize-y"
                />
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      </div>

      <SubmitBar
        outOfScopeBlocked={outOfScopeBlocked}
        readOnly={readOnly}
        submitting={submitting}
        missingRequiredCount={missingRequiredCount}
        onClick={handleSubmitWithValidation}
      />
    </div>
  );
}
