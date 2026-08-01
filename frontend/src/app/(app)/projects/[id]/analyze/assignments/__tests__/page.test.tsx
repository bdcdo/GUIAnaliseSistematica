import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: null as { id: string; isMaster: boolean } | null,
  access: { status: "unavailable" as "resolved" | "unavailable" },
  adminFactoryCalls: 0,
  serverFactoryCalls: 0,
}));

function makeClient() {
  return {
    from: () => {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "is", "order"]) {
        builder[method] = () => builder;
      }
      builder.single = async () => ({ data: { current_round_id: null }, error: null });
      builder.then = (resolve: (value: unknown) => unknown) =>
        resolve({ data: [], error: null });
      return builder;
    },
  };
}

vi.mock("next/cache", () => ({
  unstable_cache: (callback: () => unknown) => callback,
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

vi.mock("@/lib/auth", () => ({
  getProjectAccessContext: async () => state.access,
}));

vi.mock("@/lib/page-auth", () => ({
  requirePageAuthUser: async () => {
    if (!state.user) throw new Error("NEXT_NOT_FOUND");
    return state.user;
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServer: async () => {
    state.serverFactoryCalls += 1;
    return makeClient();
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdmin: () => {
    state.adminFactoryCalls += 1;
    return makeClient();
  },
}));

vi.mock("@/components/assignments/AssignmentTable", () => ({
  AssignmentTable: () => null,
}));
vi.mock("@/components/assignments/LotteryDialog", () => ({
  LotteryDialog: () => null,
}));
vi.mock("@/components/assignments/ClearPendingButton", () => ({
  ClearPendingButton: () => null,
}));

import AssignmentsPage from "@/app/(app)/projects/[id]/analyze/assignments/page";

const renderPage = () =>
  AssignmentsPage({ params: Promise.resolve({ id: "project-1" }) });

async function expectFailClosedBeforeClientCreation() {
  await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
  expect(state.adminFactoryCalls).toBe(0);
  expect(state.serverFactoryCalls).toBe(0);
}

beforeEach(() => {
  state.user = { id: "user-1", isMaster: false };
  state.access = {
    status: "resolved",
    project: { id: "project-1" },
  } as typeof state.access;
  state.adminFactoryCalls = 0;
  state.serverFactoryCalls = 0;
});

describe("AssignmentsPage — gate antes dos readers service role", () => {
  it("sessão ausente falha antes de criar qualquer client", async () => {
    state.user = null;

    await expectFailClosedBeforeClientCreation();
  });

  it("acesso ausente ou consulta falha não alcança o admin client", async () => {
    state.access = { status: "unavailable" };

    await expect(renderPage()).rejects.toThrow(
      "Não foi possível verificar sua identidade no projeto.",
    );
    expect(state.adminFactoryCalls).toBe(0);
    expect(state.serverFactoryCalls).toBe(0);
  });

  it("acesso confirmado libera os readers cacheados", async () => {
    await expect(renderPage()).resolves.toBeDefined();
    expect(state.serverFactoryCalls).toBe(1);
    expect(state.adminFactoryCalls).toBe(1);
  });
});
