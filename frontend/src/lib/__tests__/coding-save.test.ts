import { describe, it, expect, vi, beforeEach } from "vitest";
import { saveResponse } from "@/actions/responses";
import {
  saveCodingResponse,
  CODING_SAVE_TRANSPORT_ERROR,
} from "@/lib/coding-save";

vi.mock("@/actions/responses", () => ({ saveResponse: vi.fn() }));

const mockSave = vi.mocked(saveResponse);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("saveCodingResponse", () => {
  it("normaliza a rejeição de transporte para o contrato de falha", async () => {
    mockSave.mockRejectedValue(new Error("Failed to find Server Action"));

    const result = await saveCodingResponse("p1", "d1", { q: "sim" }, {
      expectedRoundId: "round-1",
    });

    expect(result).toEqual({
      success: false,
      error: CODING_SAVE_TRANSPORT_ERROR,
    });
  });

  it("devolve a falha do handler sem reescrevê-la como erro de transporte", async () => {
    mockSave.mockResolvedValue({
      success: false,
      error: "Documento removido do escopo do projeto",
    });

    const result = await saveCodingResponse("p1", "d1", { q: "sim" }, {
      expectedRoundId: "round-1",
    });

    expect(result).toEqual({
      success: false,
      error: "Documento removido do escopo do projeto",
    });
  });
});
