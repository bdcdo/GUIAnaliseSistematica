// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import { FieldHeaderLabel } from "@/components/shared/FieldHeaderLabel";

afterEach(cleanup);

describe("FieldHeaderLabel", () => {
  it("renders the prefix and description", () => {
    render(
      <FieldHeaderLabel prefix="Campo 1/3:">Data do parecer</FieldHeaderLabel>,
    );
    expect(screen.getByText("Campo 1/3:")).toBeTruthy();
    expect(screen.getByText("Data do parecer")).toBeTruthy();
  });

  it("renders help text when present", () => {
    render(
      <FieldHeaderLabel prefix="Campo 1/3:" helpText="Considere apenas o dispositivo final.">
        Data do parecer
      </FieldHeaderLabel>,
    );
    expect(
      screen.getByText("Considere apenas o dispositivo final."),
    ).toBeTruthy();
  });

  it("renders nothing extra when help text is absent", () => {
    const { container } = render(
      <FieldHeaderLabel prefix="Campo 1/3:">Data do parecer</FieldHeaderLabel>,
    );
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });

  it("renders nothing extra when help text is an empty string", () => {
    const { container } = render(
      <FieldHeaderLabel prefix="Campo 1/3:" helpText="">
        Data do parecer
      </FieldHeaderLabel>,
    );
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });

  // Só vale para `density: flow`; na Comparação o help_text não vive no fluxo,
  // e a cobertura de lá está em ComparisonPanel.unanswered.test.tsx.
  it("bounds the help text block height with the provided className (flow)", () => {
    render(
      <FieldHeaderLabel
        prefix="Campo 1/3:"
        helpText="Texto longo de orientação para o pesquisador."
        helpTextClassName="max-h-28 overflow-y-auto"
      >
        Data do parecer
      </FieldHeaderLabel>,
    );
    const helpText = screen.getByText(
      "Texto longo de orientação para o pesquisador.",
    );
    expect(helpText.className).toContain("max-h-28");
    expect(helpText.className).toContain("overflow-y-auto");
  });
});

describe("FieldHeaderLabel — densidade", () => {
  const HELP = "Considere apenas o dispositivo final.";

  // A guarda mais importante do arquivo: a Codificação usa este componente
  // como item de lista rolável, onde o enunciado É a pergunta que se está
  // respondendo. Trocar o default para `fixed` — a "uniformização" tentadora —
  // clamparia a pergunta no momento de respondê-la. Este caso fica vermelho se
  // isso acontecer.
  it("sem density, o default é flow: sem clamp e com help_text no fluxo", () => {
    const { container } = render(
      <FieldHeaderLabel prefix="Campo 1/3:" helpText={HELP}>
        Data do parecer
      </FieldHeaderLabel>,
    );
    expect(container.querySelectorAll("p")).toHaveLength(2);
    expect(screen.getByText(HELP)).toBeTruthy();
    expect(container.querySelector("p")!.className).not.toContain("line-clamp");
  });

  it("fixed clampa em duas linhas com altura reservada e expõe o texto integral", () => {
    const { container } = render(
      <FieldHeaderLabel
        prefix="Campo 1/3:"
        density={{
          kind: "fixed",
          clampLines: 2,
          fullText: "Data do parecer administrativo",
        }}
      >
        Data do parecer administrativo
      </FieldHeaderLabel>,
    );
    const label = container.querySelector("p")!;
    expect(label.className).toContain("line-clamp-2");
    // O clamp limita o teto; é o min-h que RESERVA as duas linhas e zera a
    // variação de altura entre campos. Sem ele o critério 1 da #610 cai.
    expect(label.className).toContain("min-h-10");
    expect(label.getAttribute("title")).toBe("Data do parecer administrativo");
  });

  it("fixed tira o help_text do fluxo e o troca por um gatilho", () => {
    const { container } = render(
      <FieldHeaderLabel
        prefix="Campo 1/3:"
        helpText={HELP}
        density={{ kind: "fixed", clampLines: 2, fullText: "Data do parecer" }}
      >
        Data do parecer
      </FieldHeaderLabel>,
    );
    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(screen.queryByText(HELP)).toBeNull();
    expect(
      screen.getByRole("button", {
        name: /instruções de preenchimento do campo/i,
      }),
    ).toBeTruthy();
  });

  it("fixed sem help_text não renderiza o gatilho", () => {
    render(
      <FieldHeaderLabel
        prefix="Campo 1/3:"
        density={{ kind: "fixed", clampLines: 2, fullText: "Data do parecer" }}
      >
        Data do parecer
      </FieldHeaderLabel>,
    );
    expect(
      screen.queryByRole("button", {
        name: /instruções de preenchimento do campo/i,
      }),
    ).toBeNull();
  });
});
