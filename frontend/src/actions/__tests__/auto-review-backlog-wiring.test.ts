import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  makeSupabaseAdminModuleMock,
  makeSupabaseServerModuleMock,
  makeFilterAwareSupabaseMock,
  type RpcCall,
  type WriteCall,
} from "@/test-utils/supabase-mock";
import { authModuleMock } from "@/test-utils/auth-mock";

// Fiação de regenerateAutoReviewBacklog com o reconcile da fila. Arquivo
// separado de arbitration-retry.test.ts porque este caminho lê `responses` duas
// vezes na mesma tabela (humano vs LLM, discriminados por respondent_type), o
// que exige o mock filter-aware — o simples devolveria a mesma linha para os
// dois e nunca produziria divergência.

// Uma lista só para escritas e RPCs: o que este teste fixa é a ORDEM entre elas
// (o reconcile só reabre o que o upsert de field_reviews já devolveu ao
// backlog), e arrays separados não a capturariam.
type Step = WriteCall | RpcCall;
let timeline: Step[];
let tableData: Record<string, unknown[]>;

const hoisted = vi.hoisted(() => ({
  isCoord: vi.fn<() => Promise<boolean>>(async () => true),
  adminFactory: vi.fn(),
  drain: vi.fn(async () => ({
    processed: 1,
    stale: 0,
    failed: 0,
    remaining: 0,
  })),
}));

function makeClient() {
  return makeFilterAwareSupabaseMock({
    tableData,
    writeCalls: timeline as WriteCall[],
    rpcCalls: timeline as RpcCall[],
  });
}

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => authModuleMock(hoisted.isCoord));
vi.mock("@/lib/supabase/server", () => makeSupabaseServerModuleMock(makeClient));
vi.mock("@/lib/supabase/admin", () =>
  makeSupabaseAdminModuleMock(makeClient, hoisted.adminFactory),
);
vi.mock("@/lib/auto-review-reconciler", () => ({
  drainAutoReviewReconciliationRequests: hoisted.drain,
}));

beforeEach(() => {
  timeline = [];
  hoisted.isCoord.mockResolvedValue(true);
  hoisted.adminFactory.mockClear();
  hoisted.drain.mockClear();
  tableData = {
    projects: [
      {
        id: "p1",
        pydantic_fields: [
          { name: "q1", type: "single", options: ["a", "b"], target: "all" },
        ],
      },
    ],
    // Humano diverge do LLM em q1 → o backlog tem uma linha para materializar.
    responses: [
      {
        id: "h1",
        project_id: "p1",
        document_id: "d1",
        respondent_id: "u1",
        respondent_type: "humano",
        is_latest: true,
        is_partial: false,
        answers: { q1: "a" },
        answer_field_hashes: null,
      },
      {
        id: "l1",
        project_id: "p1",
        document_id: "d1",
        respondent_type: "llm",
        is_latest: true,
        answers: { q1: "b" },
        answer_field_hashes: null,
      },
    ],
    response_equivalences: [],
    field_reviews: [],
    assignments: [],
  };
});

async function loadRegenerate() {
  return (await import("@/actions/field-reviews")).regenerateAutoReviewBacklog;
}

describe("regenerateAutoReviewBacklog — reconcile da fila", () => {
  it("reenfileira o projeto e usa somente o dreno canônico", async () => {
    const regenerate = await loadRegenerate();

    const r = await regenerate("p1");

    expect(r.success).toBe(true);

    expect(timeline).toContainEqual({
      fn: "enqueue_auto_review_reconciliation_for_project",
      args: {
        p_project_id: "p1",
      },
    });
    expect(timeline.some(
      (step) => (step as RpcCall).fn === "reconcile_auto_review_cycles",
    )).toBe(false);
    expect(hoisted.drain).toHaveBeenCalledWith({ projectId: "p1", maxRequests: 2_000 });
    expect(timeline.some((step) => (step as WriteCall).table === "assignments")).toBe(false);
    expect(timeline.some((step) => (step as WriteCall).table === "field_reviews")).toBe(false);
  });
});
