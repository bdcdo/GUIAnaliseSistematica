// @vitest-environment jsdom
//
// Cobertura de regressão para a issue #366 ("não tá indo a resposta da
// equivalencia"): antes da PR #362, os handlers deste hook chamavam
// `recordReview`/`goNextField` (escrita otimista) sem antes checar se a
// Server Action tinha de fato falhado — e a Action lançava Error, mascarado
// pelo Next 16 em produção, então o handler nunca chegava a ver o erro. Hoje
// as três actions retornam `{ error? }`; estes testes travam que a escrita
// otimista só ocorre quando `result.error` é ausente.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { submitVerdict, markCompareDocReviewed } from "@/actions/reviews";
import {
  confirmEquivalentVerdict,
  unmarkEquivalencePair,
} from "@/actions/equivalences";
import { useCompareVerdicts } from "../useCompareVerdicts";
import type { FieldResponse } from "../compare-types";
import type { VerdictInfo } from "@/lib/compare-reviews";
import { doc } from "./compare-test-helpers";

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/actions/reviews", () => ({
  submitVerdict: vi.fn(),
  markCompareDocReviewed: vi.fn(),
}));
vi.mock("@/actions/equivalences", () => ({
  confirmEquivalentVerdict: vi.fn(),
  unmarkEquivalencePair: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

const mockSubmitVerdict = vi.mocked(submitVerdict);
const mockMarkReviewed = vi.mocked(markCompareDocReviewed);
const mockConfirmEquivalent = vi.mocked(confirmEquivalentVerdict);
const mockUnmarkPair = vi.mocked(unmarkEquivalencePair);

const DOC = doc("doc1", "Doc 1", "texto");
/** Origem que CASA com (currentDoc, currentFieldName) do `setup` abaixo. */
const ORIGIN = { documentId: "doc1", fieldName: "q1" };

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

/** Nenhuma escrita otimista: a Server Action retornou `{ error }`. */
function expectNoOptimisticWrite(
  recordReview: ReturnType<typeof vi.fn>,
  goNextField: ReturnType<typeof vi.fn>,
  message: string,
) {
  expect(recordReview).not.toHaveBeenCalled();
  expect(goNextField).not.toHaveBeenCalled();
  expect(toastError).toHaveBeenCalledWith(message);
}

/** Escrita otimista após sucesso da Server Action + avanço de campo. */
function expectOptimisticWrite(
  recordReview: ReturnType<typeof vi.fn>,
  goNextField: ReturnType<typeof vi.fn>,
  docId: string,
  fieldName: string,
  info: VerdictInfo,
) {
  expect(recordReview).toHaveBeenCalledWith(docId, fieldName, info);
  expect(goNextField).toHaveBeenCalledTimes(1);
}

function setup(readOnly = false) {
  const recordReview = vi.fn();
  const goNextField = vi.fn();
  const { result } = renderHook(() =>
    useCompareVerdicts({
      readOnly,
      projectId: "p1",
      currentDoc: DOC,
      currentFieldName: "q1",
      isCurrentFieldDivergent: true,
      allDocDivergent: ["q1", "q2"],
      localReviews: {},
      fieldResponses: [] as FieldResponse[],
      comment: "",
      recordReview,
      goNextField,
    }),
  );
  return { result, recordReview, goNextField };
}

describe("modo somente leitura", () => {
  it("recusa os quatro handlers antes de chamar qualquer Server Action", async () => {
    const { result, recordReview, goNextField } = setup(true);

    await act(async () => {
      await result.current.handleVerdict(ORIGIN, "concordo", "r1");
      await result.current.handleConfirmEquivalent(
        ORIGIN,
        ["r1", "r2"],
        "r1",
        "fundida",
      );
      await result.current.handleMarkReviewed();
      await result.current.handleUnmarkPair("pair1");
    });

    expect(mockSubmitVerdict).not.toHaveBeenCalled();
    expect(mockConfirmEquivalent).not.toHaveBeenCalled();
    expect(mockMarkReviewed).not.toHaveBeenCalled();
    expect(mockUnmarkPair).not.toHaveBeenCalled();
    expect(recordReview).not.toHaveBeenCalled();
    expect(goNextField).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    // As duas ESCRITAS de veredito passaram a avisar em vez de recusar em
    // silêncio (#613): os controles já nascem `disabled` em somente-leitura, e
    // um deles ter chamado o handler mesmo assim é um bug que queremos ver.
    // `handleMarkReviewed`/`handleUnmarkPair` seguem silenciosos.
    expect(toastError).toHaveBeenCalledTimes(2);
    expect(toastError).toHaveBeenCalledWith(
      "Modo somente leitura: nenhuma decisão é registrada.",
      expect.objectContaining({ id: "compare-write-blocked-read-only" }),
    );
  });
});

// Defesa em profundidade da #613: mesmo com os cards do campo anterior ainda no
// DOM, uma decisão tomada num campo não pode ser gravada em outro. O guard vive
// aqui — a fronteira de escrita — e não só no container, porque é aqui que os
// dois vetores (veredito regular e equivalência) se encontram.
describe("origem divergente do campo atual", () => {
  const OUTRO_CAMPO = { documentId: "doc1", fieldName: "q_anterior" };
  let consoleError: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleError.mockRestore();
  });

  it("handleVerdict recusa antes da Server Action e devolve false", async () => {
    const { result, recordReview, goNextField } = setup();
    let returned: boolean | undefined;

    await act(async () => {
      returned = await result.current.handleVerdict(
        OUTRO_CAMPO,
        "ALFA-opcao-1",
        "r1",
      );
    });

    expect(returned).toBe(false);
    expect(mockSubmitVerdict).not.toHaveBeenCalled();
    expect(recordReview).not.toHaveBeenCalled();
    expect(goNextField).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("pertence a outro campo"),
      expect.objectContaining({ id: "compare-write-blocked-origin-mismatch" }),
    );
  });

  it("handleConfirmEquivalent recusa antes da Server Action", async () => {
    const { result, recordReview, goNextField } = setup();

    await act(async () => {
      await result.current.handleConfirmEquivalent(
        OUTRO_CAMPO,
        ["r1", "r2"],
        "r1",
        "fundida",
      );
    });

    expect(mockConfirmEquivalent).not.toHaveBeenCalled();
    expect(recordReview).not.toHaveBeenCalled();
    expect(goNextField).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("pertence a outro campo"),
      expect.objectContaining({ id: "compare-write-blocked-origin-mismatch" }),
    );
  });

  it("documento divergente com o MESMO nome de campo também é recusado", async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.handleVerdict(
        { documentId: "outro-doc", fieldName: "q1" },
        "concordo",
        "r1",
      );
    });

    expect(mockSubmitVerdict).not.toHaveBeenCalled();
  });
});

describe("handleVerdict", () => {
  it("submitVerdict retorna { error } → não grava otimista, não avança, mostra toast.error", async () => {
    mockSubmitVerdict.mockResolvedValue({ error: "falhou" });
    const { result, recordReview, goNextField } = setup();

    await act(async () => {
      await result.current.handleVerdict(ORIGIN, "concordo", "r1");
    });

    expectNoOptimisticWrite(recordReview, goNextField, "falhou");
  });

  it("sucesso → grava o veredito otimista e avança de campo", async () => {
    mockSubmitVerdict.mockResolvedValue({});
    const { result, recordReview, goNextField } = setup();

    await act(async () => {
      await result.current.handleVerdict(ORIGIN, "concordo", "r1");
    });

    expectOptimisticWrite(recordReview, goNextField, "doc1", "q1", {
      verdict: "concordo",
      chosenResponseId: "r1",
      comment: null,
    });
  });
});

describe("handleConfirmEquivalent — o caminho da issue #366", () => {
  it("confirmEquivalentVerdict retorna { error } → não grava otimista, não avança, mostra toast.error", async () => {
    mockConfirmEquivalent.mockResolvedValue({ error: "não foi" });
    const { result, recordReview, goNextField } = setup();

    await act(async () => {
      await result.current.handleConfirmEquivalent(
        ORIGIN,
        ["r1", "r2"],
        "r1",
        "fundida",
      );
    });

    expectNoOptimisticWrite(recordReview, goNextField, "não foi");
  });

  it("sucesso → grava o gabarito como veredito otimista e avança de campo", async () => {
    mockConfirmEquivalent.mockResolvedValue({});
    const { result, recordReview, goNextField } = setup();

    await act(async () => {
      await result.current.handleConfirmEquivalent(
        ORIGIN,
        ["r1", "r2"],
        "r1",
        "fundida",
      );
    });

    expectOptimisticWrite(recordReview, goNextField, "doc1", "q1", {
      verdict: "fundida",
      chosenResponseId: "r1",
      comment: null,
    });
  });
});

describe("handleUnmarkPair", () => {
  it("unmarkEquivalencePair retorna { error } → mostra toast.error", async () => {
    mockUnmarkPair.mockResolvedValue({ error: "não desfez" });
    const { result } = setup();

    await act(async () => {
      await result.current.handleUnmarkPair("pair1");
    });

    expect(toastError).toHaveBeenCalledWith("não desfez");
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("sucesso → mostra toast.success", async () => {
    mockUnmarkPair.mockResolvedValue({});
    const { result } = setup();

    await act(async () => {
      await result.current.handleUnmarkPair("pair1");
    });

    expect(toastSuccess).toHaveBeenCalledWith("Equivalência removida.");
  });
});

describe("handleMarkReviewed", () => {
  it("markCompareDocReviewed retorna { error } → mostra toast.error", async () => {
    mockMarkReviewed.mockResolvedValue({ error: "não marcou" });
    const { result } = setup();

    await act(async () => {
      await result.current.handleMarkReviewed();
    });

    expect(toastError).toHaveBeenCalledWith("não marcou");
  });
});

describe("rejeição da Server Action (fora do try dela) → toast.error, sem escrita otimista", () => {
  // Regressão do padrão do PR #417 estendido aos quatro handlers: uma
  // rejeição (vs. retorno { error }) era descartada pelo `void` do call site
  // — silêncio total. Cada handler precisa capturar e avisar.
  let consoleError: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleError.mockRestore();
  });

  it("handleVerdict", async () => {
    mockSubmitVerdict.mockRejectedValue(new Error("rede caiu"));
    const { result, recordReview, goNextField } = setup();

    await act(async () => {
      await result.current.handleVerdict(ORIGIN, "concordo", "r1");
    });

    expect(recordReview).not.toHaveBeenCalled();
    expect(goNextField).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("handleConfirmEquivalent", async () => {
    mockConfirmEquivalent.mockRejectedValue(new Error("rede caiu"));
    const { result, recordReview, goNextField } = setup();

    await act(async () => {
      await result.current.handleConfirmEquivalent(
        ORIGIN,
        ["r1", "r2"],
        "r1",
        "fundida",
      );
    });

    expect(recordReview).not.toHaveBeenCalled();
    expect(goNextField).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("handleMarkReviewed", async () => {
    mockMarkReviewed.mockRejectedValue(new Error("rede caiu"));
    const { result } = setup();

    await act(async () => {
      await result.current.handleMarkReviewed();
    });

    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("handleUnmarkPair", async () => {
    mockUnmarkPair.mockRejectedValue(new Error("rede caiu"));
    const { result } = setup();

    await act(async () => {
      await result.current.handleUnmarkPair("pair1");
    });

    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
  });
});
