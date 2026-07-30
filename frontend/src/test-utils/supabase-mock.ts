// Mocks chainable do client Supabase compartilhados entre os testes do
// cluster retry/comparison (arbitration-retry, comparisons-retry,
// auto-comparison, compare-sync). Extraído dos mocks duplicados desses 4
// arquivos (#387). Não é coletado pelo vitest (include cobre apenas
// *.test.ts). Não confundir com `actions/__tests__/supabase-mock.ts`
// (`makeSupabaseMock`), que serve outro conjunto de testes e não é
// filter-aware — mantido separado de propósito.

export type WriteCall = { table: string; op: string; payload: unknown };
export type RpcCall = { fn: string; args: unknown };
export type RpcResult = {
  data?: unknown;
  error?: { message: string } | null;
};

export type QueryError = {
  message: string;
  code?: string;
};

// Comparação estável por coluna. `localeCompare` não serve: os valores são ids
// opacos e o que importa é uma ordem TOTAL e repetível entre páginas, igual à do
// servidor — não uma ordem sensível a locale.
function sortRows(
  rows: Array<Record<string, unknown>>,
  { column, ascending }: { column: string; ascending: boolean },
) {
  const direction = ascending ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = String(a[column] ?? "");
    const right = String(b[column] ?? "");
    if (left === right) return 0;
    return left < right ? -direction : direction;
  });
}

function makeRpc(state: {
  rpcCalls?: RpcCall[];
  rpcResults?: Record<string, RpcResult>;
}) {
  return (fn: string, args: unknown) => {
    state.rpcCalls?.push({ fn, args });
    const result = state.rpcResults?.[fn];
    return {
      then: (resolve: (value: unknown) => unknown) =>
        resolve({ data: result?.data ?? null, error: result?.error ?? null }),
    };
  };
}

// Factories canônicos dos módulos mockados. Manter o shape aqui evita que cada
// teste replique o mesmo par createSupabaseServer/createSupabaseAdmin; `onCreate`
// preserva os casos que também verificam se a service role chegou a ser criada.
export function makeSupabaseServerModuleMock<T>(createClient: () => T) {
  return { createSupabaseServer: async () => createClient() };
}

export function makeSupabaseAdminModuleMock<T>(
  createClient: () => T,
  onCreate?: () => void,
) {
  return {
    createSupabaseAdmin: () => {
      onCreate?.();
      return createClient();
    },
  };
}

export function callsOf(
  writeCalls: WriteCall[],
  op: string,
  table?: string,
): WriteCall[] {
  return writeCalls.filter((c) => c.op === op && (!table || c.table === table));
}

// Rastreia a última operação de escrita (update/upsert/insert/delete) por
// referência mutável, para que os dois mocks abaixo possam expor o `op`
// corrente ao restante do builder (chave de erro, fallback de leitura) sem
// duplicar os quatro métodos de escrita entre si.
type OpRef = { current: string };

function attachWriteOps(
  builder: Record<string, unknown>,
  table: string,
  writeCalls: WriteCall[],
  opRef: OpRef,
) {
  builder.update = (payload: unknown) => {
    writeCalls.push({ table, op: "update", payload });
    opRef.current = "update";
    return builder;
  };
  builder.upsert = (payload: unknown) => {
    writeCalls.push({ table, op: "upsert", payload });
    opRef.current = "upsert";
    return builder;
  };
  builder.insert = (payload: unknown) => {
    writeCalls.push({ table, op: "insert", payload });
    opRef.current = "insert";
    return builder;
  };
  builder.delete = () => {
    writeCalls.push({ table, op: "delete", payload: null });
    opRef.current = "delete";
    return builder;
  };
}

// Mock filter-aware: aplica eq/neq/is/in/limit às linhas de state.tableData[table]
// e registra writes em state.writeCalls. Usado por comparisons-retry.test.ts,
// auto-comparison.test.ts e compare-sync.test.ts. `state` deve ser passado como
// objeto fresco a cada chamada de makeClient() local (não memoizar), para
// sempre refletir os valores atuais de `let tableData`/`let writeCalls` do
// arquivo de teste — que são reatribuídos por inteiro no beforeEach.
export function makeFilterAwareSupabaseMock(state: {
  tableData: Record<string, unknown[]>;
  writeCalls: WriteCall[];
  rpcCalls?: RpcCall[];
  rpcResults?: Record<string, RpcResult>;
  queryErrors?: Record<string, QueryError | null>;
  // Teto de linhas por resposta (PostgREST `max_rows`). Default: sem teto.
  maxRows?: number;
}) {
  return {
    rpc: makeRpc(state),
    from: (table: string) => {
      const eqs: Array<[string, unknown]> = [];
      const neqs: Array<[string, unknown]> = [];
      const ins: Array<[string, unknown[]]> = [];
      const opRef: OpRef = { current: "select" };
      let limitN: number | null = null;
      let rangeFrom: number | null = null;
      let rangeTo: number | null = null;
      let orderBy: { column: string; ascending: boolean } | null = null;
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = (c: string, v: unknown) => {
        eqs.push([c, v]);
        return builder;
      };
      builder.neq = (c: string, v: unknown) => {
        neqs.push([c, v]);
        return builder;
      };
      builder.is = (c: string, v: unknown) => {
        eqs.push([c, v]);
        return builder;
      };
      builder.in = (c: string, v: unknown[]) => {
        ins.push([c, v]);
        return builder;
      };
      builder.limit = (n: number) => {
        limitN = n;
        return builder;
      };
      builder.range = (from: number, to: number) => {
        rangeFrom = from;
        rangeTo = to;
        return builder;
      };
      // Ordena de verdade, porque é a ordem que decide QUAIS linhas caem em cada
      // página: um mock que aceitasse `.order()` sem aplicá-lo não distinguiria
      // uma paginação estável de uma que pula linha na fronteira.
      builder.order = (column: string, options?: { ascending?: boolean }) => {
        orderBy = { column, ascending: options?.ascending !== false };
        return builder;
      };
      attachWriteOps(builder, table, state.writeCalls, opRef);
      const rows = () => {
        const data = (state.tableData[table] ?? []) as Array<
          Record<string, unknown>
        >;
        const filtered = data.filter((r) => {
          for (const [c, v] of eqs) if (r[c] !== v) return false;
          for (const [c, v] of neqs) if (r[c] === v) return false;
          for (const [c, vals] of ins) if (!vals.includes(r[c])) return false;
          return true;
        });
        // A ordem é aplicada ANTES do recorte, como no servidor: ordenar depois
        // de paginar reordenaria a página em vez de definir o seu conteúdo.
        const ordered = orderBy ? sortRows(filtered, orderBy) : filtered;
        const limited = limitN != null ? ordered.slice(0, limitN) : ordered;
        // `maxRows` reproduz o teto do PostgREST, que vale mesmo sem .range():
        // sem ele o mock devolveria o conjunto inteiro e nenhum teste
        // conseguiria distinguir uma leitura paginada de uma truncada. Default
        // Infinity para não impor fixtures gigantes a quem não testa isso.
        const maxRows = state.maxRows ?? Infinity;
        const from = rangeFrom ?? 0;
        const to = rangeTo != null ? rangeTo + 1 : Infinity;
        return limited.slice(from, Math.min(to, from + maxRows));
      };
      const err = () => state.queryErrors?.[`${table}:${opRef.current}`] ?? null;
      builder.single = () =>
        Promise.resolve({ data: rows()[0] ?? null, error: err() });
      builder.maybeSingle = () =>
        Promise.resolve({ data: rows()[0] ?? null, error: err() });
      builder.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: rows(), error: err() });
      return builder;
    },
  };
}

// Variante simples (ignora filtros .eq/.is/.in/.neq/.limit — resolve por
// chave de tabela inteira, com fallback para chave sufixada pela operação).
// Usada só por arbitration-retry.test.ts.
export function makeSimpleSupabaseMock(state: {
  tableData: Record<string, unknown>;
  writeCalls: WriteCall[];
  rpcCalls?: RpcCall[];
  rpcResults?: Record<string, RpcResult>;
  queryErrors?: Record<string, QueryError | null>;
  // Teto de linhas por resposta (PostgREST `max_rows`). Default: sem teto.
  maxRows?: number;
}) {
  return {
    rpc: makeRpc(state),
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      const opRef: OpRef = { current: "select" };
      let rangeFrom: number | null = null;
      let rangeTo: number | null = null;
      // `order` é no-op aqui de propósito: esta variante resolve por chave de
      // tabela e não modela ordenação. O que ela precisa modelar é o TETO, que
      // é o que separa leitura completa de leitura truncada.
      for (const m of ["select", "eq", "is", "in", "neq", "limit", "order"]) {
        builder[m] = () => builder;
      }
      builder.range = (from: number, to: number) => {
        rangeFrom = from;
        rangeTo = to;
        return builder;
      };
      attachWriteOps(builder, table, state.writeCalls, opRef);
      // O teto vale mesmo sem .range(): quem não pagina recebe a primeira
      // página como se fosse o conjunto inteiro.
      const paginate = (data: unknown) => {
        if (!Array.isArray(data)) return data;
        const from = rangeFrom ?? 0;
        const to = rangeTo != null ? rangeTo + 1 : Infinity;
        return data.slice(from, Math.min(to, from + (state.maxRows ?? Infinity)));
      };
      builder.then = (resolve: (v: unknown) => unknown) =>
        resolve({
          data: paginate(
            state.tableData[`${table}:${opRef.current}`] ??
              state.tableData[table] ??
              null,
          ),
          error: state.queryErrors?.[`${table}:${opRef.current}`] ?? null,
        });
      return builder;
    },
  };
}
