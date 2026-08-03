// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LotteryPreview } from "@/actions/assignments";
import { LotteryPreviewSection } from "../LotteryPreviewSection";

const emptyPreview: LotteryPreview = {
  participants: [{ userId: "u1", existing: 1, newDocs: 0 }],
  totalNew: 0,
  totalPreserved: 1,
  eligibleDocs: 1,
  unfilledSlots: 1,
  seed: 4242,
  emptyReason: "capacity_exhausted",
};

afterEach(cleanup);

describe("LotteryPreviewSection", () => {
  it("mantém a prévia acionável quando o resultado vazio bloqueia o sorteio", () => {
    render(
      <LotteryPreviewSection
        preview={emptyPreview}
        members={[{ userId: "u1", name: "Ana", role: "pesquisador" }]}
        run={{
          previewing: false,
          loading: false,
          canPreview: true,
          canSubmit: false,
          onPreview: vi.fn(),
          onRandomize: vi.fn(),
        }}
      />,
    );

    const previewButton = screen.getByRole("button", { name: "Visualizar prévia" });
    const randomizeButton = screen.getByRole("button", { name: "Sortear" });

    expect((previewButton as HTMLButtonElement).disabled).toBe(false);
    expect((randomizeButton as HTMLButtonElement).disabled).toBe(true);
  });
});
