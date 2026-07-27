// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { PydanticField, Document } from "@/lib/types";

// Spies/estado controláveis. `urlParams` é o backing store do useUrlState mockado
// (stateful: `set` muta e força re-render, como o router faria); `autosaveProps`
// captura o que o container passa ao useAutosaveOnExit, para checar o payload.
const {
  saveResponse,
  getDocumentsForBrowse,
  getDocumentForCoding,
  autosaveProps,
  urlParams,
} = vi.hoisted(() => ({
  saveResponse: vi.fn(),
  getDocumentsForBrowse: vi.fn(),
  getDocumentForCoding: vi.fn(),
  autosaveProps: { current: null as unknown as {
    activeDocId: string | null;
    getIsDirty: () => boolean;
    getPayload: () => unknown;
  } },
  urlParams: { current: {} as Record<string, string | null> },
}));

vi.mock("@/actions/responses", () => ({ saveResponse }));
vi.mock("@/actions/documents", () => ({ getDocumentsForBrowse, getDocumentForCoding }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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
vi.mock("@/hooks/useAutosaveOnExit", () => ({
  useAutosaveOnExit: (props: typeof autosaveProps.current) => {
    autosaveProps.current = props;
  },
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
    onSubmit: () => void;
  }) => (
    <div>
      <div data-testid="qp-answers">{JSON.stringify(answers)}</div>
      <div data-testid="qp-notes">{notes}</div>
      <button onClick={() => onAnswer("q1", "sim")}>qp-set</button>
      <button onClick={() => onNotesChange?.("nota")}>qp-notes</button>
      <button onClick={onSubmit}>qp-enviar</button>
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

function assignedDoc(id: string): Document {
  return {
    id,
    project_id: "p1",
    external_id: `ext-${id}`,
    title: `Assigned ${id}`,
    text: `texto-${id}`,
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
  Element.prototype.scrollTo = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CodingPage — modo Explorar (integração)", () => {
  it("C1: após Enviar, reabrir o mesmo doc reflete as respostas salvas (sem seed stale)", async () => {
    getDocumentsForBrowse.mockResolvedValue([browseDoc("d1")]);
    // 1ª carga: vazia; 2ª carga (após o save + invalidate): com a resposta salva.
    getDocumentForCoding
      .mockResolvedValueOnce(codingResult("d1", null))
      .mockResolvedValueOnce(codingResult("d1", { q1: "sim" }));
    saveResponse.mockResolvedValue({ success: true });

    render(
      <CodingPage userId="user-teste" projectId="p1" documents={[]} fields={FIELDS} existingAnswers={{}} />,
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
    saveResponse.mockResolvedValue({ success: true });

    render(
      <CodingPage userId="user-teste" projectId="p1" documents={[]} fields={FIELDS} existingAnswers={{}} />,
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
      <CodingPage userId="user-teste" projectId="p1" documents={[]} fields={FIELDS} existingAnswers={{}} />,
    );

    await userEvent.click(await screen.findByText("pick-d1"));
    await waitFor(() =>
      expect(screen.getByTestId("qp-answers").textContent).toBe("{}"),
    );
    await userEvent.click(screen.getByText("qp-set")); // edita d1 → rascunho sujo

    expect(autosaveProps.current.activeDocId).toBe("d1");
    expect(autosaveProps.current.getIsDirty()).toBe(true);
    expect(autosaveProps.current.getPayload()).toEqual({
      projectId: "p1",
      documentId: "d1",
      answers: { q1: "sim" },
      notes: "",
    });

    // Random troca para d2 (único não respondido != atual) e reseta o rascunho.
    await userEvent.click(screen.getByText("hdr-random"));
    await waitFor(() =>
      expect(screen.getByTestId("doc-reader").textContent).toBe("texto-d2"),
    );

    // O payload de autosave agora é de d2 e NÃO carrega o rascunho de d1.
    expect(autosaveProps.current.activeDocId).toBe("d2");
    expect(autosaveProps.current.getPayload()).toBeNull();
  });

  it("I3: ?doc= de um documento atribuído abre no modo Atribuídos (não busca via browse)", async () => {
    urlParams.current = { doc: "a1" };
    getDocumentsForBrowse.mockResolvedValue([]);

    render(
      <CodingPage
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
      <CodingPage userId="user-teste" projectId="p1" documents={[]} fields={FIELDS} existingAnswers={{}} />,
    );

    await userEvent.click(await screen.findByText("pick-d1"));
    await waitFor(() =>
      expect(screen.getByTestId("qp-answers").textContent).toBe("{}"),
    );
    await userEvent.click(screen.getByText("qp-set")); // edita d1 → rascunho sujo

    // Antes do toggle: rascunho presente e doc sujo.
    expect(autosaveProps.current.getIsDirty()).toBe(true);
    expect(autosaveProps.current.getPayload()).toEqual({
      projectId: "p1",
      documentId: "d1",
      answers: { q1: "sim" },
      notes: "",
    });

    // Sai do Explorar e volta (filho keyed desmonta e re-semeia do cache).
    await userEvent.click(screen.getByText("to-assigned"));
    await userEvent.click(screen.getByText("to-browse"));

    // UI revertida ao último salvo (seed pré-edição)...
    await waitFor(() =>
      expect(screen.getByTestId("qp-answers").textContent).toBe("{}"),
    );
    // ...e o estado salvável concorda: nada de ghost-save no exit/Voltar.
    expect(autosaveProps.current.activeDocId).toBe("d1");
    expect(autosaveProps.current.getIsDirty()).toBe(false);
    expect(autosaveProps.current.getPayload()).toBeNull();
    // O doc não foi re-buscado no retorno (cache não invalidado).
    expect(getDocumentForCoding).toHaveBeenCalledTimes(1);
  });

  it("nº5: trocar de doc limpa o dirty do anterior (sem vazamento)", async () => {
    getDocumentsForBrowse.mockResolvedValue([browseDoc("d1"), browseDoc("d2")]);
    getDocumentForCoding.mockImplementation(async (_p: string, id: string) =>
      codingResult(id, null),
    );

    render(
      <CodingPage userId="user-teste" projectId="p1" documents={[]} fields={FIELDS} existingAnswers={{}} />,
    );

    await userEvent.click(await screen.findByText("pick-d1"));
    await waitFor(() =>
      expect(screen.getByTestId("qp-answers").textContent).toBe("{}"),
    );
    await userEvent.click(screen.getByText("qp-set")); // edita d1 → sujo
    expect(autosaveProps.current.getIsDirty()).toBe(true);

    // Random: d1 → d2 (markClean d1). Depois d2 → d1 (volta ao d1).
    await userEvent.click(screen.getByText("hdr-random"));
    await waitFor(() =>
      expect(screen.getByTestId("doc-reader").textContent).toBe("texto-d2"),
    );
    await userEvent.click(screen.getByText("hdr-random"));
    await waitFor(() =>
      expect(screen.getByTestId("doc-reader").textContent).toBe("texto-d1"),
    );

    // De volta a d1: não está mais sujo (sem prompt espúrio) e sem rascunho.
    expect(autosaveProps.current.activeDocId).toBe("d1");
    expect(autosaveProps.current.getIsDirty()).toBe(false);
    expect(autosaveProps.current.getPayload()).toBeNull();
  });
});
