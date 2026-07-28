// @vitest-environment jsdom
import { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Filhos que tocam Server Actions / dialogs ficam fora do escopo: este teste
// cobre só o fluxo de "resposta nova" (issue #247, ponto 4).
vi.mock("@/components/shared/AddNoteButton", () => ({
  AddNoteButton: () => <button type="button">Anotar</button>,
}));
vi.mock("@/components/stats/SuggestFieldDialog", () => ({
  SuggestFieldDialog: () => null,
}));

import { ComparisonPanel } from "@/components/compare/ComparisonPanel";
import type { PydanticField } from "@/lib/types";
import { panelProps, panelResponse } from "./compare-test-helpers";

afterEach(cleanup);

/** Casa com o (documentId, fieldName) do painel montado abaixo. */
const PANEL_ORIGIN = { documentId: "d1", fieldName: "data_parecer" };

const FIELD: PydanticField = {
  name: "data_parecer",
  type: "date",
  description: "Data do parecer",
} as PydanticField;

function renderPanel(
  props: Partial<Parameters<typeof ComparisonPanel>[0]> = {},
) {
  const onVerdict = vi.fn();
  // `pendingVerdict` do chamador é só o estado INICIAL: o spread não pode
  // sobrescrever o valor stateful, senão preparar/descartar não re-renderiza.
  const {
    pendingVerdict: initialPendingVerdict,
    readOnly = false,
    ...staticProps
  } = props;

  function Harness() {
    const [pendingVerdict, setPendingVerdict] =
      useState<Parameters<typeof ComparisonPanel>[0]["pendingVerdict"]>(
        initialPendingVerdict ?? null,
      );
    return (
      <ComparisonPanel
        {...panelProps({
          readOnly,
          documentTitle: "Nota técnica 1",
          fieldName: "data_parecer",
          fieldDescription: "Data do parecer",
          fieldType: "date",
          fields: [FIELD],
          responses: [
            panelResponse({
              id: "r-llm",
              respondent_type: "llm",
              respondent_name: "Robô",
              answer: "2021-05-10",
            }),
          ],
          onVerdict,
          // Estes três são o harness stateful deste arquivo: precisam do
          // `pendingVerdict` local, então não vêm do builder compartilhado.
          pendingVerdict,
          onPrepareVerdict: setPendingVerdict,
          onConfirmPendingVerdict: () => {
            if (pendingVerdict) {
              onVerdict(
                pendingVerdict.verdict,
                pendingVerdict.kind === "response"
                  ? pendingVerdict.chosenResponseId
                  : undefined,
              );
            }
          },
          onDiscardPendingVerdict: () => setPendingVerdict(null),
        })}
        {...staticProps}
      />
    );
  }

  render(<Harness />);
  return { onVerdict };
}

describe("ComparisonPanel — confirmação pendente", () => {
  it("mantém caminho de confirmação ao revisitar documento concluído", async () => {
    const user = userEvent.setup();
    const onConfirmPendingVerdict = vi.fn();

    renderPanel({
      docStatus: { complete: true, hasNextDoc: false, onNextDoc: vi.fn() },
      pendingVerdict: {
        kind: "response",
        verdict: "2021-05-10",
        chosenResponseId: "r-llm",
        origin: PANEL_ORIGIN,
      },
      onConfirmPendingVerdict,
    });

    await user.click(screen.getByRole("button", { name: /^confirmar$/i }));

    expect(onConfirmPendingVerdict).toHaveBeenCalledTimes(1);
  });

  it("'Descartar' aparece só com rascunho e fica desabilitado durante o salvamento", async () => {
    const user = userEvent.setup();

    renderPanel({
      pendingVerdict: {
        kind: "response",
        verdict: "2021-05-10",
        chosenResponseId: "r-llm",
        origin: PANEL_ORIGIN,
      },
    });

    // Com rascunho e sem save em voo: Descartar limpa a seleção (o Harness
    // espelha o container: onDiscardPendingVerdict → setPendingVerdict(null)).
    const discard = screen.getByRole("button", { name: /^descartar$/i });
    expect((discard as HTMLButtonElement).disabled).toBe(false);
    await user.click(discard);
    expect(screen.queryByRole("button", { name: /^descartar$/i })).toBeNull();
    expect(screen.queryByText("Selecionado:")).toBeNull();

    cleanup();

    // Durante o in-flight, descartar deixaria a UI sem referente do save em
    // andamento — o botão desabilita junto com o Confirmar.
    renderPanel({
      pendingVerdict: {
        kind: "response",
        verdict: "2021-05-10",
        chosenResponseId: "r-llm",
        origin: PANEL_ORIGIN,
      },
      isSavingVerdict: true,
    });
    expect(
      (screen.getByRole("button", { name: /^descartar$/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe("ComparisonPanel — modo somente leitura", () => {
  it("desabilita a conclusão manual de documento concordante", () => {
    renderPanel({ readOnly: true, isDivergent: false });

    expect(
      (
        screen.getByRole("button", {
          name: "Marcar doc como revisado",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});

describe("ComparisonPanel — resposta nova (issue #247, ponto 4)", () => {
  it("o input de resposta nova fica oculto até clicar em 'Nenhuma correta'", () => {
    renderPanel();
    expect(screen.queryByPlaceholderText("Resposta correta…")).toBeNull();
    expect(
      screen.getByRole("button", { name: /nenhuma correta/i }),
    ).toBeTruthy();
  });

  it("prepara o valor digitado e só salva no botão Confirmar", async () => {
    const user = userEvent.setup();
    const { onVerdict } = renderPanel();

    await user.click(screen.getByRole("button", { name: /nenhuma correta/i }));
    const input = screen.getByPlaceholderText("Resposta correta…");
    await user.type(input, "sem data no parecer");
    await user.click(
      screen.getByRole("button", { name: /usar resposta nova/i }),
    );

    expect(onVerdict).not.toHaveBeenCalled();
    expect(screen.getByText(/Selecionado:/).textContent).toContain(
      "sem data no parecer",
    );

    await user.click(screen.getByRole("button", { name: /^confirmar$/i }));

    expect(onVerdict).toHaveBeenCalledTimes(1);
    // 2º argumento (chosenResponseId) ausente: nenhuma resposta existente é o
    // gabarito — é um valor novo do revisor.
    expect(onVerdict).toHaveBeenCalledWith("sem data no parecer", undefined);
  });

  it("Enter no input também usa a resposta nova; valor em branco não prepara", async () => {
    const user = userEvent.setup();
    const { onVerdict } = renderPanel();

    await user.click(screen.getByRole("button", { name: /nenhuma correta/i }));
    const input = screen.getByPlaceholderText("Resposta correta…");

    // só espaços → não prepara nem salva. A ausência de rascunho passa a ser
    // lida pelo testid, e não pela frase do rodapé que sumiu com ele; o par
    // positivo logo abaixo (mesmo `it`) é o que impede esta asserção de virar
    // vácua.
    await user.type(input, "   {Enter}");
    expect(screen.queryByTestId("pending-confirm")).toBeNull();
    expect(onVerdict).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, "8 meses{Enter}");
    expect(onVerdict).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("pending-confirm").getAttribute("data-pending-label"),
    ).toBe("8 meses");

    await user.click(screen.getByRole("button", { name: /^confirmar$/i }));
    expect(onVerdict).toHaveBeenCalledWith("8 meses", undefined);
  });

  it("ao revisitar um campo com resposta nova salva, o botão fica destacado e reabre pré-preenchido", async () => {
    const user = userEvent.setup();
    // Veredito custom: texto livre SEM chosenResponseId e que não é marcador.
    renderPanel({
      existingVerdict: {
        verdict: "sem data no parecer",
        chosenResponseId: null,
        comment: null,
      },
    });

    const button = screen.getByRole("button", { name: /nenhuma correta/i });
    // Destaque de estado ativo, paridade com Ambíguo/Pular.
    expect(button.className).toContain("border-brand");

    // Reabre já preenchido com o valor salvo (sem precisar redigitar).
    await user.click(button);
    const input = screen.getByPlaceholderText(
      "Resposta correta…",
    ) as HTMLInputElement;
    expect(input.value).toBe("sem data no parecer");
  });

  it("não destaca o botão quando o veredito é um voto (tem chosenResponseId)", () => {
    // Voto numa resposta existente: verdict de texto, mas com chosenResponseId.
    renderPanel({
      existingVerdict: {
        verdict: "2021-05-10",
        chosenResponseId: "r-llm",
        comment: null,
      },
    });
    expect(
      screen.getByRole("button", { name: /nenhuma correta/i }).className,
    ).not.toContain("border-brand");
  });

  it("não destaca o botão quando o veredito é um marcador especial (ambiguo)", () => {
    renderPanel({
      existingVerdict: {
        verdict: "ambiguo",
        chosenResponseId: null,
        comment: null,
      },
    });
    expect(
      screen.getByRole("button", { name: /nenhuma correta/i }).className,
    ).not.toContain("border-brand");
  });
});

// A barra de confirmação segue o elemento que produziu o rascunho. Quando esse
// elemento não existe na tela — rascunho de resposta que o AgreementGroup não
// renderiza —, ela precisa aparecer nas ações da divergência, senão a revisora
// fica com um rascunho que trava a navegação (guardNavigation, #434) e que ela
// não consegue nem confirmar nem descartar pelo mouse. Soft-lock: o defeito do
// #430 com o sinal trocado.
describe("ComparisonPanel — rascunho sem card para ancorar (#610)", () => {
  it("cai para as ações da divergência em vez de sumir da tela", () => {
    renderPanel({
      pendingVerdict: {
        kind: "response",
        verdict: "resposta de uma linha que não está na lista",
        chosenResponseId: "r-que-nao-esta-na-tela",
        origin: PANEL_ORIGIN,
      },
    });

    const bar = screen.getByTestId("pending-confirm");
    expect(bar).not.toBeNull();
    expect(bar.getAttribute("data-pending-label")).toBe(
      "resposta de uma linha que não está na lista",
    );
    expect(screen.getByRole("button", { name: "Confirmar" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Descartar" })).not.toBeNull();
  });
});
