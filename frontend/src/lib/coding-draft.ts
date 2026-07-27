import { z } from "zod";
import { stableStringify } from "@/lib/schema-utils";
import type { PydanticField } from "@/lib/types";

// Rascunho local das RESPOSTAS de codificação. Espelha deliberadamente o
// desenho de `schema-draft.ts` (envelope versionado + leitura de 4 estados),
// porque as armadilhas são as mesmas e já foram pagas uma vez lá. O que muda é
// o escopo — aqui a chave desce até o documento — e o baseline, que aqui é um
// snapshot de conteúdo em vez de uma `revision` monotônica: respostas não têm
// versionamento no banco, e `updated_at` não diria QUAIS campos mudaram.
//
// Esta camada não toca em `window`: só conhece string -> resultado tipado. Todo
// o I/O vive em `useCodingDrafts`.
export const CODING_DRAFT_FORMAT_VERSION = 1;

export const CODING_DRAFT_KEY_PREFIX = "dataframeit:coding-draft:";

// O escopo é recebido inteiro, nunca como `projectId: string` solto — é o que
// impede, por construção, que se construa uma chave sem usuário. O motivo está
// em `useSchemaDraft` e vale igual aqui: o localStorage é do navegador, não da
// sessão, e nada o limpa no logout. Sem o usuário na chave, duas pesquisadoras
// que dividem a mesma máquina veem o rascunho uma da outra.
//
// O `userId` correto é o membro DONO da escrita (`ownMemberUserId` de
// `resolveProjectQueueIdentity`), nunca o `queueUserId` da impersonação: sob
// `?viewAsUser=` a fila exibida muda, mas o ator das mutations não. Chavear
// pelo usuário observado faria o master depositar rascunho no slot alheio.
export interface CodingDraftScope {
  userId: string;
  projectId: string;
  documentId: string;
}

export function codingDraftStorageKey(scope: CodingDraftScope): string {
  return `${CODING_DRAFT_KEY_PREFIX}${scope.userId}:${scope.projectId}:${scope.documentId}`;
}

// Prefixo de varredura do GC: delimita os slots DESTE usuário. O GC nunca sai
// daqui — apagar rascunho de outro usuário numa máquina compartilhada é apagar
// trabalho alheio.
export function codingDraftUserPrefix(userId: string): string {
  return `${CODING_DRAFT_KEY_PREFIX}${userId}:`;
}

// As notas viajam no mesmo diff que as respostas, sob a chave que o servidor já
// usa para elas (`justifications._notes`, ver `saveResponse`). Um único diff
// nomeado é o que permite à faixa de recuperação listar o que seria
// sobrescrito sem manter um caminho paralelo só para as notas.
export const CODING_DRAFT_NOTES_KEY = "_notes";

const codingSnapshotSchema = z.strictObject({
  // Sem tipagem por campo, de propósito. O schema Pydantic do projeto pode ter
  // mudado entre a escrita e a leitura deste envelope; um Zod que conhecesse os
  // tipos rejeitaria o rascunho INTEIRO por causa de um campo que virou grupo
  // (o caso real medido no #606). A validação contra o schema acontece na hora
  // de APLICAR, via `sanitizeStoredAnswers`, que já é a fronteira de leitura dos
  // dois modos de codificação. Aqui só se exige que a forma seja estrutural.
  answers: z.record(z.string(), z.unknown()),
  notes: z.string(),
});

export type CodingSnapshot = z.infer<typeof codingSnapshotSchema>;

const codingDraftEnvelopeSchema = z.strictObject({
  formatVersion: z.literal(CODING_DRAFT_FORMAT_VERSION),
  writeToken: z.string().min(1),
  // Redundantes com a chave, e não por decoração: o separador é `:` e três
  // UUIDs se parecem. Sem esta cópia, um bug de composição/parse de chave
  // aplicaria as respostas do documento A no documento B — fabricar dado de
  // pesquisa em silêncio é o pior desfecho que esta feature consegue produzir.
  // Com ela, o mesmo bug degrada para "rascunho descartado".
  userId: z.string().min(1),
  projectId: z.string().min(1),
  documentId: z.string().min(1),
  // Alimenta três consumidores: o TTL do GC, a evicção por idade e o "há N
  // horas" da faixa de recuperação. `schema-draft` não tem nenhum dos três
  // porque lá existe um slot por projeto; aqui existe um por documento.
  updatedAt: z.number().int().nonnegative(),
  // O que estava na tela quando este rascunho nasceu. É o que permite
  // distinguir "o servidor não andou desde então" de "andou, e retomar
  // sobrescreve" — sem construir um merge de três vias.
  base: codingSnapshotSchema,
  draft: codingSnapshotSchema,
});

export type CodingDraftEnvelope = z.infer<typeof codingDraftEnvelopeSchema>;

// Só o marcador de formato, sem `strictObject`: reconhece um envelope que
// existe mas que este build não sabe ler.
const formatMarkerSchema = z.object({ formatVersion: z.number().int() });

// Mesma taxonomia de `schema-draft.ts`, pelo mesmo motivo: colapsar "não tem
// nada" e "tem algo que não sei ler" num único `null` faz o compare-and-swap
// concluir "slot livre" e sobrescrever, em silêncio, o rascunho de uma aba mais
// nova durante um deploy que bumpe o formato.
export type CodingDraftRead =
  | { kind: "empty" }
  | { kind: "draft"; draft: CodingDraftEnvelope }
  | { kind: "stale-format"; formatVersion: number }
  | { kind: "newer-format"; formatVersion: number };

export function readCodingDraft(raw: string | null): CodingDraftRead {
  if (!raw) return { kind: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "empty" };
  }

  const envelope = codingDraftEnvelopeSchema.safeParse(parsed);
  if (envelope.success) return { kind: "draft", draft: envelope.data };

  const marker = formatMarkerSchema.safeParse(parsed);
  if (marker.success) {
    if (marker.data.formatVersion > CODING_DRAFT_FORMAT_VERSION) {
      return { kind: "newer-format", formatVersion: marker.data.formatVersion };
    }
    return { kind: "stale-format", formatVersion: marker.data.formatVersion };
  }

  return { kind: "empty" };
}

export function parseCodingDraft(raw: string | null): CodingDraftEnvelope | null {
  const read = readCodingDraft(raw);
  return read.kind === "draft" ? read.draft : null;
}

// Segunda barreira contra o envelope certo no slot errado. A primeira é a
// chave; esta prova que o conteúdo concorda com ela.
export function envelopeMatchesScope(
  envelope: CodingDraftEnvelope,
  scope: CodingDraftScope,
): boolean {
  return (
    envelope.userId === scope.userId &&
    envelope.projectId === scope.projectId &&
    envelope.documentId === scope.documentId
  );
}

// Nomes dos campos em que dois snapshots discordam, restrito aos campos que o
// schema atual conhece — mais `_notes` quando as notas diferem.
//
// A restrição a `fields` não é um detalhe de performance: uma resposta a campo
// que saiu do schema nunca seria reescrita (`sanitizeStoredAnswers` a descarta
// ao aplicar), então contá-la como diferença faria a faixa oferecer um rascunho
// cuja retomada não mudaria nada de visível.
//
// A comparação é por `stableStringify` para que reordenar as chaves de um valor
// composto — um grupo de subcampos, tipicamente — não passe por edição.
export function diffCodingSnapshots(
  a: CodingSnapshot,
  b: CodingSnapshot,
  fields: PydanticField[],
): string[] {
  const changed: string[] = [];
  for (const field of fields) {
    if (stableStringify(a.answers[field.name]) !== stableStringify(b.answers[field.name])) {
      changed.push(field.name);
    }
  }
  if (a.notes !== b.notes) changed.push(CODING_DRAFT_NOTES_KEY);
  return changed;
}

export function sameCodingSnapshot(
  a: CodingSnapshot,
  b: CodingSnapshot,
  fields: PydanticField[],
): boolean {
  return diffCodingSnapshots(a, b, fields).length === 0;
}

export type CodingDraftRecovery =
  // Sem envelope legível: nada a oferecer.
  | { kind: "none" }
  // O rascunho repete o que o servidor já tem. Retomá-lo não mudaria nada, e
  // oferecer seria ruído que ensina a pesquisadora a ignorar a faixa — a
  // primeira coisa que a tornaria inútil no dia em que ela importa.
  | { kind: "redundant" }
  // O servidor não andou desde que o rascunho nasceu: retomar só acrescenta.
  | {
      kind: "resumable";
      draft: CodingSnapshot;
      updatedAt: number;
      changedFields: string[];
    }
  // O servidor andou. Retomar ainda é legítimo — é trabalho da própria
  // pesquisadora —, mas ela precisa saber o que perde.
  | {
      kind: "diverged";
      draft: CodingSnapshot;
      updatedAt: number;
      changedFields: string[];
      overwrittenFields: string[];
    };

// Decide o que oferecer ao reabrir um documento. Puro: recebe o envelope lido,
// o que o servidor entregou no render (`remote`) e o schema atual.
export function classifyCodingDraft(
  envelope: CodingDraftEnvelope | null,
  remote: CodingSnapshot,
  fields: PydanticField[],
): CodingDraftRecovery {
  if (!envelope) return { kind: "none" };

  // O que retomar mudaria em relação ao que está na tela.
  const changedFields = diffCodingSnapshots(envelope.draft, remote, fields);
  if (changedFields.length === 0) return { kind: "redundant" };

  // O que o servidor mudou desde que este rascunho nasceu.
  const remoteMoved = diffCodingSnapshots(envelope.base, remote, fields);
  if (remoteMoved.length === 0) {
    return {
      kind: "resumable",
      draft: envelope.draft,
      updatedAt: envelope.updatedAt,
      changedFields,
    };
  }

  // A INTERSEÇÃO, não `remoteMoved` inteiro: um campo que o servidor mudou e
  // que o rascunho não toca não seria sobrescrito por retomar. Listá-lo como
  // perda é mentira que empurra a pesquisadora a descartar trabalho bom.
  const changedSet = new Set(changedFields);
  return {
    kind: "diverged",
    draft: envelope.draft,
    updatedAt: envelope.updatedAt,
    changedFields,
    overwrittenFields: remoteMoved.filter((name) => changedSet.has(name)),
  };
}
