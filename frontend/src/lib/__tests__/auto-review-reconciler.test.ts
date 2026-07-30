import { beforeEach, describe, expect, it, vi } from "vitest";

const computeBacklogRows = vi.hoisted(() => vi.fn());
const buildEquivalenceMap = vi.hoisted(() => vi.fn(() => new Map()));
const state = vi.hoisted(() => ({
  requests: [] as Array<Record<string, unknown>>,
  due: true,
  llmLatest: true,
  humanLatest: true,
  rpcError: null as string | null,
  rpcCalls: [] as Array<{ name: string; args: unknown }>,
  failures: [] as unknown[],
  deletes: [] as Array<Array<[string, unknown]>>,
  projectMembers: [{ user_id: "user-1" }] as Array<{ user_id: string }>,
  // Teto do PostgREST simulado: quanto o mock devolve por página, para provar
  // que o reconciliador pagina em vez de tomar a primeira página como universo.
  pageSize: 1000,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auto-review-backlog", () => ({ computeBacklogRows }));
vi.mock("@/lib/compare-queue", () => ({ buildEquivalenceMap }));

class Query {
  private filters: Array<[string, unknown]> = [];
  private operation: "select" | "delete" = "select";
  private head = false;
  private rangeFrom: number | null = null;

  constructor(private table: string) {}

  select(_columns?: string, options?: { head?: boolean }) {
    this.head = options?.head ?? false;
    return this;
  }
  order() { return this; }
  range(from: number, _to: number) { this.rangeFrom = from; return this; }
  limit() { return this; }
  lte() { return this; }
  single() { return this; }
  maybeSingle() { return this; }
  is(column: string, value: unknown) { this.filters.push([column, value]); return this; }
  eq(column: string, value: unknown) { this.filters.push([column, value]); return this; }
  delete() { this.operation = "delete"; return this; }

  private deleteResult() {
    state.deletes.push(this.filters);
    state.requests = state.requests.filter((request) =>
      !this.filters.every(([column, value]) => request[column] === value),
    );
    return { data: null, error: null };
  }

  private requestsResult() {
    if (this.head) {
      return { data: null, count: state.due ? state.requests.length : 0, error: null };
    }
    return { data: state.due ? state.requests : [], error: null };
  }

  private responsesResult() {
    const isLlm = this.filters.some(
      ([column, value]) => column === "respondent_type" && value === "llm",
    );
    if (isLlm) {
      return {
        data: state.llmLatest
          ? {
              id: "llm-1",
              document_id: "doc-1",
              answers: { q1: "llm" },
              answer_field_hashes: {},
              updated_at: "2026-07-16T12:00:00.000Z",
            }
          : null,
        error: null,
      };
    }
    return {
      data: state.humanLatest ? [{
        id: "human-1",
        document_id: "doc-1",
        respondent_id: "user-1",
        answers: { q1: "human" },
        answer_field_hashes: {},
        updated_at: "2026-07-16T11:00:00.000Z",
      }] : [],
      error: null,
    };
  }

  private selectResult() {
    if (this.table === "auto_review_reconciliation_requests") return this.requestsResult();
    if (this.table === "responses") return this.responsesResult();
    const rowsByTable: Record<string, unknown> = {
      projects: {
        pydantic_fields: [{ name: "q1", type: "text", target: "all" }],
        pydantic_hash: "schema-hash",
      },
      response_equivalences: [],
      field_reviews: [],
      field_review_cycle_history_entries: [{ self_reviewer_id: "user-1" }],
      member_email_links: [],
      project_members: state.projectMembers,
    };
    if (!(this.table in rowsByTable)) throw new Error(`Tabela inesperada: ${this.table}`);
    const rows = rowsByTable[this.table];
    if (!Array.isArray(rows)) return { data: rows, error: null };
    // O teto do PostgREST vale mesmo sem .range(): quem não pagina recebe a
    // primeira página como se fosse o conjunto inteiro. É isso que torna o
    // truncamento silencioso — e o que faz este mock detectar a regressão.
    const from = this.rangeFrom ?? 0;
    return { data: rows.slice(from, from + state.pageSize), error: null };
  }

  private result() {
    return this.operation === "delete" ? this.deleteResult() : this.selectResult();
  }

  then(resolve: (value: unknown) => unknown) {
    return Promise.resolve(this.result()).then(resolve);
  }
}

const admin = {
  from: (table: string) => new Query(table),
  rpc: vi.fn(async (name: string, args: unknown) => {
    state.rpcCalls.push({ name, args });
    if (name === "record_auto_review_reconciliation_failure") {
      state.failures.push(args);
      state.due = false;
      return { data: true, error: null };
    }
    return {
      data: {},
      error: state.rpcError ? { message: state.rpcError } : null,
    };
  }),
};

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => admin,
}));

const request = {
  project_id: "project-1",
  document_id: "doc-1",
  llm_response_id: "llm-1",
  allow_new_cycles: true,
};

beforeEach(() => {
  state.requests = [{ ...request }];
  state.due = true;
  state.llmLatest = true;
  state.humanLatest = true;
  state.rpcError = null;
  state.rpcCalls = [];
  state.failures = [];
  state.deletes = [];
  state.projectMembers = [{ user_id: "user-1" }];
  state.pageSize = 1000;
  admin.rpc.mockClear();
  buildEquivalenceMap.mockClear();
  computeBacklogRows.mockReset();
  computeBacklogRows.mockReturnValue({
    regenerated: 1,
    fieldReviewRows: [{
      project_id: "project-1",
      document_id: "doc-1",
      field_name: "q1",
      human_response_id: "human-1",
      llm_response_id: "llm-1",
      self_reviewer_id: "user-1",
    }],
  });
});

describe("drainAutoReviewReconciliationRequests", () => {
  it("reutiliza o cálculo canônico, reconcilia e confirma a request exata", async () => {
    const { drainAutoReviewReconciliationRequests } = await import("@/lib/auto-review-reconciler");
    const result = await drainAutoReviewReconciliationRequests();

    expect(result).toEqual({ processed: 1, stale: 0, deferred: 0, failed: 0, remaining: 0 });
    expect(computeBacklogRows).toHaveBeenCalledOnce();
    expect(state.rpcCalls).toEqual([{
      name: "reconcile_auto_review_cycles",
      args: { p_groups: [{
        human_response_id: "human-1",
        llm_response_id: "llm-1",
        field_names: ["q1"],
        divergent_field_names: ["q1"],
        expected_human_updated_at: "2026-07-16T11:00:00.000Z",
        expected_llm_updated_at: "2026-07-16T12:00:00.000Z",
        expected_project_pydantic_hash: "schema-hash",
        expected_equivalence_ids: [],
      }] },
    }]);
    expect(state.deletes[0]).toContainEqual(["llm_response_id", "llm-1"]);
  });

  // O Set de membros é o universo que decide quem ainda pode gerar auto-revisão.
  // Lido sem paginar, um projeto acima do teto do PostgREST devolveria só a
  // primeira página e o autor da resposta seria descartado como ex-membro — sem
  // erro, sem log, sem ciclo gerado.
  it("não trata membro além da primeira página como ex-membro", async () => {
    state.projectMembers = [
      ...Array.from({ length: 1000 }, (_, i) => ({ user_id: `outro-${i}` })),
      { user_id: "user-1" },
    ];
    const { drainAutoReviewReconciliationRequests } = await import("@/lib/auto-review-reconciler");

    const result = await drainAutoReviewReconciliationRequests();

    expect(result.processed).toBe(1);
    expect(computeBacklogRows).toHaveBeenCalledOnce();
    const humansConsidered = computeBacklogRows.mock.calls[0][1];
    expect(humansConsidered).toHaveLength(1);
  });

  it("também reconcilia consenso para encerrar um ciclo anterior", async () => {
    computeBacklogRows.mockReturnValue({ regenerated: 0, fieldReviewRows: [] });
    const { drainAutoReviewReconciliationRequests } = await import("@/lib/auto-review-reconciler");
    await drainAutoReviewReconciliationRequests();

    expect(state.rpcCalls[0]).toEqual({
      name: "reconcile_auto_review_cycles",
      args: { p_groups: [expect.objectContaining({ divergent_field_names: [] })] },
    });
  });

  it("descarta request obsoleta sem reconciliar", async () => {
    state.llmLatest = false;
    const { drainAutoReviewReconciliationRequests } = await import("@/lib/auto-review-reconciler");
    const result = await drainAutoReviewReconciliationRequests();

    expect(result).toEqual({ processed: 0, stale: 1, deferred: 0, failed: 0, remaining: 0 });
    expect(state.rpcCalls).toEqual([]);
    expect(state.deletes[0]).toContainEqual(["llm_response_id", "llm-1"]);
  });

  it("mantém a request e registra a falha para retry", async () => {
    state.rpcError = "lock timeout";
    const { drainAutoReviewReconciliationRequests } = await import("@/lib/auto-review-reconciler");
    const result = await drainAutoReviewReconciliationRequests();

    expect(result).toEqual({ processed: 0, stale: 0, deferred: 0, failed: 1, remaining: 0 });
    expect(state.deletes).toEqual([]);
    expect(state.failures).toEqual([{
      p_document_id: "doc-1",
      p_llm_response_id: "llm-1",
      p_error: "lock timeout",
    }]);
  });

  it("adia o sinal humano até a primeira geração LLM ficar visível", async () => {
    state.requests = [{ ...request, llm_response_id: null }];
    state.llmLatest = false;
    const { drainAutoReviewReconciliationRequests } = await import("@/lib/auto-review-reconciler");
    const result = await drainAutoReviewReconciliationRequests();

    expect(result).toEqual({ processed: 0, stale: 0, deferred: 1, failed: 0, remaining: 0 });
    expect(state.deletes).toEqual([]);
    expect(state.failures).toEqual([expect.objectContaining({
      p_document_id: "doc-1",
      p_llm_response_id: null,
    })]);
  });

  it("confirma uma geração LLM sem humano e deixa um save futuro reenfileirar", async () => {
    state.humanLatest = false;
    computeBacklogRows.mockReturnValue({ regenerated: 0, fieldReviewRows: [] });

    const { drainAutoReviewReconciliationRequests } = await import("@/lib/auto-review-reconciler");
    const result = await drainAutoReviewReconciliationRequests();

    expect(result.processed).toBe(1);
  });
});
