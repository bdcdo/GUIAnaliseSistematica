import type { Assignment } from "@/lib/types";

// Ordem em que os estados de assignment devem aparecer na fila: o que exige
// trabalho primeiro. Declarada, e não herdada do alfabeto do enum — era
// justamente `.order("status", { ascending: true })` no PostgREST que punha
// `concluido` na frente (c < e < p), fazendo o modo "Ordem de atribuição" abrir
// no que a pesquisadora já tinha terminado. Um enum ordenado por acaso é um
// acoplamento invisível: renomear "concluido" mudaria a fila sem nenhum gate
// reclamar.
const STATUS_RANK: Record<Assignment["status"], number> = {
  pendente: 0,
  em_andamento: 1,
  concluido: 2,
};

// Ordem estável do modo "Ordem de atribuição". Sem `assignments.created_at` no
// schema não há ordem cronológica de atribuição a recuperar, então o critério é
// o estado; o desempate pela posição original mantém a ordenação determinística
// entre documentos do mesmo estado (o PostgREST não garante ordem sem ORDER BY).
export function sortByAssignmentStatus<
  T extends { id: string; assignment?: Pick<Assignment, "status"> },
>(docs: T[]): T[] {
  return docs
    .map((doc, index) => ({ doc, index }))
    .sort((a, b) => {
      const ra = STATUS_RANK[a.doc.assignment?.status ?? "pendente"];
      const rb = STATUS_RANK[b.doc.assignment?.status ?? "pendente"];
      return ra - rb || a.index - b.index;
    })
    .map((entry) => entry.doc);
}

// Ordena documentos pelo timestamp de codificacao do proprio pesquisador
// (responses.updated_at), do mais recente para o mais antigo. Documentos ainda
// nao codificados vao para o fim, preservando a ordem original entre si.
//
// Os timestamps vem do PostgREST em formato ISO consistente, entao a comparacao
// lexicografica direta (`<`/`>`) ordena corretamente sem precisar de Date/parse.
export function sortByRecent<T extends { id: string }>(
  docs: T[],
  codedAtByDoc: Record<string, string>,
): T[] {
  return docs
    .map((doc, index) => ({ doc, index }))
    .sort((a, b) => {
      const ta = codedAtByDoc[a.doc.id];
      const tb = codedAtByDoc[b.doc.id];
      if (ta && tb) {
        if (ta === tb) return a.index - b.index;
        return tb < ta ? -1 : 1;
      }
      if (ta) return -1;
      if (tb) return 1;
      return a.index - b.index;
    })
    .map((entry) => entry.doc);
}
