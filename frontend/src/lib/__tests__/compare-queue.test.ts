import { describe, it, expect } from "vitest";
import {
  buildEquivalenceMap,
  indexResponsesByDoc,
  extractRespondentNames,
  buildAvailableVersions,
  buildCodingAssignedByDoc,
  buildCompareAssignmentStatusByDoc,
  qualifyDocumentsForCompare,
  buildDocumentsForCompare,
  buildReviewsAndReviewedCounts,
  buildCountsByKey,
  sortDocumentsByPendingDivergence,
  serializeEquivalencesForClient,
  type CompareQueueResponse,
  type DocCoverage,
  type QualifyDocumentsContext,
} from "@/lib/compare-queue";
import type { CompareFiltersValue } from "@/lib/compare-filters";
import type { ProjectVersionContext } from "@/lib/compare-version";
import type { PydanticField } from "@/lib/types";

function field(overrides: Partial<PydanticField>): PydanticField {
  return {
    name: "x",
    type: "text",
    options: null,
    description: "",
    target: "all",
    ...overrides,
  };
}

function response(overrides: Partial<CompareQueueResponse> = {}): CompareQueueResponse {
  return {
    id: "r1",
    document_id: "doc1",
    respondent_type: "humano",
    respondent_name: "Ana",
    respondent_id: "user-ana",
    answers: { a: "x" },
    justifications: null,
    is_latest: true,
    is_partial: false,
    pydantic_hash: "hash1",
    answer_field_hashes: {},
    schema_version_major: null,
    schema_version_minor: null,
    schema_version_patch: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const BASE_FILTERS: CompareFiltersValue = {
  version: "all",
  minHumans: 2,
  minTotal: 2,
  minAssignedPct: 50,
  since: "",
  respondent: "all",
};

const BASE_PROJECT_VERSION_CTX: ProjectVersionContext = {
  pydanticHash: null,
  version: { major: 0, minor: 1, patch: 0 },
};

function baseCtx(overrides: Partial<QualifyDocumentsContext> = {}): QualifyDocumentsContext {
  return {
    compareAssignedDocIds: null,
    codingAssignedByDoc: new Map(),
    compareAssignmentStatusByDoc: new Map(),
    filters: BASE_FILTERS,
    minVersion: null,
    projectVersionCtx: BASE_PROJECT_VERSION_CTX,
    sinceMs: null,
    fields: [field({ name: "a" })],
    equivByDocField: new Map(),
    ...overrides,
  };
}

describe("buildEquivalenceMap", () => {
  it("null/vazio retorna Map vazio", () => {
    expect(buildEquivalenceMap(null).size).toBe(0);
    expect(buildEquivalenceMap([]).size).toBe(0);
  });

  it("agrupa pares por (document_id, field_name)", () => {
    const map = buildEquivalenceMap([
      { id: "e1", document_id: "d1", field_name: "a", response_a_id: "r1", response_b_id: "r2", reviewer_id: "u1", response_a_answer_snapshot: null, response_b_answer_snapshot: null },
      { id: "e2", document_id: "d1", field_name: "a", response_a_id: "r3", response_b_id: "r4", reviewer_id: null, response_a_answer_snapshot: null, response_b_answer_snapshot: null },
      { id: "e3", document_id: "d1", field_name: "b", response_a_id: "r5", response_b_id: "r6", reviewer_id: "u1", response_a_answer_snapshot: null, response_b_answer_snapshot: null },
      { id: "e4", document_id: "d2", field_name: "a", response_a_id: "r7", response_b_id: "r8", reviewer_id: "u1", response_a_answer_snapshot: null, response_b_answer_snapshot: null },
    ]);
    expect(map.get("d1")?.get("a")).toHaveLength(2);
    expect(map.get("d1")?.get("b")).toHaveLength(1);
    expect(map.get("d2")?.get("a")).toHaveLength(1);
  });
});

describe("indexResponsesByDoc", () => {
  it("null retorna maps vazios", () => {
    const { responsesByDoc, docsMetaMap } = indexResponsesByDoc(null);
    expect(responsesByDoc.size).toBe(0);
    expect(docsMetaMap.size).toBe(0);
  });

  it("agrupa responses por document_id e captura o join documents", () => {
    const { responsesByDoc, docsMetaMap } = indexResponsesByDoc([
      { ...response({ id: "r1", document_id: "doc1" }), documents: { id: "doc1", title: "T1", external_id: null } },
      { ...response({ id: "r2", document_id: "doc1" }), documents: { id: "doc1", title: "T1", external_id: null } },
      { ...response({ id: "r3", document_id: "doc2" }), documents: null },
    ]);
    expect(responsesByDoc.get("doc1")).toHaveLength(2);
    expect(responsesByDoc.get("doc2")).toHaveLength(1);
    expect(docsMetaMap.get("doc1")).toEqual({ id: "doc1", title: "T1", external_id: null });
    // sem join `documents`, o doc não entra no mapa de metadados
    expect(docsMetaMap.has("doc2")).toBe(false);
  });
});

describe("extractRespondentNames", () => {
  it("deduplica e ignora nomes vazios/null", () => {
    const names = extractRespondentNames([
      response({ respondent_name: "Ana" }),
      response({ respondent_name: "Ana" }),
      response({ respondent_name: "Bia" }),
      { ...response(), respondent_name: null as unknown as string },
    ]);
    expect(names.sort()).toEqual(["Ana", "Bia"]);
  });

  it("null retorna []", () => {
    expect(extractRespondentNames(null)).toEqual([]);
  });
});

describe("buildAvailableVersions", () => {
  it("une versionLog e responses, ordenado desc", () => {
    const versions = buildAvailableVersions(
      [
        { version_major: 1, version_minor: 0, version_patch: 0 },
        { version_major: 0, version_minor: 2, version_patch: 0 },
      ],
      [
        response({ schema_version_major: 0, schema_version_minor: 1, schema_version_patch: 0 }),
        // versão já coberta pelo log — não deve duplicar
        response({ schema_version_major: 1, schema_version_minor: 0, schema_version_patch: 0 }),
        // sem versão gravada — ignorado
        response({ schema_version_major: null, schema_version_minor: null, schema_version_patch: null }),
      ],
    );
    expect(versions).toEqual(["1.0.0", "0.2.0", "0.1.0"]);
  });
});

describe("buildCodingAssignedByDoc / buildCompareAssignmentStatusByDoc", () => {
  const assignments = [
    { document_id: "d1", user_id: "u1", type: "codificacao", status: "pendente" },
    { document_id: "d1", user_id: "u2", type: "codificacao", status: "pendente" },
    { document_id: "d1", user_id: "u3", type: "comparacao", status: "em_andamento" },
    { document_id: "d2", user_id: "u3", type: "comparacao", status: "concluido" },
  ];

  it("buildCodingAssignedByDoc só considera type=codificacao", () => {
    const map = buildCodingAssignedByDoc(assignments);
    expect(map.get("d1")).toEqual(new Set(["u1", "u2"]));
    expect(map.has("d2")).toBe(false);
  });

  it("buildCompareAssignmentStatusByDoc: showAll=true não tem assignment individual de referência", () => {
    expect(buildCompareAssignmentStatusByDoc(assignments, true, "u3").size).toBe(0);
  });

  it("buildCompareAssignmentStatusByDoc: showAll=false filtra por type=comparacao e pelo usuário", () => {
    const map = buildCompareAssignmentStatusByDoc(assignments, false, "u3");
    expect(map.get("d1")).toBe("em_andamento");
    expect(map.get("d2")).toBe("concluido");
  });
});

// Fixtures do único doc "doc1" usado pela maioria dos casos abaixo — reduz a
// repetição do par (responsesByDoc, docsMetaMap) presente em quase todo teste.
function doc1Responses(...responses: CompareQueueResponse[]): Map<string, CompareQueueResponse[]> {
  return new Map([["doc1", responses]]);
}

function doc1Meta(): Map<string, { id: string; title: string | null; external_id: string | null }> {
  return new Map([["doc1", { id: "doc1", title: "T1", external_id: null }]]);
}

describe("qualifyDocumentsForCompare", () => {
  it("doc com 2 respostas divergentes e cobertura suficiente entra na fila", () => {
    const responsesByDoc = doc1Responses(
      response({ id: "r1", respondent_id: "u1", answers: { a: "alpha" } }),
      response({ id: "r2", respondent_id: "u2", respondent_name: "Bia", answers: { a: "beta" } }),
    );

    const result = qualifyDocumentsForCompare(responsesByDoc, doc1Meta(), baseCtx());

    expect(result.qualifiedDocIds).toEqual(["doc1"]);
    expect(result.divergentFields.doc1).toEqual(["a"]);
    expect(result.coverageByDoc.doc1).toMatchObject<Partial<DocCoverage>>({
      humanCount: 2,
      totalCount: 2,
      divergentCount: 1,
      reviewedCount: 0,
    });
  });

  it("doc sem meta (docsMetaMap) é descartado mesmo com respostas", () => {
    const responsesByDoc = doc1Responses(
      response({ id: "r1" }),
      response({ id: "r2", respondent_id: "u2" }),
    );
    const result = qualifyDocumentsForCompare(responsesByDoc, new Map(), baseCtx());
    expect(result.qualifiedDocIds).toEqual([]);
  });

  it("doc fora de compareAssignedDocIds é invisível para o não-coordenador", () => {
    const responsesByDoc = doc1Responses(
      response({ id: "r1", answers: { a: "alpha" } }),
      response({ id: "r2", respondent_id: "u2", answers: { a: "beta" } }),
    );
    const result = qualifyDocumentsForCompare(
      responsesByDoc,
      doc1Meta(),
      baseCtx({ compareAssignedDocIds: new Set(["doc2"]) }),
    );
    expect(result.qualifiedDocIds).toEqual([]);
  });

  it("abaixo do piso minHumans, o doc é descartado", () => {
    const responsesByDoc = doc1Responses(response({ id: "r1" }));
    const result = qualifyDocumentsForCompare(responsesByDoc, doc1Meta(), baseCtx());
    expect(result.qualifiedDocIds).toEqual([]);
  });

  it("sem divergência entre as respostas, o doc é descartado (mesma resposta)", () => {
    const responsesByDoc = doc1Responses(
      response({ id: "r1", answers: { a: "alpha" } }),
      response({ id: "r2", respondent_id: "u2", answers: { a: "alpha" } }),
    );
    const result = qualifyDocumentsForCompare(responsesByDoc, doc1Meta(), baseCtx());
    expect(result.qualifiedDocIds).toEqual([]);
  });

  it("compare_llm (piso minHumans=1): não exige % de atribuídos mesmo com assignedCodingCount>0", () => {
    // Só 1 humano respondeu de 2 atribuídos (50% < minAssignedPct padrão), mas
    // como minHumans < 2 o gate de % atribuídos não se aplica (regra espelhada
    // do page.tsx original, ligada ao modo compare_llm).
    const responsesByDoc = doc1Responses(
      response({ id: "r1", respondent_id: "u1", answers: { a: "alpha" } }),
      response({
        id: "r2",
        respondent_type: "llm",
        respondent_name: "LLM",
        respondent_id: null,
        answers: { a: "beta" },
      }),
    );
    const codingAssignedByDoc = new Map([["doc1", new Set(["u1", "u2"])]]);

    const result = qualifyDocumentsForCompare(
      responsesByDoc,
      doc1Meta(),
      baseCtx({
        filters: { ...BASE_FILTERS, minHumans: 1, minTotal: 2 },
        codingAssignedByDoc,
      }),
    );
    expect(result.qualifiedDocIds).toEqual(["doc1"]);
  });

  it("minHumans>=2: pct de atribuídos abaixo do piso rejeita o doc mesmo com humanCount/totalCount suficientes", () => {
    // humanCount=2 e totalCount=2 passam os pisos, mas só 1 dos 4 atribuídos
    // respondeu (25% < minAssignedPct=50) — diferente do caso compare_llm
    // acima (minHumans=1), aqui o gate de % atribuídos se aplica e rejeita.
    const responsesByDoc = doc1Responses(
      response({ id: "r1", respondent_id: "u1", answers: { a: "alpha" } }),
      response({ id: "r2", respondent_id: "u5", respondent_name: "Bia", answers: { a: "beta" } }),
    );
    const codingAssignedByDoc = new Map([["doc1", new Set(["u1", "u2", "u3", "u4"])]]);

    const result = qualifyDocumentsForCompare(
      responsesByDoc,
      doc1Meta(),
      baseCtx({ codingAssignedByDoc }),
    );
    expect(result.qualifiedDocIds).toEqual([]);
  });

  it("filtro since descarta respostas anteriores à data", () => {
    const responsesByDoc = doc1Responses(
      response({ id: "r1", answers: { a: "alpha" }, created_at: "2026-01-01T00:00:00.000Z" }),
      response({
        id: "r2",
        respondent_id: "u2",
        answers: { a: "beta" },
        created_at: "2026-06-01T00:00:00.000Z",
      }),
    );
    const result = qualifyDocumentsForCompare(
      responsesByDoc,
      doc1Meta(),
      baseCtx({ sinceMs: new Date("2026-03-01T00:00:00.000Z").getTime() }),
    );
    // só a resposta de junho sobrevive ao filtro — cai abaixo de minTotal=2
    expect(result.qualifiedDocIds).toEqual([]);
  });

  it("filtro respondent restringe a um único respondente nomeado", () => {
    const responsesByDoc = doc1Responses(
      response({ id: "r1", respondent_name: "Ana", answers: { a: "alpha" } }),
      response({ id: "r2", respondent_id: "u2", respondent_name: "Bia", answers: { a: "beta" } }),
    );
    const result = qualifyDocumentsForCompare(
      responsesByDoc,
      doc1Meta(),
      baseCtx({ filters: { ...BASE_FILTERS, respondent: "Ana" } }),
    );
    // só Ana qualifica — cai abaixo de minTotal=2
    expect(result.qualifiedDocIds).toEqual([]);
  });
});

describe("buildDocumentsForCompare", () => {
  it("filtra docs sem texto e mescla meta+texto", () => {
    const docsMetaMap = new Map([
      ["doc1", { id: "doc1", title: "T1", external_id: null }],
      ["doc2", { id: "doc2", title: "T2", external_id: null }],
    ]);
    const textMap = new Map([["doc1", "texto do doc1"]]);
    const docs = buildDocumentsForCompare(["doc1", "doc2"], textMap, docsMetaMap);
    expect(docs).toEqual([{ id: "doc1", title: "T1", external_id: null, text: "texto do doc1" }]);
  });
});

describe("buildReviewsAndReviewedCounts", () => {
  it("monta existingReviews e reviewedCount só com os vereditos do usuário atual", () => {
    const { existingReviews, reviewedCountByDoc } = buildReviewsAndReviewedCounts(
      [
        {
          document_id: "doc1",
          field_name: "a",
          verdict: "resposta_a",
          chosen_response_id: "r1",
          comment: null,
          reviewer_id: "me",
        },
        {
          document_id: "doc1",
          field_name: "b",
          verdict: "resposta_b",
          chosen_response_id: "r2",
          comment: "ok",
          reviewer_id: "outro",
        },
      ],
      "me",
      ["doc1"],
      { doc1: ["a", "b"] },
    );
    expect(existingReviews.doc1.a.verdict).toBe("resposta_a");
    // veredito de outro revisor NÃO semeia a tela do usuário atual — a
    // revisão da Comparação é por revisor (mesmo critério do reviewedCount)
    expect(existingReviews.doc1.b).toBeUndefined();
    expect(reviewedCountByDoc.doc1).toBe(1);
  });

  it("doc coberto só por vereditos de terceiros continua inteiramente pendente para o usuário", () => {
    // Regressão do bug de 2026-07-10: docs 100% revisados por OUTRO revisor
    // apareciam como "Revisão concluída" para quem nunca os revisou — o
    // teclado de voto era bloqueado e o assignment nunca fechava.
    const { existingReviews, reviewedCountByDoc } = buildReviewsAndReviewedCounts(
      [
        {
          document_id: "doc1",
          field_name: "a",
          verdict: "x",
          chosen_response_id: null,
          comment: null,
          reviewer_id: "coordenador",
        },
        {
          document_id: "doc1",
          field_name: "b",
          verdict: "y",
          chosen_response_id: null,
          comment: null,
          reviewer_id: "coordenador",
        },
      ],
      "me",
      ["doc1"],
      { doc1: ["a", "b"] },
    );
    expect(existingReviews.doc1).toBeUndefined();
    expect(reviewedCountByDoc.doc1).toBe(0);
  });

  it("doc sem nenhum review do usuário atual conta 0", () => {
    const { reviewedCountByDoc } = buildReviewsAndReviewedCounts(null, "me", ["doc1"], { doc1: ["a"] });
    expect(reviewedCountByDoc.doc1).toBe(0);
  });
});

describe("buildCountsByKey", () => {
  it("conta comentários por (doc, campo) e sugestões por campo", () => {
    const { commentCountsByKey, suggestionCountsByField } = buildCountsByKey(
      [
        { document_id: "doc1", field_name: "a" },
        { document_id: "doc1", field_name: "a" },
        { document_id: "doc1", field_name: "b" },
      ],
      [{ field_name: "a" }, { field_name: "a" }, { field_name: "c" }],
    );
    expect(commentCountsByKey["doc1|a"]).toBe(2);
    expect(commentCountsByKey["doc1|b"]).toBe(1);
    expect(suggestionCountsByField.a).toBe(2);
    expect(suggestionCountsByField.c).toBe(1);
  });
});

describe("sortDocumentsByPendingDivergence", () => {
  it("ordena por pendências (divergentCount - reviewedCount) desc, sem mutar o array recebido", () => {
    const documents = [
      { id: "low", title: null, external_id: null, text: "" },
      { id: "high", title: null, external_id: null, text: "" },
    ];
    const coverageByDoc: Record<string, DocCoverage> = {
      low: {
        docId: "low",
        humanCount: 2,
        totalCount: 2,
        assignedCodingCount: 0,
        humansFromAssigned: 0,
        divergentCount: 1,
        reviewedCount: 1,
        assignmentStatus: null,
      },
      high: {
        docId: "high",
        humanCount: 2,
        totalCount: 2,
        assignedCodingCount: 0,
        humansFromAssigned: 0,
        divergentCount: 3,
        reviewedCount: 0,
        assignmentStatus: null,
      },
    };
    const sorted = sortDocumentsByPendingDivergence(documents, coverageByDoc);
    expect(sorted.map((d) => d.id)).toEqual(["high", "low"]);
    // array original preservado (toSorted não muta)
    expect(documents.map((d) => d.id)).toEqual(["low", "high"]);
  });
});

describe("serializeEquivalencesForClient", () => {
  it("só serializa docs presentes em qualifiedDocIds", () => {
    const equivByDocField = buildEquivalenceMap([
      { id: "e1", document_id: "doc1", field_name: "a", response_a_id: "r1", response_b_id: "r2", reviewer_id: "u1", response_a_answer_snapshot: null, response_b_answer_snapshot: null },
      { id: "e2", document_id: "doc2", field_name: "a", response_a_id: "r3", response_b_id: "r4", reviewer_id: "u1", response_a_answer_snapshot: null, response_b_answer_snapshot: null },
    ]);
    const serialized = serializeEquivalencesForClient(equivByDocField, ["doc1"]);
    expect(Object.keys(serialized)).toEqual(["doc1"]);
    expect(serialized.doc1.a).toEqual([
      { id: "e1", response_a_id: "r1", response_b_id: "r2", reviewer_id: "u1", response_a_answer_snapshot: null, response_b_answer_snapshot: null },
    ]);
  });
});
