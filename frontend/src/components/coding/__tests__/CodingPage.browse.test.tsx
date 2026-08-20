// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { PydanticField, AssignedDoc } from "@/lib/types";

// Spies/estado controláveis. `urlParams` é o backing store do useUrlState mockado
// (stateful: `set` muta e força re-render, como o router faria).
//
// Até o #608 havia aqui uma sonda que capturava as props passadas ao
// `useAutosaveOnExit` e servia de proxy para "o que seria salvo ao sair". Com o
// autosave removido não há mais o que salvar ao sair, e as asserções passaram a
// observar o que a pesquisadora de fato vê: o formulário, o indicador de
// alterações não enviadas e a ausência de chamadas a `saveResponse`.
const {
  saveResponse,
  getDocumentsForBrowse,
  getDocumentForCoding,
  urlParams,
  submitVerdict,
} = vi.hoisted(() => ({
  saveResponse: vi.fn(),
  getDocumentsForBrowse: vi.fn(),
  getDocumentForCoding: vi.fn(),
  urlParams: { current: {} as Record<string, string | null> },
  // O que o painel recebeu de volta no último Enviar. No modo Explorar a cadeia
  // tem um elo a mais que no Atribuídos — `BrowseDocCoder` fica entre o
  // container e o painel —, e é ele que precisa DEVOLVER o veredito para a tela
  // rolar até a obrigatória em aberto (#608).
  submitVerdict: { current: undefined as unknown },
}));

vi.mock("@/actions/responses", () => ({ saveResponse }));
vi.mock("@/actions/documents", () => ({
  getDocumentsForBrowse,
  getDocumentForCoding,
  // O texto do doc aberto vem por aqui, não mais na fila de assignments.
  // Devolve o mesmo `texto-${id}` que os fixtures traziam, para as asserções
  // continuarem valendo — agora sobre o caminho de fetch sob demanda.
  getDocumentText: vi.fn((_projectId: string, id: string) =>
    Promise.resolve({ text: `texto-${id}`, title: `Doc ${id}` }),
  ),
}));
// `warning` incluído: é por ele que `notifySaved` avisa a pendência. Mock
// incompleto não falha no typecheck e só aparece como rejeição não tratada.
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/hooks/useUrlState", async () => {
  const React = await import("react");
  return {
    useUrlState: () => {
      const [, force] = React.useState(0);
      return {
        get: (k: string) => urlParams.current[k] ?? null,
        set: (updates: Record<string, string | null>) => {
          urlParams.current = { ...urlParams.current, ...updates };
          force((n) => n + 1);
        },
      };
    },
  };
});
vi.mock("@/hooks/useFieldOrder", () => ({
  useFieldOrder: () => ({ fieldOrder: [], handleReorder: vi.fn() }),
}));
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div />,
}));
vi.mock("@/components/coding/DocumentReader", () => ({
  DocumentReader: ({ text }: { text: string }) => (
    <div data-testid="doc-reader">{text}</div>
  ),
}));
vi.mock("@/components/coding/QuestionsPanel", () => ({
  QuestionsPanel: ({
    answers,
    notes,
    onAnswer,
    onNotesChange,
    onSubmit,
  }: {
    answers: Record<string, unknown>;
    notes?: string;
    onAnswer: (f: string, v: unknown) => void;
    onNotesChange?: (n: string) => void;
    // `unknown`, não `void`: o painel real usa o retorno, e um mock que o
    // declarasse `void` deixaria a cadeia livre para descartá-lo.
    onSubmit: () => unknown;
  }) => (
    <div>
      <div data-testid="qp-answers">{JSON.stringify(answers)}</div>
      <div data-testid="qp-notes">{notes}</div>
      <button onClick={() => onAnswer("q1", "sim")}>qp-set</button>
      <button onClick={() => onNotesChange?.("nota")}>qp-notes</button>
      <button
        onClick={() => {
          submitVerdict.current = onSubmit();
        }}
      >
        qp-enviar
      </button>
    </div>
  ),
}));
vi.mock("@/components/coding/DocumentPicker", () => ({
  DocumentPicker: ({
    documents,
    onSelect,
  }: {
    documents: { id: string; responseCount: number }[];
    onSelect: (id: string) => void;
  }) => (
    <div data-testid="picker">
      {documents.map((d) => (
        <div key={d.id}>
          <button onClick={() => onSelect(d.id)}>pick-{d.id}</button>
          <span data-testid={`count-${d.id}`}>{d.responseCount}</span>
        </div>
      ))}
    </div>
  ),
}));
vi.mock("@/components/coding/CodingHeader", () => ({
  CodingHeader: ({
    mode,
    onModeChange,
    doc,
  }: {
    mode: string;
    onModeChange: (m: "assigned" | "browse") => void;
    doc?: { variant: string; onBack?: () => void; onRandom?: () => void };
  }) => (
    <div data-testid="header">
      <div data-testid="hdr-mode">{mode}</div>
      <div data-testid="hdr-variant">{doc?.variant ?? "none"}</div>
      <button onClick={() => onModeChange("assigned")}>to-assigned</button>
      <button onClick={() => onModeChange("browse")}>to-browse</button>
      {doc?.variant === "browse" && (
        <>
          <button onClick={doc.onBack}>hdr-back</button>
          <button onClick={doc.onRandom}>hdr-random</button>
        </>
      )}
    </div>
  ),
}));
vi.mock("@/components/coding/FullscreenNav", () => ({
  FullscreenNav: () => <div data-testid="fsnav" />,
}));

import { CodingPage } from "@/components/coding/CodingPage";

const ROUND_FILTER = {
  currentRoundKey: "round-1",
  currentRoundLabel: "Rodada inicial",
  rounds: [],
  selected: "round-1",
};

const FIELDS: PydanticField[] = [
  { name: "q1", type: "text", options: null, description: "" },
];

function browseDoc(id: string, responseCount = 0, userAlreadyResponded = false) {
  return {
    id,
    external_id: `ext-${id}`,
    title: `Doc ${id}`,
    created_at: "2026-01-01",
    responseCount,
    userAlreadyResponded,
  };
}

function codingResult(id: string, answers: Record<string, unknown> | null) {
  return {
    document: { id, external_id: `ext-${id}`, title: `Doc ${id}`, text: `texto-${id}`, exclusionPending: null },
    existingAnswers: answers,
    existingJustifications: null,
  };
}

function assignedDoc(id: string): AssignedDoc {
  return {
    id,
    project_id: "p1",
    external_id: `ext-${id}`,
    title: `Assigned ${id}`,
    metadata: null,
    created_at: "2026-01-01",
    excluded_at: null,
    excluded_reason: null,
    excluded_by: null,
    exclusion_pending_at: null,
  };
}

beforeEach(() => {
  urlParams.current = {};
  submitVerdict.current = undefined;
  Element.prototype.scrollTo = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// A cadeia do critério 5 no modo Explorar. Ela tem um elo a mais que a do modo
// Atribuídos — `CodingPage → BrowseCodingView → BrowseDocCoder → QuestionsPanel`
// —, e cada elo precisa DEVOLVER o veredito. Um `{ onSubmit(...) }` em vez de
// `() => onSubmit(...)` em qualquer um deles anula a feature sem que typecheck
// ou lint reclamem, porque o tipo do handler admite `void`.
describe("CodingPage/Explorar — o veredito do servidor atravessa o BrowseDocCoder (#608)", () => {
  it("obrigatória em aberto: o painel recebe os NOMES, não `undefined`", async () => {
    getDocumentsForBrowse.mockResolvedValue([browseDoc("d1")]);
    getDocumentForCoding.mockResolvedValue(codingResult("d1", null));
    saveResponse.mockResolvedValue({
      success: true,
      missingRequiredFields: ["q2"],
    });

    render(
      <CodingPage roundFilter={ROUND_FILTER} userId="user-teste" projectId="p1" documents={[]} fields={FIELDS} existingAnswers={{}} />,
    );

    await userEvent.click(await screen.findByText("pick-d1"));
    await userEvent.click(await screen.findByText("qp-set"));
    await userEvent.click(screen.getByText("qp-enviar"));

    await waitFor(() => expect(saveResponse).toHaveBeenCalled());
    await expect(submitVerdict.current).resolves.toEqual(["q2"]);
  });

  it("codificação completa resolve sem nomes", async () => {
    getDocumentsForBrowse.mockResolvedValue([browseDoc("d1")]);
    getDocumentForCoding.mockResolvedValue(codingResult("d1", null));
    saveResponse.mockResolvedValue({ success: true, missingRequiredFields: [] });

    render(
      <CodingPage roundFilter={ROUND_FILTER} userId="user-teste" projectId="p1" documents={[]} fields={FIELDS} existingAnswers={{}} />,
    );

    await userEvent.click(await screen.findByText("pick-d1"));
    await userEvent.click(await screen.findByText("qp-set"));
    await userEvent.click(screen.getByText("qp-enviar"));

    await waitFor(() => expect(saveResponse).toHaveBeenCalled());
    await expect(submitVerdict.current).resolves.toBeUndefined();
  });
});

describe("CodingPage — modo Explorar (integração)", () => {
  it("C1: após Enviar, reabrir o mesmo doc reflete as respostas salvas (sem seed stale)", async () => {
    getDocumentsForBrowse.mockResolvedValue([browseDoc("d1")]);
    // 1ª carga: vazia; 2ª carga (após o save + invalidate): com a resposta salva.
    getDocumentForCoding
      .mockResolvedValueOnce(codingResult("d1", null))
      .mockResolvedValueOnce(codingResult("d1", { q1: "sim" }));
    saveResponse.mockResolvedValue({ success: true, missingRequiredFields: [] });

    render(
      <CodingPage roundFilter={ROUND_FILTER} userId="user-teste" projectId="p1" documents={[]} fields={FIELDS} existingAnswers={{}} />,
    );

    await userEvent.click(await screen.findByText("pick-d1"));
    await waitFor(() =>
      expect(screen.getByTestId("qp-answers").textContent).toBe("{}"),
    );

    await userEvent.click(screen.getByText("qp-set")); // edita q1=sim
    await userEvent.click(screen.getByText("qp-enviar")); // envia → save + invalidate

    // Volta ao picker e reabre o mesmo doc.
    await userEvent.click(await screen.findByText("pick-d1"));

    // Sem o fix, mostraria "{}" (stale) e getDocumentForCoding teria 1 chamada.
    await waitFor(() =>
      expect(screen.getByTestId("qp-answers").textContent).toBe('{"q1":"sim"}'),
    );
    expect(getDocumentForCoding).toHaveBeenCalledTimes(2);
  });

  it("I3: Enviar marca o doc como respondido e incrementa o contador na lista", async () => {
    getDocumentsForBrowse.mockResolvedValue([browseDoc("d1", 0)]);
    getDocumentForCoding.mockResolvedValue(codingResult("d1", null));
    saveResponse.mockResolvedValue({ success: true, missingRequiredFields: [] });

    render(
      <CodingPage roundFilter={ROUND_FILTER} userId="user-teste" projectId="p1" documents={[]} fields={FIELDS} existingAnswers={{}} />,
    );

    expect((await screen.findByTestId("count-d1")).textContent).toBe("0");
    await userEvent.click(screen.getByText("pick-d1"));
    await waitFor(() =>
      expect(screen.getByTestId("qp-answers").textContent).toBe("{}"),
    );
    await userEvent.click(screen.getByText("qp-set"));
    await userEvent.click(screen.getByText("qp-enviar"));

    // De volta ao picker: contador subiu para 1 (markResponded "submit").
    await waitFor(() =>
      expect(screen.getByTestId("count-d1").textContent).toBe("1"),
    );
  });

  it("I3: autosave-on-exit usa o doc atual; trocar de doc reseta o rascunho (não vaza p/ outro doc)", async () => {
    getDocumentsForBrowse.mockResolvedValue([browseDoc("d1"), browseDoc("d2")]);
    getDocumentForCoding.mockImplementation(async (_p: string, id: string) =>
      codingResult(id, null),
    );

    render(
      <CodingPage roundFilter={ROUND_FILTER} userId="user-teste" projectId="p1" documents={[]} fields={FIELDS} existingAnswers={{}} />,
    );

    await userEvent.click(await screen.findByText("pick-d1"));
    await waitFor(() =>
      expect(screen.getByTestId("qp-answers").textContent).toBe("{}"),
    );
    await userEvent.click(screen.getByText("qp-set")); // edita d1 → rascunho sujo

    // A edição acende o indicador de não enviado.
    expect(screen.getByText("Alterações não enviadas")).toBeTruthy();

    // Random troca para d2 (único não respondido != atual).
    await userEvent.click(screen.getByText("hdr-random"));
    await waitFor(() =>
      expect(screen.getByTestId("doc-reader").textContent).toBe("texto-d2"),
    );

    // O formulário de d2 abre vazio: o rascunho de d1 não vaza para outro doc.
    expect(screen.getByTestId("qp-answers").textContent).toBe("{}");
    // E nada disso passou pelo servidor — trocar de doc não grava.
    expect(saveResponse).not.toHaveBeenCalled();
  });

  it("I3: ?doc= de um documento atribuído abre no modo Atribuídos (não busca via browse)", async () => {
    urlParams.current = { doc: "a1" };
    getDocumentsForBrowse.mockResolvedValue([]);

    render(
      <CodingPage
        roundFilter={ROUND_FILTER}
        userId="user-teste"
        projectId="p1"
        documents={[assignedDoc("a1")]}
        fields={FIELDS}
        existingAnswers={{}}
        hasAssignments
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("hdr-mode").textContent).toBe("assigned"),
    );
    // O doc atribuído não passa pelo fetch de codificação do modo Explorar.
    expect(getDocumentForCoding).not.toHaveBeenCalled();
  });

  it("nº1: toggle de modo descarta o rascunho não salvo (sem ghost-save no exit)", async () => {
    getDocumentsForBrowse.mockResolvedValue([browseDoc("d1")]);
    getDocumentForCoding.mockResolvedValue(codingResult("d1", null));

    render(
      <CodingPage roundFilter={ROUND_FILTER} userId="user-teste" projectId="p1" documents={[]} fields={FIELDS} existingAnswers={{}} />,
    );

    await userEvent.click(await screen.findByText("pick-d1"));
    await waitFor(() =>
      expect(screen.getByTestId("qp-answers").textContent).toBe("{}"),
    );
    await userEvent.click(screen.getByText("qp-set")); // edita d1 → rascunho sujo

    // Antes do toggle: o indicador de não enviado está aceso.
    expect(screen.getByText("Alterações não enviadas")).toBeTruthy();

    // Sai do Explorar e volta (filho keyed desmonta e re-semeia do cache).
    await userEvent.click(screen.getByText("to-assigned"));
    await userEvent.click(screen.getByText("to-browse"));

    // UI revertida ao último salvo (seed pré-edição)...
    await waitFor(() =>
      expect(screen.getByTestId("qp-answers").textContent).toBe("{}"),
    );
    // ...sem que nada tenha ido ao servidor. Este teste nasceu para provar a
    // ausência de "ghost save" — uma gravação disparada pelo autosave sobre uma
    // edição que a tela já tinha descartado. Sem autosave, a ausência é
    // estrutural, e a asserção fica como guarda de que ela continua assim.
    expect(saveResponse).not.toHaveBeenCalled();
    // O doc não foi re-buscado no retorno (cache não invalidado).
    expect(getDocumentForCoding).toHaveBeenCalledTimes(1);
  });

  // Semântica invertida no #608. Era "trocar de doc limpa o dirty do anterior":
  // fazia sentido enquanto trocar de doc realmente descartava a edição, porque
  // então não havia mais nada pendente. Agora o rascunho local a preserva, e
  // apagar o sinal afirmaria "enviado" sobre trabalho que segue pendente.
  it("nº5: voltar ao doc editado mantém o sinal de não enviado", async () => {
    getDocumentsForBrowse.mockResolvedValue([browseDoc("d1"), browseDoc("d2")]);
    getDocumentForCoding.mockImplementation(async (_p: string, id: string) =>
      codingResult(id, null),
    );

    render(
      <CodingPage roundFilter={ROUND_FILTER} userId="user-teste" projectId="p1" documents={[]} fields={FIELDS} existingAnswers={{}} />,
    );

    await userEvent.click(await screen.findByText("pick-d1"));
    await waitFor(() =>
      expect(screen.getByTestId("qp-answers").textContent).toBe("{}"),
    );
    await userEvent.click(screen.getByText("qp-set")); // edita d1 → sujo
    expect(screen.getByText("Alterações não enviadas")).toBeTruthy();

    // Random: d1 → d2. Depois d2 → d1 (volta ao d1).
    await userEvent.click(screen.getByText("hdr-random"));
    await waitFor(() =>
      expect(screen.getByTestId("doc-reader").textContent).toBe("texto-d2"),
    );
    await userEvent.click(screen.getByText("hdr-random"));
    await waitFor(() =>
      expect(screen.getByTestId("doc-reader").textContent).toBe("texto-d1"),
    );

    // De volta a d1: o formulário re-semeia do cache (o rascunho não é aplicado
    // sozinho — quem aplica é a faixa, por ação explícita), mas o indicador
    // continua aceso, porque a edição de d1 nunca foi enviada.
    expect(screen.getByText("Alterações não enviadas")).toBeTruthy();
    expect(saveResponse).not.toHaveBeenCalled();
  });
});
