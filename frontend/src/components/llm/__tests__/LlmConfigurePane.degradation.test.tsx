// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

// Quando getRunningLlmJob / getEligibleDocCount lancam (RLS, rede), o
// LlmConfigurePane deve degradar sem quebrar a arvore nem gerar unhandled
// rejection — os useEffect tratam o erro com try/catch + console.error.

// vi.hoisted: os mocks precisam existir antes dos imports (hoisted) que
// disparam o factory de vi.mock.
const { getRunningLlmJob, getEligibleDocCount, cleanupStaleLlmRuns } =
  vi.hoisted(() => ({
    getRunningLlmJob: vi.fn(),
    getEligibleDocCount: vi.fn(),
    cleanupStaleLlmRuns: vi.fn(async () => ({ cleaned: 0 })),
  }));

vi.mock("@/actions/llm", () => ({
  getRunningLlmJob,
  getEligibleDocCount,
  cleanupStaleLlmRuns,
}));

vi.mock("@/actions/schema", () => ({
  saveLlmConfig: vi.fn(),
  savePrompt: vi.fn(),
  toggleLlmField: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  fetchFastAPI: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: vi.fn(async () => "test-token") }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { LlmConfigurePane } from "@/components/llm/LlmConfigurePane";

const baseProps = {
  projectId: "p1",
  promptTemplate: "",
  projectDescription: "",
  config: {
    llm_provider: "anthropic" as const,
    llm_model: "claude-test",
    llm_kwargs: {},
  },
  pydanticFields: [],
  pydanticCode: null,
  schemaBaseline: { revision: 0 },
  totalDocs: 42,
  docsWithLlm: 0,
};

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  getRunningLlmJob.mockReset();
  getEligibleDocCount.mockReset();
  cleanupStaleLlmRuns.mockClear();
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  consoleErrorSpy.mockRestore();
});

describe("LlmConfigurePane — degradacao quando actions lancam", () => {
  it("renderiza sem quebrar quando getRunningLlmJob e getEligibleDocCount lancam", async () => {
    getRunningLlmJob.mockRejectedValue(new Error("rls failure"));
    getEligibleDocCount.mockRejectedValue(new Error("rls failure"));

    render(<LlmConfigurePane {...baseProps} />);

    // A arvore montou apesar das actions lancarem.
    expect(
      screen.getByRole("button", { name: "Rodar LLM" })
    ).toBeDefined();

    // Os dois useEffect capturaram o erro (sem unhandled rejection).
    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  it("nao mostra o card de polling quando getRunningLlmJob lanca", async () => {
    getRunningLlmJob.mockRejectedValue(new Error("rls failure"));
    getEligibleDocCount.mockResolvedValue({ total: 42, eligible: 42 });

    render(<LlmConfigurePane {...baseProps} />);

    await waitFor(() => {
      expect(getRunningLlmJob).toHaveBeenCalled();
    });
    // O card "running" so aparece com status === "running"; a falha nao deve
    // religar o polling.
    expect(screen.queryByText("Carregando documentos...")).toBeNull();
  });

  it("cai no fallback totalDocs quando getEligibleDocCount lanca", async () => {
    getRunningLlmJob.mockResolvedValue(null);
    getEligibleDocCount.mockRejectedValue(new Error("rls failure"));

    render(<LlmConfigurePane {...baseProps} />);

    await waitFor(() => {
      expect(getEligibleDocCount).toHaveBeenCalled();
    });
    // displayEligible = eligibleCount ?? totalDocs => 42 (eligibleCount fica null).
    await waitFor(() => {
      expect(
        screen.getByText(/42 documentos ser/i)
      ).toBeDefined();
    });
  });
});
