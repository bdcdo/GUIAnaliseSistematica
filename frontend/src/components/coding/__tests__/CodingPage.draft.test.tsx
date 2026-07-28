// @vitest-environment jsdom
//
// Os critérios de aceitação do #608 no nível da TELA — os que nenhum teste de
// unidade cobre porque dependem da composição container + hooks + storage:
//
//   (2) fechar a aba com alterações pendentes não perde trabalho;
//   (4) a tela diz, a qualquer momento, se há alterações não enviadas;
//       e o rascunho é OFERECIDO, nunca aplicado em silêncio.
//
// Diferente das outras suítes de `CodingPage`, o `QuestionsPanel` NÃO é
// mockado por um stub mínimo: o indicador de "não enviado" mora nele, e um stub
// tornaria vácua justamente a asserção do critério 4.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup, act, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { PydanticField, Document } from "@/lib/types";

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
  DocumentReader: () => <div data-testid="doc-reader" />,
}));
vi.mock("@/components/coding/DocumentPicker", () => ({
  DocumentPicker: () => <div data-testid="picker" />,
}));
// O header é stub, mas expõe a navegação entre documentos atribuídos: é ela que
// dispara o autosave de navegação, e o efeito desse autosave sobre o rascunho
// local é o que a suíte "autosave de navegação" abaixo verifica.
vi.mock("@/components/coding/CodingHeader", () => ({
  CodingHeader: ({
    mode,
    doc,
  }: {
    mode: string;
    doc?: { index: number; onNavigate: (index: number) => void };
  }) => (
    <div>
      <div data-testid="hdr-mode">{mode}</div>
      {doc && (
        <>
          <button onClick={() => doc.onNavigate(doc.index + 1)}>ir-proximo</button>
          <button onClick={() => doc.onNavigate(doc.index - 1)}>ir-anterior</button>
        </>
      )}
    </div>
  ),
}));
vi.mock("@/components/coding/FullscreenNav", () => ({
  FullscreenNav: () => <div data-testid="fsnav" />,
}));

import { CodingPage } from "@/components/coding/CodingPage";
import { codingDraftStorageKey, parseCodingDraft } from "@/lib/coding-draft";
import { requestNavigation } from "@/lib/unsaved-work-guard";

const USER = "user-teste";
const PROJECT = "p1";
const DOC = "d1";
const KEY = codingDraftStorageKey({
  userId: USER,
  projectId: PROJECT,
  documentId: DOC,
});

const FIELDS: PydanticField[] = [
  { name: "q1", type: "text", options: null, description: "Qual o medicamento?" },
];

function assignedDoc(id: string): Document {
  return {
    id,
    project_id: PROJECT,
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

function renderPage(
  existingAnswers: Record<string, Record<string, unknown>> = {},
  documents: Document[] = [assignedDoc(DOC)],
) {
  return render(
    <CodingPage
      userId={USER}
      projectId={PROJECT}
      documents={documents}
      fields={FIELDS}
      existingAnswers={existingAnswers}
      hasAssignments
    />,
  );
}

function plantDraft(draftAnswers: Record<string, unknown>, base = {}) {
  window.localStorage.setItem(
    KEY,
    JSON.stringify({
      formatVersion: 1,
      writeToken: "tok-plantado",
      userId: USER,
      projectId: PROJECT,
      documentId: DOC,
      updatedAt: Date.now() - 5 * 60_000,
      base: { answers: base, notes: "" },
      draft: { answers: draftAnswers, notes: "" },
    }),
  );
}

const storedDraft = () => parseCodingDraft(window.localStorage.getItem(KEY));

// O campo de resposta não tem `label` associado no `FieldRenderer`; é o
// primeiro textbox do painel (o segundo é a caixa de notas).
const answerInput = () => screen.getAllByRole("textbox")[0];

const typeAnswer = async (user: ReturnType<typeof userEvent.setup>, text: string) => {
  await user.type(answerInput(), text);
};

beforeEach(() => {
  urlParams.current = {};
  window.localStorage.clear();
  Element.prototype.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  getDocumentsForBrowse.mockResolvedValue([]);
  saveResponse.mockResolvedValue({ success: true, missingRequiredFields: [] });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // `restoreAllMocks`, e não só `clearAllMocks`: o teste de quota substitui a
  // IMPLEMENTAÇÃO de `Storage.prototype.setItem` por um spy que lança, e
  // `clearAllMocks` zera as chamadas sem desfazer a substituição. Sem isto, um
  // único teste derrubava os sete seguintes com `QuotaExceededError`.
  vi.restoreAllMocks();
});

describe("critério 4 — a tela diz se há alterações não enviadas", () => {
  it("o indicador não aparece antes de editar", () => {
    renderPage();
    expect(screen.queryByText(/alterações não enviadas/i)).toBeNull();
  });

  // Mutação vermelha: derivar o indicador de qualquer coisa que não seja a
  // sujeira em memória (por exemplo, do que foi persistido no localStorage).
  it("aparece ao editar e some quando o envio é confirmado", async () => {
    const user = userEvent.setup();
    renderPage();

    await typeAnswer(user, "Zolgensma");
    expect(await screen.findByText(/alterações não enviadas/i)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /enviar/i }));
    await waitFor(() =>
      expect(screen.queryByText(/alterações não enviadas/i)).toBeNull(),
    );
  });

  // A razão de o indicador NÃO sair do storage: aqui o localStorage está
  // quebrado e a tela ainda precisa dizer a verdade sobre o trabalho pendente.
  // Mutação vermelha: derivar `unsent` de `drafts`/`storageAvailable`.
  it("com o localStorage indisponível, ainda avisa que há trabalho pendente", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("cheio", "QuotaExceededError");
    });
    const user = userEvent.setup();
    renderPage();

    await typeAnswer(user, "Zolgensma");
    expect(await screen.findByText(/alterações não enviadas/i)).toBeTruthy();
    // E avisa, além disso, que a cópia local não pôde ser guardada.
    expect(
      await screen.findByText(/não foi possível guardar uma cópia local/i),
    ).toBeTruthy();
  });
});

describe("critério 2 — o que foi digitado sobrevive fora do servidor", () => {
  // Esta suíte roda com timers REAIS (userEvent precisa deles), então o debounce
  // de 300ms já disparou quando as asserções rodam. Consequência medida: este
  // teste continua passando mesmo sem o `pagehide` — ele prova a existência da
  // rede local, NÃO o flush de saída.
  //
  // Os três gatilhos de flush (`pagehide`, `visibilitychange:hidden`, unmount)
  // são provados em `useCodingDrafts.test.ts`, com fake timers, cada um com a
  // mutação que o derruba. Aqui, alegar o contrário seria uma asserção vácua.
  it("o que foi digitado é persistido localmente, sem ir ao servidor", async () => {
    const user = userEvent.setup();
    renderPage();

    await typeAnswer(user, "Zolgensma");

    await waitFor(() => expect(storedDraft()?.draft.answers).toEqual({ q1: "Zolgensma" }));
    // Nenhuma escrita implícita: a gravação no servidor segue sendo ação
    // explícita da pesquisadora (critério 1).
    expect(saveResponse).not.toHaveBeenCalled();
  });
});

describe("recuperação — oferecer, nunca aplicar em silêncio", () => {
  // O teste que fixa a decisão de desenho mais importante da issue. Mutação
  // vermelha: semear o reducer com o rascunho no `useState`/`useReducer` inicial
  // — o formulário abriria já preenchido, que é exatamente o comportamento
  // "grava sem pedir e sem avisar" que esta issue remove.
  it("com rascunho no slot, o formulário monta com os valores DO SERVIDOR", async () => {
    plantDraft({ q1: "do rascunho" });
    renderPage({ [DOC]: { q1: "do servidor" } });

    await waitFor(() => expect(answerInput()).toBeTruthy());
    expect(answerInput()).toHaveProperty("value", "do servidor");
    // Mas a existência do rascunho é anunciada.
    expect(screen.getByText(/alterações não enviadas neste documento/i)).toBeTruthy();
  });

  it("`Retomar` aplica o rascunho e acende o indicador de não enviado", async () => {
    const user = userEvent.setup();
    plantDraft({ q1: "do rascunho" });
    renderPage({ [DOC]: { q1: "do servidor" } });

    await user.click(await screen.findByRole("button", { name: /retomar rascunho/i }));

    expect(answerInput()).toHaveProperty("value", "do rascunho");
    expect(screen.getByText(/alterações não enviadas/i)).toBeTruthy();
  });

  // Mutação vermelha: `discardDraft` que só esconde a faixa sem apagar o slot —
  // a oferta voltaria na próxima abertura e a decisão da pesquisadora seria
  // silenciosamente ignorada.
  it("`Descartar` apaga o slot", async () => {
    const user = userEvent.setup();
    plantDraft({ q1: "do rascunho" });
    renderPage({ [DOC]: { q1: "do servidor" } });

    await user.click(await screen.findByRole("button", { name: /descartar/i }));

    expect(storedDraft()).toBeNull();
    expect(
      screen.queryByText(/alterações não enviadas neste documento/i),
    ).toBeNull();
  });

  it("rascunho que apenas repete o servidor não é oferecido", async () => {
    plantDraft({ q1: "igual" });
    renderPage({ [DOC]: { q1: "igual" } });

    await waitFor(() => expect(storedDraft()).toBeNull());
    expect(
      screen.queryByText(/alterações não enviadas neste documento/i),
    ).toBeNull();
  });

  it("anuncia o que seria sobrescrito quando o servidor andou depois do rascunho", async () => {
    plantDraft({ q1: "do rascunho" }, { q1: "antigo" });
    renderPage({ [DOC]: { q1: "servidor-novo" } });

    expect(await screen.findByText(/foi salvo depois/i)).toBeTruthy();
    // Nomeia a pergunta pelo RÓTULO, não pelo nome interno do campo (`q1`). A
    // busca é escopada ao `<strong>` da faixa porque o mesmo texto também é o
    // enunciado da pergunta no formulário.
    const emphasized = screen.getByText(
      (_, el) => el?.tagName === "STRONG" && el.textContent === "Qual o medicamento?",
    );
    expect(emphasized).toBeTruthy();
  });
});

describe("envio confirmado", () => {
  // Mutação vermelha: preservar o rascunho quando ainda faltam obrigatórias. A
  // escrita aconteceu; manter o envelope deixaria o indicador aceso sobre
  // trabalho que FOI enviado, e a oferta voltaria depois.
  it("descarta o rascunho mesmo quando o documento segue pendente", async () => {
    saveResponse.mockResolvedValue({
      success: true,
      missingRequiredFields: ["outra_pergunta"],
    });
    const user = userEvent.setup();
    renderPage();

    await typeAnswer(user, "Zolgensma");
    await waitFor(() => expect(storedDraft()).not.toBeNull());

    await user.click(screen.getByRole("button", { name: /enviar/i }));
    await waitFor(() => expect(storedDraft()).toBeNull());
  });

  // Mutação vermelha: apagar o rascunho no `finally` em vez de no ramo de
  // sucesso. É o caso para o qual a feature inteira existe.
  it("falha no envio mantém o rascunho E a sujeira", async () => {
    saveResponse.mockResolvedValue({ success: false, error: "falhou" });
    const user = userEvent.setup();
    renderPage();

    await typeAnswer(user, "Zolgensma");
    await waitFor(() => expect(storedDraft()).not.toBeNull());

    await user.click(screen.getByRole("button", { name: /enviar/i }));

    await waitFor(() => expect(saveResponse).toHaveBeenCalled());
    expect(storedDraft()?.draft.answers).toEqual({ q1: "Zolgensma" });
    expect(screen.getByText(/alterações não enviadas/i)).toBeTruthy();
  });
});

// A ponta do aviso de saída ligada à rede local: o que a pesquisadora lê no
// diálogo tem de ser verdade sobre o navegador dela. `requestNavigation` é o
// mesmo ponto de entrada que `ProjectTabs` e o logo do `Header` usam no clique,
// então o teste exercita o caminho real, sem simular o diálogo.
describe("aviso de saída — a frase precisa ser verdadeira", () => {
  it("com a cópia local gravada, afirma que as alterações ficam no navegador", async () => {
    const user = userEvent.setup();
    renderPage();
    await typeAnswer(user, "Zolgensma");
    // A gravação é o que dá à frase o direito de existir.
    await waitFor(() => expect(storedDraft()?.draft.answers).toEqual({ q1: "Zolgensma" }));

    let allowed = true;
    act(() => {
      allowed = requestNavigation(() => {});
    });

    expect(allowed).toBe(false);
    const dialog = within(await screen.findByRole("alertdialog"));
    expect(
      dialog.getByText(/elas ficam salvas neste navegador/i),
    ).toBeTruthy();
  });

  it("com o navegador recusando gravar, avisa que sair perde o trabalho", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("cheio", "QuotaExceededError");
    });
    const user = userEvent.setup();
    renderPage();
    await typeAnswer(user, "Zolgensma");
    expect(await screen.findByText(/alterações não enviadas/i)).toBeTruthy();

    act(() => {
      requestNavigation(() => {});
    });

    // Mutação vermelha: fixar a frase da cópia local no diálogo. A pesquisadora
    // sairia acreditando que o trabalho está guardado, e ele não está em lugar
    // nenhum — nem no servidor, nem no navegador.
    const dialog = within(await screen.findByRole("alertdialog"));
    expect(
      dialog.getByText(/não foi possível guardar uma cópia neste navegador/i),
    ).toBeTruthy();
    expect(dialog.queryByText(/ficam salvas neste navegador/i)).toBeNull();
  });

  it("a saída retida acontece de fato quando a pesquisadora confirma", async () => {
    const user = userEvent.setup();
    renderPage();
    await typeAnswer(user, "Zolgensma");

    const proceed = vi.fn();
    act(() => {
      requestNavigation(proceed);
    });
    expect(proceed).not.toHaveBeenCalled();

    const dialog = within(await screen.findByRole("alertdialog"));
    await user.click(dialog.getByRole("button", { name: "Sair sem enviar" }));

    expect(proceed).toHaveBeenCalledTimes(1);
    // Sair não envia: o servidor segue intocado.
    expect(saveResponse).not.toHaveBeenCalled();
  });

  it("sem alterações pendentes, sair não pede confirmação nenhuma", async () => {
    renderPage();
    await screen.findByText(/qual o medicamento/i);

    let allowed = false;
    act(() => {
      allowed = requestNavigation(() => {});
    });

    expect(allowed).toBe(true);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

// Este caso isola o elo que os demais não conseguem discriminar: sair pela
// navegação SPA não dispara `beforeunload`/`pagehide`/`visibilitychange`, então
// é o próprio aviso que precisa gravar o que o debounce ainda devia — antes de
// medir se há cópia. Timers falsos e `fireEvent` (não `userEvent`) para poder
// parar DENTRO da janela do debounce de forma determinística.
describe("aviso de saída — grava o pendente antes de afirmar qualquer coisa", () => {
  it("dentro da janela do debounce, a saída grava a cópia e a frase fica verdadeira", async () => {
    vi.useFakeTimers();
    try {
      renderPage();
      fireEvent.change(answerInput(), { target: { value: "Zolgensma" } });

      // Pré-condição do teste: o debounce ainda não gravou nada.
      expect(storedDraft()).toBeNull();

      act(() => {
        requestNavigation(() => {});
      });

      // Mutação vermelha: tirar o `drafts.flushAll()` de `describeUnsentWork`.
      // Sem ele, a última coisa digitada não está no navegador no momento em que
      // a tela promete que está — e o diálogo passa a dizer o contrário.
      expect(storedDraft()?.draft.answers).toEqual({ q1: "Zolgensma" });
      const dialog = within(screen.getByRole("alertdialog"));
      expect(dialog.getByText(/elas ficam salvas neste navegador/i)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
