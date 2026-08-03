import { describe, it, expect, beforeEach, vi } from "vitest";

// Regressão da issue #182: getLotteryDocStats (path de exibição do dialog de
// sorteio) passa a ler a view agregada `lottery_doc_stats` em vez de fazer
// fetch bruto de responses/assignments do projeto inteiro. O teste trava o
// ganho garantindo que essas tabelas não são mais tocadas nesse path.
import {
  makeSupabaseMock,
  type RpcCall,
  type TableResult,
  type TableResults,
  type WriteCall,
} from "./supabase-mock";

let serverTableResults: TableResults | undefined;
let fromCalls: string[];
let writeCalls: WriteCall[];
let rpcCalls: RpcCall[];
let rpcResults: Record<string, TableResult> | undefined;

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
}));
vi.mock("@/lib/auth", () => ({
  getAuthUser: async () => ({ id: "user-1", isMaster: false }),
  requireCoordinator: async () => ({ ok: true, user: { id: "user-1" } }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => {
    const mock = makeSupabaseMock({
      tableResults: serverTableResults,
      writeCalls,
      rpcCalls,
      rpcResults,
    });
    return {
      ...mock,
      from: (table: string) => {
        fromCalls.push(table);
        return mock.from(table);
      },
    };
  },
}));

import {
  cycleAssignment,
  getLotteryDocStats,
  previewLottery,
  smartRandomize,
  type LotteryParams,
} from "../assignments";
import { LOTTERY_EMPTY_MESSAGES } from "@/lib/lottery-utils";

const ROUND_RESULTS: TableResults = {
  rounds: { data: { id: "round-1", label: "Rodada inicial" } },
  lottery_round_work_counts: { data: [] },
};

beforeEach(() => {
  serverTableResults = undefined;
  fromCalls = [];
  writeCalls = [];
  rpcCalls = [];
  rpcResults = undefined;
});

describe("getLotteryDocStats", () => {
  it("mapeia as linhas da view lottery_doc_stats para LotteryDocStats[]", async () => {
    serverTableResults = {
      ...ROUND_RESULTS,
      lottery_doc_stats: {
        data: [
          {
            id: "d1",
            external_id: "EXT-1",
            title: "Doc 1",
            human_coding_count: 2,
            has_llm_response: true,
            active_codificacao: 1,
            active_comparacao: 0,
            has_assignment_in_current_round: true,
            batch_ids: ["b1", "b2"],
          },
          {
            id: "d2",
            external_id: null,
            title: "Doc 2",
            human_coding_count: 0,
            has_llm_response: false,
            active_codificacao: 0,
            active_comparacao: 0,
            has_assignment_in_current_round: false,
            batch_ids: null,
          },
        ],
      },
      assignment_batches: {
        data: [{ id: "b1", label: "Lote 1", created_at: "2026-01-01" }],
      },
      projects: {
        data: { min_responses_for_comparison: 2, automation_mode: "compare_llm", current_round_id: "round-1" },
      },
    };

    const result = await getLotteryDocStats("p1");

    expect(result.error).toBeUndefined();
    expect(result.docs).toEqual([
      {
        id: "d1",
        externalId: "EXT-1",
        title: "Doc 1",
        humanCodingCount: 2,
        hasLlmResponse: true,
        activeAssignments: { codificacao: 1, comparacao: 0 },
        hasAssignmentInCurrentRound: true,
        batchIds: ["b1", "b2"],
      },
      {
        id: "d2",
        externalId: null,
        title: "Doc 2",
        humanCodingCount: 0,
        hasLlmResponse: false,
        activeAssignments: { codificacao: 0, comparacao: 0 },
        hasAssignmentInCurrentRound: false,
        batchIds: [],
      },
    ]);
    expect(result.minResponsesForComparison).toBe(2);
    expect(result.automationMode).toBe("compare_llm");
    expect(result.currentRoundId).toBe("round-1");
    expect(result.currentRoundLabel).toBe("Rodada inicial");
    expect(result.activeOpenAssignmentCount).toBe(0);
    expect(result.pendingScopeAssignmentCount).toBe(0);
  });

  it("separa trabalho ativo de documentos ainda em revisão de escopo", async () => {
    serverTableResults = {
      ...ROUND_RESULTS,
      lottery_doc_stats: { data: [] },
      assignment_batches: { data: [] },
      projects: {
        data: { min_responses_for_comparison: 2, automation_mode: null, current_round_id: "round-1" },
      },
      lottery_round_work_counts: {
        data: [
          { assignment_type: "codificacao", scope_state: "active", open_count: 3 },
          { assignment_type: "comparacao", scope_state: "active", open_count: 2 },
          { assignment_type: "codificacao", scope_state: "pending_scope", open_count: 4 },
        ],
      },
    };

    const result = await getLotteryDocStats("p1");

    expect(result.error).toBeUndefined();
    expect(result.activeOpenAssignmentCount).toBe(5);
    expect(result.pendingScopeAssignmentCount).toBe(4);
  });

  it("não consulta responses nem assignments crus (regressão da issue #182)", async () => {
    serverTableResults = {
      ...ROUND_RESULTS,
      lottery_doc_stats: { data: [] },
      assignment_batches: { data: [] },
      projects: { data: { min_responses_for_comparison: 2, automation_mode: null, current_round_id: "round-1" } },
    };

    await getLotteryDocStats("p1");

    expect(fromCalls).toContain("lottery_doc_stats");
    expect(fromCalls).toContain("lottery_round_work_counts");
    expect(fromCalls).not.toContain("responses");
    expect(fromCalls).not.toContain("assignments");
  });
});

describe("previewLottery", () => {
  it("caminho feliz: distribui documentos elegíveis a partir da view + assignments brutos", async () => {
    serverTableResults = {
      ...ROUND_RESULTS,
      project_members: { data: [{ user_id: "u1" }] },
      lottery_doc_stats: {
        data: [
          {
            id: "d1",
            external_id: "EXT-1",
            title: "Doc 1",
            human_coding_count: 0,
            has_llm_response: false,
            active_codificacao: 0,
            active_comparacao: 0,
            has_assignment_in_current_round: false,
            batch_ids: [],
          },
        ],
      },
      assignment_batches: { data: [] },
      projects: { data: { min_responses_for_comparison: 2, automation_mode: null, current_round_id: "round-1" } },
      assignments: { data: [] },
      responses: { data: [] },
    };

    const result = await previewLottery({
      projectId: "p1",
      type: "codificacao",
      mode: "append",
      balancing: "round",
      researchersPerDoc: 1,
      participantIds: ["u1"],
    });

    expect(result.error).toBeUndefined();
    expect(result.preview?.totalNew).toBe(1);
    expect(result.preview?.eligibleDocs).toBe(1);
    expect(result.preview?.participants).toEqual([
      { userId: "u1", existing: 0, newDocs: 1 },
    ]);
    expect(fromCalls).toContain("lottery_doc_stats");
    expect(fromCalls).toContain("assignments");
  });

  it("falha fechado quando não consegue ler as atribuições existentes", async () => {
    serverTableResults = {
      ...ROUND_RESULTS,
      project_members: { data: [{ user_id: "u1" }] },
      lottery_doc_stats: {
        data: [
          {
            id: "d1",
            external_id: null,
            title: "Doc 1",
            human_coding_count: 0,
            has_llm_response: false,
            active_codificacao: 0,
            active_comparacao: 0,
            has_assignment_in_current_round: false,
            batch_ids: [],
          },
        ],
      },
      assignment_batches: { data: [] },
      projects: {
        data: { min_responses_for_comparison: 2, automation_mode: null, current_round_id: "round-1" },
      },
      assignments: { data: null, error: { message: "timeout" } },
      responses: { data: [] },
    };

    const result = await previewLottery({
      projectId: "p1",
      type: "codificacao",
      mode: "append",
      balancing: "round",
      researchersPerDoc: 1,
      participantIds: ["u1"],
    });

    expect(result.error).toBe(
      "Erro ao ler as atribuições existentes do sorteio: timeout",
    );
    expect(rpcCalls).toHaveLength(0);
  });

  it("explica quando a capacidade total dos participantes já acabou", async () => {
    serverTableResults = {
      ...ROUND_RESULTS,
      project_members: { data: [{ user_id: "u1" }] },
      lottery_doc_stats: {
        data: [
          {
            id: "d1",
            external_id: null,
            title: "Doc 1",
            human_coding_count: 0,
            has_llm_response: false,
            active_codificacao: 0,
            active_comparacao: 0,
            has_assignment_in_current_round: false,
            batch_ids: [],
          },
          {
            id: "d2",
            external_id: null,
            title: "Doc 2",
            human_coding_count: 1,
            has_llm_response: false,
            active_codificacao: 1,
            active_comparacao: 0,
            has_assignment_in_current_round: true,
            batch_ids: ["b0"],
          },
        ],
      },
      assignment_batches: { data: [] },
      projects: {
        data: { min_responses_for_comparison: 2, automation_mode: null, current_round_id: "round-1" },
      },
      assignments: {
        data: [
          { document_id: "d2", user_id: "u1", status: "concluido", type: "codificacao", round_id: "round-1" },
        ],
      },
      responses: { data: [] },
    };

    const result = await previewLottery({
      projectId: "p1",
      type: "codificacao",
      mode: "append",
      balancing: "round",
      researchersPerDoc: 1,
      docsPerResearcher: 1,
      participantIds: ["u1"],
    });

    expect(result.error).toBeUndefined();
    expect(result.preview).toMatchObject({
      totalNew: 0,
      emptyReason: "capacity_exhausted",
      unfilledSlots: 1,
    });
  });

  it("atribuições de documentos fora do escopo não consomem capacidade", async () => {
    serverTableResults = {
      ...ROUND_RESULTS,
      project_members: { data: [{ user_id: "u1" }] },
      lottery_doc_stats: {
        data: [
          {
            id: "active-doc",
            external_id: null,
            title: "Documento ativo",
            human_coding_count: 0,
            has_llm_response: false,
            active_codificacao: 0,
            active_comparacao: 0,
            has_assignment_in_current_round: false,
            batch_ids: [],
          },
        ],
      },
      assignment_batches: { data: [] },
      projects: {
        data: { min_responses_for_comparison: 2, automation_mode: null, current_round_id: "round-1" },
      },
      assignments: {
        data: [
          { document_id: "excluded-doc", user_id: "u1", status: "em_andamento", type: "codificacao", round_id: "round-1" },
          { document_id: "pending-scope-doc", user_id: "u1", status: "pendente", type: "codificacao", round_id: "round-1" },
        ],
      },
      responses: { data: [] },
    };

    const result = await previewLottery({
      projectId: "p1",
      type: "codificacao",
      mode: "append",
      balancing: "history",
      researchersPerDoc: 1,
      docsPerResearcher: 1,
      participantIds: ["u1"],
    });

    expect(result.error).toBeUndefined();
    expect(result.preview).toMatchObject({
      totalNew: 1,
      totalPreserved: 0,
      participants: [{ userId: "u1", existing: 0, newDocs: 1 }],
    });
  });
});

// Regressão da issue #490: o sorteio de Comparação herdava o default 2 do
// sorteio de Codificação. A regra é um revisor por documento — o veredito é ato
// de desempate único.
describe("sorteio de comparação: um revisor por documento (#490)", () => {
  // Um doc apto à comparação (2 humanos) e três participantes disponíveis: se o
  // número de revisores fosse honrado, sobrariam candidatos para uma 2ª vaga.
  function comparisonFixture(assignments: unknown[] = []): TableResults {
    return {
      ...ROUND_RESULTS,
      project_members: { data: [{ user_id: "u1" }, { user_id: "u2" }, { user_id: "u3" }] },
      lottery_doc_stats: {
        data: [
          {
            id: "d1",
            external_id: "EXT-1",
            title: "Doc 1",
            human_coding_count: 2,
            has_llm_response: false,
            active_codificacao: 0,
            active_comparacao: 0,
            has_assignment_in_current_round: true,
            batch_ids: [],
          },
        ],
      },
      assignment_batches: { data: [] },
      projects: { data: { min_responses_for_comparison: 2, automation_mode: null, current_round_id: "round-1" } },
      assignments: { data: assignments },
      responses: { data: [] },
    };
  }

  it("recusa researchersPerDoc forjado no payload de comparação antes de consultar o banco", async () => {
    serverTableResults = comparisonFixture();

    const result = await previewLottery({
      projectId: "p1",
      type: "comparacao",
      mode: "append",
      balancing: "round",
      // A união discriminada proíbe este campo no braço "comparacao": o cast é
      // o teste da validação runtime na fronteira da Server Action.
      researchersPerDoc: 2,
      participantIds: ["u1", "u2", "u3"],
    } as unknown as LotteryParams);

    expect(result.error).toContain("Configuração do sorteio inválida");
    expect(fromCalls).toHaveLength(0);
    expect(rpcCalls).toHaveLength(0);
  });

  it("comparação nunca sorteia o codificador do próprio documento", async () => {
    // Espelho do trigger enforce_comparison_assignment_actor (20260716160100):
    // resposta humana is_latest veta o par no sorteio manual — sem o veto, o
    // RPC transacional abortaria o lote inteiro com 23514.
    serverTableResults = {
      ...comparisonFixture(),
      responses: {
        data: [
          { document_id: "d1", respondent_id: "u1" },
          { document_id: "d1", respondent_id: "u2" },
        ],
      },
    };

    const result = await previewLottery({
      projectId: "p1",
      type: "comparacao",
      mode: "append",
      balancing: "round",
      participantIds: ["u1", "u2", "u3"],
    } as unknown as LotteryParams);

    expect(result.error).toBeUndefined();
    expect(result.preview?.totalNew).toBe(1);
    expect(
      result.preview?.participants.find((p) => p.newDocs > 0)?.userId,
    ).toBe("u3");
  });

  it("codificação continua honrando dois pesquisadores por documento", async () => {
    serverTableResults = comparisonFixture();

    const result = await previewLottery({
      projectId: "p1",
      type: "codificacao",
      mode: "append",
      balancing: "round",
      researchersPerDoc: 2,
      participantIds: ["u1", "u2", "u3"],
    });

    expect(result.error).toBeUndefined();
    expect(result.preview?.totalNew).toBe(2);
  });

  it("documento com comparação CONCLUÍDA volta a ser sorteável, mas não para quem já comparou", async () => {
    // Concluída não ocupa a vaga (é o que permite a re-rodada por versão de
    // schema); o par continua bloqueado pelo preservedSet.
    serverTableResults = comparisonFixture([
      { document_id: "d1", user_id: "u1", status: "concluido", type: "comparacao" },
    ]);

    const result = await previewLottery({
      projectId: "p1",
      type: "comparacao",
      mode: "append",
      balancing: "round",
      participantIds: ["u1", "u2", "u3"],
    });

    expect(result.error).toBeUndefined();
    expect(result.preview?.totalNew).toBe(1);
    const sorteado = result.preview?.participants.find((p) => p.newDocs > 0);
    expect(sorteado?.userId).not.toBe("u1");
  });

  it("documento com comparação PENDENTE não recebe um segundo revisor", async () => {
    serverTableResults = comparisonFixture([
      { document_id: "d1", user_id: "u1", status: "pendente", type: "comparacao" },
    ]);

    const result = await previewLottery({
      projectId: "p1",
      type: "comparacao",
      mode: "append",
      balancing: "round",
      participantIds: ["u1", "u2", "u3"],
    });

    // O documento passa nos filtros (o coordenador não filtrou nada), mas a vaga
    // está ocupada pela comparação ativa: a prévia mostra zero elegíveis em vez
    // de arranjar um segundo revisor.
    expect(result.error).toBeUndefined();
    expect(result.preview?.eligibleDocs).toBe(0);
    expect(result.preview?.totalNew).toBe(0);
    expect(result.preview?.emptyReason).toBe("all_slots_filled");
  });

  it("não chama a RPC quando todas as vagas já estão ocupadas", async () => {
    serverTableResults = comparisonFixture([
      { document_id: "d1", user_id: "u1", status: "pendente", type: "comparacao", round_id: "round-1" },
    ]);

    const result = await smartRandomize({
      projectId: "p1",
      type: "comparacao",
      mode: "append",
      balancing: "round",
      participantIds: ["u1", "u2", "u3"],
    });

    expect(result.error).toBe(LOTTERY_EMPTY_MESSAGES.all_slots_filled);
    expect(rpcCalls).toHaveLength(0);
    expect(writeCalls).toHaveLength(0);
  });

  it("explica quando todos os pares disponíveis são vetados", async () => {
    serverTableResults = {
      ...comparisonFixture(),
      project_members: { data: [{ user_id: "u1" }] },
      responses: {
        data: [{ document_id: "d1", respondent_id: "u1", round_id: "round-1" }],
      },
    };

    const result = await previewLottery({
      projectId: "p1",
      type: "comparacao",
      mode: "append",
      balancing: "round",
      participantIds: ["u1"],
    });

    expect(result.error).toBeUndefined();
    expect(result.preview).toMatchObject({
      totalNew: 0,
      emptyReason: "no_available_pairs",
      unfilledSlots: 1,
    });
  });

  it("smartRandomize grava um assignment e registra researchers_per_doc 1 no lote", async () => {
    serverTableResults = {
      ...comparisonFixture(),
      // Fila: a 1ª leitura é a do computeLottery (lista de lotes); a 2ª é o
      // insert...select("id").single() do lote deste sorteio.
      assignment_batches: [{ data: [] }, { data: { id: "b1" } }],
    };
    rpcResults = { apply_lottery_assignments: { data: { inserted: 1 } } };

    const result = await smartRandomize({
      projectId: "p1",
      type: "comparacao",
      mode: "append",
      balancing: "round",
      participantIds: ["u1", "u2", "u3"],
    });

    expect(result.error).toBeUndefined();
    expect(result.count).toBe(1);

    const rpc = rpcCalls.find((c) => c.fn === "apply_lottery_assignments");
    expect(rpc?.args).toMatchObject({ p_type: "comparacao" });
    expect((rpc?.args as { p_assignments: unknown[] }).p_assignments).toHaveLength(1);

    expect((rpc?.args as { p_batch: unknown }).p_batch).toMatchObject({ researchers_per_doc: 1 });
  });

  it("nova rodada envia contagens e confirmações separadas no snapshot transacional", async () => {
    serverTableResults = {
      ...comparisonFixture(),
      project_members: { data: [{ user_id: "u1" }] },
      lottery_doc_stats: {
        data: [
          {
            id: "d1",
            external_id: "EXT-1",
            title: "Doc 1",
            human_coding_count: 2,
            has_llm_response: false,
            active_codificacao: 1,
            active_comparacao: 0,
            has_assignment_in_current_round: true,
            batch_ids: ["old-batch"],
          },
        ],
      },
      lottery_round_work_counts: {
        data: [
          { assignment_type: "codificacao", scope_state: "active", open_count: 2 },
          { assignment_type: "comparacao", scope_state: "pending_scope", open_count: 3 },
        ],
      },
      responses: { data: [] },
    };
    rpcResults = {
      apply_lottery_assignments: { data: { inserted: 1, round_id: "round-2" } },
    };

    const result = await smartRandomize({
      projectId: "p1",
      type: "codificacao",
      mode: "append",
      balancing: "round",
      researchersPerDoc: 1,
      participantIds: ["u1"],
      target: {
        kind: "new",
        expectedRoundId: "round-1",
        roundLabel: "Rodada 2",
        confirmActiveWork: true,
        confirmPendingScopeWork: true,
      },
    });

    expect(result).toMatchObject({ count: 1 });
    const rpc = rpcCalls.find((call) => call.fn === "apply_lottery_assignments");
    expect(rpc?.args).toMatchObject({
      p_expected_round_id: "round-1",
      p_new_round_label: "Rodada 2",
      p_confirm_open_work: true,
      p_batch: {
        open_work_snapshot: {
          active_count: 2,
          pending_scope_count: 3,
          confirm_active: true,
          confirm_pending_scope: true,
        },
      },
    });
  });
});

// Regressão da issue #521: o assignment de codificação criado DEPOIS da response
// (documento codificado pelo Explorar, antes de existir atribuição) nascia
// 'pendente' e ficava eternamente pendente na fila — syncCodingAssignmentStatus
// só roda no save, que já tinha acontecido.
describe("status inicial do assignment de codificação (#521)", () => {
  const FIELDS = [
    { name: "q1", type: "single", options: ["a", "b"], description: "" },
    { name: "q2", type: "single", options: ["a", "b"], description: "" },
  ];
  const PROJECT_ROW = {
    min_responses_for_comparison: 2,
    automation_mode: null,
    pydantic_fields: FIELDS,
    round_strategy: "schema_version",
    current_round_id: "round-1",
    schema_version_major: 1,
    schema_version_minor: 0,
    schema_version_patch: 0,
  };
  const CURRENT_VERSION = {
    schema_version_major: 1,
    schema_version_minor: 0,
    schema_version_patch: 0,
  };
  const CODED_AT = "2026-07-20T10:00:00.000Z";

  // Um documento e um participante: o sorteio cria exatamente o par (d1, u1),
  // o mesmo par que já tem response humana.
  function codingFixture(responseRows: unknown[], answerRows: unknown[]): TableResults {
    return {
      ...ROUND_RESULTS,
      rounds: [
        { data: { id: "round-1", label: "Rodada inicial" } },
        { data: [{ id: "round-1", label: "Rodada inicial" }] },
      ],
      project_members: { data: [{ user_id: "u1" }] },
      lottery_doc_stats: {
        data: [
          {
            id: "d1",
            external_id: "EXT-1",
            title: "Doc 1",
            human_coding_count: 1,
            has_llm_response: false,
            active_codificacao: 0,
            active_comparacao: 0,
            has_assignment_in_current_round: false,
            batch_ids: [],
          },
        ],
      },
      // Fila: leitura da lista de lotes no computeLottery e, depois, o insert
      // do lote deste sorteio.
      assignment_batches: [{ data: [] }, { data: { id: "b1" } }],
      projects: { data: PROJECT_ROW },
      assignments: { data: [] },
      // Fila: fase 1 (linhas leves, sem answers) e fase 2 (answers dos pares).
      responses: [{ data: responseRows }, { data: answerRows }],
    };
  }

  const lotteryParams: LotteryParams = {
    projectId: "p1",
    type: "codificacao",
    mode: "append",
    balancing: "round",
    researchersPerDoc: 1,
    participantIds: ["u1"],
  };

  function rpcRows() {
    const rpc = rpcCalls.find((c) => c.fn === "apply_lottery_assignments");
    return (rpc?.args as { p_assignments: Record<string, unknown>[] }).p_assignments;
  }

  beforeEach(() => {
    rpcResults = { apply_lottery_assignments: { data: { inserted: 1 } } };
  });

  it("sorteio manda 'concluido' + completed_at quando o sorteado já codificou o documento", async () => {
    serverTableResults = codingFixture(
      [
        {
          id: "r1",
          document_id: "d1",
          respondent_id: "u1",
          updated_at: CODED_AT,
          round_id: null,
          is_partial: false,
          ...CURRENT_VERSION,
        },
      ],
      [{ id: "r1", answers: { q1: "a", q2: "b" }, answer_field_hashes: {} }],
    );

    const result = await smartRandomize(lotteryParams);

    expect(result.error).toBeUndefined();
    expect(rpcRows()).toEqual([
      { document_id: "d1", user_id: "u1", status: "concluido", completed_at: CODED_AT },
    ]);
  });

  it("codificação parcial do sorteado vira 'em_andamento'", async () => {
    serverTableResults = codingFixture(
      [
        {
          id: "r1",
          document_id: "d1",
          respondent_id: "u1",
          updated_at: CODED_AT,
          round_id: null,
          is_partial: true,
          ...CURRENT_VERSION,
        },
      ],
      [{ id: "r1", answers: { q1: "a" }, answer_field_hashes: {} }],
    );

    await smartRandomize(lotteryParams);

    expect(rpcRows()).toEqual([
      { document_id: "d1", user_id: "u1", status: "em_andamento", completed_at: null },
    ]);
  });

  it("documento sem response do sorteado vai para a RPC sem status (default 'pendente')", async () => {
    // Response de OUTRO pesquisador não promove o par sorteado.
    serverTableResults = codingFixture(
      [
        {
          id: "r9",
          document_id: "d1",
          respondent_id: "u9",
          updated_at: CODED_AT,
          round_id: null,
          is_partial: false,
          ...CURRENT_VERSION,
        },
      ],
      [],
    );

    await smartRandomize(lotteryParams);

    expect(rpcRows()).toEqual([{ document_id: "d1", user_id: "u1" }]);
  });

  it("falha ao ler o schema aborta o sorteio antes de registrar o lote", async () => {
    // Degradar para 'pendente' em silêncio reintroduziria o próprio bug sem
    // sinal nenhum; e o cálculo vem antes do lote justamente para o erro não
    // deixar um assignment_batches órfão.
    serverTableResults = {
      ...codingFixture(
        [
          {
            id: "r1",
            document_id: "d1",
            respondent_id: "u1",
            updated_at: CODED_AT,
            round_id: null,
            is_partial: false,
            ...CURRENT_VERSION,
          },
        ],
        [{ id: "r1", answers: { q1: "a", q2: "b" }, answer_field_hashes: {} }],
      ),
      // 1ª leitura: a do computeLottery. 2ª: a do status inicial, que falha.
      projects: [{ data: PROJECT_ROW }, { data: null, error: { message: "boom" } }],
    };

    const result = await smartRandomize(lotteryParams);

    expect(result.error).toContain("status inicial");
    expect(writeCalls.some((c) => c.table === "assignment_batches")).toBe(false);
    expect(rpcCalls).toHaveLength(0);
  });

  it("atribuição manual sobre documento já codificado nasce concluída", async () => {
    serverTableResults = {
      assignments: { data: [] },
      projects: { data: PROJECT_ROW },
      responses: [
        {
          data: {
            id: "r1",
            document_id: "d1",
            respondent_id: "u1",
            updated_at: CODED_AT,
            round_id: null,
            is_partial: false,
            ...CURRENT_VERSION,
          },
        },
        { data: [{ id: "r1", answers: { q1: "a", q2: "b" }, answer_field_hashes: {} }] },
      ],
    };

    const result = await cycleAssignment("p1", "d1", "u1");

    expect(result.error).toBeUndefined();
    const insert = writeCalls.find((c) => c.table === "assignments" && c.op === "insert");
    expect(insert?.payload).toMatchObject({
      document_id: "d1",
      user_id: "u1",
      type: "codificacao",
      status: "concluido",
      completed_at: CODED_AT,
    });
  });

  it("atribuição manual sobre documento nunca codificado nasce pendente", async () => {
    serverTableResults = {
      assignments: { data: [] },
      projects: { data: PROJECT_ROW },
      responses: [{ data: null }, { data: [] }],
    };

    await cycleAssignment("p1", "d1", "u1");

    const insert = writeCalls.find((c) => c.table === "assignments" && c.op === "insert");
    expect(insert?.payload).toMatchObject({ status: "pendente", completed_at: null });
  });
});
