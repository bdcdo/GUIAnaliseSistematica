import { describe, it, expect } from "vitest";
import { sortByRecent, sortByAssignmentStatus } from "@/lib/coding-sort";
import type { Assignment } from "@/lib/types";

const ids = (docs: { id: string }[]) => docs.map((d) => d.id);

const doc = (id: string, status?: Assignment["status"]) => ({
  id,
  ...(status ? { assignment: { status } } : {}),
});

describe("sortByAssignmentStatus", () => {
  it("põe o que exige trabalho primeiro: pendente, em_andamento, concluido", () => {
    // Prova do vermelho do #608: o `ORDER BY status` do PostgREST ordenava pelo
    // ALFABETO do enum (c < e < p), então "Ordem de atribuição" abria a fila nos
    // documentos que a pesquisadora já tinha concluído. A ordem aqui é
    // declarada, não herdada da grafia dos valores.
    const docs = [
      doc("concluido-1", "concluido"),
      doc("pendente-1", "pendente"),
      doc("andamento-1", "em_andamento"),
    ];
    expect(ids(sortByAssignmentStatus(docs))).toEqual([
      "pendente-1",
      "andamento-1",
      "concluido-1",
    ]);
  });

  it("desempata pela ordem original dentro do mesmo estado", () => {
    // O PostgREST não garante ordem sem ORDER BY: sem o desempate, dois
    // carregamentos da mesma fila poderiam numerar os documentos de formas
    // diferentes e o `◀ n/total ▶` deixaria de ser estável entre refreshes.
    const docs = [
      doc("b", "pendente"),
      doc("a", "pendente"),
      doc("c", "pendente"),
    ];
    expect(ids(sortByAssignmentStatus(docs))).toEqual(["b", "a", "c"]);
  });

  it("documento sem assignment conta como pendente", () => {
    const docs = [doc("concluido-1", "concluido"), doc("sem-assignment")];
    expect(ids(sortByAssignmentStatus(docs))).toEqual([
      "sem-assignment",
      "concluido-1",
    ]);
  });

  it("nao muta o array de entrada", () => {
    const docs = [doc("concluido-1", "concluido"), doc("pendente-1", "pendente")];
    sortByAssignmentStatus(docs);
    expect(ids(docs)).toEqual(["concluido-1", "pendente-1"]);
  });
});

describe("sortByRecent", () => {
  it("ordena documentos codificados do mais recente para o mais antigo", () => {
    const docs = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const codedAt = {
      a: "2026-05-14T10:00:00.000Z",
      b: "2026-05-14T12:00:00.000Z",
      c: "2026-05-14T11:00:00.000Z",
    };
    expect(ids(sortByRecent(docs, codedAt))).toEqual(["b", "c", "a"]);
  });

  it("manda documentos nao codificados para o fim", () => {
    const docs = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const codedAt = { b: "2026-05-14T12:00:00.000Z" };
    expect(ids(sortByRecent(docs, codedAt))).toEqual(["b", "a", "c"]);
  });

  it("preserva a ordem original entre documentos nao codificados", () => {
    const docs = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    const codedAt = { c: "2026-05-14T12:00:00.000Z" };
    expect(ids(sortByRecent(docs, codedAt))).toEqual(["c", "a", "b", "d"]);
  });

  it("desempata timestamps iguais pela ordem original", () => {
    const docs = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const ts = "2026-05-14T12:00:00.000Z";
    const codedAt = { a: ts, b: ts, c: ts };
    expect(ids(sortByRecent(docs, codedAt))).toEqual(["a", "b", "c"]);
  });

  it("retorna a ordem original quando nada foi codificado", () => {
    const docs = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(ids(sortByRecent(docs, {}))).toEqual(["a", "b", "c"]);
  });

  it("nao muta o array de entrada", () => {
    const docs = [{ id: "a" }, { id: "b" }];
    const codedAt = { b: "2026-05-14T12:00:00.000Z" };
    sortByRecent(docs, codedAt);
    expect(ids(docs)).toEqual(["a", "b"]);
  });
});
