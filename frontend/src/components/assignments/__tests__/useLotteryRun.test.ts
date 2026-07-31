// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { previewLottery, smartRandomize } from "@/actions/assignments";
import type { LotteryPreview } from "@/actions/assignments";
import type { LotteryDocStats } from "@/lib/lottery-utils";
import { useLotteryParams } from "../useLotteryParams";
import { useLotteryRun } from "../useLotteryRun";
import type { LotteryMember, LotteryStats } from "../lottery-dialog-types";

vi.mock("@/actions/assignments", () => ({
  previewLottery: vi.fn(),
  smartRandomize: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockPreview = vi.mocked(previewLottery);
const mockRandomize = vi.mocked(smartRandomize);

function doc(id: string, overrides?: Partial<LotteryDocStats>): LotteryDocStats {
  return {
    id,
    externalId: null,
    title: `Doc ${id}`,
    humanCodingCount: 0,
    hasLlmResponse: false,
    activeAssignments: { codificacao: 0, comparacao: 0 },
    hasAnyAssignmentEver: false,
    batchIds: [],
    ...overrides,
  };
}

const members: LotteryMember[] = [
  { userId: "u1", name: "Ana", role: "pesquisador" },
  { userId: "u2", name: "Beto", role: "pesquisador" },
  { userId: "u3", name: "Carla", role: "coordenador" },
];

const stats: LotteryStats = {
  docs: [doc("d1"), doc("d2", { humanCodingCount: 1 }), doc("d3")],
  batches: [],
  minResponsesForComparison: 2,
  automationMode: null,
  currentRoundId: "round-1",
  currentRoundLabel: "Rodada inicial",
  openAssignmentCount: 0,
};

const previewResult: LotteryPreview = {
  participants: [{ userId: "u1", existing: 0, newDocs: 2 }],
  totalNew: 2,
  totalPreserved: 0,
  eligibleDocs: 3,
  seed: 4242,
};

// Integra useLotteryParams + useLotteryRun como no LotteryDialog real —
// o contrato sob teste é o casamento prévia↔configuração (research D13).
function setup(statsOverride: LotteryStats = stats) {
  return renderHook(() => {
    const params = useLotteryParams();
    const run = useLotteryRun({
      projectId: "p1",
      members,
      stats: statsOverride,
      params,
      onLotteryDone: vi.fn(),
    });
    return { params, run };
  });
}

beforeEach(() => {
  mockPreview.mockResolvedValue({ preview: previewResult });
  mockRandomize.mockResolvedValue({ count: 2, preserved: 0 });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useLotteryRun", () => {
  it("deriva contagens: pesquisadores participam por default, coordenador não", () => {
    const { result } = setup();
    expect(result.current.run.participantCount).toBe(2);
    expect(result.current.run.eligibleCount).toBe(3);
    expect(result.current.run.canSubmit).toBe(true);
  });

  it("bloqueia quando os filtros zeram os elegíveis", () => {
    const { result } = setup();
    act(() => {
      // "Sem nenhuma codificação" + docs com codificação → só d1 e d3;
      // seleção manual vazia zera tudo.
      result.current.params.setManualEnabled(true);
    });
    expect(result.current.run.eligibleCount).toBe(0);
    expect(result.current.run.blockedMessage).toBe(
      "Nenhum documento passa nos filtros atuais.",
    );
    expect(result.current.run.canSubmit).toBe(false);
  });

  it("mudar a configuração invalida a prévia (e a seed) por derivação", async () => {
    const { result } = setup();
    await act(() => result.current.run.handlePreview());
    expect(result.current.run.preview).toEqual(previewResult);

    act(() => {
      result.current.params.setResearchersPerDoc(3);
    });
    expect(result.current.run.preview).toBeNull();
  });

  it("o rótulo não invalida a prévia, mas entra no submit", async () => {
    const { result } = setup();
    await act(() => result.current.run.handlePreview());
    act(() => {
      result.current.params.setLabel("Lote 7");
    });
    expect(result.current.run.preview).toEqual(previewResult);

    await act(() => result.current.run.handleRandomize());
    expect(mockRandomize).toHaveBeenCalledWith(
      expect.objectContaining({ label: "Lote 7" }),
    );
  });

  it("sortear após a prévia reaproveita a seed; sem prévia, vai sem seed", async () => {
    const { result } = setup();
    await act(() => result.current.run.handlePreview());
    expect(mockPreview).toHaveBeenCalledWith(
      expect.objectContaining({ seed: undefined }),
    );

    await act(() => result.current.run.handleRandomize());
    expect(mockRandomize).toHaveBeenCalledWith(
      expect.objectContaining({ seed: 4242 }),
    );

    // Nova rodada sem prévia válida: mudança de config descartou a seed.
    act(() => {
      result.current.params.setResearchersPerDoc(3);
    });
    await act(() => result.current.run.handleRandomize());
    expect(mockRandomize).toHaveBeenLastCalledWith(
      expect.objectContaining({ seed: undefined }),
    );
  });

  it("sucesso do sorteio limpa a prévia e chama onLotteryDone", async () => {
    const onLotteryDone = vi.fn();
    const { result } = renderHook(() => {
      const params = useLotteryParams();
      const run = useLotteryRun({
        projectId: "p1",
        members,
        stats,
        params,
        onLotteryDone,
      });
      return { params, run };
    });
    await act(() => result.current.run.handlePreview());
    await act(() => result.current.run.handleRandomize());
    expect(onLotteryDone).toHaveBeenCalledOnce();
    expect(result.current.params.previewState).toBeNull();
  });
});

// Regressão da issue #490: o RadioGroup de tipo vive no mesmo dialog montado, e
// o state de revisores/pesquisadores por documento é o mesmo dos dois lados —
// marcar "Comparação" levava o default 2 da Codificação junto.
describe("useLotteryRun: um revisor por documento na comparação (#490)", () => {
  // A fixture global tem docs com 0/1 codificação e piso 2 → comparação zeraria
  // os elegíveis e o submit nem sairia. Aqui os docs estão aptos a comparar.
  const comparableStats: LotteryStats = {
    ...stats,
    docs: [
      doc("d1", { humanCodingCount: 2 }),
      doc("d2", { humanCodingCount: 2 }),
      doc("d3", { humanCodingCount: 2 }),
    ],
  };

  it("trocar para comparação não herda o valor digitado na codificação", async () => {
    const { result } = setup(comparableStats);
    act(() => {
      result.current.params.setResearchersPerDoc(3);
      result.current.params.setType("comparacao");
    });

    await act(() => result.current.run.handleRandomize());

    const enviado = mockRandomize.mock.calls.at(-1)![0];
    expect(enviado).toMatchObject({ type: "comparacao" });
    // O braço "comparacao" da união nem carrega o campo: não há valor a herdar.
    expect(enviado).not.toHaveProperty("researchersPerDoc");
  });

  it("voltar para codificação restaura o valor digitado", async () => {
    const { result } = setup(comparableStats);
    act(() => {
      result.current.params.setResearchersPerDoc(3);
      result.current.params.setType("comparacao");
    });
    act(() => {
      result.current.params.setType("codificacao");
    });

    await act(() => result.current.run.handleRandomize());

    expect(mockRandomize).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "codificacao", researchersPerDoc: 3 }),
    );
  });

  it("codificação envia o default 2 sem o coordenador tocar no campo", async () => {
    const { result } = setup(comparableStats);
    await act(() => result.current.run.handleRandomize());

    expect(mockRandomize).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "codificacao", researchersPerDoc: 2 }),
    );
  });

  it("a estimativa por participante usa um revisor por documento", () => {
    const { result } = setup(comparableStats);
    // Codificação: 3 docs × 2 pesquisadores por doc ÷ 2 participantes = 3.
    expect(result.current.run.estimatedPerParticipant).toBe(3);

    act(() => {
      result.current.params.setType("comparacao");
    });
    // Comparação: 3 docs × 1 revisor ÷ 2 participantes = 2 (arredondado p/ cima).
    expect(result.current.run.estimatedPerParticipant).toBe(2);
  });
});
