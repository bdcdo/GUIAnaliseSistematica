import { beforeEach, describe, expect, it, vi } from "vitest";

const drain = vi.hoisted(() => vi.fn());
const authorize = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auto-review-reconciler", () => ({
  drainAutoReviewReconciliationRequests: drain,
}));
vi.mock("@/lib/internal-auth", () => ({
  isAutoReviewReconciliationBearer: authorize,
}));

beforeEach(() => {
  authorize.mockReset();
  drain.mockReset();
  authorize.mockReturnValue(true);
  drain.mockResolvedValue({ processed: 1, stale: 0, failed: 0, remaining: 0 });
});

describe("POST /api/internal/auto-review/reconcile", () => {
  it("rejeita chamadas sem credencial de serviço", async () => {
    authorize.mockReturnValue(false);
    const { POST } = await import("@/app/api/internal/auto-review/reconcile/route");
    const response = await POST(new Request("https://app.test/api/internal/auto-review/reconcile", { method: "POST" }));

    expect(response.status).toBe(401);
    expect(drain).not.toHaveBeenCalled();
  });

  it("drena a outbox autenticada", async () => {
    const { POST } = await import("@/app/api/internal/auto-review/reconcile/route");
    const response = await POST(new Request("https://app.test/api/internal/auto-review/reconcile", {
      method: "POST",
      headers: { authorization: "Bearer service" },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ processed: 1, stale: 0, failed: 0, remaining: 0 });
  });

  it("sinaliza falha operacional para o backend repetir o wakeup", async () => {
    drain.mockResolvedValue({ processed: 0, stale: 0, failed: 1, remaining: 0 });
    const { POST } = await import("@/app/api/internal/auto-review/reconcile/route");
    const response = await POST(new Request("https://app.test/api/internal/auto-review/reconcile", {
      method: "POST",
      headers: { authorization: "Bearer service" },
    }));

    expect(response.status).toBe(503);
  });

  it("não expõe o erro interno do dreno", async () => {
    drain.mockRejectedValue(new Error("database secret detail"));
    const { POST } = await import("@/app/api/internal/auto-review/reconcile/route");
    const response = await POST(new Request("https://app.test/api/internal/auto-review/reconcile", { method: "POST" }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Falha ao reconciliar a fila de auto-revisão",
    });
  });
});
