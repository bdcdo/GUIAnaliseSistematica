// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { saveResponse } from "@/actions/responses";
import { toast } from "sonner";
import { CODING_SAVE_TRANSPORT_ERROR } from "@/lib/coding-save";
import { useBrowseDocuments } from "@/hooks/useBrowseDocuments";
import { useDocumentForCoding } from "@/hooks/useDocumentForCoding";
import type { BrowseDocument } from "@/actions/documents";
import { useBrowseCoding } from "../useBrowseCoding";

// Mocka os hooks de dados para asserir os contratos da #257 em isolamento:
// markResponded(intent), invalidate(id) e a exposição de error/retry.
vi.mock("@/hooks/useBrowseDocuments", () => ({ useBrowseDocuments: vi.fn() }));
vi.mock("@/hooks/useDocumentForCoding", () => ({ useDocumentForCoding: vi.fn() }));
vi.mock("@/actions/responses", () => ({ saveResponse: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const mockUseBrowseDocuments = vi.mocked(useBrowseDocuments);
const mockUseDocumentForCoding = vi.mocked(useDocumentForCoding);
const mockSave = vi.mocked(saveResponse);

const markResponded = vi.fn();
const retry = vi.fn();
const invalidate = vi.fn();

function browseDoc(id: string, overrides?: Partial<BrowseDocument>): BrowseDocument {
  return {
    id,
    external_id: `ext-${id}`,
    title: `Doc ${id}`,
    created_at: "2026-01-01",
    responseCount: 2,
    userAlreadyResponded: false,
    exclusionPendingMine: false,
    ...overrides,
  };
}

function setBrowseDocs(
  over?: Partial<ReturnType<typeof useBrowseDocuments>>,
) {
  mockUseBrowseDocuments.mockReturnValue({
    documents: [browseDoc("b1"), browseDoc("b2")],
    loading: false,
    error: false,
    retry,
    markResponded,
    ...over,
  });
}

function setDoc(over?: Partial<ReturnType<typeof useDocumentForCoding>>) {
  mockUseDocumentForCoding.mockReturnValue({
    doc: {
      document: { id: "b1", external_id: "ext-b1", title: "Doc b1", text: "txt" },
      initialAnswers: {},
      initialNotes: "",
    } as ReturnType<typeof useDocumentForCoding>["doc"],
    loading: false,
    invalidate,
    ...over,
  });
}

function setup(docParam: string | null, dirty = new Set<string>()) {
  const params = {
    projectId: "p1",
    documents: [], // nenhum atribuído → docParam vira browseDocId
    mode: "browse" as const,
    docParam,
    setSubmitting: vi.fn(),
    markDirty: vi.fn((id: string) => dirty.add(id)),
    markClean: vi.fn((id: string) => dirty.delete(id)),
    isDirty: (id: string | null | undefined) => !!id && dirty.has(id),
    recordDraft: vi.fn(),
    submitConfirmed: vi.fn(),
    updateDocParam: vi.fn(),
  };
  return { view: renderHook(() => useBrowseCoding(params)), params, dirty };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
beforeEach(() => {
  setBrowseDocs();
  setDoc();
  mockSave.mockResolvedValue({ success: true });
});

describe("useBrowseCoding", () => {
  it("deriva browseDocId do ?doc= e expõe info da lista", () => {
    const { view } = setup("b1");
    expect(view.result.current.browseDocId).toBe("b1");
    expect(view.result.current.browseDocInfo?.responseCount).toBe(2);
  });

  it("submit salva, marca respondido (intent submit), invalida e limpa a seleção", async () => {
    const { view, params } = setup("b1");

    await act(async () => {
      await view.result.current.handleBrowseSubmit({ answers: { q: "sim" }, notes: "n" });
    });

    expect(mockSave).toHaveBeenCalledWith("p1", "b1", { q: "sim" }, { notes: "n" });
    expect(params.markClean).toHaveBeenCalledWith("b1");
    expect(markResponded).toHaveBeenCalledWith("b1");
    expect(invalidate).toHaveBeenCalledWith("b1");
    expect(params.updateDocParam).toHaveBeenCalledWith(null);
  });

  it("submit com obrigatórias em aberto mantém o documento ABERTO e invalida", async () => {
    // Espelha o modo Atribuídos: o save teve sucesso (markClean/markResponded
    // rodam), mas fechar o doc tiraria a tela de baixo do aviso que pediu para
    // completá-lo (#519). A invalidação vem SEM o `updateDocParam(null)` que a
    // precede no caminho normal — aqui o refetch é desejado, para reassentar o
    // formulário no que acabou de ser gravado.
    mockSave.mockResolvedValue({ success: true, missingRequired: 2 });
    const { view, params } = setup("b1");

    await act(async () => {
      await view.result.current.handleBrowseSubmit({ answers: { q: "sim" }, notes: "n" });
    });

    expect(params.markClean).toHaveBeenCalledWith("b1");
    expect(markResponded).toHaveBeenCalledWith("b1");
    expect(invalidate).toHaveBeenCalledWith("b1");
    expect(params.updateDocParam).not.toHaveBeenCalled();
  });

  it("submit mantém rascunho e seleção, e permite retry após rejeição de transporte", async () => {
    mockSave.mockRejectedValue(new Error("Failed to find Server Action"));
    const dirty = new Set<string>();
    const { view, params } = setup("b1", dirty);
    const draft = { answers: { q: "sim" }, notes: "n" };
    act(() => view.result.current.handleDraftChange(draft));

    await act(async () => {
      await view.result.current.handleBrowseSubmit(draft);
    });

    // Falhou: nada foi confirmado como enviado, então o rascunho segue de pé.
    expect(params.submitConfirmed).not.toHaveBeenCalled();
    expect(params.markClean).not.toHaveBeenCalled();
    expect(markResponded).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect(params.updateDocParam).not.toHaveBeenCalled();
    expect(params.setSubmitting).toHaveBeenLastCalledWith(false);
    expect(toast.error).toHaveBeenCalledWith(CODING_SAVE_TRANSPORT_ERROR);

    mockSave.mockResolvedValue({ success: true });
    await act(async () => {
      await view.result.current.handleBrowseSubmit(draft);
    });
    expect(mockSave).toHaveBeenCalledTimes(2);
    expect(params.updateDocParam).toHaveBeenCalledWith(null);
  });

  it("nº3: duplo-clique em Enviar não duplica saveResponse (guarda de reentrância)", async () => {
    let resolveSave: (v: { success: true }) => void = () => {};
    mockSave.mockReturnValue(
      new Promise<{ success: true }>((r) => {
        resolveSave = r;
      }),
    );
    const { view } = setup("b1");

    // Dois envios antes do primeiro save em voo resolver: o segundo é barrado
    // pela guarda de reentrância, então saveResponse roda só uma vez.
    const p1 = view.result.current.handleBrowseSubmit({
      answers: { q: "sim" },
      notes: "",
    });
    const p2 = view.result.current.handleBrowseSubmit({
      answers: { q: "sim" },
      notes: "",
    });
    expect(mockSave).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSave({ success: true });
      await Promise.all([p1, p2]);
    });
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  // Invertido no #608, não apagado: eram três testes provando que "Voltar"
  // autosalvava (e como ele se comportava quando esse save falhava). O ponto do
  // código continua guardado — agora pela ausência da escrita. Os dois testes de
  // falha perderam o objeto junto com o save: não há mais o que falhar aqui.
  it("Voltar com o doc sujo NÃO grava no servidor e apenas navega", async () => {
    const dirty = new Set<string>();
    const { view, params } = setup("b1", dirty);
    act(() =>
      view.result.current.handleDraftChange({ answers: { q: "x" }, notes: "nota" }),
    );
    await act(async () => {
      await view.result.current.handleBrowseBack();
    });

    expect(mockSave).not.toHaveBeenCalled();
    // `markResponded` e `invalidate` existiam para reagir àquela escrita.
    // Mantê-los agora afirmaria ao resto da tela que o documento foi respondido
    // e que o cache ficou stale — duas coisas que não aconteceram.
    expect(markResponded).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    // O doc continua marcado como não enviado, e o conteúdo já foi ao rascunho
    // local quando a edição chegou.
    expect(params.markClean).not.toHaveBeenCalled();
    expect(params.recordDraft).toHaveBeenCalledWith("b1", {
      answers: { q: "x" },
      notes: "nota",
    });
    expect(params.updateDocParam).toHaveBeenCalledWith(null);
  });

  it("trocar de doc no Explorar não limpa o sinal de não enviado", () => {
    const dirty = new Set<string>();
    const { view, params } = setup("b1", dirty);
    act(() =>
      view.result.current.handleDraftChange({ answers: { q: "x" }, notes: "n" }),
    );
    act(() => view.result.current.handleBrowseSelect("b2"));

    // Antes do #608 isto chamava `markClean`, e era honesto: o Explorar
    // descartava mesmo a edição ao trocar de doc. Com o rascunho local ela
    // sobrevive, então limpar diria "enviado" sobre trabalho pendente.
    expect(params.markClean).not.toHaveBeenCalled();
    expect(params.updateDocParam).toHaveBeenCalledWith("b2");
  });

  it("expõe error/retry da lista", () => {
    setBrowseDocs({ documents: null, error: true });
    const { view } = setup(null);
    expect(view.result.current.browseError).toBe(true);
    act(() => view.result.current.retryBrowse());
    expect(retry).toHaveBeenCalled();
  });

  it("retryBrowseDoc invalida o doc selecionado", () => {
    const { view } = setup("b1");
    act(() => view.result.current.retryBrowseDoc());
    expect(invalidate).toHaveBeenCalledWith("b1");
  });
});
