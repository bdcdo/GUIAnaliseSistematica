"use client";

import { AgreementGroup, type FieldEquivalencePair } from "./AgreementGroup";
import { MultiOptionReview } from "./MultiOptionReview";
import { DivergenceActionsPanel } from "./DivergenceActionsPanel";
import { UnansweredNotice } from "./UnansweredNotice";
import { CompareFieldScope } from "./compare-field-scope";
import { Button } from "@/components/ui/button";
import { CheckCircle2 } from "lucide-react";
import {
  readOnlyTitle,
  type PendingVerdict,
  type VerdictOrigin,
} from "./compare-types";
import type { VerdictInfo } from "@/lib/compare-reviews";
import type { PydanticField } from "@/lib/types";

export interface ComparisonResponse {
  id: string;
  respondent_type: "humano" | "llm";
  respondent_name: string;
  respondent_id: string | null;
  answer: unknown;
  justification?: string;
  is_latest: boolean;
  isFieldStale: boolean;
  schemaVersion?: string | null;
}

// Affordances de equivalência agrupadas: o painel carrega uma config estruturada
// em vez de dois booleanos soltos (`allowEquivalence`, `canManageAnyPair`) e os
// repassa ao AgreementGroup.
export interface EquivalenceConfig {
  allow: boolean;
  canManageAnyPair: boolean;
}

interface CompareFieldReviewProps {
  readOnly: boolean;
  projectId: string;
  documentId: string;
  documentTitle: string;
  fieldName: string;
  fieldDescription: string;
  fields: PydanticField[];
  isMulti: boolean;
  displayOptions: string[];
  responses: ComparisonResponse[];
  existingVerdict: VerdictInfo | null;
  pendingVerdict: PendingVerdict | null;
  isDivergent: boolean;
  isSavingVerdict: boolean;
  onVerdict: (verdict: string, chosenResponseId?: string) => void;
  onPrepareVerdict: (pending: PendingVerdict) => void;
  onMarkReviewed: () => void;
  comment: string;
  onCommentChange: (value: string) => void;
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

/**
 * Tudo que pertence a UM campo divergente: os cards de resposta (ou a grade de
 * um campo multi), o aviso de quem não respondeu e as ações da divergência.
 *
 * Existe como componente próprio para que a identidade do campo seja UMA
 * fronteira de montagem, não três keys irmãs coincidentes — que era o desenho
 * anterior, em que `AgreementGroup`, `DivergenceActionsPanel` e
 * `MultiOptionReview` ficavam keyados pela mesma string em posições distintas
 * do mesmo pai. Duas consequências, e a segunda é a que importa para a #613:
 *
 * 1. a troca de campo passa a ser uma única deleção de subárvore, então um
 *    resíduo de DOM (o defeito da #613, cuja causa no reconciler segue em
 *    investigação) seria um painel inteiro e coerente, nunca meia tela de cards
 *    do campo antigo intercalada com as ações do campo atual;
 * 2. o `CompareFieldScope` montado aqui carimba a origem de toda decisão criada
 *    nesta subárvore. Como uma subárvore fantasma não re-renderiza, ela nunca
 *    passa a ver o campo novo — e o rascunho que ela produz é recusado na
 *    fronteira de escrita em vez de gravar no campo errado.
 *
 * Fica DE FORA da fronteira, deliberadamente, tudo que não é do campo: o
 * cabeçalho, os ProgressDots, o rodapé de confirmação e o container de scroll —
 * assim a troca de campo não zera o `scrollTop` nem rouba o foco.
 */
export function CompareFieldReview({
  readOnly,
  projectId,
  documentId,
  documentTitle,
  fieldName,
  fieldDescription,
  fields,
  isMulti,
  displayOptions,
  responses,
  existingVerdict,
  pendingVerdict,
  isDivergent,
  isSavingVerdict,
  onVerdict,
  onPrepareVerdict,
  onMarkReviewed,
  comment,
  onCommentChange,
  equivalence,
  equivalences,
  onConfirmEquivalent,
  onUnmarkEquivalencePair,
  currentUserId,
}: CompareFieldReviewProps) {
  return (
    <CompareFieldScope documentId={documentId} fieldName={fieldName}>
      {isMulti ? (
        <MultiOptionReview
          readOnly={readOnly}
          options={displayOptions}
          responses={responses}
          existingVerdict={existingVerdict}
          isSubmitting={isSavingVerdict}
          onSubmit={(verdictJson) => onVerdict(verdictJson)}
        />
      ) : (
        <AgreementGroup
          readOnly={readOnly}
          responses={responses.map((r) => ({
            id: r.id,
            respondent_type: r.respondent_type,
            respondent_name: r.respondent_name,
            answer: r.answer,
            justification: r.justification,
            is_latest: r.is_latest,
            isFieldStale: r.isFieldStale,
            schemaVersion: r.schemaVersion,
          }))}
          existingVerdict={existingVerdict}
          pendingVerdict={pendingVerdict}
          onVote={(displayAnswer, chosenResponseId) =>
            onPrepareVerdict({
              kind: "response",
              verdict: displayAnswer,
              chosenResponseId,
              // Origem literal das props deste render — e não do container —,
              // que é o que faz um clique em card fantasma carregar o campo
              // fantasma em vez de herdar o campo atual (#613).
              origin: { documentId, fieldName },
            })
          }
          allowEquivalence={equivalence.allow}
          equivalences={equivalences}
          onConfirmEquivalent={(responseIds, gabaritoId, verdictDisplay) =>
            onConfirmEquivalent(
              { documentId, fieldName },
              responseIds,
              gabaritoId,
              verdictDisplay,
            )
          }
          onUnmarkPair={onUnmarkEquivalencePair}
          currentUserId={currentUserId}
          canManageAnyPair={equivalence.canManageAnyPair}
        />
      )}

      <UnansweredNotice responses={responses} />

      {isDivergent ? (
        <DivergenceActionsPanel
          readOnly={readOnly}
          projectId={projectId}
          documentTitle={documentTitle}
          fieldDescription={fieldDescription}
          fields={fields}
          isMulti={isMulti}
          existingVerdict={existingVerdict}
          pendingVerdict={pendingVerdict}
          onPrepareVerdict={onPrepareVerdict}
          comment={comment}
          onCommentChange={onCommentChange}
        />
      ) : (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-green-500/20 bg-green-500/5 px-3 py-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <CheckCircle2 className="size-3.5 text-green-600" />
            Concordante: todos os respondentes concordam.
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            onClick={onMarkReviewed}
            disabled={readOnly}
            title={readOnlyTitle(readOnly)}
          >
            Marcar doc como revisado
          </Button>
        </div>
      )}
    </CompareFieldScope>
  );
}
