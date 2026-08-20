import { describe, it, expect } from "vitest";
import { fetchAllPaged } from "@/lib/supabase/fetch-all-paged";

const PAGE_SIZE = 1000;

interface Row {
  id: number;
}

// Builder falso no formato mínimo que `fetchAllPaged` consome. Registra as
// colunas de ordenação e as faixas pedidas para que o teste possa afirmar sobre
// a query montada, e não só sobre o resultado.
function fakeSource(
  pages: Array<{ data: Row[] | null; error: { message: string } | null }>,
) {
  const orders: string[][] = [];
  const ranges: Array<[number, number]> = [];
  let page = 0;

  const build = () => {
    const applied: string[] = [];
    const builder = {
      order(column: string) {
        applied.push(column);
        return builder;
      },
      range(from: number, to: number) {
        orders.push(applied);
        ranges.push([from, to]);
        return Promise.resolve(pages[page++] ?? { data: [], error: null });
      },
    };
    return builder;
  };

  return { build, orders, ranges };
}

function rows(count: number, offset = 0): Row[] {
  return Array.from({ length: count }, (_, i) => ({ id: offset + i }));
}

describe("fetchAllPaged", () => {
  it("aplica a ordem pedida em TODA página, não só na primeira", () => {
    const src = fakeSource([
      { data: rows(PAGE_SIZE), error: null },
      { data: rows(3, PAGE_SIZE), error: null },
    ]);

    return fetchAllPaged<Row>(src.build, ["document_id", "field_name"]).then(
      ({ data }) => {
        expect(data).toHaveLength(PAGE_SIZE + 3);
        expect(src.ranges).toEqual([
          [0, PAGE_SIZE - 1],
          [PAGE_SIZE, 2 * PAGE_SIZE - 1],
        ]);
        // A segunda página é uma query NOVA (o builder do PostgREST é de uso
        // único): sem reaplicar a ordem, o OFFSET dela cairia sobre uma
        // ordenação arbitrária e poderia repetir ou pular linhas da primeira.
        expect(src.orders).toEqual([
          ["document_id", "field_name"],
          ["document_id", "field_name"],
        ]);
      },
    );
  });

  it("para na primeira página incompleta", async () => {
    const src = fakeSource([{ data: rows(10), error: null }]);

    const { data, error } = await fetchAllPaged<Row>(src.build, ["id"]);

    expect(error).toBeNull();
    expect(data).toHaveLength(10);
    expect(src.ranges).toHaveLength(1);
  });

  it("devolve o erro junto do que já acumulou — o caller decide", async () => {
    const src = fakeSource([
      { data: rows(PAGE_SIZE), error: null },
      { data: null, error: { message: "conexão perdida" } },
    ]);

    const { data, error } = await fetchAllPaged<Row>(src.build, ["id"]);

    // O array vem TRUNCADO. É por isso que ignorar o `error` numa fonte
    // estrutural não devolve "menos dados", devolve número errado.
    expect(data).toHaveLength(PAGE_SIZE);
    expect(error).toEqual({ message: "conexão perdida" });
  });
});
