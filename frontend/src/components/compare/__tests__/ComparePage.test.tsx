// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  act,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
// Import só de TIPO (apagado na compilação, então não colide com o `vi.mock`
// da view): serve para o harness derivar as assinaturas reais em vez de
// redigitá-las — ver `MockComparisonPanel` abaixo.
import type { ComparisonPanel } from "@/components/compare/ComparisonPanel";

// Mocks dos Server Actions e do toast (efeitos colaterais fora do escopo do
// teste de lógica do container).
const { submitVerdict, markCompareDocReviewed } = vi.hoisted(() => ({
  submitVerdict: vi.fn<
    (...args: unknown[]) => Promise<{ error?: string } | void>
  >(async () => {}),
  markCompareDocReviewed: vi.fn(async () => {}),
}));
const { confirmEquivalentVerdict, unmarkEquivalencePair } = vi.hoisted(() => ({
  confirmEquivalentVerdict: vi.fn(async () => {}),
  unmarkEquivalencePair: vi.fn(async () => {}),
}));

vi.mock("@/actions/reviews", () => ({ submitVerdict, markCompareDocReviewed }));
vi.mock("@/actions/equivalences", () => ({
  confirmEquivalentVerdict,
  unmarkEquivalencePair,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/projects/p1/analyze/compare",
}));

// Mock das views: expõem só os controles necessários para dirigir a lógica do
// container. NÃO testam o render dos filhos reais (CompareNav/ComparisonPanel/
// DocumentReader), que este PR não altera e têm contrato garantido por tsc.
//
// As assinaturas de callback são DERIVADAS das props reais do `ComparisonPanel`
// em vez de redigitadas: uma cópia à mão diverge em silêncio quando o contrato
// muda, e foi o que aconteceu ao acrescentar a origem do veredito (#613) — o
// harness continuou chamando `onConfirmEquivalent` com a aridade antiga, os
// argumentos escorregaram uma posição e só o teste em execução denunciou.
type RealPanelProps = Parameters<typeof ComparisonPanel>[0];

interface MockComparisonPanel {
  documentId: string;
  fieldName: string;
  fieldIndex: number;
  comment: string;
  onCommentChange: (v: string) => void;
  onFieldNavigate: (i: number) => void;
  onVerdict: RealPanelProps["onVerdict"];
  pendingVerdict: PendingVerdict | null;
  onPrepareVerdict: RealPanelProps["onPrepareVerdict"];
  onConfirmPendingVerdict: () => void;
  onDiscardPendingVerdict: () => void;
  isSavingVerdict: boolean;
  onConfirmEquivalent: RealPanelProps["onConfirmEquivalent"];
  onMarkReviewed: () => void;
}

vi.mock("@/components/compare/CompareWorkspace", () => ({
  CompareWorkspace: ({
    documentText,
    comparisonPanel,
    listCollapsed,
    onToggleList,
  }: {
    documentText: string;
    comparisonPanel: MockComparisonPanel;
    listCollapsed: boolean;
    onToggleList: () => void;
  }) => (
    <div>
      <span data-testid="doc-text">{documentText}</span>
      <span data-testid="list-collapsed">{String(listCollapsed)}</span>
      <button data-testid="toggle-list" onClick={onToggleList}>
        toggle list
      </button>
      <span data-testid="field-name">{comparisonPanel.fieldName}</span>
      <span data-testid="pending-verdict">
        {comparisonPanel.pendingVerdict
          ? pendingVerdictLabel(comparisonPanel.pendingVerdict)
          : ""}
      </span>
      <input
        data-testid="comment"
        value={comparisonPanel.comment}
        onChange={(e) => comparisonPanel.onCommentChange(e.target.value)}
      />
      <button
        data-testid="next-field"
        onClick={() =>
          comparisonPanel.onFieldNavigate(comparisonPanel.fieldIndex + 1)
        }
      >
        next field
      </button>
      <button
        data-testid="prepare-verdict"
        onClick={() =>
          comparisonPanel.onPrepareVerdict({
            kind: "response",
            verdict: "Deferido",
            chosenResponseId: "r1",
            // Espelha o painel real: a origem sai das props do render corrente
            // (CompareFieldReview), não de uma constante — é isso que o
            // container valida antes de aceitar o rascunho.
            origin: {
              documentId: comparisonPanel.documentId,
              fieldName: comparisonPanel.fieldName,
            },
          })
        }
      >
        prepare verdict
      </button>
      {/*
        Simula o clique num card FANTASMA: o rascunho chega carimbado com um
        campo que não é o exibido. É o que uma subárvore sobrevivente no DOM
        produz por construção, já que ela não re-renderiza (#613).
      */}
      <button
        data-testid="prepare-verdict-campo-fantasma"
        onClick={() =>
          comparisonPanel.onPrepareVerdict({
            kind: "response",
            verdict: "ALFA-do-campo-antigo",
            chosenResponseId: "r-fantasma",
            origin: {
              documentId: comparisonPanel.documentId,
              fieldName: "campo_ja_desmontado",
            },
          })
        }
      >
        prepare verdict fantasma
      </button>
      <button
        data-testid="prepare-verdict-2"
        onClick={() =>
          comparisonPanel.onPrepareVerdict({
            kind: "response",
            verdict: "Indeferido",
            chosenResponseId: "r2",
            origin: {
              documentId: comparisonPanel.documentId,
              fieldName: comparisonPanel.fieldName,
            },
          })
        }
      >
        prepare verdict 2
      </button>
      <button
        data-testid="confirm-verdict"
        disabled={comparisonPanel.isSavingVerdict}
        onClick={() => comparisonPanel.onConfirmPendingVerdict()}
      >
        {comparisonPanel.isSavingVerdict ? "saving verdict" : "confirm verdict"}
      </button>
      <button
        data-testid="discard-verdict"
        onClick={() => comparisonPanel.onDiscardPendingVerdict()}
      >
        discard verdict
      </button>
      <button
        data-testid="confirm-equiv"
        onClick={() =>
          void comparisonPanel.onConfirmEquivalent(
            {
              documentId: comparisonPanel.documentId,
              fieldName: comparisonPanel.fieldName,
            },
            ["r1", "r2"],
            "r1",
            "Equivalentes",
          )
        }
      >
        equiv
      </button>
      <button
        data-testid="mark-reviewed"
        onClick={() => comparisonPanel.onMarkReviewed()}
      >
        mark reviewed
      </button>
    </div>
  ),
}));

vi.mock("@/components/compare/CompareNav", () => ({
  CompareNav: ({
    docIndex,
    onFilterChange,
    onDocNavigate,
  }: {
    docIndex: number;
    onFilterChange: (v: string) => void;
    onDocNavigate: (i: number) => void;
  }) => (
    <div>
      <span data-testid="nav-doc-index">{docIndex}</span>
      <button data-testid="set-filter-all" onClick={() => onFilterChange("all")}>
        filter all
      </button>
      <button
        data-testid="set-filter-b"
        onClick={() => onFilterChange("campoB")}
      >
        filter campoB
      </button>
      <button data-testid="nav-next-doc" onClick={() => onDocNavigate(1)}>
        nav doc 1
      </button>
    </div>
  ),
}));

vi.mock("@/components/coding/FullscreenNav", () => ({
  FullscreenNav: ({ title }: { title: string }) => (
    <div data-testid="fullscreen-nav">{title}</div>
  ),
}));

import { toast } from "sonner";
import { ComparePage } from "@/components/compare/ComparePage";
import { SAVE_TIMEOUT_MS } from "@/components/compare/useCompareVerdicts";
import type { PydanticField } from "@/lib/types";
import type { ReviewsByDoc } from "@/lib/compare-reviews";
import { pendingVerdictLabel, type CompareResponse, type PendingVerdict } from "@/components/compare/compare-types";

const fields: PydanticField[] = [
  { name: "campoA", type: "text", options: null, description: "Campo A", hash: "hA" },
  { name: "campoB", type: "text", options: null, description: "Campo B", hash: "hB" },
];

const documents = [
  { id: "d1", title: "Doc 1", external_id: null, text: "Texto do documento 1" },
  { id: "d2", title: "Doc 2", external_id: null, text: "Texto do documento 2" },
];

const divergentFields: Record<string, string[]> = {
  d1: ["campoA", "campoB"],
  d2: ["campoA"],
};

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
    pydantic_hash: null,
    answer_field_hashes: null,
    schema_version_major: null,
    schema_version_minor: null,
    schema_version_patch: null,
    created_at: "2026-01-01",
  };
}

const responses: Record<string, CompareResponse[]> = {
  d1: [
    resp("r1", "humano", "Ana", { campoA: "Deferido", campoB: "Sim" }),
    resp("r2", "llm", "GPT", { campoA: "Indeferido", campoB: "Não" }),
  ],
  d2: [resp("r3", "humano", "Ana", { campoA: "Deferido" })],
};

const coverage = (docId: string) => ({
  docId,
  humanCount: 2,
  totalCount: 2,
  assignedCodingCount: 2,
  humansFromAssigned: 2,
  divergentCount: divergentFields[docId].length,
  reviewedCount: 0,
  assignmentStatus: null,
});

function makeProps(existingReviews: ReviewsByDoc = {}) {
  return {
    projectId: "p1",
    documents,
    responses,
    divergentFields,
    fields,
    existingReviews,
    projectPydanticHash: null,
    respondentNames: ["Ana", "Bia"],
    defaultMinHumans: 2,
    defaultVersion: "latest_major",
    coverageByDoc: { d1: coverage("d1"), d2: coverage("d2") },
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
}

const text = (id: string) => screen.getByTestId(id).textContent;
const commentInput = () => screen.getByTestId("comment") as HTMLInputElement;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
const verdict = (verdictName: string, comment: string | null = null) => ({
  verdict: verdictName,
  chosenResponseId: null,
  comment,
});

beforeEach(() => {
  submitVerdict.mockClear();
  markCompareDocReviewed.mockClear();
  confirmEquivalentVerdict.mockClear();
  unmarkEquivalencePair.mockClear();
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(cleanup);

describe("ComparePage — comentário (fix no-derived-state)", () => {
  it("semeia o comentário do veredito existente já na montagem", () => {
    render(
      <ComparePage
        {...makeProps({ d1: { campoA: verdict("X", "nota inicial") } })}
      />,
    );
    expect(text("field-name")).toBe("campoA");
    expect(commentInput().value).toBe("nota inicial");
  });

  it("reseta o comentário ao trocar de campo (descarta rascunho, semeia do novo veredito)", async () => {
    const user = userEvent.setup();
    render(
      <ComparePage
        {...makeProps({ d1: { campoB: verdict("Deferido", "comentário do campo B") } })}
      />,
    );

    expect(text("field-name")).toBe("campoA");
    expect(commentInput().value).toBe("");

    await user.type(commentInput(), "rascunho");
    expect(commentInput().value).toBe("rascunho");

    await user.click(screen.getByTestId("next-field"));

    expect(text("field-name")).toBe("campoB");
    expect(commentInput().value).toBe("comentário do campo B");
  });

  it("preserva o comentário na caixa após emitir veredito sem avançar de campo", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    // Filtra para um único campo → emitir veredito não troca de campo (a fila
    // filtrada tem só campoB), então a caixa deve manter o comentário salvo.
    await user.click(screen.getByTestId("set-filter-b"));
    expect(text("field-name")).toBe("campoB");

    await user.type(commentInput(), "minha nota");
    expect(commentInput().value).toBe("minha nota");

    await user.click(screen.getByTestId("prepare-verdict"));
    expect(submitVerdict).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("confirm-verdict"));

    expect(submitVerdict).toHaveBeenCalledTimes(1);
    expect(text("field-name")).toBe("campoB");
    expect(commentInput().value).toBe("minha nota");
  });
});

describe("ComparePage — navegação e filtro", () => {
  // O campo atual é rastreado por NOME (#613). Consequência direta: um ciclo de
  // filtro devolve a revisora ao campo em que ela estava, em vez de jogá-la no
  // primeiro — o nome fixado continua presente na lista completa. Antes, com
  // índice, `changeFilter` zerava a posição.
  it("ciclo de filtro (todos → campoB → todos) devolve ao campo em que estava", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    await user.click(screen.getByTestId("next-field"));
    expect(text("field-name")).toBe("campoB");

    await user.click(screen.getByTestId("set-filter-all"));
    expect(text("field-name")).toBe("campoB");
  });

  it("filtrar por um campo que não é o atual move para o campo filtrado", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    expect(text("field-name")).toBe("campoA");
    await user.click(screen.getByTestId("set-filter-b"));
    expect(text("field-name")).toBe("campoB");
  });

  it("filtrar por um campo estreita a fila e o avanço fica preso nele", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    await user.click(screen.getByTestId("set-filter-b"));
    expect(text("field-name")).toBe("campoB");

    // Só há campoB na fila filtrada → a tecla 'n' (goNextField) fica presa nele.
    await user.keyboard("n");
    expect(text("field-name")).toBe("campoB");
  });

  it("navegar de documento fixa o doc e cai no primeiro campo divergente dele", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    expect(text("doc-text")).toBe("Texto do documento 1");

    await user.click(screen.getByTestId("nav-next-doc"));

    expect(text("doc-text")).toBe("Texto do documento 2");
    expect(text("field-name")).toBe("campoA");
  });

  it("o campo atual NÃO se desloca quando um campo ANTERIOR sai da fila", async () => {
    // Regressão literal do caso real da #613: a revisora resolveu q4 por
    // equivalência, avançou para q8, e o revalidate seguinte devolveu a lista
    // sem q4 — com índice, ela passou a ver (e a gravar em) q14 sem ter clicado
    // em nada. Com o pin por nome, o campo exibido não muda.
    const user = userEvent.setup();
    const fieldsABC: PydanticField[] = [
      ...fields,
      { name: "campoC", type: "text", options: null, description: "Campo C", hash: "hC" },
    ];
    const base = {
      ...makeProps(),
      fields: fieldsABC,
      divergentFields: { d1: ["campoA", "campoB", "campoC"], d2: ["campoA"] },
    };
    const { rerender } = render(<ComparePage {...base} />);

    await user.keyboard("n");
    expect(text("field-name")).toBe("campoB");

    // campoA (ANTERIOR ao atual) sai da fila; com índice, campoB viraria campoC.
    rerender(
      <ComparePage
        {...base}
        divergentFields={{ d1: ["campoB", "campoC"], d2: ["campoA"] }}
      />,
    );

    expect(text("field-name")).toBe("campoB");
  });

  it("o campo atual sai da fila → volta ao primeiro campo da fila", async () => {
    const user = userEvent.setup();
    const fieldsABC: PydanticField[] = [
      ...fields,
      { name: "campoC", type: "text", options: null, description: "Campo C", hash: "hC" },
    ];
    const base = {
      ...makeProps(),
      fields: fieldsABC,
      divergentFields: { d1: ["campoA", "campoB", "campoC"], d2: ["campoA"] },
    };
    const { rerender } = render(<ComparePage {...base} />);

    // Navega até o último campo (campoC).
    await user.keyboard("n");
    await user.keyboard("n");
    expect(text("field-name")).toBe("campoC");

    // Servidor revalida e o doc passa a ter só 2 campos divergentes; o filtro e
    // o doc não mudaram, e o campo FIXADO deixou de existir.
    rerender(
      <ComparePage
        {...base}
        divergentFields={{ d1: ["campoA", "campoB"], d2: ["campoA"] }}
      />,
    );

    // Cai no primeiro campo DA FILA — mesmo idioma da re-pinagem de documento
    // ("voltando ao topo") — e nunca em `undefined`. Note que "primeiro da fila"
    // não é sinônimo de "pendente": campoA pode já ter veredito nesta sessão e
    // só sair da lista no revalidate seguinte. O aviso ao usuário diz o mesmo.
    expect(text("field-name")).toBe("campoA");
  });
});

describe("ComparePage — atalhos de teclado (fix no-cascading-set-state)", () => {
  it("teclas 'n'/'p' navegam entre campos", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    expect(text("field-name")).toBe("campoA");
    await user.keyboard("n");
    expect(text("field-name")).toBe("campoB");
    await user.keyboard("p");
    expect(text("field-name")).toBe("campoA");
  });

  it("número prepara veredito do grupo correspondente; Enter confirma", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    // campoA: grupos [Deferido(r1), Indeferido(r2)] → '2' escolhe Indeferido.
    await user.keyboard("2");

    expect(submitVerdict).not.toHaveBeenCalled();
    expect(text("pending-verdict")).toBe("Indeferido");

    await user.keyboard("{Enter}");

    expect(submitVerdict).toHaveBeenCalledTimes(1);
    expect(submitVerdict).toHaveBeenCalledWith({
      projectId: "p1",
      documentId: "d1",
      fieldName: "campoA",
      verdict: "Indeferido",
      chosenResponseId: "r2",
      comment: undefined,
      responseSnapshot: expect.any(Array),
    });
  });

  it("teclas 'a' e 's' preparam marcadores especiais; Enter confirma", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    await user.keyboard("a");
    expect(submitVerdict).not.toHaveBeenCalled();
    expect(text("pending-verdict")).toBe("Ambíguo");

    await user.keyboard("s");
    expect(submitVerdict).not.toHaveBeenCalled();
    expect(text("pending-verdict")).toBe("Pular");

    await user.keyboard("{Enter}");
    expect(submitVerdict).toHaveBeenCalledWith({
      projectId: "p1",
      documentId: "d1",
      fieldName: "campoA",
      verdict: "pular",
      chosenResponseId: undefined,
      comment: undefined,
      responseSnapshot: expect.any(Array),
    });
  });

  it("teclas 'a' e 's' em campo multi salvam marcadores especiais diretamente", async () => {
    const user = userEvent.setup();
    render(
      <ComparePage
        {...makeProps()}
        fields={[
          {
            name: "campoA",
            type: "multi",
            options: ["Sim", "Não"],
            description: "Campo A",
            hash: "hA",
          } as PydanticField,
          fields[1],
        ]}
        divergentFields={{ d1: ["campoA"], d2: ["campoA"] }}
      />,
    );

    await user.keyboard("a");
    await user.keyboard("s");

    expect(submitVerdict).toHaveBeenNthCalledWith(1, {
      projectId: "p1",
      documentId: "d1",
      fieldName: "campoA",
      verdict: "ambiguo",
      chosenResponseId: undefined,
      comment: undefined,
      responseSnapshot: expect.any(Array),
    });
    expect(submitVerdict).toHaveBeenNthCalledWith(2, {
      projectId: "p1",
      documentId: "d1",
      fieldName: "campoA",
      verdict: "pular",
      chosenResponseId: undefined,
      comment: undefined,
      responseSnapshot: expect.any(Array),
    });
  });

  it("campo multi trava a segunda tecla especial enquanto o salvamento está em andamento", async () => {
    const save = deferred<void>();
    submitVerdict.mockReturnValueOnce(save.promise);
    const user = userEvent.setup();
    render(
      <ComparePage
        {...makeProps()}
        fields={[
          {
            name: "campoA",
            type: "multi",
            options: ["Sim", "Não"],
            description: "Campo A",
            hash: "hA",
          } as PydanticField,
          fields[1],
        ]}
        divergentFields={{ d1: ["campoA"], d2: ["campoA"] }}
      />,
    );

    // 'a' inicia um save em voo; 's' logo em seguida é ignorado — sem disparar
    // um segundo submitVerdict concorrente para o mesmo campo.
    await user.keyboard("a");
    await user.keyboard("s");

    expect(submitVerdict).toHaveBeenCalledTimes(1);
    expect(submitVerdict).toHaveBeenNthCalledWith(1, {
      projectId: "p1",
      documentId: "d1",
      fieldName: "campoA",
      verdict: "ambiguo",
      chosenResponseId: undefined,
      comment: undefined,
      responseSnapshot: expect.any(Array),
    });

    save.resolve(undefined);
    await waitFor(() => expect(submitVerdict).toHaveBeenCalledTimes(1));
  });

  it("o comentário digitado segue junto no veredito por teclado", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    await user.type(commentInput(), "minha nota");
    // Atalhos ficam desativados com foco no input; sair do campo reabilita.
    commentInput().blur();

    await user.keyboard("1");
    expect(submitVerdict).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");

    expect(submitVerdict).toHaveBeenCalledWith({
      projectId: "p1",
      documentId: "d1",
      fieldName: "campoA",
      verdict: "Deferido",
      chosenResponseId: "r1",
      comment: "minha nota",
      responseSnapshot: expect.any(Array),
    });
  });

  it("documento concluído permite preparar correção por teclado e só salva no Enter", async () => {
    const user = userEvent.setup();
    render(
      <ComparePage
        {...makeProps({
          d1: { campoA: verdict("Deferido"), campoB: verdict("Sim") },
        })}
      />,
    );

    await user.keyboard("2");

    expect(submitVerdict).not.toHaveBeenCalled();
    expect(text("pending-verdict")).toBe("Indeferido");

    await user.keyboard("{Enter}");

    expect(submitVerdict).toHaveBeenCalledWith({
      projectId: "p1",
      documentId: "d1",
      fieldName: "campoA",
      verdict: "Indeferido",
      chosenResponseId: "r2",
      comment: undefined,
      responseSnapshot: expect.any(Array),
    });
  });

  it("Ctrl+Shift+F entra em tela cheia e Esc sai", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    // Não-fullscreen: CompareNav (mock) presente, FullscreenNav ausente.
    expect(screen.queryByTestId("nav-doc-index")).not.toBeNull();
    expect(screen.queryByTestId("fullscreen-nav")).toBeNull();

    await user.keyboard("{Control>}{Shift>}F{/Shift}{/Control}");
    expect(screen.queryByTestId("fullscreen-nav")).not.toBeNull();
    expect(screen.queryByTestId("nav-doc-index")).toBeNull();

    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("fullscreen-nav")).toBeNull();
    expect(screen.queryByTestId("nav-doc-index")).not.toBeNull();
  });
});

describe("ComparePage — vereditos e equivalências (useCompareVerdicts)", () => {
  it("emitir veredito chama submitVerdict e avança para o próximo campo", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    expect(text("field-name")).toBe("campoA");

    await user.click(screen.getByTestId("prepare-verdict"));
    expect(submitVerdict).not.toHaveBeenCalled();
    expect(text("pending-verdict")).toBe("Deferido");

    await user.click(screen.getByTestId("confirm-verdict"));

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
    // O avanço automático pós-confirmação usa goNextField cru (não passa pelo
    // gate de navegação do #430) — avança sem disparar o aviso de bloqueio.
    await waitFor(() => expect(text("field-name")).toBe("campoB"));
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("falha de salvamento mantém o pendente e não avança o campo", async () => {
    submitVerdict.mockResolvedValueOnce({ error: "falha ao salvar" });
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    await user.click(screen.getByTestId("prepare-verdict"));
    expect(text("pending-verdict")).toBe("Deferido");

    await user.click(screen.getByTestId("confirm-verdict"));

    expect(submitVerdict).toHaveBeenCalledTimes(1);
    expect(text("field-name")).toBe("campoA");
    expect(text("pending-verdict")).toBe("Deferido");
  });

  // Antes do #430, trocar de campo descartava o rascunho EM SILÊNCIO (guard de
  // contexto) — foi a perda de sessão do incidente de 10/07. Agora a navegação
  // manual com rascunho pendente é bloqueada com aviso.
  it("com rascunho pendente, navegação manual (campo, doc, teclado) é bloqueada com aviso", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    await user.click(screen.getByTestId("prepare-verdict"));
    expect(text("pending-verdict")).toBe("Deferido");

    await user.click(screen.getByTestId("next-field"));
    await user.click(screen.getByTestId("nav-next-doc"));
    await user.keyboard("n");
    await user.keyboard("p");

    // Nada navegou; o rascunho sobreviveu; cada tentativa avisou.
    expect(text("field-name")).toBe("campoA");
    expect(text("doc-text")).toBe("Texto do documento 1");
    expect(text("pending-verdict")).toBe("Deferido");
    expect(toast.warning).toHaveBeenCalledTimes(4);
    expect(submitVerdict).not.toHaveBeenCalled();
  });

  // Vetores achados na revisão adversarial: filtro de campo e aba de fila
  // também mudam o contexto e cairiam no guard de render que descarta o
  // rascunho — precisam do mesmo bloqueio dos wrappers de navegação.
  it("com rascunho pendente, trocar o filtro de campo é bloqueado com aviso", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    await user.click(screen.getByTestId("prepare-verdict"));
    await user.click(screen.getByTestId("set-filter-b"));

    expect(text("field-name")).toBe("campoA");
    expect(text("pending-verdict")).toBe("Deferido");
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it("com rascunho pendente, trocar a aba de fila é bloqueado com aviso", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} isCoordinator />);

    await user.click(screen.getByTestId("prepare-verdict"));
    await user.click(screen.getByRole("tab", { name: "Todos" }));

    expect(text("pending-verdict")).toBe("Deferido");
    // Radix Tabs pode disparar onValueChange mais de uma vez (ativação por
    // foco + clique) quando o valor não muda — o que importa é o aviso.
    expect(toast.warning).toHaveBeenCalledWith(
      "Seleção não confirmada — confirme ou descarte antes de avançar.",
      { id: "compare-nav-guard" },
    );
  });

  it("'Descartar' limpa o rascunho sem salvar e libera a navegação", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    await user.click(screen.getByTestId("prepare-verdict"));
    expect(text("pending-verdict")).toBe("Deferido");

    await user.click(screen.getByTestId("discard-verdict"));
    expect(text("pending-verdict")).toBe("");

    await user.click(screen.getByTestId("next-field"));
    expect(text("field-name")).toBe("campoB");
    expect(toast.warning).not.toHaveBeenCalled();

    // Sem rascunho, confirmar é no-op: o veredito descartado não vaza para o
    // novo contexto.
    await user.click(screen.getByTestId("confirm-verdict"));
    expect(submitVerdict).not.toHaveBeenCalled();
  });

  // fireEvent (não userEvent) porque os delays internos do userEvent penduram
  // sob vi.useFakeTimers mesmo com a opção advanceTimers.
  it("salvamento pendurado: a trava se auto-liberta no timeout com erro visível e o rascunho é mantido", async () => {
    vi.useFakeTimers();
    try {
      // Promise que NUNCA resolve (fetch dropado num redeploy): sem o timeout,
      // o finally nunca rodaria e todo clique seguinte seria ignorado.
      submitVerdict.mockReturnValueOnce(new Promise(() => {}));
      render(<ComparePage {...makeProps()} />);

      fireEvent.click(screen.getByTestId("prepare-verdict"));
      fireEvent.click(screen.getByTestId("confirm-verdict"));
      expect(screen.getByTestId("confirm-verdict")).toHaveProperty(
        "disabled",
        true,
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS);
      });

      expect(toast.error).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("confirm-verdict")).toHaveProperty(
        "disabled",
        false,
      );
      // Rascunho mantido: a usuária reconfirma sem re-selecionar.
      expect(text("pending-verdict")).toBe("Deferido");

      // A trava solta volta a aceitar interação (re-preparar funciona).
      fireEvent.click(screen.getByTestId("prepare-verdict-2"));
      expect(text("pending-verdict")).toBe("Indeferido");
    } finally {
      vi.useRealTimers();
    }
  });

  it("bloqueia confirmação dupla e navegação enquanto o salvamento está em andamento", async () => {
    const save = deferred<void>();
    submitVerdict.mockReturnValueOnce(save.promise);
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    await user.click(screen.getByTestId("prepare-verdict"));
    await user.click(screen.getByTestId("confirm-verdict"));

    expect(submitVerdict).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("confirm-verdict")).toHaveProperty("disabled", true);

    await user.click(screen.getByTestId("confirm-verdict"));
    await user.click(screen.getByTestId("next-field"));
    await user.click(screen.getByTestId("nav-next-doc"));
    await user.keyboard("n");

    // Re-preparar durante o save é ignorado: o rascunho em voo (Deferido)
    // continua, sem ser trocado por Indeferido e depois descartado em silêncio.
    await user.click(screen.getByTestId("prepare-verdict-2"));
    expect(text("pending-verdict")).toBe("Deferido");

    expect(submitVerdict).toHaveBeenCalledTimes(1);
    expect(text("field-name")).toBe("campoA");
    expect(text("doc-text")).toBe("Texto do documento 1");

    save.resolve(undefined);
    await waitFor(() => expect(text("field-name")).toBe("campoB"));
  });

  it("confirmar equivalência chama confirmEquivalentVerdict e avança o campo", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    await user.click(screen.getByTestId("confirm-equiv"));

    expect(confirmEquivalentVerdict).toHaveBeenCalledTimes(1);
    expect(confirmEquivalentVerdict).toHaveBeenCalledWith({
      projectId: "p1",
      documentId: "d1",
      fieldName: "campoA",
      responseIds: ["r1", "r2"],
      gabaritoId: "r1",
      verdictDisplay: "Equivalentes",
      comment: undefined,
      responseSnapshot: expect.any(Array),
    });
    await waitFor(() => expect(text("field-name")).toBe("campoB"));
  });

  it("marcar revisado chama markCompareDocReviewed do doc atual", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    await user.click(screen.getByTestId("mark-reviewed"));

    expect(markCompareDocReviewed).toHaveBeenCalledWith("p1", "d1");
  });
});

// Antes deste PR, nenhum teste deste arquivo exercitava isCoordinator: true —
// a bar do toggle e a diferenciação da mensagem de estado vazio ficavam sem
// cobertura direta.
describe("ComparePage — rascunho vindo de outro campo (#613)", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleError.mockRestore();
  });

  it("não vira rascunho, não grava e avisa o que fazer", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    await user.click(screen.getByTestId("prepare-verdict-campo-fantasma"));

    // O rascunho nem chega a existir: sem ele, não há o que confirmar, e o
    // valor do campo antigo não tem por onde alcançar o campo atual.
    expect(text("pending-verdict")).toBe("");
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("pertence a outro campo"),
      expect.objectContaining({ id: "compare-origin-mismatch" }),
    );

    await user.click(screen.getByTestId("confirm-verdict"));
    expect(submitVerdict).not.toHaveBeenCalled();
  });

  it("um rascunho legítimo continua sendo aceito depois da recusa", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    await user.click(screen.getByTestId("prepare-verdict-campo-fantasma"));
    await user.click(screen.getByTestId("prepare-verdict"));

    expect(text("pending-verdict")).toBe("Deferido");
  });
});

describe("ComparePage — toggle de fila (só coordenador)", () => {
  function emptyProps(overrides: Partial<ReturnType<typeof makeProps>> = {}) {
    return {
      ...makeProps(),
      documents: [],
      divergentFields: {},
      responses: {},
      coverageByDoc: {},
      ...overrides,
    };
  }

  it("não-coordenador nunca vê o toggle de fila", () => {
    render(<ComparePage {...emptyProps({ isCoordinator: false })} />);
    expect(screen.queryByRole("tab", { name: "Meus atribuídos" })).toBeNull();
  });

  it("coordenador vê o toggle de fila", () => {
    render(<ComparePage {...emptyProps({ isCoordinator: true })} />);
    expect(screen.getByRole("tab", { name: "Meus atribuídos" })).not.toBeNull();
    expect(screen.getByRole("tab", { name: "Todos" })).not.toBeNull();
  });

  it("sem nenhum documento atribuído: mensagem sugere a aba 'Todos'", () => {
    render(
      <ComparePage
        {...emptyProps({
          isCoordinator: true,
          queueContext: {
            showingAll: false,
            hasAssignedDocs: false,
            isImpersonating: false,
          },
        })}
      />,
    );
    expect(
      screen.getByText(/Você não tem documentos atribuídos.*aba "Todos"/),
    ).not.toBeNull();
  });

  it("com documentos atribuídos filtrados por cobertura: mensagem não sugere trocar de aba", () => {
    render(
      <ComparePage
        {...emptyProps({
          isCoordinator: true,
          queueContext: {
            showingAll: false,
            hasAssignedDocs: true,
            isImpersonating: false,
          },
        })}
      />,
    );
    expect(
      screen.getByText(/não atendem aos filtros atuais/),
    ).not.toBeNull();
    expect(
      screen.queryByText(/Você não tem documentos atribuídos/),
    ).toBeNull();
  });

  it("impersonando sem documentos atribuídos: copy em 3ª pessoa (fila é do membro)", () => {
    render(
      <ComparePage
        {...emptyProps({
          isCoordinator: true,
          queueContext: {
            showingAll: false,
            hasAssignedDocs: false,
            isImpersonating: true,
          },
        })}
      />,
    );
    expect(
      screen.getByText(/Este membro não tem documentos atribuídos.*aba "Todos"/),
    ).not.toBeNull();
    expect(
      screen.queryByText(/Você não tem documentos atribuídos/),
    ).toBeNull();
  });

  it("impersonando com atribuídos filtrados por cobertura: copy em 3ª pessoa", () => {
    render(
      <ComparePage
        {...emptyProps({
          isCoordinator: true,
          queueContext: {
            showingAll: false,
            hasAssignedDocs: true,
            isImpersonating: true,
          },
        })}
      />,
    );
    expect(
      screen.getByText(/atribuídos a este membro não atendem aos filtros atuais/),
    ).not.toBeNull();
    expect(screen.queryByText(/Seus documentos atribuídos/)).toBeNull();
  });

  it("na aba 'Todos', a mensagem genérica não menciona assignment", () => {
    render(
      <ComparePage
        {...emptyProps({
          isCoordinator: true,
          queueContext: {
            showingAll: true,
            hasAssignedDocs: false,
            isImpersonating: false,
          },
        })}
      />,
    );
    expect(
      screen.getByText("Nenhum documento na fila com os filtros atuais."),
    ).not.toBeNull();
  });
});

// A preferência de layout atravessa sessões (#610). O par de casos é o que
// tira a vacuidade: um prova que o valor gravado é LIDO no mount, o outro que
// o toggle o ESCREVE. Testar só um dos lados passaria com metade da ligação.
describe("ComparePage — lista lateral recolhida persiste entre sessões (#610)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("monta recolhida quando a sessão anterior deixou assim", () => {
    window.localStorage.setItem("compare:listCollapsed", "1");
    render(<ComparePage {...makeProps()} />);
    expect(text("list-collapsed")).toBe("true");
  });

  it("monta expandida sem preferência gravada", () => {
    render(<ComparePage {...makeProps()} />);
    expect(text("list-collapsed")).toBe("false");
  });

  it("alternar grava a preferência", async () => {
    const user = userEvent.setup();
    render(<ComparePage {...makeProps()} />);

    await user.click(screen.getByTestId("toggle-list"));
    expect(text("list-collapsed")).toBe("true");
    expect(window.localStorage.getItem("compare:listCollapsed")).toBe("1");

    await user.click(screen.getByTestId("toggle-list"));
    expect(text("list-collapsed")).toBe("false");
    expect(window.localStorage.getItem("compare:listCollapsed")).toBe("0");
  });
});
