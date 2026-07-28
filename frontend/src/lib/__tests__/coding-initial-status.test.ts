import { describe, it, expect } from "vitest";
import {
  resolveInitialCodingStatus,
  type CodingResponseRow,
} from "@/lib/coding-initial-status";
import { OTHER_PREFIX } from "@/lib/other-option";
import type { RoundContext } from "@/lib/rounds";
import type { PydanticField, Round } from "@/lib/types";

// Regressão da issue #521: o assignment de codificação criado DEPOIS da response
// (sorteio ou atribuição manual sobre documento já codificado pelo Explorar)
// nascia 'pendente' e nada o promovia — syncCodingAssignmentStatus só roda no
// save. Aqui trava a régua que decide o status inicial.

function field(partial: Partial<PydanticField> & { name: string }): PydanticField {
  return {
    type: "single",
    options: ["a", "b"],
    description: "",
    ...partial,
  } as PydanticField;
}

const FIELDS = [field({ name: "q1" }), field({ name: "q2" })];
const COMPLETE = { q1: "a", q2: "b" };
const UPDATED_AT = "2026-07-20T10:00:00.000Z";

const SCHEMA_CTX: RoundContext = {
  strategy: "schema_version",
  currentRoundId: null,
  currentVersion: { major: 1, minor: 2, patch: 0 },
  rounds: [],
};

const NO_ROUNDS = new Map<string, Round>();

function response(partial: Partial<CodingResponseRow> = {}): CodingResponseRow {
  return {
    answers: COMPLETE,
    updated_at: UPDATED_AT,
    is_partial: false,
    schema_version_major: 1,
    schema_version_minor: 2,
    schema_version_patch: 0,
    ...partial,
  };
}

describe("resolveInitialCodingStatus", () => {
  it("sem response → pendente", () => {
    expect(resolveInitialCodingStatus(SCHEMA_CTX, NO_ROUNDS, undefined, FIELDS)).toEqual({
      status: "pendente",
      completed_at: null,
    });
  });

  it("codificação completa da rodada atual → concluido com completed_at da response", () => {
    expect(resolveInitialCodingStatus(SCHEMA_CTX, NO_ROUNDS, response(), FIELDS)).toEqual({
      status: "concluido",
      completed_at: UPDATED_AT,
    });
  });

  it("codificação parcial da rodada atual → em_andamento", () => {
    const partial = response({ answers: { q1: "a" } });
    expect(resolveInitialCodingStatus(SCHEMA_CTX, NO_ROUNDS, partial, FIELDS)).toEqual({
      status: "em_andamento",
      completed_at: null,
    });
  });

  it("codificação COMPLETA mas nunca enviada (is_partial) → em_andamento, não concluido", () => {
    // Nas linhas ANTERIORES ao #608 `is_partial` marca "não clicou em Enviar",
    // não "faltam campos": o auto-save gravava true com o formulário inteiro
    // preenchido, e essas linhas continuam no banco. Nascer
    // `concluido` aqui seria a #521 ao contrário, e definitivo —
    // `keepCodingAssignmentInProgress` nunca regride de `concluido`. O par com
    // o caso acima prova que o veredito vem do is_partial, e não do conteúdo:
    // as mesmas respostas completas, só a flag muda.
    const naoEnviada = response({ is_partial: true });
    expect(resolveInitialCodingStatus(SCHEMA_CTX, NO_ROUNDS, naoEnviada, FIELDS)).toEqual({
      status: "em_andamento",
      completed_at: null,
    });
  });

  it("opção 'outro' sem texto → em_andamento; com texto → concluido", () => {
    // O par prova que o veredito vem do complemento vazio, e não do campo em si:
    // muda só o texto livre e o status vira concluido.
    const fields = [field({ name: "q1" }), field({ name: "q2", options: ["a", "b", "Outro"] })];
    const semTexto = response({ answers: { q1: "a", q2: OTHER_PREFIX } });
    const comTexto = response({ answers: { q1: "a", q2: `${OTHER_PREFIX}liminar` } });

    expect(resolveInitialCodingStatus(SCHEMA_CTX, NO_ROUNDS, semTexto, fields).status).toBe(
      "em_andamento",
    );
    expect(resolveInitialCodingStatus(SCHEMA_CTX, NO_ROUNDS, comTexto, fields).status).toBe(
      "concluido",
    );
  });

  it("response de versão de schema anterior → pendente, não concluido", () => {
    // Sem isto, um sorteio aberto para nova rodada nasceria concluído sobre
    // trabalho da rodada passada e esconderia a recodificação pedida.
    const previous = response({ schema_version_major: 1, schema_version_minor: 1 });
    expect(resolveInitialCodingStatus(SCHEMA_CTX, NO_ROUNDS, previous, FIELDS)).toEqual({
      status: "pendente",
      completed_at: null,
    });
  });

  it("estratégia manual: rodada atual → concluido; rodada anterior → pendente", () => {
    const rounds: Round[] = [
      { id: "r-atual", project_id: "p1", label: "Rodada 2", created_at: UPDATED_AT },
      { id: "r-velha", project_id: "p1", label: "Rodada 1", created_at: UPDATED_AT },
    ];
    const ctx: RoundContext = {
      strategy: "manual",
      currentRoundId: "r-atual",
      currentVersion: { major: 1, minor: 2, patch: 0 },
      rounds,
    };
    const roundsById = new Map(rounds.map((r) => [r.id, r]));

    expect(
      resolveInitialCodingStatus(ctx, roundsById, response({ round_id: "r-atual" }), FIELDS)
        .status,
    ).toBe("concluido");
    expect(
      resolveInitialCodingStatus(ctx, roundsById, response({ round_id: "r-velha" }), FIELDS)
        .status,
    ).toBe("pendente");
  });

  it("campo obrigatório adicionado DEPOIS da codificação não a torna incompleta", () => {
    // Avaliação retroativa: `answer_field_hashes` é o snapshot do schema contra
    // o qual a resposta foi codificada. Sem ele, `q3` (novo) faria toda
    // codificação anterior parecer em andamento.
    const withHashes = response({
      answer_field_hashes: { q1: "h1", q2: "h2" },
    });
    const fieldsComNovo = [...FIELDS, field({ name: "q3" })];
    expect(resolveInitialCodingStatus(SCHEMA_CTX, NO_ROUNDS, withHashes, fieldsComNovo)).toEqual(
      { status: "concluido", completed_at: UPDATED_AT },
    );
  });
});
