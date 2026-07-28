// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { CodingHeader, type DocSection } from "@/components/coding/CodingHeader";
import type { DocRoundStatus } from "@/lib/rounds";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/components/shared/RunLlmButton", () => ({
  RunLlmButton: () => <div />,
}));

afterEach(cleanup);

function renderHeader(roundStatus: DocRoundStatus | undefined) {
  const doc: DocSection = {
    variant: "assigned",
    title: "Processo 123",
    index: 4,
    total: 23,
    onNavigate: vi.fn(),
    roundStatus,
  };
  return render(
    <CodingHeader
      mode="assigned"
      onModeChange={vi.fn()}
      assignedCount={23}
      sortMode="recent"
      onSortChange={vi.fn()}
      doc={doc}
      onToggleFullscreen={vi.fn()}
    />,
  );
}

// O critério 6 da #608 na forma em que ele de fato morde. Medido em 2026-07-27:
// nenhuma fila dos projetos ativos contém documento nunca respondido, e o filtro
// de rodada já expulsa os concluídos — a pesquisadora abria SEMPRE um formulário
// já preenchido, sem nada na tela dizendo se aquilo era uma codificação dela pela
// metade ou uma resposta completa que voltou por pertencer a outra rodada. Ela
// lia as duas como "não salvou o que eu respondi".
describe("CodingHeader — estado do documento na fila", () => {
  it("codificação incompleta é nomeada na navegação", () => {
    renderHeader({ kind: "current_pending" });
    expect(screen.getByText("Incompleto")).not.toBeNull();
  });

  it("resposta de rodada anterior diz POR QUE voltou, e identifica a rodada", () => {
    // Sem esta frase, um documento completo de volta na fila é indistinguível de
    // trabalho perdido — a leitura literal da queixa que abriu a issue.
    //
    // Na estratégia `schema_version` o `label` é o semver sob o qual ela
    // respondeu, e é ele que permite a pesquisadora reconhecer "isto é de antes
    // da mudança", em vez de suspeitar do salvamento.
    renderHeader({ kind: "previous", label: "1.2.0" });
    expect(
      screen.getByText("Respondido em rodada anterior (1.2.0)"),
    ).not.toBeNull();
  });

  it("rodada MANUAL mostra o rótulo do coordenador, não 'mudança no schema'", () => {
    // Prova do vermelho da correção: `classifyDocStatus` devolve `previous` na
    // estratégia manual quando a resposta pertence a uma rodada que o
    // coordenador definiu — sem schema nenhum envolvido. O enunciado anterior
    // ("Reaberto por mudança no schema") era falso em todo projeto manual.
    renderHeader({ kind: "previous", label: "Rodada piloto" });
    const tag = screen.getByText("Respondido em rodada anterior (Rodada piloto)");
    expect(tag).not.toBeNull();
    expect(tag.textContent).not.toContain("schema");
  });

  it("documento nunca respondido também é rotulado", () => {
    renderHeader({ kind: "no_response" });
    expect(screen.getByText("Nunca respondido")).not.toBeNull();
  });

  it("concluído da rodada atual não ganha rótulo (só alcançável em ?round=all)", () => {
    renderHeader({ kind: "current_done" });
    expect(screen.queryByText("Incompleto")).toBeNull();
    expect(screen.queryByText(/rodada anterior/)).toBeNull();
    expect(screen.queryByText("Nunca respondido")).toBeNull();
  });

  it("sem estado conhecido não inventa rótulo", () => {
    renderHeader(undefined);
    expect(screen.queryByText("Incompleto")).toBeNull();
  });

  it("o rótulo é TEXTO, não só cor (WCAG 1.4.1)", () => {
    // A informação não pode depender do ícone nem da cor: quem não distingue as
    // cores, e quem usa leitor de tela, precisa do mesmo dado. O ícone é
    // `aria-hidden` justamente porque o texto ao lado já o diz.
    const { container } = renderHeader({ kind: "current_pending" });
    const tag = within(container).getByText("Incompleto");
    expect(tag.textContent?.trim()).toBe("Incompleto");
    expect(container.querySelector("svg[aria-hidden]")).not.toBeNull();
  });
});
