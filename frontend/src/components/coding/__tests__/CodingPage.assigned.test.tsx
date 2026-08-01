// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { PydanticField, Document } from "@/lib/types";
import type { DocRoundStatus } from "@/lib/rounds";

// Caracterização do modo Atribuídos ANTES do refactor da issue #389 (extração
// da cascata allDone/no-doc/view de CodingPageInner para AssignedCodingView).
// Serve de rede de segurança: os contratos observáveis aqui não podem mudar.
const { saveResponse, getDocumentsForBrowse, urlParams, submitVerdict } = vi.hoisted(
  () => ({
    saveResponse: vi.fn(),
    getDocumentsForBrowse: vi.fn(),
    urlParams: { current: {} as Record<string, string | null> },
    // O que o container devolveu ao painel no último Enviar. É por este valor de
    // retorno — e não por um canal de estado — que o veredito do servidor chega
    // a `useQuestionValidation` para rolar até a pergunta pendente (#608); com o
    // `QuestionsPanel` mockado aqui, capturá-lo é o que torna a ligação
    // observável do lado do container.
    submitVerdict: { current: undefined as unknown },
  }),
);

vi.mock("@/actions/responses", () => ({ saveResponse }));
vi.mock("@/actions/documents", () => ({
  getDocumentsForBrowse,
  getDocumentForCoding: vi.fn(),
}));
// `warning` junto de `success`/`error`: um envio que grava com obrigatória em
// aberto avisa por ele (`notifySaved`). Mock incompleto não falha no typecheck —
// mocks não são tipados — e só aparece como rejeição não tratada dentro do
// handler assíncrono, longe da asserção que estava sendo feita.
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
    onAnswer,
    onSubmit,
    outOfScope,
  }: {
    answers: Record<string, unknown>;
    onAnswer: (f: string, v: unknown) => void;
    // `unknown`, não `void`: o painel real usa o retorno, e um mock que o
    // declarasse `void` deixaria o container livre para descartá-lo.
    onSubmit: () => unknown;
    outOfScope?: unknown;
  }) => (
    <div>
      <div data-testid="qp-answers">{JSON.stringify(answers)}</div>
      <div data-testid="qp-outofscope">{JSON.stringify(outOfScope ?? null)}</div>
      <button onClick={() => onAnswer("q1", "sim")}>qp-set</button>
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

const ROUND_FILTER = {
  currentRoundKey: "round-1",
  currentRoundLabel: "Rodada inicial",
  rounds: [],
  selected: "round-1",
};

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
  submitVerdict.current = undefined;
  Element.prototype.scrollTo = vi.fn();
  getDocumentsForBrowse.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CodingPage — documento inicial (#608)", () => {
  // Critério 6 da #608. Medido em 2026-07-27 nos dois projetos ativos: NENHUMA
  // fila tem documento nunca respondido, e o filtro de rodada já expulsa os
  // concluídos da rodada atual server-side. O que a pesquisadora encontrava na
  // frente eram respostas completas reabertas por mudança de schema — que
  // exigem ação, mas não são o trabalho que ela deixou pela metade.
  const TRES = [assignedDoc("a1"), assignedDoc("a2"), assignedDoc("a3")];
  // `previous` carrega o rótulo da rodada — o mesmo dado que o `CodingHeader`
  // exibe. Aqui ele é irrelevante para a escolha do documento inicial, que olha
  // só o `kind`; o que importa é que o formato bata com o do servidor.
  const ANTERIOR: DocRoundStatus = { kind: "previous", label: "1.0.0" };
  const PENDENTE: DocRoundStatus = { kind: "current_pending" };
  const STATUS_A2_PENDENTE: Record<string, DocRoundStatus> = {
    a1: ANTERIOR,
    a2: PENDENTE,
    a3: ANTERIOR,
  };
  const STATUS_NENHUMA_PENDENTE: Record<string, DocRoundStatus> = {
    a1: ANTERIOR,
    a2: ANTERIOR,
    a3: ANTERIOR,
  };

  it("abre na primeira codificação incompleta, não no primeiro da lista", async () => {
    render(
      <CodingPage
        roundFilter={ROUND_FILTER}
        userId="user-teste"
        projectId="p1"
        documents={TRES}
        statusByDoc={STATUS_A2_PENDENTE}
        fields={FIELDS}
        existingAnswers={{}}
        hasAssignments
      />,
    );

    expect((await screen.findByTestId("doc-reader")).textContent).toBe("texto-a2");
  });

  it("sem nenhuma incompleta, respeita a ordem do sort (índice 0)", async () => {
    // O fallback não é detalhe: em "recent" o índice 0 é o último documento que
    // ela mexeu, e pular dali quebraria "retomar de onde parei".
    render(
      <CodingPage
        roundFilter={ROUND_FILTER}
        userId="user-teste"
        projectId="p1"
        documents={TRES}
        statusByDoc={STATUS_NENHUMA_PENDENTE}
        fields={FIELDS}
        existingAnswers={{}}
        hasAssignments
      />,
    );

    expect((await screen.findByTestId("doc-reader")).textContent).toBe("texto-a1");
  });

  it("?doc= explícito vence a priorização", async () => {
    // Link compartilhado / refresh: a URL é uma escolha da pesquisadora e não
    // pode ser sobrescrita por heurística de fila.
    urlParams.current = { doc: "a3" };
    render(
      <CodingPage
        roundFilter={ROUND_FILTER}
        userId="user-teste"
        projectId="p1"
        documents={TRES}
        statusByDoc={STATUS_A2_PENDENTE}
        fields={FIELDS}
        existingAnswers={{}}
        hasAssignments
      />,
    );

    expect((await screen.findByTestId("doc-reader")).textContent).toBe("texto-a3");
  });

  it("sem statusByDoc (prop ausente) cai no índice 0 sem quebrar", async () => {
    render(
      <CodingPage
        roundFilter={ROUND_FILTER}
        userId="user-teste"
        projectId="p1"
        documents={TRES}
        fields={FIELDS}
        existingAnswers={{}}
        hasAssignments
      />,
    );

    expect((await screen.findByTestId("doc-reader")).textContent).toBe("texto-a1");
  });
});

// A ligação container→painel do critério 5 vista do lado do container. O teste
// ponta a ponta com o painel REAL mora em `CodingPage.draft.test.tsx`; aqui o
// alvo é só o contrato do `onSubmit` que a página entrega, porque foi
// exatamente ele que um `void` intermediário anulou sem que typecheck ou lint
// reclamassem (o tipo do handler admite `void`).
describe("CodingPage — onSubmit devolve o veredito do servidor (#608)", () => {
  const UM = [assignedDoc("a1")];

  it("obrigatória em aberto: o painel recebe os NOMES, não `undefined`", async () => {
    saveResponse.mockResolvedValue({
      success: true,
      missingRequiredFields: ["q2"],
    });
    const user = userEvent.setup();
    render(
      <CodingPage
        roundFilter={ROUND_FILTER}
        userId="user-teste"
        projectId="p1"
        documents={UM}
        fields={FIELDS}
        existingAnswers={{}}
        hasAssignments
      />,
    );

    await user.click(await screen.findByText("qp-set"));
    await user.click(screen.getByText("qp-enviar"));

    await waitFor(() => expect(saveResponse).toHaveBeenCalled());
    await expect(submitVerdict.current).resolves.toEqual(["q2"]);
  });

  it("codificação completa resolve sem nomes", async () => {
    saveResponse.mockResolvedValue({ success: true, missingRequiredFields: [] });
    const user = userEvent.setup();
    render(
      <CodingPage
        roundFilter={ROUND_FILTER}
        userId="user-teste"
        projectId="p1"
        documents={UM}
        fields={FIELDS}
        existingAnswers={{}}
        hasAssignments
      />,
    );

    await user.click(await screen.findByText("qp-set"));
    await user.click(screen.getByText("qp-enviar"));

    await waitFor(() => expect(saveResponse).toHaveBeenCalled());
    await expect(submitVerdict.current).resolves.toBeUndefined();
  });
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
    saveResponse.mockResolvedValue({ success: true, missingRequiredFields: [] });

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
      { notes: "", expectedRoundId: "round-1" },
    );
  });

  it("documento normal: renderiza o doc certo com as respostas existentes", async () => {
    render(
      <CodingPage
        roundFilter={ROUND_FILTER}
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
        roundFilter={ROUND_FILTER}
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
        roundFilter={ROUND_FILTER}
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
