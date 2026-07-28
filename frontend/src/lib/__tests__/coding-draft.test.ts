// Camada pura do rascunho local de respostas (#608). O que se fixa aqui é a
// leitura fail-closed do envelope e a classificação que decide o que a faixa de
// recuperação oferece — as duas coisas de que depende a promessa "o rascunho é
// oferecido, nunca aplicado em silêncio". O I/O (chave, compare-and-swap,
// debounce, GC) é coberto por `useCodingDrafts.test.ts`.
import { describe, it, expect } from "vitest";
import {
  CODING_DRAFT_FORMAT_VERSION,
  CODING_DRAFT_NOTES_KEY,
  classifyCodingDraft,
  codingDraftStorageKey,
  codingDraftUserPrefix,
  diffCodingSnapshots,
  envelopeMatchesScope,
  readCodingDraft,
  sameCodingSnapshot,
  type CodingDraftEnvelope,
  type CodingSnapshot,
} from "@/lib/coding-draft";
import type { PydanticField } from "@/lib/types";

const field = (name: string, extra: Partial<PydanticField> = {}): PydanticField =>
  ({ name, type: "text", options: null, description: "", ...extra }) as PydanticField;

const FIELDS = [field("q1"), field("q2")];

const snapshot = (
  answers: Record<string, unknown>,
  notes = "",
): CodingSnapshot => ({ answers, notes });

const SCOPE = { userId: "u-1", projectId: "p-1", documentId: "d-1" };

const envelope = (over: Partial<CodingDraftEnvelope> = {}): CodingDraftEnvelope => ({
  formatVersion: CODING_DRAFT_FORMAT_VERSION,
  writeToken: "tok-1",
  userId: "u-1",
  projectId: "p-1",
  documentId: "d-1",
  updatedAt: 1_700_000_000_000,
  base: snapshot({ q1: "a" }),
  draft: snapshot({ q1: "a", q2: "b" }),
  ...over,
});

const raw = (value: unknown): string => JSON.stringify(value);

describe("codingDraftStorageKey — escopo da chave", () => {
  // O usuário na chave é o que impede duas pesquisadoras que dividem a mesma
  // máquina de verem o rascunho uma da outra: nada limpa o localStorage no
  // logout. Mutação que fica vermelha: tirar `userId` da composição.
  it("separa usuários no mesmo documento", () => {
    const a = codingDraftStorageKey(SCOPE);
    const b = codingDraftStorageKey({ ...SCOPE, userId: "u-2" });
    expect(a).not.toBe(b);
    expect(a).toContain("u-1");
  });

  it("separa documentos do mesmo projeto", () => {
    expect(codingDraftStorageKey(SCOPE)).not.toBe(
      codingDraftStorageKey({ ...SCOPE, documentId: "d-2" }),
    );
  });

  // O GC varre por este prefixo; se ele não delimitasse o usuário, a varredura
  // alcançaria o slot de um colega na mesma máquina.
  it("o prefixo de varredura do GC contém o usuário e casa com a chave", () => {
    expect(codingDraftStorageKey(SCOPE).startsWith(codingDraftUserPrefix("u-1"))).toBe(true);
    expect(codingDraftStorageKey(SCOPE).startsWith(codingDraftUserPrefix("u-2"))).toBe(false);
  });
});

describe("readCodingDraft — leitura fail-closed", () => {
  it("lê um envelope válido", () => {
    const read = readCodingDraft(raw(envelope()));
    expect(read.kind).toBe("draft");
  });

  it("slot vazio é `empty`", () => {
    expect(readCodingDraft(null).kind).toBe("empty");
    expect(readCodingDraft("").kind).toBe("empty");
  });

  it("JSON quebrado é `empty`, não lança", () => {
    expect(readCodingDraft("{nao-e-json").kind).toBe("empty");
  });

  // Mutação vermelha: trocar `z.strictObject` por `z.object`. Uma propriedade
  // desconhecida significa que o envelope foi escrito por um contrato que não é
  // este; aceitá-la parcialmente aplicaria dado de origem desconhecida.
  it("propriedade desconhecida no envelope não vira `draft`", () => {
    const read = readCodingDraft(raw({ ...envelope(), extra: 1 }));
    expect(read.kind).toBe("stale-format");
  });

  // Mutação vermelha: devolver `stale-format` para formato maior. Um envelope
  // de formato MAIOR foi escrito por um build que sabe mais — durante um deploy,
  // a aba velha não pode assumir o slot da aba nova.
  it("formato maior cede o slot (`newer-format`)", () => {
    const read = readCodingDraft(raw({ formatVersion: CODING_DRAFT_FORMAT_VERSION + 1 }));
    expect(read).toEqual({
      kind: "newer-format",
      formatVersion: CODING_DRAFT_FORMAT_VERSION + 1,
    });
  });

  // Mutação vermelha: colapsar `stale-format` em `empty`. "Não havia rascunho" e
  // "havia um que não consegui ler" são fatos diferentes — o segundo precisa ser
  // contado para a pesquisadora, senão todo bump de formato apaga trabalho calado.
  it("formato antigo é `stale-format`, distinto de `empty`", () => {
    const read = readCodingDraft(raw({ formatVersion: 0, writeToken: "x" }));
    expect(read).toEqual({ kind: "stale-format", formatVersion: 0 });
  });

  it("envelope do formato corrente porém corrompido é `stale-format`, não `empty`", () => {
    const read = readCodingDraft(raw({ ...envelope(), writeToken: "" }));
    expect(read.kind).toBe("stale-format");
  });

  it("rejeita `notes` ausente e `answers` em forma errada", () => {
    expect(readCodingDraft(raw({ ...envelope(), draft: { answers: {} } })).kind).toBe(
      "stale-format",
    );
    expect(
      readCodingDraft(raw({ ...envelope(), draft: { answers: [], notes: "" } })).kind,
    ).toBe("stale-format");
  });

  // A contrapartida do `z.record(z.string(), z.unknown())`: um valor que não
  // casa com o tipo do campo no schema ATUAL ainda é um envelope legível. O
  // schema pode ter mudado desde a escrita; quem filtra é `sanitizeStoredAnswers`
  // na hora de aplicar. Mutação vermelha: tipar `answers` por campo.
  it("aceita valor de qualquer forma em `answers` (o schema pode ter mudado)", () => {
    const read = readCodingDraft(
      raw(envelope({ draft: snapshot({ q1: { doenca: "x" }, q2: ["a", "b"] }) })),
    );
    expect(read.kind).toBe("draft");
  });
});

describe("envelopeMatchesScope — o envelope certo no slot certo", () => {
  // Mutação vermelha: remover a checagem. O separador da chave é `:` e três
  // UUIDs se parecem; sem esta segunda barreira, um bug de parse aplicaria as
  // respostas de um documento em outro — dado de pesquisa fabricado em silêncio.
  it("recusa envelope cuja identidade embutida discorda da chave", () => {
    expect(envelopeMatchesScope(envelope(), SCOPE)).toBe(true);
    expect(envelopeMatchesScope(envelope({ documentId: "d-9" }), SCOPE)).toBe(false);
    expect(envelopeMatchesScope(envelope({ userId: "u-9" }), SCOPE)).toBe(false);
    expect(envelopeMatchesScope(envelope({ projectId: "p-9" }), SCOPE)).toBe(false);
  });
});

describe("diffCodingSnapshots — o que difere", () => {
  it("nomeia os campos que diferem", () => {
    expect(
      diffCodingSnapshots(snapshot({ q1: "a", q2: "x" }), snapshot({ q1: "a" }), FIELDS),
    ).toEqual(["q2"]);
  });

  // Mutação vermelha: trocar `stableStringify` por `JSON.stringify`. Um grupo de
  // subcampos que faz round-trip pelo jsonb volta com as chaves em outra ordem;
  // contá-lo como edição faria a faixa oferecer um rascunho idêntico ao servidor.
  it("reordenar chaves de um valor composto não conta como diferença", () => {
    const a = snapshot({ q1: { cid: "G12", doenca: "AME" } });
    const b = snapshot({ q1: { doenca: "AME", cid: "G12" } });
    expect(diffCodingSnapshots(a, b, FIELDS)).toEqual([]);
    expect(sameCodingSnapshot(a, b, FIELDS)).toBe(true);
  });

  // Mutação vermelha: iterar as chaves de `answers` em vez de `fields`. Um campo
  // que saiu do schema não seria reescrito ao aplicar (`sanitizeStoredAnswers` o
  // descarta), então contá-lo faria a faixa prometer uma mudança que não ocorre.
  it("ignora campo que saiu do schema", () => {
    expect(
      diffCodingSnapshots(snapshot({ q1: "a", removido: "z" }), snapshot({ q1: "a" }), FIELDS),
    ).toEqual([]);
  });

  it("as notas entram no diff sob a chave que o servidor já usa", () => {
    expect(diffCodingSnapshots(snapshot({}, "nota"), snapshot({}, ""), FIELDS)).toEqual([
      CODING_DRAFT_NOTES_KEY,
    ]);
  });

  it("ausente e vazio são distintos; ausente e ausente são iguais", () => {
    expect(diffCodingSnapshots(snapshot({ q1: "" }), snapshot({}), FIELDS)).toEqual(["q1"]);
    expect(diffCodingSnapshots(snapshot({}), snapshot({}), FIELDS)).toEqual([]);
  });
});

describe("classifyCodingDraft — o que a faixa oferece", () => {
  const remote = snapshot({ q1: "a" });

  it("sem envelope, não há nada a oferecer", () => {
    expect(classifyCodingDraft(null, remote, FIELDS)).toEqual({ kind: "none" });
  });

  // Mutação vermelha: oferecer sempre que houver envelope. Uma faixa que aparece
  // sem ter o que oferecer ensina a pesquisadora a ignorá-la — e ela deixa de
  // funcionar no dia em que há trabalho de verdade no slot.
  it("rascunho que repete o servidor é `redundant`", () => {
    const r = classifyCodingDraft(
      envelope({ base: snapshot({}), draft: snapshot({ q1: "a" }) }),
      remote,
      FIELDS,
    );
    expect(r.kind).toBe("redundant");
  });

  // Mutação vermelha: devolver sempre `diverged`. Avisar "o documento foi salvo
  // depois" quando não foi é o mesmo ruído, com o agravante de sugerir perda.
  it("servidor parado desde o rascunho é `resumable`", () => {
    const r = classifyCodingDraft(
      envelope({ base: snapshot({ q1: "a" }), draft: snapshot({ q1: "a", q2: "b" }) }),
      remote,
      FIELDS,
    );
    expect(r).toMatchObject({ kind: "resumable", changedFields: ["q2"] });
  });

  it("servidor que andou é `diverged`", () => {
    const r = classifyCodingDraft(
      envelope({ base: snapshot({ q1: "antigo" }), draft: snapshot({ q1: "rascunho" }) }),
      remote,
      FIELDS,
    );
    expect(r.kind).toBe("diverged");
  });

  // O teste que fixa a decisão de desenho mais fácil de errar, e o único que
  // separa a interseção de "tudo que o servidor mudou". Mutação vermelha:
  // `overwrittenFields: remoteMoved`.
  //
  // O cenário discriminante exige um campo em que o servidor andou E o rascunho
  // já coincide com o valor novo — duas abas, ou a mesma pessoa que digitou o
  // que já fora gravado. Ali retomar não perde nada, e anunciar perda empurra a
  // pesquisadora a descartar trabalho bom. Cuidado ao editar: com `q2: "antigo"`
  // no rascunho os dois cálculos dão o mesmo resultado e o teste vira vácuo.
  it("`overwrittenFields` exclui o campo que o servidor mudou e o rascunho já concorda", () => {
    const r = classifyCodingDraft(
      envelope({
        base: snapshot({ q1: "antigo", q2: "antigo" }),
        draft: snapshot({ q1: "rascunho", q2: "coincide" }),
      }),
      snapshot({ q1: "antigo", q2: "coincide" }),
      FIELDS,
    );
    if (r.kind !== "diverged") throw new Error("esperava diverged");
    expect(r.changedFields).toEqual(["q1"]);
    expect(r.overwrittenFields).toEqual([]);
  });

  // O caso complementar: aqui o rascunho de fato atropela a escrita do servidor,
  // e o campo PRECISA ser anunciado.
  it("`overwrittenFields` inclui o campo que o rascunho atropela", () => {
    const r = classifyCodingDraft(
      envelope({
        base: snapshot({ q1: "antigo", q2: "antigo" }),
        draft: snapshot({ q1: "rascunho", q2: "antigo" }),
      }),
      snapshot({ q1: "antigo", q2: "servidor-novo" }),
      FIELDS,
    );
    if (r.kind !== "diverged") throw new Error("esperava diverged");
    expect(r.changedFields.toSorted()).toEqual(["q1", "q2"]);
    expect(r.overwrittenFields).toEqual(["q2"]);
  });

  it("carrega o conteúdo e o instante do rascunho para a faixa", () => {
    const r = classifyCodingDraft(
      envelope({ base: snapshot({ q1: "a" }), draft: snapshot({ q1: "a", q2: "b" }) }),
      remote,
      FIELDS,
    );
    if (r.kind !== "resumable") throw new Error("esperava resumable");
    expect(r.draft.answers).toEqual({ q1: "a", q2: "b" });
    expect(r.updatedAt).toBe(1_700_000_000_000);
  });

  // Um rascunho que só difere num campo removido do schema não tem o que
  // acrescentar: aplicá-lo não mudaria nada de visível.
  it("diferença apenas em campo removido do schema é `redundant`", () => {
    const r = classifyCodingDraft(
      envelope({ base: snapshot({ q1: "a" }), draft: snapshot({ q1: "a", removido: "z" }) }),
      remote,
      FIELDS,
    );
    expect(r.kind).toBe("redundant");
  });
});
