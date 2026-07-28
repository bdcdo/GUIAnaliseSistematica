// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Radix (Popover) usa APIs de Pointer/observer que o jsdom não tem.
beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.scrollIntoView = () => {};
  proto.hasPointerCapture = () => false;
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

vi.mock("@/components/shared/AddNoteButton", () => ({
  AddNoteButton: () => <button type="button">Anotar</button>,
}));
vi.mock("@/components/stats/SuggestFieldDialog", () => ({
  SuggestFieldDialog: () => null,
}));

import { ComparisonPanel } from "@/components/compare/ComparisonPanel";
import type { PydanticField } from "@/lib/types";
import {
  panelProps,
  panelResponse as resp,
  type PanelResponse as Resp,
} from "./compare-test-helpers";

afterEach(cleanup);

const FIELD: PydanticField = {
  name: "data_parecer",
  type: "date",
  description: "Data do parecer",
} as PydanticField;

function renderPanel(responses: Resp[], fieldHelpText?: string) {
  render(
    <ComparisonPanel
      {...panelProps({
        documentTitle: "Nota técnica 1",
        fieldName: "data_parecer",
        fieldDescription: "Data do parecer",
        fieldHelpText,
        fieldType: "date",
        fields: [FIELD],
        responses,
      })}
    />,
  );
}

describe("ComparisonPanel — não preencheu este campo (issue #247, ponto 3)", () => {
  it("lista o humano que deixou o campo em branco quando só o robô respondeu", () => {
    renderPanel([
      resp({ id: "llm", respondent_type: "llm", respondent_name: "Robô", answer: "2021-05-10" }),
      resp({ id: "ana", respondent_name: "Ana", answer: undefined }),
    ]);
    expect(screen.getByText(/1 respondente não preencheu este campo/i)).toBeTruthy();
    expect(screen.getByText(/Ana/)).toBeTruthy();
  });

  it("não conta respondente cujo schema antigo nem tinha o campo (isFieldStale)", () => {
    renderPanel([
      resp({ id: "llm", respondent_type: "llm", respondent_name: "Robô", answer: "2021-05-10" }),
      resp({ id: "bia", respondent_name: "Bia", answer: undefined, isFieldStale: true }),
    ]);
    expect(screen.queryByText(/não preencheu este campo/i)).toBeNull();
  });

  it("não lista LLM que deixou o campo em branco (a issue é sobre humanos)", () => {
    renderPanel([
      resp({ id: "robo", respondent_type: "llm", respondent_name: "Robô", answer: undefined }),
      resp({ id: "ana", respondent_name: "Ana", answer: "2021-05-10" }),
    ]);
    expect(screen.queryByText(/não preencheu este campo/i)).toBeNull();
  });

  it("deduplica o mesmo respondente com duas respostas em branco (respondent_id)", () => {
    renderPanel([
      resp({ id: "llm", respondent_type: "llm", respondent_name: "Robô", answer: "2021-05-10" }),
      resp({ id: "ana1", respondent_id: "ana", respondent_name: "Ana", answer: undefined }),
      resp({ id: "ana2", respondent_id: "ana", respondent_name: "Ana", answer: undefined }),
    ]);
    expect(screen.getByText(/1 respondente não preencheu este campo/i)).toBeTruthy();
    expect(screen.getByText(/: Ana$/)).toBeTruthy();
  });

  it("pluraliza quando dois ou mais deixaram em branco", () => {
    renderPanel([
      resp({ id: "llm", respondent_type: "llm", respondent_name: "Robô", answer: "2021-05-10" }),
      resp({ id: "ana", respondent_name: "Ana", answer: undefined }),
      resp({ id: "caio", respondent_name: "Caio", answer: undefined }),
    ]);
    expect(
      screen.getByText(/2 respondentes não preencheram este campo/i),
    ).toBeTruthy();
  });

  it("não mostra nada quando todos preencheram", () => {
    renderPanel([
      resp({ id: "llm", respondent_type: "llm", respondent_name: "Robô", answer: "2021-05-10" }),
      resp({ id: "ana", respondent_name: "Ana", answer: "2021-05-11" }),
    ]);
    expect(screen.queryByText(/não preencheu este campo/i)).toBeNull();
  });
});

// O help_text continua acessível, mas saiu do fluxo permanente do cabeçalho:
// era um bloco de até 96px de instrução de PREENCHIMENTO no topo de uma tela de
// ARBITRAGEM, e a altura variável entre campos fazia os cards saltarem ao
// navegar (#610).
//
// Os três casos formam um par que não pode ficar vácuo: (1) e (2) provam que o
// texto está fora do DOM ATÉ o clique e dentro DEPOIS dele — se alguém apagar o
// help_text de vez, (2) fica vermelho; se alguém devolvê-lo ao fluxo, (1) fica
// vermelho. Sozinho, o caso (3) passaria trivialmente nos dois mundos.
describe("ComparisonPanel — help_text sob demanda no header (#373/#610)", () => {
  const RESPONSES = [
    resp({ id: "llm", respondent_type: "llm", respondent_name: "Robô", answer: "2021-05-10" }),
  ];
  const HELP = "Considere apenas a data de assinatura.";
  const helpButton = () =>
    screen.queryByRole("button", {
      name: /instruções de preenchimento do campo/i,
    });

  it("com help_text, oferece o gatilho e mantém o texto FORA do fluxo", () => {
    renderPanel(RESPONSES, HELP);
    expect(helpButton()).not.toBeNull();
    expect(screen.queryByText(HELP)).toBeNull();
  });

  it("o texto integral continua alcançável ao abrir o popover", async () => {
    const user = userEvent.setup();
    renderPanel(RESPONSES, HELP);
    await user.click(helpButton()!);
    expect(await screen.findByText(HELP)).toBeTruthy();
  });

  it("sem help_text, não há gatilho nem texto", () => {
    renderPanel(RESPONSES);
    expect(helpButton()).toBeNull();
    expect(screen.queryByText(/Considere apenas/)).toBeNull();
  });
});

// O enunciado é clampado em duas linhas de altura reservada; o texto integral
// vive no `title`. Sem esta asserção, "otimizar" o clamp removendo a via para o
// texto completo passaria despercebido.
describe("ComparisonPanel — enunciado clampado (#610)", () => {
  it("expõe o enunciado integral mesmo quando ele não cabe em duas linhas", () => {
    renderPanel([
      resp({ id: "llm", respondent_type: "llm", respondent_name: "Robô", answer: "2021-05-10" }),
    ]);
    expect(screen.getByTitle("Data do parecer")).toBeTruthy();
  });
});
