import { describe, it, expect } from "vitest";
import {
  computeLlmErrorMetrics,
  type LlmErrorMetricsInput,
  type MetricsEquivalence,
  type MetricsFinalAnswer,
  type MetricsResponse,
  type MetricsReview,
} from "@/lib/llm-error-metrics";
import type { PydanticField } from "@/lib/types";

function field(overrides: Partial<PydanticField> = {}): PydanticField {
  return {
    name: "x",
    type: "text",
    options: null,
    description: "",
    target: "all",
    ...overrides,
  };
}

function response(overrides: Partial<MetricsResponse> = {}): MetricsResponse {
  return {
    id: "r1",
    document_id: "doc1",
    respondent_type: "humano",
    is_latest: true,
    answers: {},
    justifications: null,
    answer_field_hashes: null,
    created_at: "2026-01-01T00:00:00Z",
    schema_version_major: 1,
    schema_version_minor: 0,
    schema_version_patch: 0,
    ...overrides,
  };
}

function review(overrides: Partial<MetricsReview> = {}): MetricsReview {
  return {
    document_id: "doc1",
    field_name: "x",
    verdict: "sim",
    chosen_response_id: "rh",
    comment: null,
    created_at: "2026-02-01T00:00:00Z",
    ...overrides,
  };
}

function finalAnswer(
  overrides: Partial<MetricsFinalAnswer> = {},
): MetricsFinalAnswer {
  return {
    document_id: "doc1",
    field_name: "x",
    provenance: "consenso",
    final_verdict: null,
    self_reviewed_at: null,
    final_decided_at: null,
    human_response_id: null,
    llm_response_id: null,
    human_answer_snapshot: null,
    llm_answer_snapshot: null,
    ...overrides,
  };
}

function equiv(
  a: string,
  b: string,
  snapA: unknown,
  snapB: unknown,
  overrides: Partial<MetricsEquivalence> = {},
): MetricsEquivalence {
  return {
    document_id: "doc1",
    field_name: "x",
    response_a_id: a,
    response_b_id: b,
    response_a_answer_snapshot: snapA,
    response_b_answer_snapshot: snapB,
    ...overrides,
  };
}

function run(overrides: Partial<LlmErrorMetricsInput> = {}) {
  return computeLlmErrorMetrics({
    fields: [field()],
    documentTitles: new Map([["doc1", "Documento 1"]]),
    responses: [],
    reviews: [],
    finalAnswers: [],
    equivalences: [],
    errorResolutions: new Map(),
    ...overrides,
  });
}

// Respostas divergentes no texto: o LLM disse "NI", o humano disse "N/A".
const llmResp = response({
  id: "rllm",
  respondent_type: "llm",
  answers: { x: "NI" },
});
const humanResp = response({ id: "rh", answers: { x: "N/A" } });

describe("computeLlmErrorMetrics — fonte Comparação", () => {
  it("conta erro quando o gabarito escolhido difere da resposta do LLM", () => {
    const { errors, reviewedEntries } = run({
      responses: [llmResp, humanResp],
      reviews: [review({ verdict: "N/A" })],
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].llmAnswer).toBe("NI");
    expect(errors[0].chosenVerdict).toBe("N/A");
    expect(reviewedEntries).toHaveLength(1);
    expect(reviewedEntries[0].isError).toBe(true);
  });

  it("não conta erro quando a própria resposta do LLM é o gabarito", () => {
    const { errors, reviewedEntries } = run({
      responses: [llmResp, humanResp],
      reviews: [review({ chosen_response_id: "rllm", verdict: "NI" })],
    });

    expect(errors).toHaveLength(0);
    expect(reviewedEntries).toHaveLength(1);
    expect(reviewedEntries[0].isError).toBe(false);
  });

  // A regressão que este módulo não pode quebrar: "semelhantes" é acerto.
  it("equivalência marcada suprime o erro e PERMANECE no denominador", () => {
    const { errors, reviewedEntries } = run({
      responses: [llmResp, humanResp],
      reviews: [review({ verdict: "N/A" })],
      equivalences: [equiv("rh", "rllm", "N/A", "NI")],
    });

    expect(errors).toHaveLength(0);
    expect(reviewedEntries).toHaveLength(1);
    expect(reviewedEntries[0].isError).toBe(false);
  });

  it("propaga equivalência por transitividade (A≡B, B≡C ⇒ A≡C)", () => {
    // O par marcado liga o LLM a uma resposta intermediária; o gabarito
    // escolhido é uma terceira resposta, ligada à intermediária só por texto.
    const intermediaria = response({ id: "rmid", answers: { x: "nao informado" } });
    const escolhida = response({ id: "rh2", answers: { x: "Não informado" } });

    const { errors } = run({
      responses: [llmResp, intermediaria, escolhida],
      reviews: [review({ chosen_response_id: "rh2", verdict: "Não informado" })],
      equivalences: [equiv("rllm", "rmid", "NI", "nao informado")],
    });

    expect(errors).toHaveLength(0);
  });

  it("ignora par cujo snapshot não corresponde mais à resposta atual", () => {
    // A resposta humana foi revisada depois de o par ser criado: a decisão de
    // equivalência era sobre outro valor e não vale mais.
    const { errors } = run({
      responses: [llmResp, humanResp],
      reviews: [review({ verdict: "N/A" })],
      equivalences: [equiv("rh", "rllm", "valor antigo", "NI")],
    });

    expect(errors).toHaveLength(1);
  });

  it("descarta par sem colunas de snapshot (fail-closed)", () => {
    const semSnapshot = {
      document_id: "doc1",
      field_name: "x",
      response_a_id: "rh",
      response_b_id: "rllm",
    } as unknown as MetricsEquivalence;

    const { errors } = run({
      responses: [llmResp, humanResp],
      reviews: [review({ verdict: "N/A" })],
      equivalences: [semSnapshot],
    });

    expect(errors).toHaveLength(1);
  });

  it("cai no texto do veredito quando a resposta escolhida não está no conjunto", () => {
    // `chosen_response_id` aponta para uma resposta de rodada anterior que não
    // veio na página; o texto gravado no veredito ainda prova a igualdade.
    const { errors } = run({
      responses: [llmResp],
      reviews: [review({ chosen_response_id: "sumiu", verdict: "NI" })],
    });

    expect(errors).toHaveLength(0);
  });

  it("ignora campos fora da superfície de revisão humana", () => {
    const { reviewedEntries } = run({
      fields: [field({ name: "a", target: "none" }), field({ name: "b", target: "llm_only" })],
      responses: [response({ id: "rllm", respondent_type: "llm", answers: { a: "1", b: "2" } })],
      reviews: [
        review({ field_name: "a", verdict: "z" }),
        review({ field_name: "b", verdict: "z" }),
      ],
    });

    expect(reviewedEntries).toHaveLength(0);
  });
});

describe("computeLlmErrorMetrics — fonte Auto-revisão", () => {
  const llmDoc2 = response({
    id: "rllm2",
    document_id: "doc2",
    respondent_type: "llm",
    answers: { x: "NI" },
  });
  const humanDoc2 = response({ id: "rh2", document_id: "doc2", answers: { x: "N/A" } });
  const titles = new Map([
    ["doc1", "Documento 1"],
    ["doc2", "Documento 2"],
  ]);

  it("consenso conta como acerto quando houve codificação humana", () => {
    const { errors, reviewedEntries } = run({
      documentTitles: titles,
      responses: [llmDoc2, humanDoc2],
      finalAnswers: [finalAnswer({ document_id: "doc2", provenance: "consenso" })],
    });

    expect(errors).toHaveLength(0);
    expect(reviewedEntries).toHaveLength(1);
    expect(reviewedEntries[0].isError).toBe(false);
  });

  // A armadilha da view: ela emite 'consenso' para todo documento com resposta
  // do LLM, inclusive os que ninguém codificou.
  it("consenso SEM codificação humana fica fora do denominador", () => {
    const { errors, reviewedEntries } = run({
      documentTitles: titles,
      responses: [llmDoc2],
      finalAnswers: [finalAnswer({ document_id: "doc2", provenance: "consenso" })],
    });

    expect(errors).toHaveLength(0);
    expect(reviewedEntries).toHaveLength(0);
  });

  it("não conta campo que ainda não existia quando o humano codificou", () => {
    const { reviewedEntries } = run({
      documentTitles: titles,
      responses: [
        llmDoc2,
        response({
          id: "rh2",
          document_id: "doc2",
          answers: { outro: "v" },
          answer_field_hashes: { outro: "h1" },
        }),
      ],
      finalAnswers: [finalAnswer({ document_id: "doc2", provenance: "consenso" })],
    });

    expect(reviewedEntries).toHaveLength(0);
  });

  it("classifica cada proveniência no balde certo", () => {
    const cases: Array<{
      provenance: string;
      final_verdict?: string | null;
      esperado: "acerto" | "erro" | "fora";
    }> = [
      { provenance: "consenso", esperado: "acerto" },
      { provenance: "auto_corrigido", esperado: "acerto" },
      { provenance: "equivalente", esperado: "acerto" },
      { provenance: "arbitrado", final_verdict: "llm", esperado: "acerto" },
      { provenance: "arbitrado", final_verdict: "humano", esperado: "erro" },
      { provenance: "ambiguo", esperado: "fora" },
      { provenance: "aguarda_auto_revisao", esperado: "fora" },
      { provenance: "aguarda_arbitragem", esperado: "fora" },
      { provenance: "aguarda_reconciliacao", esperado: "fora" },
    ];

    for (const { provenance, final_verdict, esperado } of cases) {
      const { errors, reviewedEntries } = run({
        documentTitles: titles,
        responses: [llmDoc2, humanDoc2],
        finalAnswers: [
          finalAnswer({
            document_id: "doc2",
            provenance,
            final_verdict: final_verdict ?? null,
            human_answer_snapshot: "N/A",
            llm_answer_snapshot: "NI",
            final_decided_at: final_verdict ? "2026-03-01T00:00:00Z" : null,
          }),
        ],
      });

      const resumo = { provenance, final_verdict: final_verdict ?? null };
      if (esperado === "fora") {
        expect(reviewedEntries, JSON.stringify(resumo)).toHaveLength(0);
      } else {
        expect(reviewedEntries, JSON.stringify(resumo)).toHaveLength(1);
        expect(errors.length, JSON.stringify(resumo)).toBe(
          esperado === "erro" ? 1 : 0,
        );
      }
    }
  });

  it("descreve o erro arbitrado pelos snapshots do ciclo", () => {
    const { errors } = run({
      documentTitles: titles,
      responses: [llmDoc2, humanDoc2],
      finalAnswers: [
        finalAnswer({
          document_id: "doc2",
          provenance: "arbitrado",
          final_verdict: "humano",
          final_decided_at: "2026-03-01T00:00:00Z",
          human_response_id: "rh2",
          llm_response_id: "rllm2",
          human_answer_snapshot: "N/A",
          llm_answer_snapshot: "NI",
        }),
      ],
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      documentId: "doc2",
      documentTitle: "Documento 2",
      llmAnswer: "NI",
      chosenVerdict: "N/A",
      chosenResponseId: "rh2",
      llmResponseId: "rllm2",
      reviewedAt: "2026-03-01T00:00:00Z",
    });
  });
});

describe("computeLlmErrorMetrics — deduplicação entre as fontes", () => {
  it("conta uma vez só, vencendo a decisão mais recente", () => {
    const { errors, reviewedEntries } = run({
      responses: [llmResp, humanResp],
      // Comparação decidiu em fevereiro que o LLM errou...
      reviews: [review({ verdict: "N/A", created_at: "2026-02-01T00:00:00Z" })],
      // ...e a arbitragem decidiu em março que o LLM estava certo.
      finalAnswers: [
        finalAnswer({
          provenance: "arbitrado",
          final_verdict: "llm",
          final_decided_at: "2026-03-01T00:00:00Z",
          human_response_id: "rh",
          llm_response_id: "rllm",
        }),
      ],
    });

    expect(reviewedEntries).toHaveLength(1);
    expect(errors).toHaveLength(0);
  });

  it("um veredito explícito vence o consenso, que não é decisão de ninguém", () => {
    const { errors, reviewedEntries } = run({
      responses: [llmResp, humanResp],
      reviews: [review({ verdict: "N/A" })],
      finalAnswers: [finalAnswer({ provenance: "consenso" })],
    });

    expect(reviewedEntries).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });
});

describe("computeLlmErrorMetrics — metadados para os filtros da UI", () => {
  it("preenche schemaVersion e reviewedAt nas duas fontes", () => {
    const { reviewedEntries } = run({
      documentTitles: new Map([
        ["doc1", "Documento 1"],
        ["doc2", "Documento 2"],
      ]),
      responses: [
        llmResp,
        humanResp,
        response({
          id: "rllm2",
          document_id: "doc2",
          respondent_type: "llm",
          answers: { x: "NI" },
          created_at: "2026-01-15T00:00:00Z",
          schema_version_major: 2,
          schema_version_minor: 1,
          schema_version_patch: 0,
        }),
        response({ id: "rh2", document_id: "doc2", answers: { x: "NI" } }),
      ],
      reviews: [review({ verdict: "N/A" })],
      finalAnswers: [finalAnswer({ document_id: "doc2", provenance: "consenso" })],
    });

    expect(reviewedEntries).toHaveLength(2);
    const porDoc = new Map(reviewedEntries.map((e) => [e.documentId, e]));
    expect(porDoc.get("doc1")).toMatchObject({
      schemaVersion: "1.0.0",
      reviewedAt: "2026-02-01T00:00:00Z",
    });
    // Consenso não tem instante de decisão: cai na data da resposta do LLM.
    expect(porDoc.get("doc2")).toMatchObject({
      schemaVersion: "2.1.0",
      reviewedAt: "2026-01-15T00:00:00Z",
    });
  });

  it("anexa o resolvedAt de erros já resolvidos", () => {
    const { errors } = run({
      responses: [llmResp, humanResp],
      reviews: [review({ verdict: "N/A" })],
      errorResolutions: new Map([["doc1:x", "2026-04-01T00:00:00Z"]]),
    });

    expect(errors[0].resolvedAt).toBe("2026-04-01T00:00:00Z");
  });
});
