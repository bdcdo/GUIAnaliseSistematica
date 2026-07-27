/**
 * Decide se — e o que — avisar quando a fila de campos divergentes de um parecer
 * muda de composição sob a revisora.
 *
 * `computeDivergentFieldNames` roda no servidor a cada `revalidatePath`: a lista
 * encolhe quando uma equivalência funde grupos e cresce quando o snapshot de um
 * par deixa de casar. Com o campo atual fixado por nome (#613) a revisora não é
 * mais deslocada, mas a fila mudar em silêncio continua desorientador — foi o
 * que tornou o bug difícil de relatar ("tem coisa que foi respondida e ainda
 * continua").
 *
 * Puro e fora do hook de propósito: as três supressões abaixo são o que separa
 * um aviso útil de um toast que a revisora aprende a ignorar, e cada uma merece
 * teste próprio sem montar componente.
 */

export interface QueueChangeInput {
  /** Campos da fila no render anterior; `null` na primeira montagem. */
  previousFields: readonly string[] | null;
  currentFields: readonly string[];
  /** Campo EXIBIDO no render anterior — não o pin já re-resolvido. */
  previousFieldName: string | undefined;
  previousDocId: string | undefined;
  currentDocId: string | undefined;
  previousFilter: string;
  currentFilter: string;
  /** Vereditos locais do doc atual, para reconhecer a ação da própria revisora. */
  reviewedFields: Readonly<Record<string, unknown>> | undefined;
}

export interface QueueChangeNotice {
  /** `id` fixo do toast: uma rajada de revalidates colapsa num aviso só. */
  id: "compare-field-left-queue" | "compare-queue-changed";
  message: string;
}

export function queueChangeNotice(
  input: QueueChangeInput,
): QueueChangeNotice | null {
  const {
    previousFields,
    currentFields,
    previousFieldName,
    previousDocId,
    currentDocId,
    previousFilter,
    currentFilter,
    reviewedFields,
  } = input;

  if (previousFields === null) return null; // primeira montagem: não há "mudou"
  if (previousDocId !== currentDocId) return null; // (1) troca de parecer
  if (previousFilter !== currentFilter) return null; // (2) troca de filtro
  if (sameOrder(previousFields, currentFields)) return null;

  const stillPresent = new Set(currentFields);
  const departed = previousFields.filter((fn) => !stillPresent.has(fn));

  // (3) consequência da própria ação dela: confirmar uma equivalência funde
  // grupos e tira o campo da fila. `recordReview` já gravou o veredito local
  // nesse ponto, então "todo campo que saiu já tem veredito" identifica
  // exatamente esse caso — que é, de longe, o mais comum.
  if (
    departed.length > 0 &&
    departed.every((fn) => reviewedFields?.[fn] !== undefined)
  ) {
    return null;
  }

  if (previousFieldName !== undefined && departed.includes(previousFieldName)) {
    return {
      id: "compare-field-left-queue",
      message:
        "O campo que você estava revisando saiu da fila de divergências — voltando ao primeiro campo pendente.",
    };
  }

  return {
    id: "compare-queue-changed",
    message: `A fila de divergências deste parecer mudou (${previousFields.length} → ${currentFields.length} campos). Você continua no campo atual.`,
  };
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
