"use client";

import { useState } from "react";
import { CustomAnswerInput } from "./CustomAnswerInput";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Lightbulb } from "lucide-react";
import { AddNoteButton } from "@/components/shared/AddNoteButton";
import { SuggestFieldDialog } from "@/components/stats/SuggestFieldDialog";
import { formatVerdictDisplay } from "@/lib/verdict-display";
import type { VerdictInfo } from "@/lib/compare-reviews";
import type { PydanticField } from "@/lib/types";
import { PendingConfirmBar } from "./PendingConfirmBar";
import {
  pendingVerdictLabel,
  readOnlyTitle,
  type PendingVerdict,
  type VerdictOrigin,
} from "./compare-types";
import { useVerdictOrigin } from "./compare-field-scope";

interface DivergenceActionsPanelProps {
  readOnly: boolean;
  projectId: string;
  documentTitle: string;
  fieldDescription: string;
  fields: PydanticField[];
  isMulti: boolean;
  existingVerdict: VerdictInfo | null;
  pendingVerdict: PendingVerdict | null;
  onPrepareVerdict: (pending: PendingVerdict) => void;
  comment: string;
  onCommentChange: (value: string) => void;
  /**
   * Confirmação do rascunho quando ele NÃO nasceu num card — Ambíguo, Pular e
   * resposta nova são criados aqui, e três das quatro variantes de
   * `PendingVerdict` passam por este painel. `null` quando a barra já está
   * ancorada no card, para que exista exatamente um controle de confirmação no
   * DOM por vez.
   */
  pendingConfirm: {
    onConfirm: () => void;
    onDiscard: () => void;
    isSaving: boolean;
  } | null;
}

// Ações do campo divergente: marcadores Ambíguo/Pular + resposta nova, veredito
// anterior e a linha de feedback (comentário, nota, sugestão de schema). O
// dialog de sugestão mora aqui junto do seu único gatilho (o botão Sugerir).
export function DivergenceActionsPanel({
  readOnly,
  projectId,
  documentTitle,
  fieldDescription,
  fields,
  isMulti,
  existingVerdict,
  pendingVerdict,
  onPrepareVerdict,
  comment,
  onCommentChange,
  pendingConfirm,
}: DivergenceActionsPanelProps) {
  // Documento e campo vêm do escopo, não de props: é a MESMA origem que carimba
  // os rascunhos criados aqui e a que endereça a nota e a sugestão de schema,
  // então não há como o painel anotar um campo e decidir sobre outro (#613).
  const origin = useVerdictOrigin();
  const { documentId, fieldName } = origin;
  const [suggestOpen, setSuggestOpen] = useState(false);
  const writeTitle = readOnlyTitle(readOnly);
  const suggestionTitle = readOnlyTitle(
    readOnly,
    "Sugerir alteração ao codebook neste campo",
  );

  return (
    <>
      {!isMulti && (
        <SpecialVerdictMarkers
          readOnly={readOnly}
          writeTitle={writeTitle}
          origin={origin}
          documentId={documentId}
          fieldName={fieldName}
          existingVerdict={existingVerdict}
          pendingVerdict={pendingVerdict}
          onPrepareVerdict={onPrepareVerdict}
        />
      )}

      {pendingVerdict && pendingConfirm && (
        <PendingConfirmBar
          label={pendingVerdictLabel(pendingVerdict)}
          showLabel
          isSaving={pendingConfirm.isSaving}
          onConfirm={pendingConfirm.onConfirm}
          onDiscard={pendingConfirm.onDiscard}
        />
      )}

      {existingVerdict && (
        <div className="mt-2 rounded-md bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
          Veredito anterior:{" "}
          <span className="font-medium text-foreground">
            {formatVerdictDisplay(existingVerdict.verdict)}
          </span>
          {existingVerdict.comment && (
            <span className="ml-1">
              &mdash; &ldquo;{existingVerdict.comment}&rdquo;
            </span>
          )}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Input
          placeholder="Comentário (opcional)"
          value={comment}
          onChange={(e) => onCommentChange(e.target.value)}
          disabled={readOnly}
          title={writeTitle}
          className="flex-1 min-w-[180px] text-sm"
        />
        <AddNoteButton
          key={documentId}
          projectId={projectId}
          documentId={documentId}
          documentTitle={documentTitle}
          fieldName={fieldName}
          fieldLabel={fieldDescription}
          variant="outline"
          size="sm"
          label="Anotar"
          disabled={readOnly}
          disabledReason={writeTitle}
        />
        <Button
          variant="outline"
          size="sm"
          className="gap-1"
          onClick={() => setSuggestOpen(true)}
          title={suggestionTitle}
          disabled={readOnly}
        >
          <Lightbulb className="size-3.5" />
          Sugerir
        </Button>
      </div>

      <SuggestFieldDialog
        // Remonta ao trocar de campo: o form do dialog renasce semeado pelos
        // valores do novo campo, dispensando o reset-em-render por prop.
        key={fieldName}
        projectId={projectId}
        fieldName={fieldName}
        allFields={fields}
        open={suggestOpen}
        onOpenChange={setSuggestOpen}
      />
    </>
  );
}

/**
 * Os três caminhos de decisão que não vêm de um card: Ambíguo, Pular e resposta
 * nova. Extraído do corpo do painel porque cada botão carrega a mesma pergunta
 * em duas versões — "é o rascunho atual?" e, na falta de rascunho, "é o veredito
 * já gravado?" —, e essas seis condições dominavam a complexidade do painel sem
 * dizer nada sobre o resto dele (nota, sugestão de schema, veredito anterior).
 *
 * Nenhum deles GRAVA: todos preparam um rascunho, que só vira linha em `reviews`
 * pela confirmação explícita (#417).
 */
function SpecialVerdictMarkers({
  readOnly,
  writeTitle,
  origin,
  documentId,
  fieldName,
  existingVerdict,
  pendingVerdict,
  onPrepareVerdict,
}: {
  readOnly: boolean;
  writeTitle: string | undefined;
  origin: VerdictOrigin;
  documentId: string;
  fieldName: string;
  existingVerdict: VerdictInfo | null;
  pendingVerdict: PendingVerdict | null;
  onPrepareVerdict: (pending: PendingVerdict) => void;
}) {
  // O rascunho, quando existe, é quem manda no destaque: ele representa a
  // decisão que a revisora está tomando agora, e o veredito gravado é apenas o
  // que valia antes dela abrir o campo.
  const marked = (kind: PendingVerdict["kind"], savedVerdict: string) =>
    cn(
      (pendingVerdict
        ? pendingVerdict.kind === kind
        : existingVerdict?.verdict === savedVerdict) &&
        "border-brand bg-brand/10 text-brand",
    );

  return (
    <div className="mt-2 flex flex-wrap gap-1">
      <Button
        variant="outline"
        size="sm"
        className={marked("ambiguous", "ambiguo")}
        onClick={() =>
          onPrepareVerdict({ kind: "ambiguous", verdict: "ambiguo", origin })
        }
        disabled={readOnly}
        title={writeTitle}
      >
        [A] Ambíguo
      </Button>
      <Button
        variant="outline"
        size="sm"
        className={marked("skip", "pular")}
        onClick={() =>
          onPrepareVerdict({ kind: "skip", verdict: "pular", origin })
        }
        disabled={readOnly}
        title={writeTitle}
      >
        [S] Pular
      </Button>
      {/*
        "Nenhuma correta" + input de resposta nova (issue #247, ponto 4). Keyed
        por doc|campo: navegar remonta e reseta o estado interno (aberto/valor)
        sem reset-em-effect — react-doctor só aceita key={identidade} para
        reset-on-prop-change.
      */}
      <CustomAnswerInput
        key={`${documentId}|${fieldName}`}
        readOnly={readOnly}
        currentValue={savedCustomAnswer(existingVerdict)}
        pendingValue={
          pendingVerdict?.kind === "custom" ? pendingVerdict.verdict : null
        }
        onSubmit={(value) =>
          onPrepareVerdict({ kind: "custom", verdict: value, origin })
        }
      />
    </div>
  );
}

/**
 * A resposta custom já gravada neste campo, se houver. Num campo não-multi, um
 * veredito de texto sem `chosenResponseId` que não seja marcador especial é, por
 * construção, uma resposta digitada — o voto num card sempre carrega o
 * `chosenResponseId`. Devolvê-la destaca o botão e re-semeia o input ao
 * revisitar o campo, em paridade com Ambíguo/Pular.
 */
function savedCustomAnswer(existingVerdict: VerdictInfo | null): string | null {
  if (!existingVerdict) return null;
  if (existingVerdict.chosenResponseId) return null;
  const { verdict } = existingVerdict;
  if (verdict === "ambiguo" || verdict === "pular") return null;
  return verdict;
}
