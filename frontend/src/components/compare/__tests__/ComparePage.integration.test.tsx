// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  act,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";

// Smoke de ÁRVORE REAL: renderiza os filhos reais (CompareNav, ComparisonPanel,
// CompareWorkspace) para garantir que o container os monta com props válidas e
// que um veredito confirmado no painel real chega ao Server Action. Só o
// DocumentReader é mockado (usa react-markdown via next/dynamic, ruidoso em
// jsdom e irrelevante para esta verificação).
const compareMocks = vi.hoisted(() => ({
  submitVerdict: vi.fn<
    (...args: unknown[]) => Promise<{ error?: string } | void>
  >(async () => {}),
  markCompareDocReviewed: vi.fn(async () => {}),
  confirmEquivalentVerdict: vi.fn(async () => {}),
  unmarkEquivalencePair: vi.fn(async () => {}),
  createProjectComment: vi.fn(async () => ({ error: null })),
  createSchemaSuggestion: vi.fn(async () => ({ error: null })),
  fetchFastAPI: vi.fn(async () => ({ job_id: "job-1" })),
  requireSupabaseToken: vi.fn(async () => "test-token"),
  getToken: vi.fn(async () => "test-token"),
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

const {
  submitVerdict,
  markCompareDocReviewed,
  confirmEquivalentVerdict,
  unmarkEquivalencePair,
  createProjectComment,
  createSchemaSuggestion,
  fetchFastAPI,
} = compareMocks;

vi.mock("@/actions/reviews", () => ({
  submitVerdict: compareMocks.submitVerdict,
  markCompareDocReviewed: compareMocks.markCompareDocReviewed,
}));
vi.mock("@/actions/equivalences", () => ({
  confirmEquivalentVerdict: compareMocks.confirmEquivalentVerdict,
  unmarkEquivalencePair: compareMocks.unmarkEquivalencePair,
}));
vi.mock("@/actions/project-comments", () => ({
  createProjectComment: compareMocks.createProjectComment,
}));
vi.mock("@/actions/suggestions", () => ({
  createSchemaSuggestion: compareMocks.createSchemaSuggestion,
}));
vi.mock("@/lib/api", () => ({
  fetchFastAPI: compareMocks.fetchFastAPI,
  requireSupabaseToken: compareMocks.requireSupabaseToken,
}));
vi.mock("sonner", () => ({ toast: compareMocks.toast }));
vi.mock("@/components/coding/DocumentReader", () => ({
  DocumentReader: ({ text }: { text: string }) => (
    <div data-testid="doc-reader">{text}</div>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/projects/p1/analyze/compare",
}));
// A árvore real monta RunCard, que usa useAuth().getToken para anexar o JWT.
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: compareMocks.getToken }),
}));

import { ComparePage } from "@/components/compare/ComparePage";
import type { PydanticField } from "@/lib/types";
import type { CompareResponse } from "@/components/compare/compare-types";

const fields: PydanticField[] = [
  { name: "campoA", type: "text", options: null, description: "Pergunta A", hash: "hA" },
  { name: "campoB", type: "text", options: null, description: "Pergunta B", hash: "hB" },
];

const documents = [
  { id: "d1", title: "Doc 1", external_id: null, text: "Texto do documento 1" },
];

function resp(
  id: string,
  type: "humano" | "llm",
  name: string,
  answers: Record<string, unknown>,
): CompareResponse {
  return {
    id,
    respondent_type: type,
    respondent_name: name,
    respondent_id: id,
    answers,
    justifications: null,
    is_latest: true,
    is_partial: false,
    pydantic_hash: null,
    answer_field_hashes: null,
    schema_version_major: null,
    schema_version_minor: null,
    schema_version_patch: null,
    created_at: "2026-01-01",
  };
}

const props = {
  projectId: "p1",
  documents,
  responses: {
    d1: [
      resp("r1", "humano", "Ana", { campoA: "Deferido", campoB: "Sim" }),
      resp("r2", "llm", "GPT", { campoA: "Indeferido", campoB: "Não" }),
    ],
  },
  divergentFields: { d1: ["campoA", "campoB"] },
  fields,
  existingReviews: {},
  projectPydanticHash: null,
  respondentNames: ["Ana", "GPT"],
  defaultMinHumans: 2,
  defaultVersion: "latest_major",
  coverageByDoc: {
    d1: {
      docId: "d1",
      humanCount: 1,
      totalCount: 2,
      assignedCodingCount: 1,
      humansFromAssigned: 1,
      divergentCount: 2,
      reviewedCount: 0,
      assignmentStatus: null,
    },
  },
  commentCountsByKey: {},
  suggestionCountsByField: {},
  availableVersions: ["1.0.0"],
  latestMajorLabel: null,
  currentProjectVersion: "1.0.0",
  equivalencesByDocField: {},
  currentUserId: "u1",
  canManageAnyPair: false,
  isCoordinator: false,
  queueContext: {
    showingAll: false,
    hasAssignedDocs: false,
    isImpersonating: false,
  },
};

const renderReal = (overrides: Partial<typeof props> = {}) =>
  render(
    <TooltipProvider>
      <ComparePage {...props} {...overrides} />
    </TooltipProvider>,
  );

const renderMulti = () =>
  render(
    <TooltipProvider>
      <ComparePage
        {...props}
        fields={[
          {
            name: "campoA",
            type: "multi",
            options: ["Sim", "Não"],
            description: "Pergunta A",
            hash: "hA",
          },
        ]}
        responses={{
          d1: [
            resp("r1", "humano", "Ana", { campoA: ["Sim"] }),
            resp("r2", "llm", "GPT", { campoA: ["Não"] }),
          ],
        }}
        divergentFields={{ d1: ["campoA"] }}
      />
    </TooltipProvider>,
  );

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function dispatchConcurrentConfirmations(confirmButton: HTMLElement) {
  // O mesmo act mantém os três eventos antes do rerender; só a trava síncrona
  // pode rejeitar o segundo click e o Enter.
  await act(async () => {
    confirmButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    confirmButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  });
  expect(submitVerdict).toHaveBeenCalledTimes(1);
}

async function finishSave(save: ReturnType<typeof deferred<void>>) {
  await act(async () => {
    save.resolve();
    await save.promise;
  });
}

// jsdom não tem ResizeObserver — exigido por react-resizable-panels.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

// Radix (Popover do CompareFilters) usa APIs de Pointer que o jsdom não tem.
{
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.scrollIntoView = () => {};
  proto.hasPointerCapture = () => false;
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

function expectNoCompareWrites(): void {
  expect(submitVerdict).not.toHaveBeenCalled();
  expect(confirmEquivalentVerdict).not.toHaveBeenCalled();
  expect(markCompareDocReviewed).not.toHaveBeenCalled();
  expect(unmarkEquivalencePair).not.toHaveBeenCalled();
  expect(createProjectComment).not.toHaveBeenCalled();
  expect(createSchemaSuggestion).not.toHaveBeenCalled();
  expect(fetchFastAPI).not.toHaveBeenCalled();
}

describe("ComparePage — árvore real (smoke)", () => {
  it("monta os filhos reais e exibe o texto do documento e as respostas", () => {
    renderReal();
    expect(screen.getByTestId("doc-reader").textContent).toBe(
      "Texto do documento 1",
    );
    // O ComparisonPanel real renderiza as respostas divergentes do campo atual.
    expect(screen.getByText("Deferido")).not.toBeNull();
    expect(screen.getByText("Indeferido")).not.toBeNull();
  });

  it("clicar 'Ambíguo' no painel real só dispara submitVerdict ao confirmar", async () => {
    const user = userEvent.setup();
    renderReal();

    await user.click(screen.getByRole("button", { name: /Ambíguo/i }));

    expect(submitVerdict).not.toHaveBeenCalled();
    expect(screen.getByText("Selecionado:")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Confirmar" }));

    expect(submitVerdict).toHaveBeenCalledTimes(1);
    expect(submitVerdict).toHaveBeenCalledWith({
      projectId: "p1",
      documentId: "d1",
      fieldName: "campoA",
      verdict: "ambiguo",
      chosenResponseId: undefined,
      comment: undefined,
      responseSnapshot: expect.any(Array),
    });
  });

  it("confirmação de rascunho mantém click/Enter em single-flight no mesmo batch", async () => {
    const save = deferred<void>();
    submitVerdict.mockReturnValueOnce(save.promise);
    const user = userEvent.setup();
    renderReal();

    await user.click(screen.getByRole("button", { name: /Ambíguo/i }));
    const confirmButton = screen.getByRole("button", { name: "Confirmar" });

    await dispatchConcurrentConfirmations(confirmButton);

    expect(screen.getByRole("button", { name: "Salvando..." })).toHaveProperty(
      "disabled",
      true,
    );

    await finishSave(save);
  });

  it("campo multi mantém click/Enter em single-flight e exibe o save em andamento", async () => {
    const save = deferred<void>();
    submitVerdict.mockReturnValueOnce(save.promise);
    renderMulti();

    const confirmButton = screen.getByRole("button", {
      name: "[Enter] Confirmar",
    });

    await dispatchConcurrentConfirmations(confirmButton);

    const savingButton = screen.getByRole("button", { name: "Salvando..." });
    expect(savingButton).toHaveProperty("disabled", true);
    for (const checkbox of screen.getAllByRole("checkbox")) {
      expect(checkbox).toHaveProperty("disabled", true);
    }

    await finishSave(save);
  });

  it("campo multi libera a trava após erro e aceita nova tentativa", async () => {
    submitVerdict
      .mockResolvedValueOnce({ error: "falha ao salvar" })
      .mockResolvedValueOnce({});
    const user = userEvent.setup();
    renderMulti();

    await user.click(
      screen.getByRole("button", { name: "[Enter] Confirmar" }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "[Enter] Confirmar" }),
      ).toHaveProperty("disabled", false),
    );

    await user.click(
      screen.getByRole("button", { name: "[Enter] Confirmar" }),
    );
    expect(submitVerdict).toHaveBeenCalledTimes(2);
  });

  it("fora da impersonação, número + Enter continuam salvando o veredito", async () => {
    const user = userEvent.setup();
    renderReal();

    await user.keyboard("1{Enter}");

    expect(submitVerdict).toHaveBeenCalledTimes(1);
    expect(submitVerdict).toHaveBeenCalledWith({
      projectId: "p1",
      documentId: "d1",
      fieldName: "campoA",
      verdict: "Deferido",
      chosenResponseId: "r1",
      comment: undefined,
      responseSnapshot: expect.any(Array),
    });
  });

  it("impersonação mantém navegação, mas bloqueia controles e atalhos de escrita", async () => {
    const user = userEvent.setup();
    renderReal({
      queueContext: { ...props.queueContext, isImpersonating: true },
      canManageAnyPair: true,
    });

    expect(
      screen.getByRole("status").textContent,
    ).toMatch(/Comparação está somente leitura/i);

    const voteButton = screen.getByRole("button", {
      name: /Selecionar esta resposta para confirmar: Deferido/i,
    }) as HTMLButtonElement;
    const ambiguousButton = screen.getByRole("button", {
      name: /Ambíguo/i,
    }) as HTMLButtonElement;
    const comment = screen.getByPlaceholderText(
      "Comentário (opcional)",
    ) as HTMLInputElement;
    const addNote = screen.getByRole("button", {
      name: "Anotar",
    }) as HTMLButtonElement;
    const suggest = screen.getByRole("button", {
      name: "Sugerir",
    }) as HTMLButtonElement;
    const runLlm = screen.getByRole("button", {
      name: /Rodar LLM indisponível/i,
    }) as HTMLButtonElement;

    expect(voteButton.disabled).toBe(true);
    expect(ambiguousButton.disabled).toBe(true);
    expect(comment.disabled).toBe(true);
    expect(addNote.disabled).toBe(true);
    expect(suggest.disabled).toBe(true);
    expect(runLlm.disabled).toBe(true);
    expect(
      (screen.getAllByRole("checkbox")[0] as HTMLButtonElement).disabled,
    ).toBe(true);

    await user.click(voteButton);
    await user.click(ambiguousButton);
    await user.keyboard("1as{Enter}");

    expect(screen.queryByText("Selecionado:")).toBeNull();
    expectNoCompareWrites();

    // Navegação de leitura continua disponível no mesmo listener.
    await user.keyboard("n");
    expect(screen.getByText("Pergunta B")).not.toBeNull();
    await user.keyboard("p");
    expect(screen.getByText("Pergunta A")).not.toBeNull();
  });

  it("entrar em impersonação descarta o rascunho da identidade anterior sem salvar", async () => {
    const user = userEvent.setup();
    const { rerender } = renderReal();

    await user.click(
      screen.getByRole("button", {
        name: /Selecionar esta resposta para confirmar: Deferido/i,
      }),
    );
    // O par presente-ANTES / ausente-DEPOIS é o que sustenta o teste: a
    // asserção de ausência sozinha passaria mesmo se o gate de impersonação
    // fosse deletado, porque a barra também não existiria sem rascunho nenhum.
    expect(screen.getByTestId("pending-confirm")).not.toBeNull();

    rerender(
      <TooltipProvider>
        <ComparePage
          {...props}
          queueContext={{ ...props.queueContext, isImpersonating: true }}
        />
      </TooltipProvider>,
    );

    expect(screen.queryByTestId("pending-confirm")).toBeNull();
    expect(
      screen.queryAllByRole("button", { name: "Confirmar" }),
    ).toHaveLength(0);

    await user.keyboard("{Enter}");

    expectNoCompareWrites();
  });

  // Defesa em profundidade da #613, na árvore real. A propriedade que faz estas
  // asserções valerem alguma coisa é o fixture ter conjuntos de resposta
  // DISJUNTOS por campo (campoA: Deferido/Indeferido; campoB: Sim/Não): assim
  // "gravou valor de outro campo" é inequívoco, sem depender de qual card foi
  // clicado. É a mesma propriedade que o fixture E2E preserva de propósito.
  it("após navegar, a tela mostra só os cards do campo atual", async () => {
    const user = userEvent.setup();
    renderReal();

    expect(screen.getAllByTestId("agreement-group")).toHaveLength(1);
    expect(screen.getByText("Deferido")).not.toBeNull();

    await user.keyboard("n");

    // Critério de aceitação 1 da #613: uma raiz, sempre.
    expect(screen.getAllByTestId("agreement-group")).toHaveLength(1);
    expect(screen.getByText("Sim")).not.toBeNull();
    expect(screen.queryByText("Deferido")).toBeNull();
    expect(screen.queryByText("Indeferido")).toBeNull();
  });

  // Deliberadamente pelo MOUSE, e não pelo teclado: o teclado sempre leu
  // `answerGroups` frescos e por isso nunca foi o vetor da #613 (ver o
  // comentário em `useCompareKeyboard`). Um teste de teclado aqui afirmaria uma
  // propriedade que já valia ANTES da correção — verde tanto no código são
  // quanto no doente, que é a definição de teste que não testa nada.
  it("veredito confirmado depois de navegar grava no campo novo, com valor do campo novo", async () => {
    const user = userEvent.setup();
    renderReal();

    await user.keyboard("n");

    // O primeiro card na tela: posição natural do clique, e exatamente onde
    // ficava o card fantasma do campo anterior.
    const card = screen.getByRole("button", {
      name: /Selecionar esta resposta para confirmar: Sim/i,
    });
    await user.click(card);
    await user.click(screen.getByRole("button", { name: /^Confirmar$/ }));

    expect(submitVerdict).toHaveBeenCalledTimes(1);
    const call = vi.mocked(submitVerdict).mock.calls[0][0] as {
      fieldName: string;
      verdict: string;
    };
    expect(call.fieldName).toBe("campoB");
    // Valor do conjunto de campoB. Como os conjuntos são disjuntos, "Deferido"
    // aqui seria prova de campo trocado.
    expect(call.verdict).toBe("Sim");
  });

  it("'Descartar' no painel real limpa a seleção sem salvar", async () => {
    const user = userEvent.setup();
    renderReal();

    await user.click(screen.getByRole("button", { name: /Ambíguo/i }));
    expect(screen.getByText("Selecionado:")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Descartar" }));

    expect(screen.queryByText("Selecionado:")).toBeNull();
    expect(screen.queryByRole("button", { name: "Descartar" })).toBeNull();
    expect(submitVerdict).not.toHaveBeenCalled();
  });

  it("com rascunho pendente, trocar filtro de fila no popover real é bloqueado com aviso", async () => {
    const user = userEvent.setup();
    renderReal();

    await user.click(screen.getByRole("button", { name: /Ambíguo/i }));
    expect(screen.getByText("Selecionado:")).not.toBeNull();

    // Vetor da revisão do PR #434: CompareFilters faz o próprio push de URL e
    // recompõe a fila — sem o gate, o rascunho seria descartado em silêncio
    // pelo guard de contexto (mesma classe do incidente do #430).
    await user.click(screen.getByRole("button", { name: /Filtros/i }));
    const dateInput = document.querySelector('input[type="date"]');
    expect(dateInput).not.toBeNull();
    fireEvent.change(dateInput as HTMLInputElement, {
      target: { value: "2026-01-01" },
    });

    expect(compareMocks.toast.warning).toHaveBeenCalledWith(
      "Seleção não confirmada — confirme ou descarte antes de avançar.",
      { id: "compare-nav-guard" },
    );
    // Rascunho intacto e filtro não aplicado (input controlado volta a vazio).
    expect(screen.getByText("Selecionado:")).not.toBeNull();
    expect((dateInput as HTMLInputElement).value).toBe("");
  });

  it("coordenador vê o toggle de fila real (CompareQueueTabs) montado", () => {
    render(
      <TooltipProvider>
        <ComparePage {...props} isCoordinator canManageAnyPair />
      </TooltipProvider>,
    );
    expect(screen.getByRole("tab", { name: "Meus atribuídos" })).not.toBeNull();
    expect(screen.getByRole("tab", { name: "Todos" })).not.toBeNull();
  });
});

// A confirmação deixou de ser uma barra fixa no rodapé e passou a nascer no
// elemento que produziu o rascunho (#610). A garantia do #417 é a mesma — dois
// atos, em controles distintos —, mas o segundo alvo fica a poucos pixels do
// primeiro em vez de a algumas centenas.
describe("ComparePage — confirmação ancorada ao que produziu o rascunho (#610)", () => {
  const voteButton = () =>
    screen.getByRole("button", {
      name: /Selecionar esta resposta para confirmar: Deferido/i,
    });

  it("sem rascunho, não existe nenhum controle de confirmação na tela", () => {
    renderReal();
    expect(screen.queryByTestId("pending-confirm")).toBeNull();
    expect(screen.queryAllByRole("button", { name: "Confirmar" })).toHaveLength(
      0,
    );
  });

  // A LACUNA que este PR fecha: até aqui nenhum teste provava que clicar num
  // CARD não grava — o análogo usava "Ambíguo". Reverter `onVote` para chamar
  // `onVerdict` direto (isto é, desfazer o #417 no caminho do mouse) passava
  // despercebido.
  it("clicar num card prepara e NÃO grava; a gravação só vem da confirmação", async () => {
    const user = userEvent.setup();
    renderReal();

    await user.click(voteButton());
    expect(submitVerdict).not.toHaveBeenCalled();

    const card = screen.getByTestId("pending-confirm").closest(
      '[data-testid="answer-card"]',
    ) as HTMLElement;
    await user.click(within(card).getByRole("button", { name: "Confirmar" }));

    expect(submitVerdict).toHaveBeenCalledTimes(1);
    expect(submitVerdict).toHaveBeenCalledWith(
      expect.objectContaining({ fieldName: "campoA", verdict: "Deferido" }),
    );
  });

  it("a barra de confirmação nasce DENTRO do card clicado", async () => {
    const user = userEvent.setup();
    renderReal();

    await user.click(voteButton());

    const card = voteButton().closest(
      '[data-testid="answer-card"]',
    ) as HTMLElement;
    expect(card.getAttribute("data-pending")).toBe("true");
    expect(
      within(card).getByRole("button", { name: "Confirmar" }),
    ).not.toBeNull();
  });

  // Guarda direta contra o modo de falha mais provável de uma implementação
  // apressada: manter o rodapé E acrescentar a barra no card, deixando dois
  // botões "Confirmar" no DOM.
  it("há no máximo um controle de confirmação no DOM, em qualquer estado", async () => {
    const user = userEvent.setup();
    renderReal();

    expect(screen.queryAllByTestId("pending-confirm")).toHaveLength(0);

    await user.click(voteButton());
    expect(screen.queryAllByTestId("pending-confirm")).toHaveLength(1);
    expect(screen.queryAllByRole("button", { name: "Confirmar" })).toHaveLength(
      1,
    );

    await user.click(screen.getByRole("button", { name: /Ambíguo/i }));
    expect(screen.queryAllByTestId("pending-confirm")).toHaveLength(1);
    expect(screen.queryAllByRole("button", { name: "Confirmar" })).toHaveLength(
      1,
    );
  });

  it("Enter confirma o rascunho criado pelo mouse", async () => {
    const user = userEvent.setup();
    renderReal();

    await user.click(voteButton());
    expect(submitVerdict).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");

    expect(submitVerdict).toHaveBeenCalledTimes(1);
  });

  it("'Descartar' dentro do card limpa o rascunho sem salvar", async () => {
    const user = userEvent.setup();
    renderReal();

    await user.click(voteButton());
    const card = voteButton().closest(
      '[data-testid="answer-card"]',
    ) as HTMLElement;

    await user.click(within(card).getByRole("button", { name: "Descartar" }));

    expect(screen.queryByTestId("pending-confirm")).toBeNull();
    expectNoCompareWrites();
  });
});
