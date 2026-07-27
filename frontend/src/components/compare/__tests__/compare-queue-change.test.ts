import { describe, it, expect } from "vitest";
import { queueChangeNotice } from "../compare-queue-change";

// Aviso de mudança de composição da fila de campos divergentes (#613). O valor
// destes testes está nas SUPRESSÕES: um aviso que dispara na troca de parecer,
// na troca de filtro ou a cada equivalência confirmada é um aviso que a revisora
// aprende a ignorar — e aí não avisa nada quando importa.
const base = {
  previousFields: ["q1", "q2", "q3"],
  currentFields: ["q1", "q2", "q3"],
  previousFieldName: "q2",
  previousDocId: "d1",
  currentDocId: "d1",
  previousFilter: "all",
  currentFilter: "all",
  reviewedFields: undefined,
};

describe("queueChangeNotice — quando avisa", () => {
  it("a fila encolheu e o campo exibido sobreviveu → aviso de composição", () => {
    const notice = queueChangeNotice({
      ...base,
      currentFields: ["q1", "q2"],
    });

    expect(notice?.id).toBe("compare-queue-changed");
    expect(notice?.message).toContain("3 → 2 campos");
  });

  it("o campo exibido saiu da fila → aviso específico", () => {
    const notice = queueChangeNotice({
      ...base,
      currentFields: ["q1", "q3"],
    });

    expect(notice?.id).toBe("compare-field-left-queue");
  });

  it("a fila cresceu (snapshot de um par deixou de casar) → aviso", () => {
    const notice = queueChangeNotice({
      ...base,
      currentFields: ["q1", "q2", "q3", "q4"],
    });

    expect(notice?.id).toBe("compare-queue-changed");
    expect(notice?.message).toContain("3 → 4 campos");
  });
});

describe("queueChangeNotice — supressões", () => {
  it("primeira montagem não é mudança", () => {
    expect(
      queueChangeNotice({ ...base, previousFields: null }),
    ).toBeNull();
  });

  it("fila idêntica não avisa", () => {
    expect(queueChangeNotice(base)).toBeNull();
  });

  it("(1) trocar de parecer não é mudança de fila", () => {
    expect(
      queueChangeNotice({
        ...base,
        currentDocId: "d2",
        currentFields: ["qA", "qB"],
      }),
    ).toBeNull();
  });

  it("(2) trocar de filtro não é mudança de fila", () => {
    expect(
      queueChangeNotice({
        ...base,
        currentFilter: "q2",
        currentFields: ["q2"],
      }),
    ).toBeNull();
  });

  it("(3) o campo saiu porque ELA acabou de resolvê-lo → silêncio", () => {
    // É o caso de longe mais comum: confirmar uma equivalência funde grupos e
    // tira o campo da fila. Sem esta supressão, toda equivalência avisaria.
    expect(
      queueChangeNotice({
        ...base,
        currentFields: ["q1", "q3"],
        reviewedFields: { q2: { verdict: "x" } },
      }),
    ).toBeNull();
  });

  it("mas um campo que ela NÃO resolveu, saindo junto, ainda avisa", () => {
    const notice = queueChangeNotice({
      ...base,
      currentFields: ["q1"],
      reviewedFields: { q2: { verdict: "x" } },
    });

    // q3 saiu sem veredito dela — a fila mudou por outra causa.
    expect(notice).not.toBeNull();
  });

  it("reordenação sem mudança de conjunto ainda conta como mudança", () => {
    // A ordem vem do schema Pydantic; se ela mudou, a numeração "Campo N/M" que
    // a revisora está lendo mudou de significado.
    const notice = queueChangeNotice({
      ...base,
      currentFields: ["q3", "q2", "q1"],
    });

    expect(notice?.id).toBe("compare-queue-changed");
  });
});
