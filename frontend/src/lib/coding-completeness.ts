import { isFieldVisible } from "@/lib/conditional";
import { isIncompleteOther } from "@/lib/other-option";
import { fieldExistedWhenCoded } from "@/lib/answer-staleness";
import {
  resolveRequired,
  resolveSubfieldRequired,
  resolveSubfieldRule,
  resolveTarget,
} from "@/lib/pydantic-field";
import { isSubfieldRecord } from "@/lib/subfield-value";
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";

// Campos que o humano precisa responder para a codificação contar como
// completa: visíveis para humano, obrigatórios, com a condição de visibilidade
// satisfeita pelas respostas atuais e — quando `answerFieldHashes` é fornecido —
// que já existiam no schema contra o qual a resposta foi codificada
// (staleness-aware). Os defaults de `target` e `required` saem dos resolvedores
// de pydantic-field, nunca de uma re-derivação local. Exportado para que a régua
// de completude da UI (useQuestionValidation) derive a contagem e o bloqueio de
// submit desta MESMA fonte, em vez de reimplementar os filtros e divergir.
export function requiredHumanFields(
  fields: PydanticField[],
  answers: Record<string, unknown>,
  answerFieldHashes?: AnswerFieldHashes,
): PydanticField[] {
  return fields.filter(
    (f) =>
      resolveTarget(f.target) !== "llm_only" &&
      resolveTarget(f.target) !== "none" &&
      resolveRequired(f.required) &&
      isFieldVisible(f, answers) &&
      fieldExistedWhenCoded(answerFieldHashes, f.name),
  );
}

// Predicado por-campo: `true` quando o valor conta como resposta válida para
// fins de completude. Trata vazio (`undefined`/`null`/`""`), "Outro:" incompleto
// em `single` e `multi` vazio/com "Outro:" incompleto como NÃO respondido. Fonte
// única desse check — consumido por `isCodingComplete` (aqui) e pela régua da UI
// (useQuestionValidation), para que a UI não mantenha uma cópia que possa derivar.
export function isFieldAnswered(field: PydanticField, value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (field.type === "single" && isIncompleteOther(value)) return false;
  if (field.type === "multi" && Array.isArray(value)) {
    if (value.length === 0) return false;
    if (value.some(isIncompleteOther)) return false;
  }
  if (field.subfields?.length) return isSubfieldGroupAnswered(field, value);
  return true;
}

// Um grupo guarda um objeto, e objeto não-vazio sempre passou o check acima —
// então `{doenca: "x", cid: ""}` contava como respondido mesmo com `cid`
// obrigatório, e um grupo `at_least_one` sem nada preenchido também. O
// asterisco do FieldRenderer e o texto "pelo menos um" não tinham
// contrapartida em régua nenhuma (#491).
//
// As duas regras que o schema já declara, e nada além delas: `at_least_one`
// exige um subcampo qualquer; `all` exige os subcampos marcados como
// obrigatórios — os demais seguem opcionais, e um grupo sem nenhum obrigatório
// continua valendo por presença, como antes.
function isSubfieldGroupAnswered(field: PydanticField, value: unknown): boolean {
  // A régua vale para o valor NA FORMA que o grupo produz. Um valor de outra
  // forma — string, tipicamente — é resposta coletada quando o campo ainda era
  // texto simples, antes de ganhar subcampos, e já era completa sob o schema da
  // época. Rejeitá-la aqui contradiria a postura que o sistema toma em
  // `computeFieldHash`, que exclui as propriedades estruturais justamente para
  // que mexer nelas não invalide resposta já coletada. Medido: sem esta
  // fronteira, a régua reclassificava 125 codificações concluídas do Zolgensma
  // e do Judiciário, TODAS por essa mudança de forma e nenhuma por subcampo
  // obrigatório em branco (harness/2026-07-24-subfield-completeness).
  //
  // A fronteira mora em `subfield-value.ts` porque o FieldRenderer decide pela
  // MESMA leitura o que exibir. Enquanto cada lado a escrevia por conta
  // própria, a resposta anistiada aqui era a que o renderizador não sabia
  // mostrar — o ✓ com a tela vazia da #607.
  if (!isSubfieldRecord(value)) return true;
  const answers = value;
  const subfields = field.subfields ?? [];

  if (resolveSubfieldRule(field.subfield_rule) === "at_least_one") {
    return subfields.some((sf) => isSubfieldFilled(answers[sf.key]));
  }
  return subfields.every(
    (sf) =>
      !resolveSubfieldRequired(sf.required) || isSubfieldFilled(answers[sf.key]),
  );
}

// Subcampo é sempre texto livre no gerador (`str`/`Optional[str]`), então só
// espaço em branco é vazio — mesma normalização que `_normalize_optional_str`
// aplica no backend ao ler o valor de volta.
function isSubfieldFilled(value: unknown): boolean {
  if (typeof value === "string") return value.trim() !== "";
  return value !== undefined && value !== null;
}

// Campos obrigatórios que ainda faltam — a régua de completude na forma que a UI
// precisa (quantos e quais), com `isCodingComplete` derivado dela. A UI de
// codificação e o feedback de save consomem esta primitiva em vez de reimplementar
// a regra: uma cópia paralela é o que deixava "o que o botão exige" divergir de "o
// que o servidor considera concluído" sem nenhum gate reclamar (#519).
export function missingRequiredHumanFields(
  fields: PydanticField[],
  answers: Record<string, unknown>,
  answerFieldHashes?: AnswerFieldHashes,
): PydanticField[] {
  return requiredHumanFields(fields, answers, answerFieldHashes).filter(
    (f) => !isFieldAnswered(f, answers[f.name]),
  );
}

// True quando todos os campos obrigatórios e visíveis para o humano estão
// respondidos. Fonte única da regra de "codificação completa", espelhada pelo
// gate inline de saveResponse (promoção a "concluido") e pelo backlog de
// auto-revisão (regenerateAutoReviewBacklog). Ver issue #174: sem esse gate, o
// backlog varria codificações em andamento (parciais) para a arbitragem, onde
// apareciam como "(vazio)" em diversos campos. Puro/client-safe — usado tanto
// em server actions quanto em testes Vitest.
//
// `answerFieldHashes` (opcional): passar o snapshot per-campo da resposta torna a
// avaliação staleness-aware — um campo obrigatório recém-adicionado ao schema não
// rebaixa uma codificação que estava completa à época, porque o carimbo prova
// quais campos existiam (ver fieldExistedWhenCoded). Dois consumidores passam o
// snapshot:
//   • a avaliação RETROATIVA (backlog de auto-revisão, reconciliação) contra o
//     schema atual, que sem isso marcaria toda codificação anterior a um bump de
//     schema como falsamente incompleta;
//   • o gate de `is_partial` em saveResponse, que avalia contra o snapshot da
//     própria escrita (buildPersistedResponseSnapshot). Para uma codificação NOVA
//     esse snapshot estampa o schema inteiro como chaves, então aware ≡ blind e
//     nenhum obrigatório em branco é perdoado; a distinção só morde ao reenviar
//     uma resposta JÁ submetida sob schema que cresceu — exatamente o caso que não
//     deve rebaixar um doc concluído (#519/#520). Até o #608 o gatilho era o
//     auto-save de navegação; hoje é reabrir o doc e clicar em Enviar.
// Quem permanece staleness-BLIND de propósito é a promoção a `concluido` em
// syncCodingAssignmentStatus (coding-sync): lá é o guard de não-rebaixar um
// assignment já concluído que sustenta a invariante, não o carimbo per-campo.
export function isCodingComplete(
  fields: PydanticField[],
  answers: Record<string, unknown>,
  answerFieldHashes?: AnswerFieldHashes,
): boolean {
  return missingRequiredHumanFields(fields, answers, answerFieldHashes).length === 0;
}
