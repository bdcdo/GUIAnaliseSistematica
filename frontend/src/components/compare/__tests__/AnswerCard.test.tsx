// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AnswerCard } from "@/components/compare/AnswerCard";
import { TooltipProvider } from "@/components/ui/tooltip";

afterEach(cleanup);

function renderCard(props: Partial<Parameters<typeof AnswerCard>[0]> = {}) {
  const onVote = vi.fn();
  render(
    <TooltipProvider>
      <AnswerCard
        readOnly={false}
        index={0}
        displayAnswer="Deferido"
        respondentNames={["Ana"]}
        respondentCount={1}
        hasLlm={false}
        staleCount={0}
        isChosen={false}
        isPending={false}
        versions={["1.0.0"]}
        onVote={onVote}
        {...props}
      />
    </TooltipProvider>,
  );
  return { onVote };
}

describe("AnswerCard — overlay de voto", () => {
  it("vota ao clicar no card (overlay button) e ao acionar pelo teclado", async () => {
    const user = userEvent.setup();
    const { onVote } = renderCard();

    const voteButton = screen.getByRole("button", {
      name: /selecionar esta resposta para confirmar/i,
    });
    await user.click(voteButton);
    expect(onVote).toHaveBeenCalledTimes(1);

    voteButton.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onVote).toHaveBeenCalledTimes(3);
  });

  it("destaca visualmente a resposta preparada para confirmação", () => {
    renderCard({ isPending: true });

    expect(
      screen.getByRole("button", {
        name: /selecionar esta resposta para confirmar/i,
      }).parentElement?.className,
    ).toContain("border-brand");
  });

  it("seleciona o gabarito sem disparar o voto (não há mais aninhamento)", async () => {
    const user = userEvent.setup();
    const onSetGabarito = vi.fn();
    const { onVote } = renderCard({
      equivalenceMode: {
        selected: true,
        onToggle: vi.fn(),
        gabarito: { isGabarito: false, onSetGabarito },
      },
    });

    await user.click(screen.getByRole("radio"));
    expect(onSetGabarito).toHaveBeenCalledTimes(1);
    expect(onVote).not.toHaveBeenCalled();
  });

  it("alterna a seleção pelo checkbox sem disparar o voto", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const { onVote } = renderCard({
      equivalenceMode: { selected: false, onToggle },
    });

    await user.click(screen.getByRole("checkbox"));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onVote).not.toHaveBeenCalled();
  });

  it("oculta o radio de gabarito quando selecionado mas gabarito é null", () => {
    renderCard({
      equivalenceMode: { selected: true, onToggle: vi.fn(), gabarito: null },
    });

    // Ramo selecionado: o checkbox aparece marcado...
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe(
      "true",
    );
    // ...mas sem afordância de gabarito, o radio não é renderizado.
    expect(screen.queryByRole("radio")).toBeNull();
  });
});

// O segundo passo da confirmação passou a viver dentro do card que produziu o
// rascunho (#610).
describe("AnswerCard — slot de confirmação", () => {
  const slot = <button type="button">Confirmar</button>;

  it("renderiza o slot só no card preparado", () => {
    const { unmount } = render(
      <TooltipProvider>
        <AnswerCard
          readOnly={false}
          index={0}
          displayAnswer="Deferido"
          respondentNames={["Ana"]}
          respondentCount={1}
          hasLlm={false}
          staleCount={0}
          isChosen={false}
          isPending={false}
          versions={["1.0.0"]}
          onVote={vi.fn()}
          confirmSlot={slot}
        />
      </TooltipProvider>,
    );
    expect(screen.queryByRole("button", { name: "Confirmar" })).toBeNull();
    unmount();

    renderCard({ isPending: true, confirmSlot: slot });
    expect(screen.getByRole("button", { name: "Confirmar" })).not.toBeNull();
    expect(screen.getByTestId("answer-card").getAttribute("data-pending")).toBe(
      "true",
    );
  });

  // Guarda-corpo contra a "otimização" tentadora de fazer o segundo clique no
  // card confirmar: isso transformaria um duplo-clique acidental em escrita,
  // que é exatamente o que o #417 fechou. Clicar no corpo re-prepara, e só o
  // controle DISTINTO confirma.
  it("o clique no corpo do card re-prepara — não confirma", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const { onVote } = renderCard({
      isPending: true,
      confirmSlot: (
        <button type="button" onClick={onConfirm}>
          Confirmar
        </button>
      ),
    });

    await user.click(
      screen.getByRole("button", {
        name: /selecionar esta resposta para confirmar/i,
      }),
    );

    expect(onVote).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
