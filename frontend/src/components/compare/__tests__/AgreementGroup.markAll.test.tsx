// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AgreementGroup } from "@/components/compare/AgreementGroup";
import { stubRadixJsdomApis } from "@/test-utils/radix-jsdom";

beforeAll(stubRadixJsdomApis);

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

function renderGroup(
  props: Partial<Parameters<typeof AgreementGroup>[0]> = {},
) {
  const onConfirmEquivalent =
    vi.fn<
      (
        responseIds: string[],
        gabaritoId: string,
        verdictDisplay: string,
      ) => Promise<void>
    >(async () => {});
  const onVote = vi.fn();
  const onUnmarkPair = vi.fn(async () => {});
  render(
    <AgreementGroup
      readOnly={false}
      responses={[
        resp({ id: "ni-1", respondent_name: "Ana", answer: "NI" }),
        resp({ id: "ni-2", respondent_name: "Bia", answer: "NI" }),
        resp({ id: "na-1", respondent_name: "Caio", answer: "N/A" }),
        resp({
          id: "info-1",
          respondent_name: "Dora",
          answer: "não informado",
        }),
      ]}
      existingVerdict={null}
      pendingVerdict={null}
      onVote={onVote}
      allowEquivalence={true}
      equivalences={[]}
      onConfirmEquivalent={onConfirmEquivalent}
      onUnmarkPair={onUnmarkPair}
      currentUserId="u1"
      canManageAnyPair={false}
      {...props}
    />,
  );
  return { onConfirmEquivalent, onUnmarkPair, onVote };
}

describe("AgreementGroup — 'Todas são similares' (issue #247, ponto 5)", () => {
  it("pré-seleciona todos os grupos e só confirma equivalência no botão explícito", async () => {
    const user = userEvent.setup();
    const { onConfirmEquivalent } = renderGroup();

    await user.click(
      screen.getByRole("button", { name: /todas são similares/i }),
    );

    expect(onConfirmEquivalent).not.toHaveBeenCalled();
    const confirmBtn = await screen.findByRole("button", {
      name: /confirmar .*equivalentes/i,
    });

    await user.click(confirmBtn);

    await waitFor(() => expect(onConfirmEquivalent).toHaveBeenCalledTimes(1));
    const [responseIds, gabaritoId, verdictDisplay] =
      onConfirmEquivalent.mock.calls[0];
    // um representante por grupo distinto (NI, N/A, não informado)
    expect(responseIds).toHaveLength(3);
    // gabarito = primeiro do maior grupo (NI tem 2 respostas)
    expect(gabaritoId).toBe("ni-1");
    expect(verdictDisplay).toBe("NI");
    expect(responseIds).toContain("ni-1");
    expect(responseIds).toContain("na-1");
    expect(responseIds).toContain("info-1");
  });

  it("sem maioria clara (empate 1×1), não funde cego: abre a confirmação manual do gabarito", async () => {
    const user = userEvent.setup();
    const { onConfirmEquivalent } = renderGroup({
      responses: [
        resp({ id: "a", respondent_name: "Ana", answer: "NI" }),
        resp({ id: "b", respondent_name: "Bia", answer: "8 meses" }),
      ],
    });

    await user.click(
      screen.getByRole("button", { name: /todas são similares/i }),
    );

    // Empate no topo: não pode registrar um gabarito arbitrário sem o revisor
    // ver. Em vez de fundir, pré-seleciona tudo e mostra a barra de confirmação.
    expect(onConfirmEquivalent).not.toHaveBeenCalled();
    const confirmBtn = await screen.findByRole("button", {
      name: /confirmar .*equivalentes/i,
    });

    // O revisor confirma (aceitando o gabarito default = primeiro grupo).
    await user.click(confirmBtn);
    await waitFor(() => expect(onConfirmEquivalent).toHaveBeenCalledTimes(1));
    const [responseIds, gabaritoId] = onConfirmEquivalent.mock.calls[0];
    expect(responseIds).toHaveLength(2);
    expect(responseIds).toContain("a");
    expect(responseIds).toContain("b");
    expect(gabaritoId).toBe("a");
  });

  it("não mostra o botão quando há um único grupo (nada a fundir)", () => {
    renderGroup({
      responses: [
        resp({ id: "a", respondent_name: "Ana", answer: "NI" }),
        resp({ id: "b", respondent_name: "Bia", answer: "NI" }),
      ],
    });
    expect(
      screen.queryByRole("button", { name: /todas são similares/i }),
    ).toBeNull();
  });

  it("não mostra o botão quando allowEquivalence é falso (campo de opção)", () => {
    renderGroup({ allowEquivalence: false });
    expect(
      screen.queryByRole("button", { name: /todas são similares/i }),
    ).toBeNull();
  });

  it("somente leitura preserva variantes visíveis sem permitir voto, equivalência ou desfazer", async () => {
    const user = userEvent.setup();
    const { onConfirmEquivalent, onUnmarkPair, onVote } = renderGroup({
      readOnly: true,
      equivalences: [
        {
          id: "pair-1",
          response_a_id: "ni-1",
          response_b_id: "na-1",
          reviewer_id: "u1",
          response_a_answer_snapshot: "NI",
          response_b_answer_snapshot: "N/A",
        },
      ],
    });

    const vote = screen.getByRole("button", {
      name: /Selecionar esta resposta para confirmar: NI/i,
    }) as HTMLButtonElement;
    const markAll = screen.getByRole("button", {
      name: /Todas são similares/i,
    }) as HTMLButtonElement;
    const checkbox = screen.getAllByRole("checkbox")[0] as HTMLButtonElement;

    expect(vote.disabled).toBe(true);
    expect(markAll.disabled).toBe(true);
    expect(checkbox.disabled).toBe(true);

    await user.click(
      screen.getByRole("button", { name: /1 variante/i }),
    );
    const unmark = await screen.findByRole("button", {
      name: "Desfazer equivalência",
    });
    expect((unmark as HTMLButtonElement).disabled).toBe(true);

    await user.click(vote);
    await user.click(markAll);
    await user.click(checkbox);
    await user.click(unmark);

    expect(onVote).not.toHaveBeenCalled();
    expect(onConfirmEquivalent).not.toHaveBeenCalled();
    expect(onUnmarkPair).not.toHaveBeenCalled();
  });
});

// A prosa que explicava a equivalência saiu do banner permanente (três linhas
// em todo campo divergente) e foi para um popover, mantendo visíveis a frase
// curta e o botão — que são a affordance de descoberta (#610).
//
// Esta cobertura é nova: o texto explicativo NÃO tinha teste nenhum antes de
// sair do fluxo. Sem ela, mover a prosa a apagaria do radar.
describe("AgreementGroup — explicação da equivalência sob demanda (#610)", () => {
  it("mantém a frase curta e o botão visíveis, com o detalhe no popover", async () => {
    const user = userEvent.setup();
    renderGroup();

    expect(
      screen.getByText(/marque os equivalentes e escolha o gabarito/i),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /todas são similares/i }),
    ).toBeTruthy();
    // O detalhe (o exemplo NI ≡ N/A e o que "gabarito" significa) não ocupa
    // espaço até ser pedido.
    expect(screen.queryByText(/NI ≡ N\/A/)).toBeNull();

    await user.click(
      screen.getByRole("button", {
        name: /como funciona a equivalência entre respostas/i,
      }),
    );

    // Escopado ao popover: "gabarito" também aparece na frase curta que ficou
    // visível, então um getByText solto casaria dois nós e não distinguiria de
    // onde veio o texto.
    const detail = (await screen.findByText(/NI ≡ N\/A/)).closest(
      '[data-slot="popover-content"]',
    ) as HTMLElement;
    expect(within(detail).getByText(/gabarito/i)).toBeTruthy();
  });
});
