// Mock chainable do client Supabase para testes de Server Actions, extraído
// dos mocks duplicados de members/schema/rounds.test.ts. Não é coletado pelo
// vitest (include cobre apenas *.test.ts).
//
// Builder: qualquer método de filtro/modificador devolve o próprio builder;
// update/insert/delete registram a chamada em `writeCalls`; o await (thenable)
// resolve com o resultado fixado por tabela em `tableResults` — um valor fixo
// ou uma fila (array) consumida na ordem das queries, necessária quando a
// action consulta a mesma tabela mais de uma vez com expectativas diferentes.
// Sem entrada para a tabela, vale `defaultResult` (ou data/error/count nulos).

export type WriteCall = {
  table: string;
  op: "update" | "insert" | "delete" | "upsert";
  payload: unknown;
};

export type RpcCall = {
  fn: string;
  args: unknown;
};

export type FilterCall = {
  table: string;
  method: "eq" | "is" | "in" | "neq" | "match" | "not";
  column: string;
  value: unknown;
};

export type TableResult = {
  data?: unknown;
  error?: { message: string; code?: string } | null;
  count?: number;
};

export type TableResults = Record<string, TableResult | TableResult[]>;

export interface SupabaseMockState {
  tableResults: TableResults | undefined;
  readonly writeCalls: WriteCall[];
  createClient: () => ReturnType<typeof makeSupabaseMock>;
  reset: (tableResults?: TableResults) => void;
}

// Estado mutável compartilhado pelo mock e pelo teste. O array de writes
// mantém a referência entre resets; os resultados podem variar por cenário.
export function createSupabaseMockState(): SupabaseMockState {
  const state: SupabaseMockState = {
    tableResults: undefined,
    writeCalls: [],
    createClient: () =>
      makeSupabaseMock({
        tableResults: state.tableResults,
        writeCalls: state.writeCalls,
      }),
    reset: (tableResults) => {
      state.tableResults = tableResults;
      state.writeCalls.length = 0;
    },
  };
  return state;
}

export function makeSupabaseMock(opts?: {
  tableResults?: TableResults;
  defaultResult?: TableResult;
  writeCalls?: WriteCall[];
  filterCalls?: FilterCall[];
  rpcCalls?: RpcCall[];
  rpcResults?: Record<string, TableResult | TableResult[]>;
}) {
  const {
    tableResults,
    defaultResult,
    writeCalls,
    filterCalls,
    rpcCalls,
    rpcResults,
  } = opts ?? {};
  return {
    // rpc(): registra a chamada e resolve { data, error } como o thenable das
    // queries. Resultado por função em `rpcResults`; sem entrada, sucesso vazio.
    rpc: (fn: string, args: unknown) => {
      rpcCalls?.push({ fn, args });
      const entry = rpcResults?.[fn];
      const result = Array.isArray(entry) ? entry.shift() : entry;
      const response = {
        data: result?.data ?? null,
        error: result?.error ?? null,
      };
      return {
        single: () => Promise.resolve(response),
        maybeSingle: () => Promise.resolve(response),
        then: (resolve: (v: unknown) => unknown) => resolve(response),
      };
    },
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      let rangeFrom: number | null = null;
      let rangeTo: number | null = null;
      for (const m of ["select", "single", "maybeSingle", "order", "limit"]) {
        builder[m] = () => builder;
      }
      // range() precisa recortar de verdade, com os DOIS limites: um mock que
      // devolve o conjunto inteiro a cada página faz um leitor paginado nunca
      // alcançar o fim, e um que ignora o limite superior nunca deixa uma
      // leitura truncada se distinguir de uma completa.
      builder.range = (from: number, to: number) => {
        rangeFrom = from;
        rangeTo = to;
        return builder;
      };
      for (const method of ["eq", "is", "in", "neq", "match"] as const) {
        builder[method] = (column: string, value: unknown) => {
          filterCalls?.push({ table, method, column, value });
          return builder;
        };
      }
      // not() tem aridade 3 (coluna, operador, valor); registra o valor final.
      builder.not = (column: string, _operator: string, value: unknown) => {
        filterCalls?.push({ table, method: "not", column, value });
        return builder;
      };
      builder.update = (payload: unknown) => {
        writeCalls?.push({ table, op: "update", payload });
        return builder;
      };
      builder.insert = (payload: unknown) => {
        writeCalls?.push({ table, op: "insert", payload });
        return builder;
      };
      builder.upsert = (payload: unknown) => {
        writeCalls?.push({ table, op: "upsert", payload });
        return builder;
      };
      builder.delete = () => {
        writeCalls?.push({ table, op: "delete", payload: null });
        return builder;
      };
      builder.then = (resolve: (v: unknown) => unknown) => {
        const entry = tableResults?.[table];
        const queued = Array.isArray(entry);
        const fixed = queued ? entry.shift() : entry;
        const result = fixed ?? defaultResult;
        const data = result?.data ?? null;
        // Uma fila já entrega cada página pronta — recortá-la de novo cortaria
        // duas vezes. Um resultado fixo, ao contrário, representa a tabela
        // inteira: sem o recorte, um leitor paginado nunca veria o fim.
        const paginated =
          !queued && rangeFrom !== null && Array.isArray(data)
            ? data.slice(rangeFrom, rangeTo !== null ? rangeTo + 1 : undefined)
            : data;
        return resolve({
          data: paginated,
          error: result?.error ?? null,
          count: result?.count ?? null,
        });
      };
      return builder;
    },
  };
}
