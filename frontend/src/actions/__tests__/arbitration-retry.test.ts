import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  makeSupabaseAdminModuleMock,
  makeSupabaseServerModuleMock,
  makeSimpleSupabaseMock,
  type RpcCall,
  type RpcResult,
  type WriteCall,
} from "@/test-utils/supabase-mock";
import { authModuleMock } from "@/test-utils/auth-mock";

// Mock supabase chainable — mesmo padrão de field-reviews.test.ts. Captura a
// RPC que faz o commit atômico de retryPendingArbitrations/assignArbitrator
// sem subir Postgres.
let writeCalls: WriteCall[];
let rpcCalls: RpcCall[];
let rpcResults: Record<string, RpcResult>;
let tableData: Record<string, unknown>;

const arbitrationCalls = () =>
  rpcCalls.filter((call) => call.fn === "assign_arbitration_cycles_if_eligible");

// Teto do PostgREST por resposta; só o teste de paginação o reduz.
let maxRows: number | undefined;

function makeClient() {
  return makeSimpleSupabaseMock({
    tableData,
    writeCalls,
    rpcCalls,
    rpcResults,
    maxRows,
  });
}

// isProjectCoordinator: hoisted para permitir override por teste.
const hoisted = vi.hoisted(() => ({
  isCoord: vi.fn<() => Promise<boolean>>(async () => true),
  adminFactory: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => authModuleMock(hoisted.isCoord));
vi.mock("@/lib/supabase/server", () => makeSupabaseServerModuleMock(makeClient));
vi.mock("@/lib/supabase/admin", () =>
  makeSupabaseAdminModuleMock(makeClient, hoisted.adminFactory),
);

beforeEach(() => {
  writeCalls = [];
  rpcCalls = [];
  rpcResults = {
    assign_arbitration_cycles_if_eligible: { data: 1 },
  };
  tableData = {
    field_reviews: [],
    project_members: [],
    assignments: [],
    responses: [],
  };
  hoisted.isCoord.mockResolvedValue(true);
  hoisted.adminFactory.mockClear();
  maxRows = undefined;
});

async function loadRetry() {
  return (await import("@/actions/field-reviews")).retryPendingArbitrations;
}

describe("retryPendingArbitrations — guards", () => {
  it("não-coordenador → erro, sem efeito colateral", async () => {
    hoisted.isCoord.mockResolvedValueOnce(false);
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(false);
    expect(r.error).toContain("coordenadores");
    expect(r.assigned).toBe(0);
    expect(writeCalls).toHaveLength(0);
  });

  it("sem field_reviews pendentes → assigned 0 e nenhuma RPC", async () => {
    tableData.field_reviews = [];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    expect(r.assigned).toBe(0);
    expect(r.stillNoPool).toBe(0);
    expect(arbitrationCalls()).toHaveLength(0);
  });
});

describe("retryPendingArbitrations — agrupamento por (document_id, self_reviewer_id)", () => {
  it("dois fields do mesmo doc/self_reviewer → 1 commit atômico", async () => {
    tableData.field_reviews = [
      { id: "fr1", document_id: "doc1", self_reviewer_id: "userA" },
      { id: "fr2", document_id: "doc1", self_reviewer_id: "userA" },
    ];
    // Pool com 1 árbitro elegível (assignArbitrator pode sortear)
    tableData.project_members = [
      { user_id: "userB", role: "pesquisador" },
    ];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    expect(arbitrationCalls()).toHaveLength(1);
    expect(arbitrationCalls()[0].args).toEqual({
      p_project_id: "p1",
      p_document_id: "doc1",
      p_user_id: "userB",
      p_field_review_ids: ["fr1", "fr2"],
    });
    expect(writeCalls).toHaveLength(0);
  });

  it("dois docs distintos → 2 commits atômicos", async () => {
    tableData.field_reviews = [
      { id: "fr1", document_id: "doc1", self_reviewer_id: "userA" },
      { id: "fr2", document_id: "doc2", self_reviewer_id: "userC" },
    ];
    tableData.project_members = [
      { user_id: "userB", role: "pesquisador" },
    ];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    expect(arbitrationCalls()).toHaveLength(2);
    expect(writeCalls).toHaveLength(0);
  });

  it("self_reviewers diferentes no mesmo doc → 2 grupos (caso raro mas suportado)", async () => {
    tableData.field_reviews = [
      { id: "fr1", document_id: "doc1", self_reviewer_id: "userA" },
      { id: "fr2", document_id: "doc1", self_reviewer_id: "userC" },
    ];
    tableData.project_members = [
      { user_id: "userB", role: "pesquisador" },
    ];
    const retry = await loadRetry();
    await retry("p1");
    expect(arbitrationCalls()).toHaveLength(2);
  });
});

describe("retryPendingArbitrations — pool vazio", () => {
  it("nenhum membro elegível → stillNoPool incrementa, sem UPDATE", async () => {
    tableData.field_reviews = [
      { id: "fr1", document_id: "doc1", self_reviewer_id: "userA" },
    ];
    tableData.project_members = [];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    expect(r.assigned).toBe(0);
    expect(r.stillNoPool).toBe(1);
    expect(arbitrationCalls()).toHaveLength(0);
  });

  it("candidato desabilitado antes do commit → RPC não grava", async () => {
    tableData.field_reviews = [
      { id: "fr1", document_id: "doc1", self_reviewer_id: "userA" },
    ];
    tableData.project_members = [
      { user_id: "userB", role: "pesquisador" },
    ];
    rpcResults.assign_arbitration_cycles_if_eligible = { data: 0 };

    const retry = await loadRetry();

    expect(await retry("p1")).toMatchObject({
      success: true,
      assigned: 0,
      stillNoPool: 0,
    });
    expect(arbitrationCalls()).toHaveLength(1);
    expect(writeCalls).toHaveLength(0);
  });
});

describe("retryPendingArbitrations — exclui codificadores do documento", () => {
  it("membro que codificou o doc é excluído do pool", async () => {
    tableData.field_reviews = [
      { id: "fr1", document_id: "doc1", self_reviewer_id: "userA" },
    ];
    tableData.project_members = [
      { user_id: "userB", role: "pesquisador" },
      { user_id: "userC", role: "pesquisador" },
    ];
    // userB deu resposta humana em doc1 → não pode arbitrar (juiz em causa própria)
    tableData.responses = [{ document_id: "doc1", respondent_id: "userB" }];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    expect(arbitrationCalls()).toHaveLength(1);
    expect(arbitrationCalls()[0].args).toMatchObject({ p_user_id: "userC" });
  });

  it("todos os elegíveis codificaram o doc → fallback para elegível != auto-revisor", async () => {
    tableData.field_reviews = [
      { id: "fr1", document_id: "doc1", self_reviewer_id: "userA" },
    ];
    tableData.project_members = [
      { user_id: "userB", role: "pesquisador" },
      { user_id: "userC", role: "pesquisador" },
    ];
    // Doc codificado por toda a equipe elegível (caso de calibração): nenhum
    // árbitro totalmente neutro, mas userB/userC não são o auto-revisor userA.
    tableData.responses = [
      { document_id: "doc1", respondent_id: "userB" },
      { document_id: "doc1", respondent_id: "userC" },
    ];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    expect(r.assigned).toBe(1);
    expect(r.stillNoPool).toBe(0);
    expect(arbitrationCalls()).toHaveLength(1);
    const args = arbitrationCalls()[0].args as { p_user_id: string };
    expect(["userB", "userC"]).toContain(args.p_user_id);
  });

  it("único elegível é o próprio auto-revisor → stillNoPool, sem UPDATE", async () => {
    tableData.field_reviews = [
      { id: "fr1", document_id: "doc1", self_reviewer_id: "userA" },
    ];
    tableData.project_members = [{ user_id: "userA", role: "pesquisador" }];
    tableData.responses = [{ document_id: "doc1", respondent_id: "userA" }];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    expect(r.assigned).toBe(0);
    expect(r.stillNoPool).toBe(1);
    expect(arbitrationCalls()).toHaveLength(0);
  });
});

describe("retryPendingArbitrations — pool além do teto do PostgREST", () => {
  // O pool de can_arbitrate é um universo, como o de comparação: lido sem
  // paginar, um projeto acima do teto do PostgREST não enxerga os árbitros que
  // caem fora da primeira página. Aqui o único candidato ocioso está na 2ª —
  // sem paginação a arbitragem recai sobre quem já está carregado, e a
  // degradação do balanceamento não deixa rastro.
  it("considera árbitro além da primeira página", async () => {
    maxRows = 2;
    tableData.field_reviews = [
      { id: "fr1", document_id: "doc1", self_reviewer_id: "userA" },
    ];
    tableData.project_members = [
      // O auto-revisor nunca arbitra a própria resposta: ocupa a 1ª página sem
      // ser candidato.
      { user_id: "userA", role: "pesquisador" },
      { user_id: "ocupado", role: "pesquisador" },
      { user_id: "userC", role: "pesquisador" },
    ];
    // Carga aberta só de quem está na 1ª página, para que o desempate por menor
    // carga escolha userC de forma determinística assim que ele for visto.
    tableData.assignments = [
      { user_id: "ocupado" },
      { user_id: "ocupado" },
    ];

    const retry = await loadRetry();
    const r = await retry("p1");

    expect(r.success).toBe(true);
    expect(arbitrationCalls()).toHaveLength(1);
    expect(arbitrationCalls()[0].args).toMatchObject({ p_user_id: "userC" });
  });
});

describe("retryPendingArbitrations — batch de responses agrupado por doc", () => {
  it("dois docs com codificadores distintos → cada assignArbitrator vê só o seu doc", async () => {
    tableData.field_reviews = [
      { id: "fr1", document_id: "doc1", self_reviewer_id: "userA" },
      { id: "fr2", document_id: "doc2", self_reviewer_id: "userA" },
    ];
    tableData.project_members = [
      { user_id: "userB", role: "pesquisador" },
      { user_id: "userC", role: "pesquisador" },
    ];
    // userB codificou doc1; userC codificou doc2. Pool por doc deve excluir
    // só o codificador daquele doc — não confundir entre docs.
    tableData.responses = [
      { document_id: "doc1", respondent_id: "userB" },
      { document_id: "doc2", respondent_id: "userC" },
    ];
    const retry = await loadRetry();
    const r = await retry("p1");
    expect(r.success).toBe(true);
    const calls = arbitrationCalls();
    expect(calls).toHaveLength(2);
    const arbitrators = calls
      .map((call) => (call.args as { p_user_id: string }).p_user_id)
      .sort();
    // doc1 só pode ir pra userC (userB codificou); doc2 só pra userB
    // (userC codificou). Sem batch correto por doc, ambas as chamadas
    // veriam o conjunto union {userB, userC} e cairiam no fallback,
    // sorteando qualquer um — quebrando a isolação por documento.
    expect(arbitrators).toEqual(["userB", "userC"]);
  });
});

// regenerateAutoReviewBacklog não tinha nenhum teste antes do #385 — passou a
// reusar o mesmo requireCoordinator de retryPendingArbitrations (mesmo
// arquivo), então o gap real a fechar é o guard.
async function loadRegenerate() {
  return (await import("@/actions/field-reviews")).regenerateAutoReviewBacklog;
}

describe("regenerateAutoReviewBacklog — guard", () => {
  it("não-coordenador → erro, sem efeito colateral", async () => {
    hoisted.isCoord.mockResolvedValueOnce(false);
    const regenerate = await loadRegenerate();

    const r = await regenerate("p1");

    expect(r.success).toBe(false);
    expect(r.error).toContain("coordenadores");
    expect(writeCalls).toHaveLength(0);
    expect(hoisted.adminFactory).not.toHaveBeenCalled();
  });
});
