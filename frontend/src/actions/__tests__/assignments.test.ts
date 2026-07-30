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
            has_any_assignment_ever: true,
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
            has_any_assignment_ever: false,
            batch_ids: null,
          },
        ],
      },
      assignment_batches: {
        data: [{ id: "b1", label: "Lote 1", created_at: "2026-01-01" }],
      },
      projects: {
        data: { min_responses_for_comparison: 2, automation_mode: "compare_llm" },
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
        hasAnyAssignmentEver: true,
        batchIds: ["b1", "b2"],
      },
      {
        id: "d2",
        externalId: null,
        title: "Doc 2",
        humanCodingCount: 0,
        hasLlmResponse: false,
        activeAssignments: { codificacao: 0, comparacao: 0 },
        hasAnyAssignmentEver: false,
        batchIds: [],
      },
    ]);
    expect(result.minResponsesForComparison).toBe(2);
    expect(result.automationMode).toBe("compare_llm");
  });

  it("não consulta responses nem assignments crus (regressão da issue #182)", async () => {
    serverTableResults = {
      lottery_doc_stats: { data: [] },
      assignment_batches: { data: [] },
      projects: { data: { min_responses_for_comparison: 2, automation_mode: null } },
    };

    await getLotteryDocStats("p1");

    expect(fromCalls).toContain("lottery_doc_stats");
    expect(fromCalls).not.toContain("responses");
    expect(fromCalls).not.toContain("assignments");
  });
});

describe("previewLottery", () => {
  it("caminho feliz: distribui documentos elegíveis a partir da view + assignments brutos", async () => {
    serverTableResults = {
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
            has_any_assignment_ever: false,
            batch_ids: [],
          },
        ],
      },
      assignment_batches: { data: [] },
      projects: { data: { min_responses_for_comparison: 2, automation_mode: null } },
      assignments: { data: [] },
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

  // `fetchAllPaged` devolve as páginas já lidas JUNTO com o erro. Ignorar esse
  // erro faria o sorteio validar os participantes contra um universo de membros
  // parcial — e recusar participante legítimo sob a mensagem genérica de
  // "participante válido", que é o truncamento silencioso de volta por outra
  // porta. O erro real tem que chegar ao coordenador.
  it("reporta a falha ao ler os membros em vez de recusar o participante", async () => {
    serverTableResults = {
      project_members: { data: null, error: { message: "conexão caiu" } },
      lottery_doc_stats: { data: [] },
      assignment_batches: { data: [] },
      projects: { data: { min_responses_for_comparison: 2, automation_mode: null } },
      assignments: { data: [] },
    };

    const result = await previewLottery({
      projectId: "p1",
      type: "codificacao",
      mode: "append",
      balancing: "round",
      researchersPerDoc: 1,
      participantIds: ["u1"],
    });

    expect(result.error).toContain("conexão caiu");
    expect(result.error).not.toContain("participante válido");
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
            has_any_assignment_ever: true,
            batch_ids: [],
          },
        ],
      },
      assignment_batches: { data: [] },
      projects: { data: { min_responses_for_comparison: 2, automation_mode: null } },
      assignments: { data: assignments },
    };
  }

  it("ignora researchersPerDoc forjado no payload e atribui um único revisor", async () => {
    serverTableResults = comparisonFixture();

    const result = await previewLottery({
      projectId: "p1",
      type: "comparacao",
      mode: "append",
      balancing: "round",
      // A união discriminada proíbe este campo no braço "comparacao": o cast é o
      // teste. Server Action é endpoint HTTP público e o projeto não valida com
      // zod — o contrato sob prova é o server IGNORAR o que o client pediu, e
      // não confiar no type-check que só existe em tempo de compilação.
      researchersPerDoc: 2,
      participantIds: ["u1", "u2", "u3"],
    } as unknown as LotteryParams);

    expect(result.error).toBeUndefined();
    expect(result.preview?.totalNew).toBe(1);
    expect(
      result.preview?.participants.filter((p) => p.newDocs > 0),
    ).toHaveLength(1);
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
      // Forjado: é este pedido que, honrado, abriria a 2ª vaga do documento.
      researchersPerDoc: 2,
      participantIds: ["u1", "u2", "u3"],
    } as unknown as LotteryParams);

    // O documento passa nos filtros (o coordenador não filtrou nada), mas a vaga
    // está ocupada pela comparação ativa: a prévia mostra zero elegíveis em vez
    // de arranjar um segundo revisor.
    expect(result.error).toBeUndefined();
    expect(result.preview?.eligibleDocs).toBe(0);
    expect(result.preview?.totalNew).toBe(0);
  });

  it("smartRandomize grava um assignment e registra researchers_per_doc 1 no lote", async () => {
    serverTableResults = {
      ...comparisonFixture(),
      // Fila: a 1ª leitura é a do computeLottery (lista de lotes); a 2ª é o
      // insert...select("id").single() do lote deste sorteio.
      assignment_batches: [{ data: [] }, { data: { id: "b1" } }],
    };
    rpcResults = { apply_lottery_assignments: { data: 1 } };

    const result = await smartRandomize({
      projectId: "p1",
      type: "comparacao",
      mode: "append",
      balancing: "round",
      researchersPerDoc: 2, // forjado — a gravação tem de refletir o efetivo (1)
      participantIds: ["u1", "u2", "u3"],
    } as unknown as LotteryParams);

    expect(result.error).toBeUndefined();
    expect(result.count).toBe(1);

    const rpc = rpcCalls.find((c) => c.fn === "apply_lottery_assignments");
    expect(rpc?.args).toMatchObject({ p_type: "comparacao" });
    expect((rpc?.args as { p_assignments: unknown[] }).p_assignments).toHaveLength(1);

    const lote = writeCalls.find(
      (c) => c.table === "assignment_batches" && c.op === "insert",
    );
    expect(lote?.payload).toMatchObject({ researchers_per_doc: 1 });
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
    current_round_id: null,
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
            has_any_assignment_ever: false,
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
    rpcResults = { apply_lottery_assignments: { data: 1 } };
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
