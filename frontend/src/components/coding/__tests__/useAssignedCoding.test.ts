// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { saveResponse } from "@/actions/responses";
import { toast } from "sonner";
import { CODING_SAVE_TRANSPORT_ERROR } from "@/lib/coding-save";
import { useAssignedCoding } from "../useAssignedCoding";
import type { Document, Assignment, PydanticField } from "@/lib/types";

vi.mock("@/actions/responses", () => ({ saveResponse: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
// sortByRecent é testado em outro lugar; aqui usamos a ordem como vem.
vi.mock("@/lib/coding-sort", () => ({
  sortByRecent: (docs: unknown[]) => docs,
}));

const mockSave = vi.mocked(saveResponse);

type AssignedDoc = Document & { assignment?: Pick<Assignment, "id" | "status"> };

function doc(id: string): AssignedDoc {
  return {
    id,
    external_id: `ext-${id}`,
    title: `Doc ${id}`,
    text: `texto ${id}`,
  } as AssignedDoc;
}

const DOCS = [doc("d1"), doc("d2"), doc("d3")];

function setup(overrides?: {
  existingAnswers?: Record<string, Record<string, unknown>>;
  existingJustifications?: Record<string, Record<string, unknown>>;
  dirty?: Set<string>;
  fields?: PydanticField[];
}) {
  const dirty = overrides?.dirty ?? new Set<string>();
  const params = {
    projectId: "p1",
    documents: DOCS,
    fields: overrides?.fields ?? [],
    sortedDocuments: DOCS,
    codedAtByDoc: {},
    existingAnswers: overrides?.existingAnswers ?? {},
    existingJustifications: overrides?.existingJustifications ?? {},
    initialDocIndex: 0,
    setSubmitting: vi.fn(),
    markDirty: vi.fn((id: string) => dirty.add(id)),
    markClean: vi.fn((id: string) => dirty.delete(id)),
    isDirty: (id: string | null | undefined) => !!id && dirty.has(id),
    recordDraft: vi.fn(),
    restoreDraft: vi.fn(() => null),
    submitConfirmed: vi.fn(),
    updateDocParam: vi.fn(),
    setParams: vi.fn(),
  };
  const view = renderHook(() => useAssignedCoding(params));
  return { view, params, dirty };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
beforeEach(() => {
  mockSave.mockResolvedValue({ success: true, missingRequiredFields: [] });
});

describe("useAssignedCoding", () => {
  it("semeia respostas e notas das props (sem derived-useState)", () => {
    const { view } = setup({
      existingAnswers: { d1: { q: "a" } },
      existingJustifications: { d1: { _notes: "nota d1" } },
    });
    expect(view.result.current.currentDoc?.id).toBe("d1");
    expect(view.result.current.docAnswers).toEqual({ q: "a" });
    expect(view.result.current.docNotes).toBe("nota d1");
  });

  it("handleAnswer atualiza a resposta e marca sujo", () => {
    const { view, params } = setup();
    act(() => view.result.current.handleAnswer("q1", "sim"));
    expect(view.result.current.docAnswers).toEqual({ q1: "sim" });
    expect(params.markDirty).toHaveBeenCalledWith("d1");
  });

  it("handleSubmit avança o índice ao salvar com sucesso", async () => {
    const { view, params } = setup();
    act(() => view.result.current.handleAnswer("q1", "sim"));
    await act(async () => {
      await view.result.current.handleSubmit();
    });
    expect(mockSave).toHaveBeenCalledWith("p1", "d1", { q1: "sim" }, {
      notes: "",
    });
    expect(params.markClean).toHaveBeenCalledWith("d1");
    expect(view.result.current.currentDoc?.id).toBe("d2");
    expect(params.updateDocParam).toHaveBeenCalledWith("d2");
  });

  it("save com obrigatórias em aberto NÃO avança de documento", async () => {
    // Avançar tiraria a tela de baixo do aviso que acabou de pedir para
    // completar o documento — e ele reapareceria na fila depois, o sintoma
    // relatado como "minha codificação não salvou" (#519). O save em si teve
    // sucesso: markClean roda, só a navegação é que fica retida.
    mockSave.mockResolvedValue({ success: true, missingRequiredFields: ["q1", "q2"] });
    const { view, params } = setup();
    act(() => view.result.current.handleAnswer("q1", "sim"));
    await act(async () => {
      await view.result.current.handleSubmit();
    });
    expect(params.markClean).toHaveBeenCalledWith("d1");
    expect(view.result.current.currentDoc?.id).toBe("d1");
    expect(params.updateDocParam).not.toHaveBeenCalled();
    expect(view.result.current.allDone).toBe(false);
  });

  it("save sem pendência (lista vazia) avança normalmente", async () => {
    // Boundary com o teste acima: é o TAMANHO da lista — não a presença da
    // chave — que libera a navegação. `[]` é truthy em JS, então testar a lista
    // crua prenderia no documento quem completou a codificação.
    mockSave.mockResolvedValue({ success: true, missingRequiredFields: [] });
    const { view, params } = setup();
    act(() => view.result.current.handleAnswer("q1", "sim"));
    await act(async () => {
      await view.result.current.handleSubmit();
    });
    expect(view.result.current.currentDoc?.id).toBe("d2");
    expect(params.updateDocParam).toHaveBeenCalledWith("d2");
  });

  it("pendência no último documento não marca allDone", async () => {
    mockSave.mockResolvedValue({ success: true, missingRequiredFields: ["q1"] });
    const { view } = setup();
    act(() => view.result.current.handleDocNavigate(2)); // vai para d3 (último)
    act(() => view.result.current.handleAnswer("q1", "sim"));
    await act(async () => {
      await view.result.current.handleSubmit();
    });
    expect(view.result.current.allDone).toBe(false);
    expect(view.result.current.currentDoc?.id).toBe("d3");
  });

  it("mantém respostas e documento atual, e permite retry após rejeição de transporte", async () => {
    mockSave.mockRejectedValue(new Error("Failed to find Server Action"));
    const { view, params } = setup();
    act(() => view.result.current.handleAnswer("q1", "sim"));

    await act(async () => {
      await view.result.current.handleSubmit();
    });

    expect(view.result.current.docAnswers).toEqual({ q1: "sim" });
    expect(view.result.current.currentDoc?.id).toBe("d1");
    expect(params.updateDocParam).not.toHaveBeenCalled();
    expect(params.setSubmitting).toHaveBeenLastCalledWith(false);
    expect(toast.error).toHaveBeenCalledWith(CODING_SAVE_TRANSPORT_ERROR);

    mockSave.mockResolvedValue({ success: true, missingRequiredFields: [] });
    await act(async () => {
      await view.result.current.handleSubmit();
    });
    expect(mockSave).toHaveBeenCalledTimes(2);
    expect(view.result.current.currentDoc?.id).toBe("d2");
  });

  it("handleSubmit marca allDone no último documento", async () => {
    const { view } = setup();
    act(() => view.result.current.handleDocNavigate(2)); // vai para d3 (último)
    act(() => view.result.current.handleAnswer("q1", "sim"));
    await act(async () => {
      await view.result.current.handleSubmit();
    });
    expect(view.result.current.allDone).toBe(true);
  });

  // Invertido no #608, não apagado: era "handleDocNavigate autosalva o doc sujo
  // antes de trocar (#28)". A asserção continua guardando o mesmo ponto do
  // código — só que agora provando a ausência da escrita. Apagá-la deixaria o
  // critério "nenhuma gravação automática" sem guarda, e reintroduzir o autosave
  // não deixaria nada vermelho.
  it("navegar com o doc sujo NÃO grava no servidor; o conteúdo fica no rascunho", async () => {
    const { view, params } = setup();
    act(() => view.result.current.handleAnswer("q1", "sim")); // d1 fica sujo
    await act(async () => {
      view.result.current.handleDocNavigate(1);
    });
    expect(mockSave).not.toHaveBeenCalled();
    // O doc deixado segue marcado como não enviado: é o que mantém o indicador
    // aceso e o aviso de saída armado. Limpar aqui afirmaria "enviado" sobre
    // trabalho que ninguém enviou.
    expect(params.markClean).not.toHaveBeenCalled();
    // O registro no rascunho local é o que substitui a gravação: o conteúdo de
    // d1 continua recuperável depois da troca.
    expect(params.recordDraft).toHaveBeenCalledWith("d1", {
      answers: { q1: "sim" },
      notes: "",
    });
    expect(view.result.current.currentDoc?.id).toBe("d2");
    expect(params.updateDocParam).toHaveBeenCalledWith("d2");
  });

  it("navegar com o doc limpo também não grava", () => {
    const { view } = setup();
    act(() => view.result.current.handleDocNavigate(1));
    expect(mockSave).not.toHaveBeenCalled();
    expect(view.result.current.currentDoc?.id).toBe("d2");
  });

  it("trocar a ordenação com o doc sujo NÃO grava no servidor", () => {
    const { view, params } = setup();
    act(() => view.result.current.handleAnswer("q1", "sim"));
    act(() => view.result.current.handleSortChange("default"));
    expect(mockSave).not.toHaveBeenCalled();
    expect(params.markClean).not.toHaveBeenCalled();
  });

  // Regressão da mudança de comportamento intencional: sair da tela "Parabéns!"
  // ao navegar ou trocar a ordenação (o `case "index"` do reducer zera allDone).
  it("handleDocNavigate zera allDone (sai da tela Parabéns ao navegar)", async () => {
    const { view } = setup();
    act(() => view.result.current.handleDocNavigate(2)); // vai para d3 (último)
    act(() => view.result.current.handleAnswer("q1", "sim"));
    await act(async () => {
      await view.result.current.handleSubmit();
    });
    expect(view.result.current.allDone).toBe(true);

    act(() => view.result.current.handleDocNavigate(0)); // ◀ reabre o doc
    expect(view.result.current.allDone).toBe(false);
    expect(view.result.current.currentDoc?.id).toBe("d1");
  });

  it("handleSortChange zera allDone (sai da tela Parabéns ao reordenar)", async () => {
    const { view } = setup();
    act(() => view.result.current.handleDocNavigate(2)); // vai para d3 (último)
    act(() => view.result.current.handleAnswer("q1", "sim"));
    await act(async () => {
      await view.result.current.handleSubmit();
    });
    expect(view.result.current.allDone).toBe(true);

    act(() => view.result.current.handleSortChange("recent"));
    expect(view.result.current.allDone).toBe(false);
  });

  // Reconciliação com #252/#288: a limpeza de condicionais órfãs (antes no
  // CodingPage.handleAnswer) é reaplicada no reducer do modo Atribuídos.
  it("handleAnswer limpa a resposta de condicional órfã ao ocultar o pai (#252)", () => {
    const fields: PydanticField[] = [
      { name: "q1", type: "single", options: ["sim", "não"], description: "" },
      {
        name: "q2",
        type: "text",
        options: null,
        description: "",
        condition: { field: "q1", equals: "sim" },
      },
    ];
    const { view } = setup({ fields });
    // q1 = "sim" torna q2 visível; responde q2.
    act(() => view.result.current.handleAnswer("q1", "sim"));
    act(() => view.result.current.handleAnswer("q2", "detalhe"));
    expect(view.result.current.docAnswers).toEqual({ q1: "sim", q2: "detalhe" });
    // q1 = "não" oculta q2 → a resposta órfã de q2 é zerada para null.
    act(() => view.result.current.handleAnswer("q1", "não"));
    expect(view.result.current.docAnswers).toEqual({ q1: "não", q2: null });
  });

  it("duplo-clique em Enviar não duplica saveResponse (guarda de reentrância)", async () => {
    let resolveSave: (v: { success: true, missingRequiredFields: [] }) => void = () => {};
    mockSave.mockReturnValue(
      new Promise<{ success: true, missingRequiredFields: [] }>((r) => {
        resolveSave = r;
      }),
    );
    const { view } = setup({ existingAnswers: { d1: { q1: "sim" } } });

    // Dois envios antes do primeiro save em voo resolver: o segundo é barrado
    // pela guarda de reentrância, então saveResponse roda só uma vez.
    const p1 = view.result.current.handleSubmit();
    const p2 = view.result.current.handleSubmit();
    expect(mockSave).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSave({ success: true, missingRequiredFields: [] });
      await Promise.all([p1, p2]);
    });
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it("congela a edição enquanto submitting (não perde teclas no save em voo)", async () => {
    let resolveSave: (v: { success: true, missingRequiredFields: [] }) => void = () => {};
    mockSave.mockReturnValue(
      new Promise<{ success: true, missingRequiredFields: [] }>((r) => {
        resolveSave = r;
      }),
    );
    const { view, params } = setup({ existingAnswers: { d1: { q1: "sim" } } });

    // Save em voo → savingRef.current === true.
    const p = view.result.current.handleSubmit();
    expect(mockSave).toHaveBeenCalledTimes(1);

    // Edições durante o save são ignoradas: nada muda e markDirty não é chamado.
    act(() => view.result.current.handleAnswer("q2", "tarde demais"));
    act(() => view.result.current.handleNotesChange("nota tardia"));
    expect(view.result.current.docAnswers).toEqual({ q1: "sim" });
    expect(view.result.current.docNotes).toBe("");
    expect(params.markDirty).not.toHaveBeenCalled();

    await act(async () => {
      resolveSave({ success: true, missingRequiredFields: [] });
      await p;
    });
  });
});
