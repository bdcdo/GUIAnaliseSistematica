import { describe, it, expect } from "vitest";
import { isSubfieldRecord, readLegacyGroupText } from "@/lib/subfield-value";
import { NOT_INFORMED } from "@/lib/sentinels";

describe("isSubfieldRecord", () => {
  it("reconhece a forma que o grupo produz", () => {
    expect(isSubfieldRecord({})).toBe(true);
    expect(isSubfieldRecord({ anos: "18" })).toBe(true);
  });

  it("rejeita o que não é registro", () => {
    expect(isSubfieldRecord("01 ano")).toBe(false);
    expect(isSubfieldRecord(42)).toBe(false);
    expect(isSubfieldRecord(true)).toBe(false);
    expect(isSubfieldRecord(["a"])).toBe(false);
    expect(isSubfieldRecord(undefined)).toBe(false);
  });

  // `typeof null === "object"`: sem o teste explícito, um valor nulo passaria
  // por registro e estouraria na primeira leitura de subcampo.
  it("rejeita null", () => {
    expect(isSubfieldRecord(null)).toBe(false);
  });
});

describe("readLegacyGroupText", () => {
  it("devolve o texto coletado antes de o campo virar grupo", () => {
    expect(readLegacyGroupText("18 anos e 6 meses")).toBe("18 anos e 6 meses");
    expect(readLegacyGroupText("Quase 2 meses")).toBe("Quase 2 meses");
  });

  // A sentinela também é uma string, mas é a forma CORRENTE de responder o
  // grupo — não um resíduo do formato antigo. Tratá-la como legado poria a UI
  // de recuperação na frente de quem respondeu normalmente.
  it("não confunde a sentinela com valor legado", () => {
    expect(readLegacyGroupText(NOT_INFORMED)).toBeNull();
  });

  it("não vê texto onde não há", () => {
    expect(readLegacyGroupText("")).toBeNull();
    expect(readLegacyGroupText("   ")).toBeNull();
    expect(readLegacyGroupText({ anos: "18" })).toBeNull();
    expect(readLegacyGroupText([])).toBeNull();
    expect(readLegacyGroupText(null)).toBeNull();
    expect(readLegacyGroupText(undefined)).toBeNull();
  });
});

// Os dois predicados não são complementares, e é de propósito: a régua de
// completude é permissiva por decreto (anistiar tudo que não seja registro
// evita rebaixar as codificações do #606), o display é conservador por
// evidência (só mostra o que é texto de fato). Um número num campo-grupo cai
// nas duas frestas ao mesmo tempo: não é registro, e não é legado exibível.
describe("a assimetria entre a régua e o display", () => {
  it("um valor pode não ser registro e ainda assim não ser legado exibível", () => {
    expect(isSubfieldRecord(42)).toBe(false);
    expect(readLegacyGroupText(42)).toBeNull();

    expect(isSubfieldRecord(["a"])).toBe(false);
    expect(readLegacyGroupText(["a"])).toBeNull();
  });
});
