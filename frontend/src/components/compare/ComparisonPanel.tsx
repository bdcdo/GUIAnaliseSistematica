"use client";

import { useEffect, useMemo, useRef } from "react";
import { ProgressDots } from "../coding/ProgressDots";
import type { FieldEquivalencePair } from "./AgreementGroup";
import {
  CompareFieldReview,
  type ComparisonResponse,
  type EquivalenceConfig,
} from "./CompareFieldReview";
import { KeyboardHints } from "./KeyboardHints";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { normalizeForComparison } from "@/lib/utils";
import {
  buildResponseGroupKeys,
} from "@/lib/equivalence";
import {
  comparableMultiOptions,
  multiSelectionSets,
} from "@/lib/compare-multi-options";
import { ArrowRight, CheckCircle2, MessageSquare, Lightbulb } from "lucide-react";
import { FieldHeaderLabel } from "@/components/shared/FieldHeaderLabel";
import type { VerdictInfo } from "@/lib/compare-reviews";
import type { PydanticField } from "@/lib/types";
import {
  pendingVerdictLabel,
  type PendingVerdict,
  type VerdictOrigin,
} from "./compare-types";

// Conclusão do documento + navegação da fila. Discriminated union: `hasNextDoc`
// e `onNextDoc` só fazem sentido depois que a revisão do documento terminou, então
// o tipo torna "avançar com doc incompleto" irrepresentável — mesmo idioma do
// `equivalenceMode` do AnswerCard (#322). Também tira dois booleanos soltos
// (`isDocComplete`, `hasNextDoc`) da interface do painel, derrubando a contagem
// de `no-many-boolean-props` e os braços implícitos de `prefer-explicit-variants`.
type DocStatus =
  | { complete: false }
  | { complete: true; hasNextDoc: boolean; onNextDoc: () => void };

interface ComparisonPanelProps {
  readOnly: boolean;
  projectId: string;
  documentId: string;
  documentTitle: string;
  fieldName: string;
  fieldDescription: string;
  fieldHelpText?: string;
  fieldType?: "single" | "multi" | "text" | "date";
  fieldOptions?: string[] | null;
  fields: PydanticField[];
  fieldIndex: number;
  totalFields: number;
  responses: ComparisonResponse[];
  existingVerdict: VerdictInfo | null;
  reviewed: boolean[];
  isDivergent: boolean;
  docStatus: DocStatus;
  onFieldNavigate: (index: number) => void;
  onVerdict: (verdict: string, chosenResponseId?: string) => void;
  pendingVerdict: PendingVerdict | null;
  onPrepareVerdict: (pending: PendingVerdict) => void;
  onConfirmPendingVerdict: () => void;
  onDiscardPendingVerdict: () => void;
  isSavingVerdict: boolean;
  onMarkReviewed: () => void;
  comment: string;
  onCommentChange: (value: string) => void;
  commentCount: number;
  suggestionCount: number;
  equivalence: EquivalenceConfig;
  equivalences: FieldEquivalencePair[];
  onConfirmEquivalent: (
    origin: VerdictOrigin,
    responseIds: string[],
    gabaritoId: string,
    verdictDisplay: string,
  ) => Promise<void>;
  onUnmarkEquivalencePair: (pairId: string) => Promise<void>;
  currentUserId: string;
}

export function ComparisonPanel({
  readOnly,
  projectId,
  documentId,
  documentTitle,
  fieldName,
  fieldDescription,
  fieldHelpText,
  fieldType,
  fieldOptions,
  fields,
  fieldIndex,
  totalFields,
  responses,
  existingVerdict,
  reviewed,
  isDivergent,
  docStatus,
  onFieldNavigate,
  onVerdict,
  pendingVerdict,
  onPrepareVerdict,
  onConfirmPendingVerdict,
  onDiscardPendingVerdict,
  isSavingVerdict,
  onMarkReviewed,
  comment,
  onCommentChange,
  commentCount,
  suggestionCount,
  equivalence,
  equivalences,
  onConfirmEquivalent,
  onUnmarkEquivalencePair,
  currentUserId,
}: ComparisonPanelProps) {
  // Primitivos derivados para deps estáveis do effect (o objeto
  // `docStatus` é recriado a cada render).
  const docComplete = docStatus.complete;
  const docHasNext = docStatus.complete && docStatus.hasNextDoc;

  // Quando o documento é concluído, o botão "Próximo parecer" recebe foco
  // automático para que um único Enter avance — sem timer cego.
  const nextDocButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (docComplete && docHasNext) {
      nextDocButtonRef.current?.focus({ preventScroll: true });
    }
  }, [docComplete, docHasNext, documentId]);

  const isMulti = fieldType === "multi" && !!fieldOptions?.length;

  // Opções a exibir num multi: as do schema mais as que alguém marcou e que
  // saíram do schema depois. Sem a união, uma divergência causada por opção
  // removida — que `computeDivergentFieldNames` conta pela mesma primitiva —
  // não teria linha na tela: o revisor via tudo concordando e não conseguia
  // resolver o campo, que voltava à fila para sempre. Pior, `isAnswerCorrect`
  // compara o conjunto do veredito com o da resposta, então a opção nunca
  // renderizada nunca entrava no veredito e a resposta que a marcasse ficava
  // sem como ser julgada correta (#484). As do schema mantêm posição — e
  // portanto o atalho numérico. Calculado aqui, e não no MultiOptionReview,
  // para o `optionCount` dos atalhos não recomputar a mesma união e sair
  // dessincronizado.
  //
  // A primitiva é a mesma da divergência, mas o CONJUNTO DE ENTRADA é
  // deliberadamente mais amplo: `computeDivergentFieldNames` filtra por
  // staleness e visibilidade condicional antes de montar os conjuntos, e aqui
  // entram todas as respostas — inclusive as stale, que o painel exibe. Ou
  // seja, este conjunto contém o da divergência: nunca falta linha para uma
  // opção que divergiu, e pode sobrar linha para uma opção que só uma resposta
  // stale marcou. Sobrar é coerente com exibir a resposta stale; faltar é o
  // bug que este código corrige.
  const displayOptions = useMemo(
    () =>
      isMulti
        ? comparableMultiOptions(
            fieldOptions ?? [],
            multiSelectionSets(responses.map((r) => r.answer)),
          )
        : [],
    [isMulti, fieldOptions, responses],
  );

  const groupCount = useMemo(() => {
    const present = responses.filter((r) => r.answer !== undefined);
    const groupKeys = buildResponseGroupKeys(present, equivalences, (r) =>
      normalizeForComparison(r.answer),
    );
    const keys = new Set<string>();
    for (const r of present) keys.add(groupKeys.get(r.id) ?? r.id);
    return keys.size;
  }, [responses, equivalences]);

  const feedbackBadge = commentCount + suggestionCount;

  return (
    <div className="flex h-full flex-col">
      {/*
        `data-testid` é contrato de medição, não estilo: a comparação de área
        antes/depois da #610 mede a altura deste bloco em navegador, e casar por
        classe Tailwind quebraria no primeiro ajuste de layout — em silêncio e
        sempre para o lado do verde. Mesma razão do `agreement-group`.

        Este cabeçalho é `shrink-0` ACIMA do único scroller do painel: tudo que
        cresce aqui empurra os cards sem amortecimento. Daí a densidade `fixed`
        do FieldHeaderLabel e a caixa de tamanho constante do ProgressDots —
        juntos, tornam a altura deste bloco invariante entre campos.
      */}
      <div className="shrink-0 border-b px-4 py-1.5" data-testid="compare-header">
        <ProgressDots
          total={totalFields}
          currentIndex={fieldIndex}
          answered={reviewed}
          onNavigate={onFieldNavigate}
        />
        <div className="mt-1.5 flex items-start justify-between gap-2">
          <FieldHeaderLabel
            prefix={`Campo ${fieldIndex + 1}/${totalFields}:`}
            helpText={fieldHelpText}
            density={{
              kind: "fixed",
              clampLines: 2,
              fullText: fieldDescription || fieldName,
            }}
          >
            {fieldDescription || fieldName}
          </FieldHeaderLabel>
          <div className="flex shrink-0 items-center gap-1">
            {feedbackBadge > 0 && (
              <Badge
                variant="secondary"
                className="h-5 gap-1 px-1.5 text-[10px]"
                title={`${commentCount} nota(s), ${suggestionCount} sugestão(ões) de schema`}
              >
                <MessageSquare className="size-3" />
                {commentCount}
                {suggestionCount > 0 && (
                  <>
                    <Lightbulb className="ml-1 size-3" />
                    {suggestionCount}
                  </>
                )}
              </Badge>
            )}
            {isDivergent && (
              <KeyboardHints
                readOnly={readOnly}
                groupCount={groupCount}
                isMulti={isMulti}
                optionCount={isMulti ? displayOptions.length : undefined}
              />
            )}
          </div>
        </div>
      </div>

      {/*
        O container de scroll NÃO é keyado: preservá-lo entre campos é o que
        mantém o `scrollTop` da lista. Quem carrega a identidade do campo é o
        `CompareFieldReview` abaixo — fronteira ÚNICA de montagem, em vez das
        três keys irmãs coincidentes que existiam aqui (uma por slot). Ver o
        cabeçalho de CompareFieldReview para o porquê (#613).
      */}
      <div className="flex-1 overflow-y-auto px-4 py-2">
        <CompareFieldReview
          key={`${documentId}|${fieldName}|${readOnly}`}
          readOnly={readOnly}
          projectId={projectId}
          documentId={documentId}
          documentTitle={documentTitle}
          fieldName={fieldName}
          fieldDescription={fieldDescription}
          fields={fields}
          isMulti={isMulti}
          displayOptions={displayOptions}
          responses={responses}
          existingVerdict={existingVerdict}
          pendingVerdict={pendingVerdict}
          isDivergent={isDivergent}
          isSavingVerdict={isSavingVerdict}
          onVerdict={onVerdict}
          onPrepareVerdict={onPrepareVerdict}
          onMarkReviewed={onMarkReviewed}
          comment={comment}
          onCommentChange={onCommentChange}
          equivalence={equivalence}
          equivalences={equivalences}
          onConfirmEquivalent={onConfirmEquivalent}
          onUnmarkEquivalencePair={onUnmarkEquivalencePair}
          currentUserId={currentUserId}
        />
      </div>

      {isDivergent && !isMulti && (!docStatus.complete || pendingVerdict) && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-t bg-muted/20 px-4 py-2">
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {readOnly ? (
              "Decisões desabilitadas no modo somente leitura."
            ) : pendingVerdict ? (
              <>
                Selecionado:{" "}
                <span className="font-medium text-foreground">
                  {pendingVerdictLabel(pendingVerdict)}
                </span>
              </>
            ) : (
              "Escolha uma resposta para confirmar."
            )}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            {pendingVerdict && (
              <Button
                variant="ghost"
                size="sm"
                disabled={readOnly || isSavingVerdict}
                onClick={onDiscardPendingVerdict}
              >
                Descartar
              </Button>
            )}
            <Button
              size="sm"
              disabled={readOnly || !pendingVerdict || isSavingVerdict}
              onClick={onConfirmPendingVerdict}
            >
              {readOnly
                ? "Somente leitura"
                : isSavingVerdict
                  ? "Salvando..."
                  : "Confirmar"}
            </Button>
          </div>
        </div>
      )}

      {docStatus.complete && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-green-500/20 bg-green-500/5 px-4 py-2">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CheckCircle2 className="size-3.5 text-green-600" />
            Revisão do documento concluída.
          </span>
          {docStatus.hasNextDoc ? (
            <Button
              ref={nextDocButtonRef}
              size="sm"
              className="gap-1"
              disabled={isSavingVerdict}
              onClick={docStatus.onNextDoc}
            >
              Próximo parecer
              <ArrowRight className="size-3.5" />
            </Button>
          ) : (
            <span className="text-xs font-medium text-green-700">
              Fila concluída.
            </span>
          )}
        </div>
      )}

    </div>
  );
}
