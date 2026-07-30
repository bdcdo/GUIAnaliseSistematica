import { describe, expect, it, vi } from "vitest";
import { SUPABASE_PAGE_SIZE, fetchAllPaged } from "@/lib/supabase/paginate";

function rows(count: number, offset = 0) {
  return Array.from({ length: count }, (_, i) => ({ user_id: `u${offset + i}` }));
}

type OrderCall = [string, { ascending: boolean }];

// Simula o teto do PostgREST: cada chamada devolve no máximo uma página do
// conjunto total, recortada pelo range pedido. `order` fica registrado para que
// os testes possam afirmar que a paginação pede ordem estável ao servidor.
function fakeTable(total: number) {
  const range = vi.fn((from: number, to: number) =>
    Promise.resolve({
      data: rows(Math.max(0, Math.min(to + 1, total) - from), from),
      error: null,
    }),
  );
  const orderCalls: OrderCall[] = [];
  const query = {
    order: (column: string, options: { ascending: boolean }) => {
      orderCalls.push([column, options]);
      return query;
    },
    range,
  };
  return { build: () => query, range, orderCalls };
}

describe("fetchAllPaged", () => {
  it("lê tudo e encerra na página vazia quando cabe numa página", async () => {
    const table = fakeTable(3);

    const result = await fetchAllPaged(table.build, "user_id");

    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(3);
    expect(table.range).toHaveBeenCalledWith(0, SUPABASE_PAGE_SIZE - 1);
    expect(table.range).toHaveBeenLastCalledWith(3, 3 + SUPABASE_PAGE_SIZE - 1);
  });

  it("busca as páginas seguintes quando a primeira vem cheia", async () => {
    const total = SUPABASE_PAGE_SIZE + 7;
    const table = fakeTable(total);

    const result = await fetchAllPaged(table.build, "user_id");

    expect(result.data).toHaveLength(total);
    expect(new Set(result.data.map((r) => r.user_id)).size).toBe(total);
    expect(table.range).toHaveBeenNthCalledWith(
      2,
      SUPABASE_PAGE_SIZE,
      SUPABASE_PAGE_SIZE * 2 - 1,
    );
  });

  // Paginação por offset sem ORDER BY é ambígua na fronteira das páginas: o
  // Postgres não promete a mesma ordem entre execuções, então a linha da divisa
  // pode repetir ou — o caso grave — ser pulada, reproduzindo o truncamento
  // silencioso. A ordem tem que ir em TODA página, não só na primeira.
  it("pede ordem estável ao servidor em todas as páginas", async () => {
    const table = fakeTable(SUPABASE_PAGE_SIZE + 1);

    await fetchAllPaged(table.build, "user_id");

    // 2 páginas com dados + a vazia que encerra.
    expect(table.orderCalls).toHaveLength(3);
    for (const call of table.orderCalls) {
      expect(call).toEqual(["user_id", { ascending: true }]);
    }
  });

  it("ordena pela coluna que o chamador declarou", async () => {
    const table = fakeTable(1);

    await fetchAllPaged(table.build, "id");

    expect(table.orderCalls[0]).toEqual(["id", { ascending: true }]);
  });

  // O caso que quebra a heurística "página curta = fim": um servidor cujo
  // max_rows é menor que o nosso devolve a primeira página já incompleta.
  // Avançar pelo tamanho recebido é o que mantém a leitura completa.
  it("lê tudo mesmo quando o servidor devolve menos que a página pedida", async () => {
    const serverMax = 2;
    const total = 5;
    const range = vi.fn((from: number) =>
      Promise.resolve({
        data: rows(Math.max(0, Math.min(from + serverMax, total) - from), from),
        error: null,
      }),
    );
    const query = { order: () => query, range };

    const result = await fetchAllPaged(() => query, "user_id");

    expect(result.data).toHaveLength(total);
    expect(new Set(result.data.map((r) => r.user_id)).size).toBe(total);
  });

  it("interrompe no erro e devolve o que já tinha lido", async () => {
    const range = vi
      .fn()
      .mockResolvedValueOnce({ data: rows(SUPABASE_PAGE_SIZE), error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    const query = { order: () => query, range };

    const result = await fetchAllPaged(() => query, "user_id");

    expect(result.error).toEqual({ message: "boom" });
    expect(result.data).toHaveLength(SUPABASE_PAGE_SIZE);
  });

  it("recria o builder a cada página, porque o do PostgREST é de uso único", async () => {
    const table = fakeTable(SUPABASE_PAGE_SIZE + 1);
    const build = vi.fn(table.build);

    await fetchAllPaged(build, "user_id");

    // 2 páginas com dados + a vazia que encerra.
    expect(build).toHaveBeenCalledTimes(3);
  });
});
