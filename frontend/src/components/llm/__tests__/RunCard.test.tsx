// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const { fetchFastAPI, getToken } = vi.hoisted(() => ({
  fetchFastAPI: vi.fn(),
  getToken: vi.fn(async () => "test-token"),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken }),
}));

vi.mock("@/actions/schema", () => ({
  saveLlmConfig: vi.fn(async () => ({})),
  savePrompt: vi.fn(async () => ({})),
}));

vi.mock("@/lib/api", () => ({
  fetchFastAPI,
  requireSupabaseToken: vi.fn(async () => "test-token"),
}));

vi.mock("@/hooks/useEligibleDocCount", () => ({
  useEligibleDocCount: () => ({ eligibleCount: 20_000 }),
}));

vi.mock("@/hooks/useLlmRunProgress", () => ({
  useLlmRunProgress: () => ({
    progress: 0,
    total: 0,
    status: "idle",
    phase: "idle",
    etaSeconds: null,
    currentBatch: 0,
    totalBatches: 0,
    processedComplete: 0,
    processedPartial: 0,
    processedEmpty: 0,
    errorInfo: null,
    start: vi.fn(),
    dismissError: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/components/llm/DocumentSelector", () => ({
  DocumentSelector: () => null,
}));

import { RunCard } from "@/components/llm/RunCard";

const props = {
  projectId: "00000000-0000-4000-8000-000000000001",
  config: {
    llm_provider: "openai" as const,
    llm_model: "test-model",
    llm_kwargs: {},
  },
  prompt: "Analise {texto}",
  pydanticCode: null,
  totalDocs: 20_000,
  docsWithLlm: 0,
};

function selectFilter(id: string) {
  const filter = document.getElementById(id);
  if (!filter) throw new Error(`Filtro ${id} não encontrado`);
  fireEvent.click(filter);
}

function expectRejectedNumericValues({
  input,
  runButton,
  decimal,
  aboveLimit,
  limitLabel,
}: {
  input: HTMLInputElement;
  runButton: HTMLButtonElement;
  decimal: string;
  aboveLimit: string;
  limitLabel: string;
}) {
  fireEvent.change(input, { target: { value: decimal } });
  expect(input.value).toBe(decimal);
  expect(screen.getByRole("alert").textContent).toContain("número inteiro");
  expect(runButton.disabled).toBe(true);

  fireEvent.change(input, { target: { value: "" } });
  expect(input.value).toBe("");
  expect(screen.getByRole("alert").textContent).toContain("número inteiro");

  fireEvent.change(input, { target: { value: aboveLimit } });
  expect(screen.getByRole("alert").textContent).toContain(limitLabel);
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(runButton.disabled).toBe(true);
  expect(fetchFastAPI).not.toHaveBeenCalled();
}

beforeEach(() => {
  fetchFastAPI.mockClear();
});

afterEach(cleanup);

describe("RunCard — limites dos filtros", () => {
  it("aceita amostra de 10.000 e bloqueia valor acima com erro visível", () => {
    render(<RunCard {...props} />);
    selectFilter("filter-random");

    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    const runButton = screen.getByRole("button", {
      name: "Rodar LLM",
    }) as HTMLButtonElement;
    expect(input.max).toBe("10000");

    fireEvent.change(input, { target: { value: "10000" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(runButton.disabled).toBe(false);

    expectRejectedNumericValues({
      input,
      runButton,
      decimal: "10.5",
      aboveLimit: "10001",
      limitLabel: "10.000",
    });
  });

  it("aceita 1.000 respostas e bloqueia valor acima com erro visível", () => {
    render(<RunCard {...props} />);
    selectFilter("filter-max-responses");

    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    const runButton = screen.getByRole("button", {
      name: "Rodar LLM",
    }) as HTMLButtonElement;
    expect(input.max).toBe("1000");

    fireEvent.change(input, { target: { value: "1000" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(runButton.disabled).toBe(false);

    expectRejectedNumericValues({
      input,
      runButton,
      decimal: "1.5",
      aboveLimit: "1001",
      limitLabel: "1.000",
    });
  });
});
