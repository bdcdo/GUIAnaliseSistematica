// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { CodingDraftBanner } from "@/components/coding/CodingDraftBanner";
import type { CodingDraftRecovery } from "@/lib/coding-draft";
import type { PydanticField } from "@/lib/types";

afterEach(cleanup);

const FIELDS: PydanticField[] = [
  { name: "q1", type: "text", options: null, description: "Diagnóstico" },
];

const DRAFT = { answers: { q1: "do rascunho" }, notes: "" };

// `changedFields` é o que retomar mudaria; `overwrittenFields` é a interseção
// com o que o servidor andou. A faixa só renderiza o segundo, mas ambos fazem
// parte do veredito — montar o literal completo é o que mantém o teste falando
// do mesmo objeto que a classificação produz.
const diverged: CodingDraftRecovery = {
  kind: "diverged",
  updatedAt: Date.now(),
  draft: DRAFT,
  changedFields: ["q1"],
  overwrittenFields: ["q1"],
};

const resumable: CodingDraftRecovery = {
  kind: "resumable",
  updatedAt: Date.now(),
  draft: DRAFT,
  changedFields: ["q1"],
};

function show(recovery: CodingDraftRecovery) {
  render(
    <CodingDraftBanner
      recovery={recovery}
      fields={FIELDS}
      onRestore={() => {}}
      onDiscard={() => {}}
      now={Date.now()}
    />,
  );
  return screen.getByRole("status");
}

// A faixa é uma live region: o leitor de tela reanuncia o que estiver dentro
// dela sempre que muda. O que precisa estar lá é o FATO (há rascunho, e retomar
// sobrescreve tais respostas); o que não pode estar são os controles, que o
// leitor já alcança pela navegação normal e que, dentro da região, viram ruído
// repetido a cada anúncio.
describe("CodingDraftBanner — o que a região live anuncia", () => {
  // Mutação vermelha: devolver o `role="status"` ao container externo. Os dois
  // botões voltam para dentro da região e este teste cai.
  it("não contém os controles", () => {
    expect(within(show(diverged)).queryAllByRole("button")).toEqual([]);
  });

  it("anuncia que há rascunho não enviado", () => {
    expect(within(show(resumable)).getByText(/alterações não enviadas/)).toBeTruthy();
  });

  // Mutação vermelha: deixar o bloco de sobrescrita FORA do wrapper (era onde
  // ele estava). O aviso mais consequente da faixa — quais respostas retomar
  // substitui — deixaria de ser anunciado.
  it("anuncia também o que retomar vai sobrescrever", () => {
    const live = within(show(diverged));
    expect(live.getByText(/foi salvo depois que o rascunho foi criado/)).toBeTruthy();
    expect(live.getByText("Diagnóstico")).toBeTruthy();
  });

  // Os botões continuam na tela e alcançáveis — o que mudou é onde a fronteira
  // da região live passa, não o que a faixa oferece.
  it("os botões seguem presentes fora da região", () => {
    show(diverged);
    expect(screen.getByRole("button", { name: "Retomar rascunho" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Descartar" })).toBeTruthy();
  });
});
