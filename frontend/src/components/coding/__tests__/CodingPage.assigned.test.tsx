// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { PydanticField, Document } from "@/lib/types";

// Caracterização do modo Atribuídos ANTES do refactor da issue #389 (extração
// da cascata allDone/no-doc/view de CodingPageInner para AssignedCodingView).
// Serve de rede de segurança: os contratos observáveis aqui não podem mudar.
const { saveResponse, getDocumentsForBrowse, urlParams } = vi.hoisted(() => ({
  saveResponse: vi.fn(),
  getDocumentsForBrowse: vi.fn(),
  urlParams: { current: {} as Record<string, string | null> },
}));

vi.mock("@/actions/responses", () => ({ saveResponse }));
vi.mock("@/actions/documents", () => ({
  getDocumentsForBrowse,
  getDocumentForCoding: vi.fn(),
}));
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
  useAutosaveOnExit: () => {},
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
    onAnswer,
    onSubmit,
    outOfScope,
  }: {
    answers: Record<string, unknown>;
    onAnswer: (f: string, v: unknown) => void;
    onSubmit: () => void;
    outOfScope?: unknown;
  }) => (
    <div>
      <div data-testid="qp-answers">{JSON.stringify(answers)}</div>
      <div data-testid="qp-outofscope">{JSON.stringify(outOfScope ?? null)}</div>
      <button onClick={() => onAnswer("q1", "sim")}>qp-set</button>
      <button onClick={onSubmit}>qp-enviar</button>
    </div>
  ),
}));
vi.mock("@/components/coding/DocumentPicker", () => ({
  DocumentPicker: () => <div data-testid="picker" />,
}));
vi.mock("@/components/coding/CodingHeader", () => ({
  CodingHeader: ({ mode }: { mode: string }) => (
    <div data-testid="hdr-mode">{mode}</div>
  ),
}));
vi.mock("@/components/coding/FullscreenNav", () => ({
  FullscreenNav: () => <div data-testid="fsnav" />,
}));

import { CodingPage } from "@/components/coding/CodingPage";

const FIELDS: PydanticField[] = [
  { name: "q1", type: "text", options: null, description: "" },
];

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
  getDocumentsForBrowse.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CodingPage — modo Atribuídos (integração)", () => {
  it("sem documentos atribuídos: mostra o empty-state 'no-doc'", async () => {
    render(
      <CodingPage
        userId="user-teste"
        projectId="p1"
        documents={[]}
        fields={FIELDS}
        existingAnswers={{}}
        hasAssignments
      />,
    );

    expect(
      await screen.findByText("Nenhum documento atribuído. Use a aba Explorar."),
    ).not.toBeNull();
  });

  it("último documento atribuído: enviar mostra o empty-state 'tudo concluído'", async () => {
    saveResponse.mockResolvedValue({ success: true });

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

    expect((await screen.findByTestId("doc-reader")).textContent).toBe(
      "texto-a1",
    );
    await userEvent.click(screen.getByText("qp-set"));
    await userEvent.click(screen.getByText("qp-enviar"));

    expect(await screen.findByText("Parabéns!")).not.toBeNull();
    expect(saveResponse).toHaveBeenCalledWith(
      "p1",
      "a1",
      { q1: "sim" },
      { notes: "" },
    );
  });

  it("documento normal: renderiza o doc certo com as respostas existentes", async () => {
    render(
      <CodingPage
        userId="user-teste"
        projectId="p1"
        documents={[assignedDoc("a1"), assignedDoc("a2")]}
        fields={FIELDS}
        existingAnswers={{}}
        hasAssignments
      />,
    );

    expect((await screen.findByTestId("doc-reader")).textContent).toBe(
      "texto-a1",
    );
    expect(screen.getByTestId("qp-answers").textContent).toBe("{}");
  });

  it("fora do escopo habilitado no projeto: config chega ao QuestionsPanel com status normal", async () => {
    render(
      <CodingPage
        userId="user-teste"
        projectId="p1"
        documents={[assignedDoc("a1")]}
        fields={FIELDS}
        existingAnswers={{}}
        hasAssignments
        outOfScopeEnabled
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("qp-outofscope").textContent).toBe(
        JSON.stringify({
          projectId: "p1",
          documentId: "a1",
          documentTitle: "Assigned a1",
          initialState: { status: "normal" },
        }),
      ),
    );
  });

  it("fora do escopo com pendência do próprio usuário: status pending_mine com o motivo", async () => {
    render(
      <CodingPage
        userId="user-teste"
        projectId="p1"
        documents={[assignedDoc("a1")]}
        fields={FIELDS}
        existingAnswers={{}}
        hasAssignments
        pendingExclusionByDoc={{ a1: "duplicado" }}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("qp-outofscope").textContent).toBe(
        JSON.stringify({
          projectId: "p1",
          documentId: "a1",
          documentTitle: "Assigned a1",
          initialState: { status: "pending_mine", reason: "duplicado" },
        }),
      ),
    );
  });
});
