// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AgreementGroup } from "@/components/compare/AgreementGroup";

afterEach(cleanup);

type Resp = Parameters<typeof AgreementGroup>[0]["responses"][number];

function resp(over: Partial<Resp> & { id: string; answer: unknown }): Resp {
  return {
    respondent_type: "humano",
    respondent_name: "Anon",
    is_latest: true,
    isFieldStale: false,
    ...over,
  } as Resp;
}

function renderGroup() {
  render(
    <AgreementGroup
      readOnly={false}
      responses={[
        resp({ id: "a", respondent_name: "Ana", answer: "Alfa" }),
        resp({ id: "b", respondent_name: "Bia", answer: "Beta" }),
        resp({ id: "c", respondent_name: "Caio", answer: "Gama" }),
      ]}
      existingVerdict={null}
      pendingVerdict={null}
      onVote={vi.fn()}
      allowEquivalence={true}
      equivalences={[]}
      onConfirmEquivalent={vi.fn(async () => {})}
      onUnmarkPair={vi.fn(async () => {})}
      currentUserId="u1"
      canManageAnyPair={false}
      pendingConfirm={{
        onConfirm: vi.fn(),
        onDiscard: vi.fn(),
        isSaving: false,
      }}
    />,
  );
}

function gabaritoLabel() {
  // O rodapé exibe "Gabarito: <resposta>"; o valor fica no <span> irmão.
  return screen.getByText(/^Gabarito:/).textContent ?? "";
}

/**
 * Cobre a saída do `setGabaritoOverride` de dentro do updater de
 * `setSelectionOrder` (react-doctor `no-impure-state-updater`, 0.7.8): o reset
 * do gabarito ao desmarcar o grupo escolhido passou a rodar no nível do
 * handler. O comportamento observável não pode mudar.
 */
describe("AgreementGroup — desmarcar o grupo que é gabarito", () => {
  // Discriminador: desmarcar sozinho não prova o reset, porque
  // `effectiveGabarito` já ignora um override fora de `selectionOrder`. O que
  // só o reset garante é que **remarcar** o grupo não ressuscite o override
  // antigo — sem ele, Beta voltaria a gabarito mesmo entrando por último.
  it("não ressuscita o gabarito antigo ao remarcar o grupo desmarcado", async () => {
    const user = userEvent.setup();
    renderGroup();

    const checkboxes = screen.getAllByRole("checkbox", {
      name: /selecionar para marcar como equivalente/i,
    });
    // Os três: a barra de gabarito só aparece com 2+ selecionados, e precisa
    // continuar visível depois de desmarcar um. O default é o primeiro da
    // ordem de seleção (Alfa).
    await user.click(checkboxes[0]);
    await user.click(checkboxes[1]);
    await user.click(checkboxes[2]);
    expect(gabaritoLabel()).toContain("Alfa");

    // Promove Beta a gabarito pelo radio do próprio card.
    await user.click(screen.getAllByRole("radio")[1]);
    expect(gabaritoLabel()).toContain("Beta");

    // Desmarcar Beta precisa limpar o override — senão o gabarito apontaria
    // para um grupo que não está mais na seleção.
    await user.click(
      screen.getAllByRole("checkbox", {
        name: /selecionar para marcar como equivalente/i,
      })[1],
    );

    expect(gabaritoLabel()).not.toContain("Beta");
    expect(gabaritoLabel()).toContain("Alfa");

    // Remarcar Beta: ela entra no fim da ordem, então o gabarito segue Alfa.
    await user.click(
      screen.getAllByRole("checkbox", {
        name: /selecionar para marcar como equivalente/i,
      })[1],
    );

    expect(gabaritoLabel()).toContain("Alfa");
    expect(gabaritoLabel()).not.toContain("Beta");
  });

  it("preserva o override ao desmarcar um grupo que não é o gabarito", async () => {
    const user = userEvent.setup();
    renderGroup();

    const checkboxes = screen.getAllByRole("checkbox", {
      name: /selecionar para marcar como equivalente/i,
    });
    await user.click(checkboxes[0]); // Alfa
    await user.click(checkboxes[1]); // Beta
    await user.click(checkboxes[2]); // Gama

    // Gama vira gabarito.
    await user.click(screen.getAllByRole("radio")[2]);
    expect(gabaritoLabel()).toContain("Gama");

    // Desmarcar Beta não pode derrubar o gabarito escolhido.
    await user.click(
      screen.getAllByRole("checkbox", {
        name: /selecionar para marcar como equivalente/i,
      })[1],
    );

    expect(gabaritoLabel()).toContain("Gama");
  });
});
