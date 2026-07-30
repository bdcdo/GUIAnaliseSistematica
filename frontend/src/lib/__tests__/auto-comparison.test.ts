import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  makeFilterAwareSupabaseMock,
  type QueryError,
  type RpcCall,
  type RpcResult,
  type WriteCall,
} from "@/test-utils/supabase-mock";
import {
  CURRENT_HASH,
  makeEmptyComparisonTableData,
  makeHumanResponse,
  makeIncompleteCoderComparisonScenario,
  makeProjectMember,
  makeProjectRow,
} from "@/test-utils/comparison-fixtures";

// Mock supabase chainable e FILTER-AWARE: diferente do mock de
// arbitration-retry.test.ts, aplica os filtros .eq/.neq/.in às linhas, porque a
// comparação consulta `responses` duas vezes na mesma chamada (humano vs LLM) —
// um mock que ignora filtros devolveria o mesmo array para ambas.
let writeCalls: WriteCall[];
let rpcCalls: RpcCall[];
let rpcResults: Record<string, RpcResult>;
let tableData: Record<string, unknown[]>;
let queryErrors: Record<string, QueryError | null>;
// Teto do PostgREST por resposta; só os testes de paginação o reduzem.
let maxRows: number | undefined;

const assignmentCalls = () =>
  rpcCalls.filter((call) => call.fn === "assign_comparison_if_eligible");

function makeClient() {
  return makeFilterAwareSupabaseMock({
    tableData,
    writeCalls,
    rpcCalls,
    rpcResults,
    queryErrors,
    maxRows,
  });
}

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => makeClient(),
}));

// `@/lib/auto-comparison.ts` não importa `@/lib/auth` — o mock de
// `@/lib/auth`/`isCoord` que existia antes era boilerplate copiado sem
// efeito (nenhum teste deste arquivo exercitava o guard) — removido no #387.

const llm = (q1: string, extra: Record<string, unknown> = {}) => ({
  id: "r-llm",
  project_id: "p1",
  document_id: "doc1",
  respondent_type: "llm",
  is_latest: true,
  answers: { q1 },
  answer_field_hashes: null,
  pydantic_hash: CURRENT_HASH,
  schema_version_major: null,
  schema_version_minor: null,
  schema_version_patch: null,
  ...extra,
});

beforeEach(() => {
  writeCalls = [];
  rpcCalls = [];
  rpcResults = {
    assign_comparison_if_eligible: { data: true },
  };
  tableData = makeEmptyComparisonTableData();
  queryErrors = {};
  maxRows = undefined;
});

async function loadLib() {
  return import("@/lib/auto-comparison");
}

async function runAutoComparison(
  mode: "compare_humans" | "compare_llm" = "compare_humans",
) {
  const { createAutoComparisonIfDiverges } = await loadLib();
  return createAutoComparisonIfDiverges("p1", "doc1", mode);
}

async function expectAutoComparisonOutcome(
  responses: unknown[],
  assigned: boolean,
  mode: "compare_humans" | "compare_llm" = "compare_humans",
) {
  tableData.responses = responses;
  tableData.project_members = [makeProjectMember("userC")];
  const result = await runAutoComparison(mode);
  expect(result.assigned).toBe(assigned);
  expect(assignmentCalls()).toHaveLength(assigned ? 1 : 0);
  return result;
}

describe("assignComparisonReviewer — pool e balanceamento", () => {
  // O pool elegível é um universo: lido sem paginar, um projeto acima do teto do
  // PostgREST perde os revisores que caem fora da primeira página — que ficariam
  // permanentemente fora do sorteio, sem erro nem log.
  it("considera revisor além da primeira página do PostgREST", async () => {
    const { assignComparisonReviewer } = await loadLib();
    maxRows = 2;
    tableData.project_members = [
      makeProjectMember("userA"),
      makeProjectMember("userB"),
      makeProjectMember("userC"),
    ];

    const r = await assignComparisonReviewer(
      makeClient() as never,
      "p1",
      "doc1",
      new Set(["userA", "userB"]),
    );

    expect(r.assigned).toBe(true);
    expect(assignmentCalls()[0].args).toMatchObject({ p_user_id: "userC" });
  });

  it("exclui TODOS os codificadores do pool", async () => {
    const { assignComparisonReviewer } = await loadLib();
    tableData.project_members = [
      makeProjectMember("userA"),
      makeProjectMember("userB"),
      makeProjectMember("userC"),
    ];
    const r = await assignComparisonReviewer(
      makeClient() as never,
      "p1",
      "doc1",
      new Set(["userA", "userB"]), // codificadores
    );
    expect(r.assigned).toBe(true);
    expect(r.noPool).toBe(false);
    expect(assignmentCalls()).toHaveLength(1);
    expect(assignmentCalls()[0].args).toEqual({
      p_project_id: "p1",
      p_document_id: "doc1",
      p_user_id: "userC",
    });
    expect(writeCalls).toHaveLength(0);
  });

  it("pool vazio (todos codificaram) → noPool, sem commit", async () => {
    const { assignComparisonReviewer } = await loadLib();
    tableData.project_members = [
      makeProjectMember("userA"),
      makeProjectMember("userB"),
    ];
    const r = await assignComparisonReviewer(
      makeClient() as never,
      "p1",
      "doc1",
      new Set(["userA", "userB"]),
    );
    expect(r.noPool).toBe(true);
    expect(r.assigned).toBe(false);
    expect(assignmentCalls()).toHaveLength(0);
  });

  it("ninguém can_compare → noPool", async () => {
    const { assignComparisonReviewer } = await loadLib();
    tableData.project_members = [];
    const r = await assignComparisonReviewer(
      makeClient() as never,
      "p1",
      "doc1",
      new Set(),
    );
    expect(r.noPool).toBe(true);
  });

  it("não reutiliza quem já concluiu comparação do mesmo documento", async () => {
    const { assignComparisonReviewer } = await loadLib();
    tableData.project_members = [makeProjectMember("userC")];
    tableData.assignments = [
      {
        project_id: "p1",
        document_id: "doc1",
        user_id: "userC",
        type: "comparacao",
        status: "concluido",
      },
    ];

    const result = await assignComparisonReviewer(
      makeClient() as never,
      "p1",
      "doc1",
      new Set(["userA"]),
    );

    expect(result).toEqual({ assigned: false, noPool: true });
    expect(assignmentCalls()).toHaveLength(0);
  });

  it("escolhe o revisor de menor carga de comparações abertas", async () => {
    const { assignComparisonReviewer } = await loadLib();
    tableData.project_members = [
      makeProjectMember("userB"),
      makeProjectMember("userC"),
    ];
    // userB já tem 2 comparações abertas; userC nenhuma → escolhe userC.
    tableData.assignments = [
      {
        user_id: "userB",
        project_id: "p1",
        type: "comparacao",
        status: "pendente",
      },
      {
        user_id: "userB",
        project_id: "p1",
        type: "comparacao",
        status: "em_andamento",
      },
    ];
    const r = await assignComparisonReviewer(
      makeClient() as never,
      "p1",
      "doc1",
      new Set(["userA"]),
    );
    expect(r.assigned).toBe(true);
    expect(assignmentCalls()[0].args).toMatchObject({
      p_user_id: "userC",
    });
  });

  it("candidato desabilitado antes do commit → não cria assignment", async () => {
    const { assignComparisonReviewer } = await loadLib();
    tableData.project_members = [makeProjectMember("userC")];
    rpcResults.assign_comparison_if_eligible = { data: false };

    const result = await assignComparisonReviewer(
      makeClient() as never,
      "p1",
      "doc1",
      new Set(["userA"]),
    );

    expect(result).toEqual({ assigned: false, noPool: false });
    expect(assignmentCalls()).toHaveLength(1);
    expect(writeCalls).toHaveLength(0);
  });
});

describe("createAutoComparisonIfDiverges — compare_humans", () => {
  it("2 humanos divergentes → atribui comparacao", async () => {
    await expectAutoComparisonOutcome(
      [makeHumanResponse("userA", "A"), makeHumanResponse("userB", "B")],
      true,
    );
    expect(assignmentCalls()[0].args).toMatchObject({
      p_user_id: "userC",
    });
  });

  it("falha ao carregar equivalências → lança, sem criar comparação", async () => {
    tableData.responses = [
      makeHumanResponse("userA", "A"),
      makeHumanResponse("userB", "B"),
    ];
    tableData.project_members = [makeProjectMember("userC")];
    queryErrors["response_equivalences:select"] = {
      message: "falha ao carregar equivalências",
    };

    await expect(runAutoComparison()).rejects.toThrow(
      "falha ao carregar equivalências",
    );
    expect(assignmentCalls()).toHaveLength(0);
  });

  it("exclui do pool quem tem resposta vigente incompleta", async () => {
    const scenario = makeIncompleteCoderComparisonScenario();
    tableData.responses = scenario.responses;
    tableData.project_members = scenario.members;
    // Sem a exclusão de userC, o balanceamento escolheria esse respondente:
    // userD já tem uma comparação aberta e userC teria carga zero.
    tableData.assignments = scenario.openAssignments;

    const result = await runAutoComparison();

    expect(result.assigned).toBe(true);
    expect(assignmentCalls()[0].args).toMatchObject({
      p_user_id: "userD",
    });
  });

  it("2 humanos em consenso → não atribui", async () => {
    await expectAutoComparisonOutcome(
      [makeHumanResponse("userA", "A"), makeHumanResponse("userB", "A")],
      false,
    );
  });

  it("abaixo do mínimo (1 humano) → não dispara", async () => {
    await expectAutoComparisonOutcome([makeHumanResponse("userA", "A")], false);
  });

  it("codificação incompleta não conta para o mínimo", async () => {
    // userB tem resposta vazia (incompleta) → só 1 humano completo.
    tableData.responses = [
      makeHumanResponse("userA", "A"),
      { ...makeHumanResponse("userB", "B"), answers: {} },
    ];
    tableData.project_members = [makeProjectMember("userC")];
    const r = await runAutoComparison();
    expect(r.assigned).toBe(false);
  });

  it("já existe comparacao ativa → idempotente, não re-sorteia", async () => {
    tableData.responses = [
      makeHumanResponse("userA", "A"),
      makeHumanResponse("userB", "B"),
    ];
    tableData.project_members = [makeProjectMember("userC")];
    tableData.assignments = [
      {
        document_id: "doc1",
        project_id: "p1",
        type: "comparacao",
        status: "pendente",
      },
    ];
    const r = await runAutoComparison();
    expect(r.assigned).toBe(false);
    expect(assignmentCalls()).toHaveLength(0);
  });

  it("comparison_includes_llm=true: humanos concordam mas LLM diverge → dispara", async () => {
    tableData.projects = [makeProjectRow({ comparison_includes_llm: true })];
    await expectAutoComparisonOutcome(
      [
        makeHumanResponse("userA", "A"),
        makeHumanResponse("userB", "A"),
        llm("Z"),
      ],
      true,
    );
  });

  it("comparison_includes_llm=false: humanos concordam e só LLM diverge → NÃO dispara", async () => {
    tableData.projects = [makeProjectRow({ comparison_includes_llm: false })];
    await expectAutoComparisonOutcome(
      [
        makeHumanResponse("userA", "A"),
        makeHumanResponse("userB", "A"),
        llm("Z"),
      ],
      false,
    );
  });
});

describe("createAutoComparisonIfDiverges — compare_llm", () => {
  it("1 humano + LLM divergentes → atribui comparacao", async () => {
    tableData.projects = [makeProjectRow({ automation_mode: "compare_llm" })];
    tableData.responses = [makeHumanResponse("userA", "A"), llm("B")];
    tableData.project_members = [makeProjectMember("userC")];
    const r = await runAutoComparison("compare_llm");
    expect(r.assigned).toBe(true);
    expect(assignmentCalls()[0].args).toMatchObject({
      p_user_id: "userC",
    });
  });

  it("1 humano + LLM em consenso → não dispara", async () => {
    tableData.projects = [makeProjectRow({ automation_mode: "compare_llm" })];
    tableData.responses = [makeHumanResponse("userA", "A"), llm("A")];
    tableData.project_members = [makeProjectMember("userC")];
    const r = await runAutoComparison("compare_llm");
    expect(r.assigned).toBe(false);
  });

  it("sem resposta do LLM → não dispara", async () => {
    tableData.projects = [makeProjectRow({ automation_mode: "compare_llm" })];
    tableData.responses = [makeHumanResponse("userA", "A")];
    tableData.project_members = [makeProjectMember("userC")];
    const r = await runAutoComparison("compare_llm");
    expect(r.assigned).toBe(false);
  });

  it("codificador do doc não entra no pool (LLM compara, mas humano que codificou não revisa)", async () => {
    tableData.projects = [makeProjectRow({ automation_mode: "compare_llm" })];
    tableData.responses = [makeHumanResponse("userA", "A"), llm("B")];
    // userA é o único can_compare, mas codificou o doc → noPool.
    tableData.project_members = [makeProjectMember("userA")];
    const r = await runAutoComparison("compare_llm");
    expect(r.assigned).toBe(false);
    expect(r.noPool).toBe(true);
  });
});

// O gatilho aplica o MESMO piso de versão (`latest_major`) que a fila
// (compare/page.tsx) e o fecho (compare-sync.ts) — fecha a NOTA de follow-up do
// #286 e restaura o acoplamento gatilho==fila==fecho. Divergência que só existe
// entre rodadas antigas NÃO materializa assignment (era o "fantasma" da NOTA).
describe("createAutoComparisonIfDiverges — piso de versão latest_major (#247)", () => {
  it("divergência só entre codificações de versão ANTIGA (hash) não materializa", async () => {
    // Dois humanos completos que DIVERGEM, mas ambos de um schema anterior
    // (pydantic_hash != atual, semver NULL) → descartados pelo piso → 0 < 2.
    await expectAutoComparisonOutcome(
      [
        makeHumanResponse("userA", "A", { pydantic_hash: "hash-antigo" }),
        makeHumanResponse("userB", "B", { pydantic_hash: "hash-antigo" }),
      ],
      false,
    );
  });

  it("divergência só entre codificações de MAJOR anterior (semver) não materializa", async () => {
    // Projeto na major 2; respostas divergentes da major 1 → abaixo do piso.
    // `pydantic_hash` antigo junto do semver antigo: é o que o Postgres devolve
    // de verdade (uma resposta de major anterior carrega o hash daquele schema,
    // não o atual). Assim o descarte acontece pelo branch semver (major 1 < 2) E
    // o fallback por hash também recusaria (hash != atual) — não depende da ordem
    // dos branches em responseQualifiesForVersion.
    tableData.projects = [
      makeProjectRow({
        schema_version_major: 2,
        schema_version_minor: 0,
        schema_version_patch: 0,
      }),
    ];
    await expectAutoComparisonOutcome(
      [
        makeHumanResponse("userA", "A", {
          pydantic_hash: "hash-antigo",
          schema_version_major: 1,
          schema_version_minor: 0,
          schema_version_patch: 0,
        }),
        makeHumanResponse("userB", "B", {
          pydantic_hash: "hash-antigo",
          schema_version_major: 1,
          schema_version_minor: 0,
          schema_version_patch: 0,
        }),
      ],
      false,
    );
  });

  it("divergência na MAJOR corrente ainda materializa (semver)", async () => {
    tableData.projects = [
      makeProjectRow({
        schema_version_major: 2,
        schema_version_minor: 0,
        schema_version_patch: 0,
      }),
    ];
    await expectAutoComparisonOutcome(
      [
        makeHumanResponse("userA", "A", {
          schema_version_major: 2,
          schema_version_minor: 0,
          schema_version_patch: 0,
        }),
        makeHumanResponse("userB", "B", {
          schema_version_major: 2,
          schema_version_minor: 0,
          schema_version_patch: 0,
        }),
      ],
      true,
    );
  });

  it("mistura: 1 corrente + 1 antiga divergem → antiga descartada, sobra 1 < mínimo", async () => {
    await expectAutoComparisonOutcome(
      [
        makeHumanResponse("userA", "A"), // corrente (hash atual)
        makeHumanResponse("userB", "B", { pydantic_hash: "hash-antigo" }), // antiga
      ],
      false,
    );
  });

  it("compare_llm: humano corrente diverge de LLM de schema antigo → LLM descartado, sem 2ª resposta", async () => {
    tableData.projects = [makeProjectRow({ automation_mode: "compare_llm" })];
    tableData.responses = [
      makeHumanResponse("userA", "A"),
      llm("B", { pydantic_hash: "hash-antigo" }),
    ];
    tableData.project_members = [makeProjectMember("userC")];
    const r = await runAutoComparison("compare_llm");
    // LLM antigo não qualifica → falta a 2ª resposta → não dispara.
    expect(r.assigned).toBe(false);
    expect(assignmentCalls()).toHaveLength(0);
  });
});

describe("scanComparisonBacklog — piso de versão latest_major (#247)", () => {
  it("doc cuja divergência só existe em versão antiga fica fora do backlog", async () => {
    const { scanComparisonBacklog } = await loadLib();
    tableData.responses = [
      makeHumanResponse("userA", "A", { pydantic_hash: "hash-antigo" }),
      makeHumanResponse("userB", "B", { pydantic_hash: "hash-antigo" }),
    ];
    const backlog = await scanComparisonBacklog(
      makeClient() as never,
      "p1",
      "compare_humans",
    );
    expect(backlog).toHaveLength(0);
  });

  it("doc divergente na versão corrente entra no backlog", async () => {
    const { scanComparisonBacklog } = await loadLib();
    tableData.responses = [
      makeHumanResponse("userA", "A"),
      makeHumanResponse("userB", "B"),
    ];
    const backlog = await scanComparisonBacklog(
      makeClient() as never,
      "p1",
      "compare_humans",
    );
    expect(backlog).toHaveLength(1);
    expect(backlog[0].documentId).toBe("doc1");
  });
});
