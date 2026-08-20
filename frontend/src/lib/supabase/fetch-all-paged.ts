// Paginação de leitura do PostgREST. O builder é de uso único (o await o
// executa), por isso o caller passa uma FÁBRICA de query, não a query pronta.
//
// Compartilhado entre o export e a métrica de erro do LLM: os dois varrem
// tabelas inteiras de um projeto, onde o teto default de 1000 linhas do
// PostgREST truncaria em silêncio — e truncar aqui não dá erro, dá número errado.
const PAGE_SIZE = 1000;

export async function fetchAllPaged<T>(
  build: () => {
    range: (
      from: number,
      to: number,
    ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
  },
): Promise<{ data: T[]; error: { message: string } | null }> {
  const all: T[] = [];
  let from = 0;
  for (;;) {
    // await sequencial é da natureza da paginação: só dá para pedir a próxima
    // página sabendo que a anterior veio cheia.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const { data, error } = await build().range(from, from + PAGE_SIZE - 1);
    if (error) return { data: all, error };
    const batch = data ?? [];
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return { data: all, error: null };
}
