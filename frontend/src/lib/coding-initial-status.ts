import { isCodingComplete } from "@/lib/coding-completeness";
import { classifyDocStatus, type ResponseRoundFields, type RoundContext } from "@/lib/rounds";
import type { AnswerFieldHashes, PydanticField, Round } from "@/lib/types";

/** Colunas da response humana que decidem o status inicial do assignment. */
export interface CodingResponseRow extends ResponseRoundFields {
  answers: Record<string, unknown> | null;
  answer_field_hashes?: AnswerFieldHashes;
  /** Vira o `completed_at` do assignment promovido — a hora em que o trabalho ficou pronto. */
  updated_at: string | null;
}

export type CodingAssignmentStatus = "pendente" | "em_andamento" | "concluido";

export interface InitialCodingStatus {
  status: CodingAssignmentStatus;
  completed_at: string | null;
}

/**
 * Status com que um assignment de codificação deve NASCER, derivado da última
 * response humana do par (documento, usuário) — issue #521.
 *
 * O default `pendente` da coluna é uma suposição sobre trabalho que o banco já
 * sabe existir: quem codifica pelo Explorar (antes de haver atribuição) fica
 * eternamente "pendente" na fila, porque `syncCodingAssignmentStatus` só roda
 * no save e o save já aconteceu. Derivar aqui torna esse estado impossível de
 * construir nos dois caminhos de criação (sorteio e atribuição manual).
 *
 * Composição de dois juízes que já existem, em vez de uma terceira cópia da
 * regra:
 *
 * - `classifyDocStatus` (lib/rounds) decide se a response conta para a rodada
 *   ATUAL. Response de rodada anterior tem de ser recodificada, então o
 *   assignment nasce `pendente` — sem isto, um sorteio aberto para uma nova
 *   rodada (bump de schema major) nasceria concluído sobre trabalho velho e
 *   esconderia a re-rodada que o coordenador acabou de pedir.
 * - `isCodingComplete` (lib/coding-completeness) decide se a codificação está
 *   completa. A avaliação aqui é RETROATIVA (schema atual × codificação
 *   antiga), daí passar `answer_field_hashes` — mesmo motivo de
 *   `computeBacklogRows` em lib/auto-review-backlog: sem o snapshot, um campo
 *   obrigatório adicionado depois da codificação a faria parecer incompleta.
 *
 * Não dispara automação (auto-revisão/auto-comparação): ela já rodou no submit
 * da response. `syncCodingAssignmentStatus` chama `runCodingAutomation` mesmo
 * quando o UPDATE do assignment não afeta linha nenhuma — que é exatamente o
 * caso em que o assignment ainda não existia.
 *
 * O terceiro juiz é o guard de `is_partial`, que precisa viver aqui porque
 * `classifyDocStatus` não o expõe: ele colapsa `is_partial` em
 * `current_pending`, o mesmo ramo de uma response enviada e incompleta. Ver o
 * comentário no corpo da função.
 */
export function resolveInitialCodingStatus(
  ctx: RoundContext,
  roundsById: Map<string, Round>,
  response: CodingResponseRow | undefined,
  fields: PydanticField[],
): InitialCodingStatus {
  if (!response) return { status: "pendente", completed_at: null };

  const round = classifyDocStatus(ctx, response, roundsById);
  if (round.kind === "previous" || round.kind === "no_response") {
    return { status: "pendente", completed_at: null };
  }

  // `is_partial === true` não é promovível a `concluido`, por duas razões que
  // hoje coincidem mas têm origens distintas:
  //
  //   • nas linhas gravadas a partir do #608, significa "o conjunto gravado
  //     está incompleto" (actions/responses.ts, `isPartialToWrite`);
  //   • nas linhas ANTERIORES ao #608, significa "nunca submetida" — o
  //     auto-save gravava `true` enquanto o pesquisador não clicasse em Enviar,
  //     mesmo com todos os campos preenchidos. Essas linhas continuam no banco
  //     e esta função as lê.
  //
  // Promover qualquer uma delas seria a #521 ao contrário — e um estado do qual
  // não se sai: `keepCodingAssignmentInProgress` nunca regride de `concluido`,
  // então nem um submit posterior corrigiria a linha.
  if (response.is_partial === true) {
    return { status: "em_andamento", completed_at: null };
  }

  if (isCodingComplete(fields, response.answers ?? {}, response.answer_field_hashes)) {
    return { status: "concluido", completed_at: response.updated_at };
  }
  return { status: "em_andamento", completed_at: null };
}
