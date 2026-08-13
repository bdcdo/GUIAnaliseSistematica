// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { toggleLlmField } = vi.hoisted(() => ({ toggleLlmField: vi.fn() }));
const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/actions/schema", () => ({ toggleLlmField }));
vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

import { ModelConfigCard } from "@/components/llm/ModelConfigCard";
import { LLM_AMBIGUITIES_FIELD } from "@/lib/standard-questions";

const baseProps = {
  projectId: "p1",
  config: {
    llm_provider: "anthropic" as const,
    llm_model: "claude-test",
    llm_kwargs: {},
  },
  setConfig: vi.fn(),
  pydanticFields: [] as { name: string }[],
  schemaBaseline: { revision: 0 },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// O segundo switch é o de ambiguidades (o primeiro é "justificativas").
function ambiguitiesSwitch() {
  return screen.getAllByRole("switch")[1];
}

describe("ModelConfigCard — toggle de ambiguidades", () => {
  it("chama toggleLlmField com LLM_AMBIGUITIES_FIELD e mostra sucesso", async () => {
    toggleLlmField.mockResolvedValue({
      status: "saved",
      snapshot: { fields: [], version: "0.2.0", revision: 1 },
    });
    const user = userEvent.setup();
    render(<ModelConfigCard {...baseProps} />);

    await user.click(ambiguitiesSwitch());

    await waitFor(() =>
      expect(toggleLlmField).toHaveBeenCalledWith(
        "p1",
        LLM_AMBIGUITIES_FIELD,
        true,
        { revision: 0 },
      ),
    );
    expect(toastSuccess).toHaveBeenCalledWith("Campo de ambiguidades adicionado");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("reverte o estado otimista e mostra erro quando a action falha", async () => {
    toggleLlmField.mockResolvedValue({ status: "error", message: "schema bloqueado" });
    const user = userEvent.setup();
    render(<ModelConfigCard {...baseProps} />);

    const sw = ambiguitiesSwitch();
    expect(sw.getAttribute("aria-checked")).toBe("false");

    await user.click(sw);

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("schema bloqueado"),
    );
    // useOptimistic reverte para a base (pydanticFields sem o campo) ao fim da
    // transição, já que o schema não mudou.
    await waitFor(() =>
      expect(ambiguitiesSwitch().getAttribute("aria-checked")).toBe("false"),
    );
  });

  it("reflete o schema quando o campo já existe", () => {
    render(
      <ModelConfigCard
        {...baseProps}
        pydanticFields={[{ name: "llm_ambiguidades" }]}
      />,
    );
    expect(ambiguitiesSwitch().getAttribute("aria-checked")).toBe("true");
  });
});
