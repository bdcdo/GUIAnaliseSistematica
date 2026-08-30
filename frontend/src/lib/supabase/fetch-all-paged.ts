// Paginação de leitura do PostgREST. O builder é de uso único (o await o
// executa), por isso o caller passa uma FÁBRICA de query, não a query pronta.
//
// Compartilhado entre o export e a métrica de erro do LLM: os dois varrem
// tabelas inteiras de um projeto, onde o teto default de 1000 linhas do
// PostgREST truncaria em silêncio — e truncar aqui não dá erro, dá número errado.
//
// `orderBy` é obrigatório e a assinatura exige pelo menos uma coluna porque
// `.range()` pagina por LIMIT/OFFSET: sem ORDER BY o Postgres não promete ordem
// nenhuma ENTRE statements, e uma troca de plano ou uma escrita concorrente
// entre duas páginas pode reemitir uma linha da página anterior e omitir outra.
// Omitir uma linha aqui não é perder uma linha: na métrica, a resposta LLM
// `is_latest` que sumir tira o documento inteiro do numerador E do denominador.
// A ordem aplicada precisa ser TOTAL — as colunas passadas têm que desempatar
// até a última linha, tipicamente a PK.
const PAGE_SIZE = 1000;

interface PagedQueryBuilder<T> {
  order: (column: string) => PagedQueryBuilder<T>;
  range: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
}

export async function fetchAllPaged<T>(
  build: () => PagedQueryBuilder<T>,
  orderBy: readonly [string, ...string[]],
): Promise<{ data: T[]; error: { message: string } | null }> {
  const all: T[] = [];
  let from = 0;
  for (;;) {
    const query = orderBy.reduce<PagedQueryBuilder<T>>(
      (acc, column) => acc.order(column),
      build(),
    );
    // await sequencial é da natureza da paginação: só dá para pedir a próxima
    // página sabendo que a anterior veio cheia.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const { data, error } = await query.range(from, from + PAGE_SIZE - 1);
    if (error) return { data: all, error };
    const batch = data ?? [];
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return { data: all, error: null };
}
