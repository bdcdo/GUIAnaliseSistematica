// Métrica de erro do LLM exibida em LLM Insights: numerador (`errors`) e
// denominador (`reviewedEntries`) de "taxa de erro".
//
// Puro e sem Supabase — recebe linhas cruas e devolve as duas listas — para
// ser testável fora do runtime do Next, no molde de `compare-divergence.ts`.
//
// Há DUAS fontes de veredito sobre acerto/erro do LLM, e as duas contam:
//
//   Fonte A — Comparação (`reviews`): o revisor escolheu, entre as respostas
//   do documento, qual é o gabarito. O LLM acertou se a resposta dele cai na
//   mesma classe de equivalência da escolhida.
//
//   Fonte B — Auto-revisão (`field_reviews`, lida via a view `final_answers`):
//   o próprio codificador confronta a sua resposta com a do LLM, com
//   arbitragem quando ele contesta. A RPC desse fluxo nunca escreve em
//   `reviews`, então antes desta métrica os projetos em `auto_review_llm`
//   apareciam sem taxa nenhuma.
//
// Um projeto que trocou de `automation_mode` tem histórico nas duas tabelas
// para o mesmo (documento, campo) — não há constraint cruzada impedindo — daí
// a deduplicação em `pickWinner`.
import { normalizeForComparison } from "@/lib/utils";
import {
  buildResponseGroupKeys,
  filterCurrentEquivalencePairs,
  type EquivalencePair,
} from "@/lib/equivalence";
import { isFieldApplicable } from "@/lib/compare-divergence";
import {
  multiSelectionSets,
  multiSelectionsAgree,
} from "@/lib/compare-multi-options";
import { isCodingComplete } from "@/lib/coding-completeness";
import { resolveTarget } from "@/lib/pydantic-field";
import { formatAnswer } from "@/lib/reviews/queries";
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";

/** De qual das duas fontes o veredito veio. A UI usa para decidir affordances. */
export type LlmErrorSource = "comparacao" | "auto_revisao";

export interface LlmError {
  documentId: string;
  documentTitle: string;
  fieldName: string;
  fieldDescription: string;
  llmAnswer: string;
  llmJustification: string | null;
  chosenVerdict: string;
  reviewerComment: string | null;
  resolvedAt: string | null;
  reviewedAt: string;
  schemaVersion: string | null;
  llmResponseId: string;
  chosenResponseId: string | null;
  source: LlmErrorSource;
}

// Todo (doc, campo) que o LLM respondeu e que já tem veredito humano — de
// qualquer das duas fontes — após as mesmas supressões aplicadas a `errors`.
// A UI usa como denominador, para que a taxa respeite os filtros ativos.
export interface ReviewedEntry {
  documentId: string;
  documentTitle: string;
  fieldName: string;
  schemaVersion: string | null;
  reviewedAt: string;
  isError: boolean;
}

/* ── Formatos crus de entrada (colunas do banco, snake_case) ── */

export interface MetricsResponse {
  id: string;
  document_id: string;
  respondent_type: "humano" | "llm";
  is_latest: boolean;
  answers: Record<string, unknown> | null;
  justifications: Record<string, string> | null;
  answer_field_hashes?: AnswerFieldHashes | null;
  created_at: string;
  schema_version_major: number | null;
  schema_version_minor: number | null;
  schema_version_patch: number | null;
}

export interface MetricsReview {
  document_id: string;
  field_name: string;
  verdict: string;
  chosen_response_id: string | null;
  comment: string | null;
  created_at: string;
}

// Os valores que o `CASE` de `final_answers` emite, e nada além deles. União
// literal em vez de `string` de propósito: com `string`, um estado terminal
// novo (ou renomeado) na view cairia no ramo "pendente" e sumiria em silêncio
// do numerador E do denominador — sem erro, sem log e sem teste vermelho. Assim
// o drift vira erro de compilação em `classifyAutoReview`.
export type AutoReviewProvenance =
  | "consenso"
  | "auto_corrigido"
  | "equivalente"
  | "ambiguo"
  | "arbitrado"
  | "aguarda_reconciliacao"
  | "aguarda_auto_revisao"
  | "aguarda_arbitragem";

// Linha da view `final_answers` (uma por documento com LLM × campo do schema).
export interface MetricsFinalAnswer {
  document_id: string;
  field_name: string;
  provenance: AutoReviewProvenance;
  final_verdict: string | null;
  self_reviewed_at: string | null;
  final_decided_at: string | null;
  human_response_id: string | null;
  llm_response_id: string | null;
  human_answer_snapshot: unknown;
  llm_answer_snapshot: unknown;
  /** Texto que o arbitrador escreveu ao decidir; exibido como "Comentário do revisor". */
  arbitrator_comment: string | null;
}

export interface MetricsEquivalence extends EquivalencePair {
  document_id: string;
  field_name: string;
}

export interface LlmErrorMetricsInput {
  fields: PydanticField[];
  /**
   * `projects.automation_mode`. A fonte de auto-revisão só é lida em
   * 'auto_review_llm': `field_reviews` não é materializado nos outros modos, e
   * a view devolveria 'consenso' — que ali significa apenas "este projeto não
   * usa auto-revisão" — para todo campo de todo documento.
   */
  automationMode: string | null;
  /**
   * Só os documentos ATIVOS do projeto. As chaves, e não só os valores, são
   * consumidas: elas definem o conjunto de documentos que a métrica mede.
   */
  documentTitles: Map<string, string>;
  /** Todas as responses do projeto, de todas as rodadas e respondentes. */
  responses: MetricsResponse[];
  /** Já filtradas por `chosen_response_id IS NOT NULL`. */
  reviews: MetricsReview[];
  /** Já filtradas por projeto; vazio quando o projeto não usa auto-revisão. */
  finalAnswers: MetricsFinalAnswer[];
  /** Já filtradas por `superseded_at IS NULL`, COM as colunas de snapshot. */
  equivalences: MetricsEquivalence[];
  /** "documentId:fieldName" -> resolved_at */
  errorResolutions: Map<string, string | null>;
}

// Candidato antes da deduplicação entre as duas fontes.
interface Candidate {
  documentId: string;
  fieldName: string;
  /** Quando o humano decidiu. `null` em consenso (ninguém decidiu nada). */
  decidedAt: string | null;
  isError: boolean;
  error: LlmError | null;
  entry: ReviewedEntry;
}

function formatSchemaVersion(response: {
  schema_version_major: number | null;
  schema_version_minor: number | null;
  schema_version_patch: number | null;
}): string | null {
  const { schema_version_major, schema_version_minor, schema_version_patch } =
    response;
  if (
    schema_version_major == null ||
    schema_version_minor == null ||
    schema_version_patch == null
  )
    return null;
  return `${schema_version_major}.${schema_version_minor}.${schema_version_patch}`;
}

// Campos sobre os quais faz sentido perguntar se o LLM acertou: os que o LLM
// responde E o humano revisa. Os três excluídos saem por razões distintas —
// `none` e `llm_only` o coordenador tirou da superfície de revisão humana, e
// `human_only` o LLM sequer recebe (`llm_runner._visible_fields` o descarta).
//
// `human_only` é o mais traiçoeiro dos três na fonte de auto-revisão: sem
// resposta do LLM não há divergência, sem divergência `computeDivergentFieldNames`
// não gera linha em `field_reviews`, e sem linha a view emite 'consenso' — um
// acerto fabricado por campo `human_only` por documento codificado, sempre no
// sentido de deflacionar a taxa.
//
// O default de `target` sai de `resolveTarget`, nunca de um `!== x` local
// (regra (c2) do CLAUDE.md).
export function isMeasurableField(
  field: PydanticField | undefined,
): field is PydanticField {
  if (!field) return false;
  const target = resolveTarget(field.target);
  return target !== "none" && target !== "llm_only" && target !== "human_only";
}

// "O LLM acertou este campo?" a partir da proveniência da auto-revisão. O mapa
// espelha o `CASE` da view `final_answers`, e o `satisfies` é o gate de drift:
// acrescentar um estado à view sem classificá-lo aqui não compila.
const AUTO_REVIEW_OUTCOME = {
  // Sem linha em `field_reviews`: humano e LLM concordaram na codificação, e o
  // campo nunca entrou na fila de auto-revisão.
  consenso: "acerto",
  // O codificador reconheceu que errou e o LLM estava certo.
  auto_corrigido: "acerto",
  // Respostas diferentes no texto, mesma coisa no conteúdo — o análogo exato do
  // "semelhantes" da Comparação, e como lá, não é erro do LLM.
  equivalente: "acerto",
  // O único caso em que a proveniência sozinha não decide: quem decide é
  // `final_verdict`.
  arbitrado: "depende_do_veredito",
  // 'ambiguo' é terminal mas não produz gabarito: fica fora do numerador E do
  // denominador, como já acontece com o veredito "ambiguo" da Comparação. Os
  // 'aguarda_*' são pendências, não acertos.
  ambiguo: "pendente",
  aguarda_reconciliacao: "pendente",
  aguarda_auto_revisao: "pendente",
  aguarda_arbitragem: "pendente",
} satisfies Record<
  AutoReviewProvenance,
  "acerto" | "pendente" | "depende_do_veredito"
>;

function classifyAutoReview(
  row: MetricsFinalAnswer,
): "acerto" | "erro" | "pendente" {
  // A indexação é total pelo tipo; o `undefined` só aparece se o banco emitir
  // um valor fora da união, e aí "pendente" é a leitura conservadora.
  const outcome: string | undefined = AUTO_REVIEW_OUTCOME[row.provenance];
  if (outcome !== "depende_do_veredito") {
    return outcome === "acerto" ? "acerto" : "pendente";
  }
  return row.final_verdict === "humano" ? "erro" : "acerto";
}

// Vence a decisão mais recente. Consenso não é decisão de ninguém e perde para
// qualquer veredito explícito, de qualquer das fontes; empate mantém o
// incumbente, o que torna o resultado estável dada a ordem de inserção.
function beats(candidate: Candidate, incumbent: Candidate): boolean {
  if (candidate.decidedAt && !incumbent.decidedAt) return true;
  if (!candidate.decidedAt) return false;
  return candidate.decidedAt > incumbent.decidedAt!;
}

// Contexto derivado uma vez e compartilhado pelas duas fontes.
interface MetricsContext {
  fieldMap: Map<string, PydanticField>;
  isActiveDocument: (docId: string) => boolean;
  titleOf: (docId: string) => string;
  resolvedAtOf: (docId: string, fieldName: string) => string | null;
  responsesByDoc: Map<string, MetricsResponse[]>;
  responseById: Map<string, MetricsResponse>;
  llmLatestByDoc: Map<string, MetricsResponse>;
  /** Classes de equivalência por (documento, campo), memoizadas. */
  groupKeysFor: (docId: string, fieldName: string) => Map<string, string>;
  /** `isCodingComplete` da response, memoizado por id. */
  codingIsComplete: (response: MetricsResponse) => boolean;
}

function buildContext(input: LlmErrorMetricsInput): MetricsContext {
  const { fields, documentTitles, responses, equivalences, errorResolutions } = input;

  const responsesByDoc = new Map<string, MetricsResponse[]>();
  const responseById = new Map<string, MetricsResponse>();
  const llmLatestByDoc = new Map<string, MetricsResponse>();
  for (const response of responses) {
    const bucket = responsesByDoc.get(response.document_id);
    if (bucket) bucket.push(response);
    else responsesByDoc.set(response.document_id, [response]);
    responseById.set(response.id, response);
    if (response.respondent_type === "llm" && response.is_latest) {
      llmLatestByDoc.set(response.document_id, response);
    }
  }

  const equivByDocField = new Map<string, Map<string, MetricsEquivalence[]>>();
  for (const pair of equivalences) {
    let byField = equivByDocField.get(pair.document_id);
    if (!byField) {
      byField = new Map();
      equivByDocField.set(pair.document_id, byField);
    }
    const bucket = byField.get(pair.field_name);
    if (bucket) bucket.push(pair);
    else byField.set(pair.field_name, [pair]);
  }

  // Memoizado: um documento com muitos campos revisados repetiria o union-find
  // por campo à toa.
  const groupKeyCache = new Map<string, Map<string, string>>();
  const groupKeysFor = (docId: string, fieldName: string) => {
    const cacheKey = `${docId}:${fieldName}`;
    const cached = groupKeyCache.get(cacheKey);
    if (cached) return cached;

    // Todas as responses do documento entram, inclusive rodadas anteriores:
    // `chosen_response_id` pode apontar para uma resposta que não é mais a
    // `is_latest`, e é justamente por essas que o fecho transitivo passa.
    const items = (responsesByDoc.get(docId) ?? []).map((response) => ({
      id: response.id,
      answer: response.answers?.[fieldName],
    }));
    const pairs = filterCurrentEquivalencePairs(
      items,
      equivByDocField.get(docId)?.get(fieldName) ?? [],
      (item) => item.answer,
    );
    const groupKeys = buildResponseGroupKeys(items, pairs, (item) =>
      normalizeForComparison(item.answer),
    );
    groupKeyCache.set(cacheKey, groupKeys);
    return groupKeys;
  };

  // Memoizado por response: a fonte de auto-revisão pergunta uma vez por
  // (documento, campo), mas completude é propriedade da RESPONSE — só os checks
  // de aplicabilidade dependem do campo. Sem o cache, um projeto de 5000
  // documentos × 40 campos reavaliava `isCodingComplete` (que por sua vez itera
  // todos os campos) centenas de milhares de vezes por render.
  const completeCache = new Map<string, boolean>();
  const codingIsComplete = (response: MetricsResponse) => {
    const cached = completeCache.get(response.id);
    if (cached !== undefined) return cached;
    const complete = isCodingComplete(
      fields,
      response.answers ?? {},
      response.answer_field_hashes ?? undefined,
    );
    completeCache.set(response.id, complete);
    return complete;
  };

  return {
    fieldMap: new Map(fields.map((f) => [f.name, f])),
    isActiveDocument: (docId) => documentTitles.has(docId),
    titleOf: (docId) => documentTitles.get(docId) || docId,
    resolvedAtOf: (docId, fieldName) =>
      errorResolutions.get(`${docId}:${fieldName}`) ?? null,
    responsesByDoc,
    responseById,
    llmLatestByDoc,
    groupKeysFor,
    codingIsComplete,
  };
}

// O LLM errou este campo, na leitura da Comparação? Para tudo que não é `multi`,
// uma única noção de "mesma resposta": as classes do union-find já fundem tanto
// pares marcados como equivalentes pelo revisor quanto respostas de texto
// idêntico, e propagam por transitividade (A≡B, B≡C ⇒ A≡C). É a mesma primitiva
// que a tela de Comparação usa para decidir divergência.
function comparisonIsError(
  review: MetricsReview,
  field: PydanticField,
  llmResponse: MetricsResponse,
  ctx: MetricsContext,
): boolean {
  if (review.chosen_response_id === llmResponse.id) return false;

  const isMulti = field.type === "multi" && !!field.options?.length;
  return isMulti
    ? multiIsError(review, field, llmResponse, ctx)
    : groupedIsError(review, llmResponse, ctx);
}

// `multi` tem semântica de CONJUNTO de opções, e é assim que
// `computeDivergentFieldNames` o compara — enquanto `normalizeForComparison`
// serializa o array na ordem em que veio, e faria de ["a","b"] vs ["b","a"] um
// erro do LLM que a tela de Comparação exibe como concordância. Fica de fora do
// union-find pelo mesmo motivo que lá: a UI de revisão de multi
// (MultiOptionReview) não tem cards de equivalência, não há par a fundir.
//
// Hoje o caminho é defensivo: `MultiOptionReview` submete sem
// `chosenResponseId`, e a página filtra `chosen_response_id IS NOT NULL`, de
// modo que nenhum review de `multi` chega até aqui. Ele existe para que a
// afirmação "esta métrica usa as primitivas da Comparação" seja verdadeira por
// construção, e não por acidente da UI atual.
function multiIsError(
  review: MetricsReview,
  field: PydanticField,
  llmResponse: MetricsResponse,
  ctx: MetricsContext,
): boolean {
  const chosen = review.chosen_response_id
    ? ctx.responseById.get(review.chosen_response_id)
    : undefined;
  // Sem a response escolhida não há conjunto com que comparar: o texto do
  // veredito de multi é um JSON de opção→marcada, de outra forma que a resposta.
  if (!chosen) return true;

  return !multiSelectionsAgree(
    field.options ?? [],
    multiSelectionSets([
      llmResponse.answers?.[review.field_name],
      chosen.answers?.[review.field_name],
    ]),
  );
}

// Demais tipos: classe de equivalência do union-find, que já funde tanto os
// pares marcados pelo revisor quanto as respostas de texto idêntico.
function groupedIsError(
  review: MetricsReview,
  llmResponse: MetricsResponse,
  ctx: MetricsContext,
): boolean {
  const groupKeys = ctx.groupKeysFor(review.document_id, review.field_name);
  const llmKey = groupKeys.get(llmResponse.id);
  const chosenKey = review.chosen_response_id
    ? groupKeys.get(review.chosen_response_id)
    : undefined;

  if (llmKey !== undefined && chosenKey !== undefined) return llmKey !== chosenKey;

  // A response escolhida sumiu do conjunto (apagada, ou de um documento que não
  // veio na página). Resta comparar o texto do veredito, que é uma cópia do
  // valor escolhido no momento da revisão.
  return (
    normalizeForComparison(llmResponse.answers?.[review.field_name]) !==
    normalizeForComparison(review.verdict)
  );
}

/* ── Fonte A: Comparação (`reviews`) ── */
function comparisonCandidates(
  reviews: MetricsReview[],
  ctx: MetricsContext,
): Candidate[] {
  const candidates: Candidate[] = [];

  for (const review of reviews) {
    // Documento excluído (soft delete) sai da métrica inteira, não só do
    // título: medir o acerto do LLM sobre um documento que o coordenador tirou
    // do projeto é ruído em ambos os sentidos.
    if (!ctx.isActiveDocument(review.document_id)) continue;

    const llmResponse = ctx.llmLatestByDoc.get(review.document_id);
    if (!llmResponse) continue;

    const field = ctx.fieldMap.get(review.field_name);
    if (!isMeasurableField(field)) continue;

    candidates.push(buildComparisonCandidate(review, field, llmResponse, ctx));
  }

  return candidates;
}

function buildComparisonCandidate(
  review: MetricsReview,
  field: PydanticField,
  llmResponse: MetricsResponse,
  ctx: MetricsContext,
): Candidate {
  const isError = comparisonIsError(review, field, llmResponse, ctx);
  const shared: SharedEntryFields = {
    documentId: review.document_id,
    documentTitle: ctx.titleOf(review.document_id),
    fieldName: review.field_name,
    schemaVersion: formatSchemaVersion(llmResponse),
    reviewedAt: review.created_at,
  };

  return {
    documentId: review.document_id,
    fieldName: review.field_name,
    decidedAt: review.created_at,
    isError,
    error: isError
      ? {
          ...shared,
          fieldDescription: field.description || review.field_name,
          llmAnswer: formatAnswer(llmResponse.answers?.[review.field_name]),
          llmJustification:
            llmResponse.justifications?.[review.field_name] || null,
          chosenVerdict: review.verdict,
          reviewerComment: review.comment,
          resolvedAt: ctx.resolvedAtOf(review.document_id, review.field_name),
          llmResponseId: llmResponse.id,
          chosenResponseId: review.chosen_response_id,
          source: "comparacao",
        }
      : null,
    entry: { ...shared, isError },
  };
}

// A view produz uma linha por campo do schema para TODO documento com resposta
// do LLM, e marca 'consenso' sempre que não há linha em `field_reviews` —
// inclusive em documentos que ninguém codificou. O gate espelha
// `computeBacklogRows` (`auto-review-backlog.ts`), que é quem MATERIALIZA as
// linhas, e precisa espelhá-lo nos DOIS eixos que ele usa:
//
//   • codificação humana COMPLETA (`isCodingComplete`), senão a ausência de
//     linha num documento pela metade viraria concordância;
//   • campo APLICÁVEL às duas responses (`isFieldApplicable`), como no
//     `applicable.length < 2` de `computeDivergentFieldNames`. Sem o lado do
//     LLM, um campo acrescentado ao schema depois da rodada — ausente do
//     `answer_field_hashes` dela — e um condicional visível só para o humano
//     entravam como acerto: acrescentar um campo obrigatório hoje daria um
//     acerto de graça em cada documento já codificado.
function hasComparableHumanCoding(
  docId: string,
  field: PydanticField,
  llmResponse: MetricsResponse,
  ctx: MetricsContext,
): boolean {
  if (
    !isFieldApplicable(
      field,
      llmResponse.answers,
      llmResponse.answer_field_hashes ?? undefined,
    )
  )
    return false;

  return (ctx.responsesByDoc.get(docId) ?? []).some(
    (response) =>
      response.respondent_type === "humano" &&
      response.is_latest &&
      isFieldApplicable(
        field,
        response.answers,
        response.answer_field_hashes ?? undefined,
      ) &&
      ctx.codingIsComplete(response),
  );
}

type SharedEntryFields = Omit<ReviewedEntry, "isError">;

// Os snapshots congelam os valores sobre os quais o veredito foi dado; a
// resposta atual pode já ter sido revisada desde então. `arbitratedLlm` é a
// response a que o veredito se refere (`row.llm_response_id`), que depois de uma
// nova rodada NÃO é mais a `is_latest`: parear o snapshot da rodada 1 com a
// justificativa e a versão de schema da rodada 2 mostraria ao coordenador um
// argumento que defende outra resposta, e arquivaria o erro sob a versão errada.
function buildAutoReviewError(
  row: MetricsFinalAnswer,
  field: PydanticField,
  arbitratedLlm: MetricsResponse,
  shared: SharedEntryFields,
  ctx: MetricsContext,
): LlmError {
  return {
    ...shared,
    fieldDescription: field.description || row.field_name,
    llmAnswer: formatAnswer(
      row.llm_answer_snapshot ?? arbitratedLlm.answers?.[row.field_name],
    ),
    llmJustification: arbitratedLlm.justifications?.[row.field_name] || null,
    chosenVerdict: formatAnswer(row.human_answer_snapshot),
    reviewerComment: row.arbitrator_comment,
    resolvedAt: ctx.resolvedAtOf(row.document_id, row.field_name),
    llmResponseId: arbitratedLlm.id,
    chosenResponseId: row.human_response_id,
    source: "auto_revisao",
  };
}

interface MeasurableAutoReviewRow {
  field: PydanticField;
  /** A response sobre a qual o veredito se deu, que só coincide com a corrente
   *  enquanto não houve nova rodada. Em 'consenso' não há `llm_response_id`. */
  arbitratedLlm: MetricsResponse;
  isError: boolean;
}

// A cadeia de guardas da fonte B, separada da montagem do candidato. `null`
// quando a linha não é mensurável: documento excluído, campo fora da superfície
// de revisão, documento sem LLM corrente, codificação humana ausente ou
// incompleta, campo inaplicável a um dos lados, ou veredito ainda pendente.
function measurableAutoReviewRow(
  row: MetricsFinalAnswer,
  ctx: MetricsContext,
): MeasurableAutoReviewRow | null {
  // A view junta só `responses` e `projects` — nunca `documents` —, então
  // documentos com `excluded_at`/`exclusion_pending_at` continuam nela com as
  // responses que sobreviveram ao soft delete.
  if (!ctx.isActiveDocument(row.document_id)) return null;

  const field = ctx.fieldMap.get(row.field_name);
  if (!isMeasurableField(field)) return null;

  const llmResponse = ctx.llmLatestByDoc.get(row.document_id);
  if (!llmResponse) return null;
  if (!hasComparableHumanCoding(row.document_id, field, llmResponse, ctx))
    return null;

  const outcome = classifyAutoReview(row);
  if (outcome === "pendente") return null;

  return {
    field,
    arbitratedLlm:
      (row.llm_response_id
        ? ctx.responseById.get(row.llm_response_id)
        : undefined) ?? llmResponse,
    isError: outcome === "erro",
  };
}

/* ── Fonte B: Auto-revisão (view `final_answers`) ── */
function autoReviewCandidate(
  row: MetricsFinalAnswer,
  ctx: MetricsContext,
): Candidate | null {
  const measurable = measurableAutoReviewRow(row, ctx);
  if (!measurable) return null;
  const { field, arbitratedLlm, isError } = measurable;
  const decidedAt = row.final_decided_at ?? row.self_reviewed_at ?? null;
  const shared: SharedEntryFields = {
    documentId: row.document_id,
    documentTitle: ctx.titleOf(row.document_id),
    fieldName: row.field_name,
    schemaVersion: formatSchemaVersion(arbitratedLlm),
    // Consenso não tem instante de decisão; a data da resposta do LLM é o que
    // situa a entrada no tempo para o filtro de período.
    reviewedAt: decidedAt ?? arbitratedLlm.created_at,
  };

  return {
    documentId: row.document_id,
    fieldName: row.field_name,
    decidedAt,
    isError,
    error: isError
      ? buildAutoReviewError(row, field, arbitratedLlm, shared, ctx)
      : null,
    entry: { ...shared, isError },
  };
}

function autoReviewCandidates(
  finalAnswers: MetricsFinalAnswer[],
  ctx: MetricsContext,
): Candidate[] {
  return finalAnswers.flatMap((row) => {
    const candidate = autoReviewCandidate(row, ctx);
    return candidate ? [candidate] : [];
  });
}

// Único ponto que decide se a fonte de auto-revisão vale para um projeto.
// Sem esse gate, um projeto de Comparação (`compare_llm`) veria toda a sua
// grade documento × campo entrar como acerto: medido no Zolgensma, o
// denominador saltava de 898 para 2944 e a taxa despencava de 37% para 11% —
// puro ruído de linhas 'consenso' que nunca passaram por auto-revisão, porque
// `field_reviews` não é materializado nesse modo.
//
// Exportado porque a página também precisa da resposta ANTES de consultar o
// banco: a view `final_answers` é cara (uma chamada de
// `is_auto_review_reconciliation_pending`, SECURITY DEFINER, por linha
// documento × campo) e não faz sentido pagá-la para descartar o resultado.
export function usesAutoReviewSource(automationMode: string | null): boolean {
  return automationMode === "auto_review_llm";
}

export function computeLlmErrorMetrics(input: LlmErrorMetricsInput): {
  errors: LlmError[];
  reviewedEntries: ReviewedEntry[];
} {
  const ctx = buildContext(input);

  const autoReviewEnabled = usesAutoReviewSource(input.automationMode);

  const candidates = [
    ...comparisonCandidates(input.reviews, ctx),
    ...(autoReviewEnabled ? autoReviewCandidates(input.finalAnswers, ctx) : []),
  ];

  /* ── Deduplicação por (documento, campo) ── */
  // Vale tanto ENTRE as fontes quanto DENTRO da Comparação: `reviews` é única
  // por (projeto, doc, campo, revisor), então um campo revisado por três
  // pessoas rendia três entradas e pesava o triplo na taxa. Uma entrada por
  // campo é a leitura certa de "quantos campos o LLM errou" — medido no
  // projeto Zolgensma, o efeito é de menos de 1 ponto percentual (961 reviews
  // colapsam em 898 campos), mas o peso deixa de depender de quantas pessoas
  // passaram pelo documento.
  const winners = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const key = `${candidate.documentId}:${candidate.fieldName}`;
    const incumbent = winners.get(key);
    if (!incumbent || beats(candidate, incumbent)) winners.set(key, candidate);
  }

  // Ordem estável por (documento, campo): a ordem de retorno do Postgres não é
  // garantida, e a UI exibe esta lista como está quando o sort é "default".
  const sorted = [...winners.values()].sort((a, b) =>
    a.documentId === b.documentId
      ? a.fieldName.localeCompare(b.fieldName)
      : a.documentId.localeCompare(b.documentId),
  );

  return {
    errors: sorted.flatMap((c) => (c.error ? [c.error] : [])),
    reviewedEntries: sorted.map((c) => c.entry),
  };
}
