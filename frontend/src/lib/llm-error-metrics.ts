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
import { isFieldVisible } from "@/lib/conditional";
import {
  buildResponseGroupKeys,
  filterCurrentEquivalencePairs,
  type EquivalencePair,
} from "@/lib/equivalence";
import { fieldExistedWhenCoded } from "@/lib/answer-staleness";
import { isCodingComplete } from "@/lib/coding-completeness";
import { formatAnswer } from "@/lib/reviews/queries";
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";

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

// Linha da view `final_answers` (uma por documento com LLM × campo do schema).
export interface MetricsFinalAnswer {
  document_id: string;
  field_name: string;
  provenance: string;
  final_verdict: string | null;
  self_reviewed_at: string | null;
  final_decided_at: string | null;
  human_response_id: string | null;
  llm_response_id: string | null;
  human_answer_snapshot: unknown;
  llm_answer_snapshot: unknown;
  arbitrator_comment?: string | null;
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

export function formatSchemaVersion(response: {
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

// Campos que o coordenador removeu da superfície de revisão humana nunca são
// erro: vereditos antigos sobre eles vazariam para a métrica.
function isMeasurableField(field: PydanticField | undefined): field is PydanticField {
  return !!field && field.target !== "none" && field.target !== "llm_only";
}

// "O LLM acertou este campo?" a partir da proveniência da auto-revisão. O mapa
// espelha a view `final_answers`; 'arbitrado' é o único caso em que
// `provenance` sozinho não decide.
function classifyAutoReview(
  row: MetricsFinalAnswer,
): "acerto" | "erro" | "pendente" {
  switch (row.provenance) {
    // Sem linha em `field_reviews`: humano e LLM concordaram na codificação, e
    // o campo nunca entrou na fila de auto-revisão.
    case "consenso":
    // O codificador reconheceu que errou e o LLM estava certo.
    case "auto_corrigido":
    // Respostas diferentes no texto, mesma coisa no conteúdo — o análogo
    // exato do "semelhantes" da Comparação, e como lá, não é erro do LLM.
    case "equivalente":
      return "acerto";
    case "arbitrado":
      return row.final_verdict === "humano" ? "erro" : "acerto";
    // 'ambiguo' é terminal mas não produz gabarito: fica fora do numerador E
    // do denominador, como já acontece com o veredito "ambiguo" da Comparação.
    // Os 'aguarda_*' são pendências, não acertos.
    default:
      return "pendente";
  }
}

// Vence a decisão mais recente. Consenso não é decisão de ninguém e perde para
// qualquer veredito explícito, de qualquer das fontes; empate mantém o
// incumbente, o que torna o resultado estável dada a ordem de inserção.
function beats(candidate: Candidate, incumbent: Candidate): boolean {
  if (candidate.decidedAt && !incumbent.decidedAt) return true;
  if (!candidate.decidedAt) return false;
  return candidate.decidedAt > incumbent.decidedAt!;
}

export function computeLlmErrorMetrics(input: LlmErrorMetricsInput): {
  errors: LlmError[];
  reviewedEntries: ReviewedEntry[];
} {
  const {
    fields,
    automationMode,
    documentTitles,
    responses,
    reviews,
    finalAnswers,
    equivalences,
    errorResolutions,
  } = input;

  const fieldMap = new Map(fields.map((f) => [f.name, f]));
  const titleOf = (docId: string) => documentTitles.get(docId) || docId;
  const resolvedAtOf = (docId: string, fieldName: string) =>
    errorResolutions.get(`${docId}:${fieldName}`) ?? null;

  const responsesByDoc = new Map<string, MetricsResponse[]>();
  const llmLatestByDoc = new Map<string, MetricsResponse>();
  for (const response of responses) {
    const bucket = responsesByDoc.get(response.document_id);
    if (bucket) bucket.push(response);
    else responsesByDoc.set(response.document_id, [response]);
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

  // Classes de equivalência por (documento, campo), memoizadas: um documento
  // com muitos campos revisados repetiria o union-find à toa.
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

  const candidates: Candidate[] = [];

  /* ── Fonte A: Comparação (`reviews`) ── */
  for (const review of reviews) {
    const llmResponse = llmLatestByDoc.get(review.document_id);
    if (!llmResponse) continue;

    const field = fieldMap.get(review.field_name);
    if (!isMeasurableField(field)) continue;

    const llmAnswer = llmResponse.answers?.[review.field_name];
    let isError = false;

    if (review.chosen_response_id !== llmResponse.id) {
      // Uma única noção de "mesma resposta": as classes do union-find já fundem
      // tanto pares marcados como equivalentes pelo revisor quanto respostas de
      // texto idêntico, e propagam por transitividade (A≡B, B≡C ⇒ A≡C). É a
      // mesma primitiva que a tela de Comparação usa para decidir divergência.
      const groupKeys = groupKeysFor(review.document_id, review.field_name);
      const llmKey = groupKeys.get(llmResponse.id);
      const chosenKey = review.chosen_response_id
        ? groupKeys.get(review.chosen_response_id)
        : undefined;

      if (llmKey !== undefined && chosenKey !== undefined) {
        isError = llmKey !== chosenKey;
      } else {
        // A response escolhida sumiu do conjunto (apagada, ou de um documento
        // que não veio na página). Resta comparar o texto do veredito, que é
        // uma cópia do valor escolhido no momento da revisão.
        isError =
          normalizeForComparison(llmAnswer) !==
          normalizeForComparison(review.verdict);
      }
    }

    const schemaVersion = formatSchemaVersion(llmResponse);
    candidates.push({
      documentId: review.document_id,
      fieldName: review.field_name,
      decidedAt: review.created_at,
      isError,
      error: isError
        ? {
            documentId: review.document_id,
            documentTitle: titleOf(review.document_id),
            fieldName: review.field_name,
            fieldDescription: field.description || review.field_name,
            llmAnswer: formatAnswer(llmAnswer),
            llmJustification:
              llmResponse.justifications?.[review.field_name] || null,
            chosenVerdict: review.verdict,
            reviewerComment: review.comment,
            resolvedAt: resolvedAtOf(review.document_id, review.field_name),
            reviewedAt: review.created_at,
            schemaVersion,
            llmResponseId: llmResponse.id,
            chosenResponseId: review.chosen_response_id,
          }
        : null,
      entry: {
        documentId: review.document_id,
        documentTitle: titleOf(review.document_id),
        fieldName: review.field_name,
        schemaVersion,
        reviewedAt: review.created_at,
        isError,
      },
    });
  }

  /* ── Fonte B: Auto-revisão (view `final_answers`) ── */
  // Sem este gate, um projeto de Comparação (`compare_llm`) veria toda a sua
  // grade documento × campo entrar como acerto: medido no projeto Zolgensma,
  // o denominador saltava de 898 para 2944 e a taxa despencava de 37% para
  // 11% — puro ruído de linhas 'consenso' que nunca passaram por auto-revisão.
  const autoReviewEnabled = automationMode === "auto_review_llm";
  for (const row of autoReviewEnabled ? finalAnswers : []) {
    const field = fieldMap.get(row.field_name);
    if (!isMeasurableField(field)) continue;

    const llmResponse = llmLatestByDoc.get(row.document_id);
    if (!llmResponse) continue;

    // A view produz uma linha por campo do schema para TODO documento com
    // resposta do LLM, e marca 'consenso' sempre que não há linha em
    // `field_reviews` — inclusive em documentos que ninguém codificou. Sem
    // este gate, não-codificação viraria acerto do LLM e afundaria a taxa.
    //
    // O gate espelha `computeBacklogRows` (`auto-review-backlog.ts`), que é
    // quem MATERIALIZA as linhas de `field_reviews`: ele só varre codificações
    // humanas COMPLETAS. Um gate mais frouxo aqui leria a ausência de linha
    // num documento pela metade como concordância, quando ela só significa que
    // o documento ainda não era elegível ao backlog.
    const humanCoded = (responsesByDoc.get(row.document_id) ?? []).some(
      (response) =>
        response.respondent_type === "humano" &&
        response.is_latest &&
        fieldExistedWhenCoded(
          response.answer_field_hashes ?? undefined,
          field.name,
        ) &&
        isFieldVisible(field, response.answers ?? {}) &&
        isCodingComplete(
          fields,
          response.answers ?? {},
          response.answer_field_hashes ?? undefined,
        ),
    );
    if (!humanCoded) continue;

    const outcome = classifyAutoReview(row);
    if (outcome === "pendente") continue;

    const isError = outcome === "erro";
    const decidedAt = row.final_decided_at ?? row.self_reviewed_at ?? null;
    // Consenso não tem instante de decisão; a data da resposta do LLM é o que
    // situa a entrada no tempo para o filtro de período.
    const reviewedAt = decidedAt ?? llmResponse.created_at;
    const schemaVersion = formatSchemaVersion(llmResponse);

    candidates.push({
      documentId: row.document_id,
      fieldName: row.field_name,
      decidedAt,
      isError,
      error: isError
        ? {
            documentId: row.document_id,
            documentTitle: titleOf(row.document_id),
            fieldName: row.field_name,
            fieldDescription: field.description || row.field_name,
            // Os snapshots congelam os valores sobre os quais o veredito foi
            // dado; a resposta atual pode já ter sido revisada desde então.
            llmAnswer: formatAnswer(
              row.llm_answer_snapshot ?? llmResponse.answers?.[row.field_name],
            ),
            llmJustification:
              llmResponse.justifications?.[row.field_name] || null,
            chosenVerdict: formatAnswer(row.human_answer_snapshot),
            reviewerComment: row.arbitrator_comment ?? null,
            resolvedAt: resolvedAtOf(row.document_id, row.field_name),
            reviewedAt,
            schemaVersion,
            llmResponseId: row.llm_response_id ?? llmResponse.id,
            chosenResponseId: row.human_response_id,
          }
        : null,
      entry: {
        documentId: row.document_id,
        documentTitle: titleOf(row.document_id),
        fieldName: row.field_name,
        schemaVersion,
        reviewedAt,
        isError,
      },
    });
  }

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
