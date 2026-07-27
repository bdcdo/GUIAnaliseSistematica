"use client";

import { useCallback } from "react";
import { toast } from "sonner";
import {
  submitVerdict,
  markCompareDocReviewed,
  type ResponseSnapshotEntry,
} from "@/actions/reviews";
import {
  confirmEquivalentVerdict,
  unmarkEquivalencePair,
} from "@/actions/equivalences";
import type { ReviewsByDoc, VerdictInfo } from "@/lib/compare-reviews";
import {
  verdictOriginMatches,
  type CompareDocument,
  type FieldResponse,
  type VerdictOrigin,
} from "./compare-types";

interface UseCompareVerdictsParams {
  readOnly: boolean;
  projectId: string;
  currentDoc: CompareDocument | undefined;
  currentFieldName: string;
  isCurrentFieldDivergent: boolean;
  allDocDivergent: string[];
  localReviews: ReviewsByDoc;
  fieldResponses: FieldResponse[];
  comment: string;
  recordReview: (docId: string, fieldName: string, info: VerdictInfo) => void;
  goNextField: () => void;
}

export interface CompareVerdicts {
  // `origin` em primeira posição e obrigatório nas duas escritas: a fronteira
  // não confia no chamador para ter resolvido o campo certo (#613).
  handleVerdict: (
    origin: VerdictOrigin,
    verdict: string,
    chosenResponseId?: string,
  ) => Promise<boolean>;
  handleConfirmEquivalent: (
    origin: VerdictOrigin,
    responseIds: string[],
    gabaritoId: string,
    verdictDisplay: string,
  ) => Promise<void>;
  handleMarkReviewed: () => Promise<void>;
  handleUnmarkPair: (pairId: string) => Promise<void>;
}

export const SAVE_TIMEOUT_MS = 15_000;
const TIMEOUT_MESSAGE =
  "O salvamento não respondeu. Verifique a conexão e tente novamente.";

/**
 * Resolve a promise de uma server action em "salvou?", exibindo o toast
 * adequado no caminho de erro. Ponto único para os três modos de falha:
 * rejeição da action (fora do try dela, que o `void` do call site
 * descartaria em silêncio) vira log + mensagem genérica; `{ error }`
 * retornado vira toast com a mensagem da própria action; e uma promise que
 * NUNCA settles (fetch dropado num redeploy — issue #430) é resolvida como
 * erro pelo timeout, senão o `await` do chamador ficaria pendurado para
 * sempre com a trava de in-flight presa. Após o timeout, o settle tardio da
 * promise original é ignorado por completo — nenhum efeito pós-save (escrita
 * otimista, toast de sucesso, avanço de campo) roda fora de hora; se o save
 * tardio tiver persistido no servidor, reconfirmar recai no upsert
 * idempotente de `submitVerdict`.
 */
async function actionSucceeded(
  promise: Promise<{ error?: string }>,
  logLabel: string,
  logContext: Record<string, unknown>,
  rejectionMessage: string,
): Promise<boolean> {
  const result = await new Promise<{ error?: string } | void>((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      resolve({ error: TIMEOUT_MESSAGE });
    }, SAVE_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        // Rejeição tardia: o timeout já reportou o erro; um segundo toast
        // aqui chegaria fora de contexto.
        if (timedOut) return;
        console.error(logLabel, { error, ...logContext });
        toast.error(rejectionMessage);
        resolve({ error: "unexpected" });
      },
    );
  });
  if (result?.error) {
    if (result.error !== "unexpected") toast.error(result.error);
    return false;
  }
  return true;
}

/** Snapshot das respostas presentes no momento do veredito (auditoria). */
function buildSnapshot(fieldResponses: FieldResponse[]): ResponseSnapshotEntry[] {
  return fieldResponses
    .filter((r) => r.answer !== undefined)
    .map((r) => ({
      id: r.id,
      respondent_name: r.respondent_name,
      respondent_type: r.respondent_type,
      answer: r.answer,
      ...(r.justification ? { justification: r.justification } : {}),
    }));
}

type CompareWriteBlockReason =
  | "read-only"
  | "no-doc"
  | "no-field"
  | "not-divergent"
  | "origin-mismatch";

/**
 * Resultado do gate de escrita. Discriminado (e não um booleano) porque as
 * cinco razões de recusa levam a mensagens diferentes: colapsá-las num `false`
 * era exatamente o que fazia `handleVerdict` retornar sem dizer nada à revisora
 * (#613, "ruídos adjacentes"). O `doc` viaja no ramo `ok` para preservar o
 * estreitamento de tipo que o antigo type guard dava.
 */
type CompareWriteGate =
  | { ok: true; doc: CompareDocument }
  | { ok: false; reason: CompareWriteBlockReason };

const COMPARE_WRITE_BLOCK_MESSAGE: Record<CompareWriteBlockReason, string> = {
  // Os controles já nascem `disabled` em somente-leitura; chegar aqui significa
  // que um deles escapou do gate visual — a mensagem é o sinal desse bug.
  "read-only": "Modo somente leitura: nenhuma decisão é registrada.",
  "no-doc": "Nenhum parecer selecionado — recarregue a página.",
  "no-field": "Nenhum campo selecionado — recarregue a página.",
  "not-divergent":
    "Este campo não está mais divergente e não aceita veredito. Recarregue a página.",
  "origin-mismatch":
    "Essa resposta pertence a outro campo e não pode ser registrada aqui. Recarregue a página — a tela está exibindo conteúdo desatualizado.",
};

/**
 * Fronteira de escrita da Comparação. Valida a ORIGEM recebida (o campo em que
 * a decisão foi tomada) contra o campo atual, em vez de simplesmente confiar no
 * campo do render corrente — que era o buraco pelo qual um clique em card
 * fantasma gravava no campo seguinte (#613).
 */
function compareWriteGate(
  readOnly: boolean,
  currentDoc: CompareDocument | undefined,
  currentFieldName: string,
  isCurrentFieldDivergent: boolean,
  origin: VerdictOrigin,
): CompareWriteGate {
  if (readOnly) return { ok: false, reason: "read-only" };
  if (currentDoc === undefined) return { ok: false, reason: "no-doc" };
  if (currentFieldName.length === 0) return { ok: false, reason: "no-field" };
  if (!isCurrentFieldDivergent) return { ok: false, reason: "not-divergent" };
  if (!verdictOriginMatches(origin, currentDoc.id, currentFieldName)) {
    return { ok: false, reason: "origin-mismatch" };
  }
  return { ok: true, doc: currentDoc };
}

/** Recusa com mensagem visível; devolve `false` para o `return` do chamador. */
function rejectCompareWrite(
  reason: CompareWriteBlockReason,
  context: Record<string, unknown>,
): false {
  // `console.error` (e não warn) porque `origin-mismatch` só é alcançável se a
  // tela exibir conteúdo de um campo desmontado: se aparecer em produção, é um
  // vetor novo e queremos vê-lo.
  console.error("compare: escrita recusada", { reason, ...context });
  toast.error(COMPARE_WRITE_BLOCK_MESSAGE[reason], {
    // `id` fixo: cliques repetidos no mesmo card fantasma atualizam o mesmo
    // toast em vez de empilhar uma pilha de avisos idênticos.
    id: `compare-write-blocked-${reason}`,
  });
  return false;
}

/**
 * Handlers de submissão de veredito (regular e por equivalência) + marcar
 * revisado / desfazer equivalência. Extraído de `ComparePage` para tirar ~140
 * linhas do container (`no-giant-component`). A escrita otimista vai por
 * `recordReview` (overrides); o avanço de campo por `goNextField` (que já faz
 * o clamp de limite).
 *
 * O comentário NÃO é limpo aqui após o sucesso: quando há avanço, o guard de
 * render de `ComparePage` re-semeia a caixa do veredito do novo campo (""); se
 * o campo permanece (filtro de campo único ou último campo divergente), o
 * comentário recém-salvo continua visível na caixa, em vez de sumir.
 */
export function useCompareVerdicts({
  readOnly,
  projectId,
  currentDoc,
  currentFieldName,
  isCurrentFieldDivergent,
  allDocDivergent,
  localReviews,
  fieldResponses,
  comment,
  recordReview,
  goNextField,
}: UseCompareVerdictsParams): CompareVerdicts {
  const handleVerdict = useCallback(
    async (
      origin: VerdictOrigin,
      verdict: string,
      chosenResponseId?: string,
    ) => {
      const gate = compareWriteGate(
        readOnly,
        currentDoc,
        currentFieldName,
        isCurrentFieldDivergent,
        origin,
      );
      if (!gate.ok) {
        return rejectCompareWrite(gate.reason, {
          origin,
          currentFieldName,
          verdict,
        });
      }
      const currentDocument = gate.doc;

      const verdictComment = comment || undefined;
      const info: VerdictInfo = {
        verdict,
        chosenResponseId: chosenResponseId ?? null,
        comment: verdictComment ?? null,
      };
      const saved = await actionSucceeded(
        submitVerdict({
          projectId,
          documentId: currentDocument.id,
          fieldName: currentFieldName,
          verdict,
          chosenResponseId,
          comment: verdictComment,
          responseSnapshot: buildSnapshot(fieldResponses),
        }),
        "Failed to submit compare verdict",
        {
          projectId,
          documentId: currentDocument.id,
          fieldName: currentFieldName,
          verdict,
          chosenResponseId,
        },
        "Não foi possível salvar o veredito. Tente novamente antes de avançar.",
      );
      if (!saved) return false;

      // Escrita otimista só após o sucesso: `recordReview` grava em `overrides`
      // (estado da sessão, não auto-revertido). Gravar antes deixaria o campo
      // exibido como revisado mesmo quando o save falha, até um reload.
      recordReview(currentDocument.id, currentFieldName, info);

      toast.success("Veredito salvo!");

      // Usa `info` recém-emitido sobre o estado atual (que o setState ainda não
      // refletiu neste closure) para decidir se o documento fechou.
      const nextDocReviews = {
        ...localReviews[currentDocument.id],
        [currentFieldName]: info,
      };
      const allFieldsReviewed = allDocDivergent.every(
        (fn) => !!nextDocReviews[fn],
      );
      if (allFieldsReviewed) {
        toast.success("Revisão do documento concluída!");
      } else {
        goNextField();
      }
      return true;
    },
    [
      readOnly,
      projectId,
      currentDoc,
      currentFieldName,
      isCurrentFieldDivergent,
      allDocDivergent,
      localReviews,
      comment,
      fieldResponses,
      recordReview,
      goNextField,
    ],
  );

  const handleConfirmEquivalent = useCallback(
    async (
      origin: VerdictOrigin,
      responseIds: string[],
      gabaritoId: string,
      verdictDisplay: string,
    ) => {
      // O mesmo gate do veredito regular: o botão "Confirmar N respostas como
      // equivalentes" também vive na subárvore de cards e, num painel fantasma,
      // gravaria a equivalência (em `response_equivalences`, não só em
      // `reviews`) contra o campo errado.
      const gate = compareWriteGate(
        readOnly,
        currentDoc,
        currentFieldName,
        isCurrentFieldDivergent,
        origin,
      );
      if (!gate.ok) {
        rejectCompareWrite(gate.reason, {
          origin,
          currentFieldName,
          responseIds,
        });
        return;
      }

      const verdictComment = comment || undefined;
      const docId = gate.doc.id;
      const fieldName = currentFieldName;
      const info: VerdictInfo = {
        verdict: verdictDisplay,
        chosenResponseId: gabaritoId,
        comment: verdictComment ?? null,
      };
      const saved = await actionSucceeded(
        confirmEquivalentVerdict({
          projectId,
          documentId: docId,
          fieldName,
          responseIds,
          gabaritoId,
          verdictDisplay,
          comment: verdictComment,
          responseSnapshot: buildSnapshot(fieldResponses),
        }),
        "Failed to confirm equivalent verdict",
        { projectId, documentId: docId, fieldName },
        "Não foi possível salvar a equivalência. Tente novamente antes de avançar.",
      );
      if (!saved) return;

      // Escrita otimista só após o sucesso (ver handleVerdict): não deixar o
      // campo/doc exibido como revisado quando a marcação de equivalência falha.
      recordReview(docId, fieldName, info);

      toast.success(
        `${responseIds.length} respostas marcadas como equivalentes.`,
      );

      const nextDocReviews = { ...localReviews[docId], [fieldName]: info };
      const allFieldsReviewed = allDocDivergent.every(
        (fn) => !!nextDocReviews[fn],
      );
      if (allFieldsReviewed) {
        toast.success("Revisão do documento concluída!");
      } else {
        goNextField();
      }
    },
    [
      readOnly,
      projectId,
      currentDoc,
      currentFieldName,
      isCurrentFieldDivergent,
      allDocDivergent,
      localReviews,
      comment,
      fieldResponses,
      recordReview,
      goNextField,
    ],
  );

  const handleMarkReviewed = useCallback(async () => {
    if (readOnly || !currentDoc) return;
    const saved = await actionSucceeded(
      markCompareDocReviewed(projectId, currentDoc.id),
      "Failed to mark compare doc reviewed",
      { projectId, documentId: currentDoc.id },
      "Não foi possível marcar o documento como revisado. Tente novamente.",
    );
    if (!saved) return;
    toast.success("Documento marcado como revisado.");
  }, [readOnly, projectId, currentDoc]);

  const handleUnmarkPair = useCallback(
    async (pairId: string) => {
      if (readOnly) return;
      const saved = await actionSucceeded(
        unmarkEquivalencePair(projectId, pairId),
        "Failed to unmark equivalence pair",
        { projectId, pairId },
        "Não foi possível remover a equivalência. Tente novamente.",
      );
      if (!saved) return;
      toast.success("Equivalência removida.");
    },
    [readOnly, projectId],
  );

  return {
    handleVerdict,
    handleConfirmEquivalent,
    handleMarkReviewed,
    handleUnmarkPair,
  };
}
