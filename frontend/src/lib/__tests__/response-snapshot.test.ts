import { describe, expect, it } from "vitest";
import {
  buildPersistedResponseSnapshot,
  sanitizeStoredAnswers,
} from "@/lib/response-snapshot";
import { OTHER_PREFIX } from "@/lib/other-option";
import { buildFieldHashMap, isFieldStale } from "@/lib/answer-staleness";
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";

const field = (input: Partial<PydanticField> & { name: string }): PydanticField =>
  ({ type: "text", options: null, description: input.name, ...input }) as PydanticField;

describe("sanitizeStoredAnswers", () => {
  it("mantém valores atuais e omite single ou multi sem nenhuma opção válida", () => {
    const fields = [
      field({ name: "single", type: "single", options: ["X", "Y"] }),
      field({ name: "multi", type: "multi", options: ["X", "Y"] }),
      field({ name: "vazio", type: "multi", options: ["X"] }),
    ];

    expect(
      sanitizeStoredAnswers(fields, {
        single: "X",
        multi: ["X", "Z"],
        vazio: ["Z"],
      }),
    ).toEqual({ single: "X", multi: ["X"] });
    expect(sanitizeStoredAnswers(fields, { single: "A" })).toEqual({});
  });

  it("preserva Outro permitido e filtra só opções comuns inválidas", () => {
    const fields = [
      field({ name: "single", type: "single", options: ["X"], allow_other: true }),
      field({ name: "multi", type: "multi", options: ["X"], allow_other: true }),
    ];

    expect(
      sanitizeStoredAnswers(fields, {
        single: `${OTHER_PREFIX}livre`,
        multi: ["X", "Z", `${OTHER_PREFIX}livre`],
      }),
    ).toEqual({
      single: `${OTHER_PREFIX}livre`,
      multi: ["X", `${OTHER_PREFIX}livre`],
    });
  });

  it("usa apenas propriedades próprias e não fabrica constructor", () => {
    const fields = [field({ name: "constructor", type: "single", options: ["X"] })];
    expect(sanitizeStoredAnswers(fields, {})).toEqual({});
  });

  it("omite campos sem widget humano e condicionais ocultas", () => {
    const fields = [
      field({ name: "gatilho", type: "single", options: ["sim", "nao"] }),
      field({ name: "detalhe", condition: { field: "gatilho", equals: "sim" } }),
      field({ name: "llm", target: "llm_only" }),
      field({ name: "none", target: "none" }),
    ];

    expect(
      sanitizeStoredAnswers(fields, {
        gatilho: "nao",
        detalhe: "órfão",
        llm: "segredo",
        none: "ignorado",
      }),
    ).toEqual({ gatilho: "nao" });
  });

  it("normaliza resposta ausente para objeto vazio", () => {
    expect(sanitizeStoredAnswers([field({ name: "q" })], null)).toEqual({});
    expect(sanitizeStoredAnswers([field({ name: "q" })], undefined)).toEqual({});
  });

  it("sem schema preserva a resposta bruta", () => {
    const answers = { legado: "valor" };
    expect(sanitizeStoredAnswers([], answers)).toBe(answers);
  });
});

describe("buildPersistedResponseSnapshot", () => {
  it("preserva campos não revisados e atualiza somente mudanças explícitas", () => {
    const fields = [
      field({ name: "partial", type: "multi", options: ["X", "Y"], hash: "partial-new" }),
      field({
        name: "other",
        type: "multi",
        options: ["X"],
        allow_other: true,
        hash: "other-new",
      }),
      field({ name: "edited", hash: "edited-new" }),
      field({ name: "cleared", type: "multi", options: ["X"], hash: "cleared-new" }),
      field({ name: "stale", type: "single", options: ["X", "Y"], hash: "stale-new" }),
      field({
        name: "constructor",
        type: "single",
        options: ["X", "Y"],
        hash: "constructor-new",
      }),
      field({ name: "fresh", hash: "fresh-new" }),
    ];
    const storedAnswers = {
      partial: ["X", "Z"],
      other: ["X", `${OTHER_PREFIX}livre`],
      edited: "antigo",
      cleared: ["X"],
      stale: "A",
      constructor: "A",
      removed: "legado",
    };
    const storedHashes: AnswerFieldHashes = {
      partial: "partial-old",
      other: "other-old",
      edited: "edited-old",
      cleared: "cleared-old",
      stale: "stale-old",
      constructor: "constructor-old",
      removed: "removed-old",
    };
    const rawSubmittedAnswers = {
      partial: ["X"],
      other: ["X", `${OTHER_PREFIX}livre`],
      edited: "novo",
      cleared: [],
      fresh: "primeiro",
    };
    const originalInputs = structuredClone({ storedAnswers, storedHashes, rawSubmittedAnswers });

    const result = buildPersistedResponseSnapshot({
      fields,
      existing: { answers: storedAnswers, hashes: storedHashes },
      rawSubmittedAnswers,
      promoteLegacyIfComplete: false,
    });

    expect(result.persistedAnswers).toEqual({
      partial: ["X", "Z"],
      other: ["X", `${OTHER_PREFIX}livre`],
      edited: "novo",
      cleared: [],
      stale: "A",
      constructor: "A",
      removed: "legado",
      fresh: "primeiro",
    });
    expect(result.answerFieldHashes).toEqual({
      partial: "partial-old",
      other: "other-old",
      edited: "edited-new",
      cleared: "cleared-new",
      stale: "stale-old",
      constructor: "constructor-old",
      removed: "removed-old",
      fresh: "fresh-new",
    });
    expect(Object.hasOwn(result.persistedAnswers, "constructor")).toBe(true);
    expect({ storedAnswers, storedHashes, rawSubmittedAnswers }).toEqual(originalInputs);
  });

  it("remove filho quando o pesquisador muda deliberadamente o gatilho", () => {
    const fields = [
      field({ name: "gatilho", type: "single", options: ["sim", "nao"], hash: "g-new" }),
      field({ name: "detalhe", hash: "d-new", condition: { field: "gatilho", equals: "sim" } }),
    ];

    const result = buildPersistedResponseSnapshot({
      fields,
      existing: {
        answers: { gatilho: "sim", detalhe: "texto" },
        hashes: { gatilho: "g-old", detalhe: "d-old" },
      },
      rawSubmittedAnswers: { gatilho: "nao" },
      promoteLegacyIfComplete: false,
    });

    // Só o gatilho foi revisado, então só ele ganha a proveniência de hoje. O
    // filho foi invalidado por consequência, com o formulário já o ocultando:
    // carimbar `d-new` afirmaria que o pesquisador viu a versão nova do campo.
    expect(result.persistedAnswers).toEqual({ gatilho: "nao" });
    expect(result.answerFieldHashes).toEqual({ gatilho: "g-new", detalhe: "d-old" });
  });

  it("remove filho stale oculto da projeção quando o gatilho muda", () => {
    const fields = [
      field({ name: "gatilho", type: "single", options: ["sim", "nao"], hash: "g-new" }),
      field({
        name: "detalhe",
        type: "single",
        options: ["atual"],
        hash: "d-new",
        condition: { field: "gatilho", equals: "sim" },
      }),
    ];

    const result = buildPersistedResponseSnapshot({
      fields,
      existing: {
        answers: { gatilho: "sim", detalhe: "antigo" },
        hashes: { gatilho: "g-old", detalhe: "d-old" },
      },
      rawSubmittedAnswers: { gatilho: "nao" },
      promoteLegacyIfComplete: false,
    });

    expect(result.submittedAnswers).toEqual({ gatilho: "nao" });
    expect(result.persistedAnswers).toEqual({ gatilho: "nao" });
    expect(result.answerFieldHashes).toEqual({ gatilho: "g-new", detalhe: "d-old" });
  });

  it("remove em cascata condicionais ocultadas pela mudança deliberada", () => {
    const fields = [
      field({ name: "gatilho", type: "single", options: ["sim", "nao"], hash: "g-new" }),
      field({
        name: "filho",
        type: "single",
        options: ["atual"],
        hash: "f-new",
        condition: { field: "gatilho", equals: "sim" },
      }),
      field({
        name: "neto",
        hash: "n-new",
        condition: { field: "filho", exists: true },
      }),
    ];

    const result = buildPersistedResponseSnapshot({
      fields,
      existing: {
        answers: { gatilho: "sim", filho: "antigo", neto: "texto" },
        hashes: { gatilho: "g-old", filho: "f-old", neto: "n-old" },
      },
      rawSubmittedAnswers: { gatilho: "nao" },
      promoteLegacyIfComplete: false,
    });

    expect(result.persistedAnswers).toEqual({ gatilho: "nao" });
    expect(result.answerFieldHashes).toEqual({
      gatilho: "g-new",
      filho: "f-old",
      neto: "n-old",
    });
  });

  it("preserva descendente já oculto quando o intermediário continua visível", () => {
    const fields = [
      field({ name: "gatilho", type: "single", options: ["A", "B"], hash: "g-new" }),
      field({
        name: "intermediario",
        type: "single",
        options: ["mostrar", "ocultar"],
        hash: "i-new",
        condition: { field: "gatilho", exists: true },
      }),
      field({
        name: "descendente",
        hash: "d-new",
        condition: { field: "intermediario", equals: "mostrar" },
      }),
    ];

    const result = buildPersistedResponseSnapshot({
      fields,
      existing: {
        answers: {
          gatilho: "A",
          intermediario: "ocultar",
          descendente: "preservado",
        },
        hashes: { gatilho: "g-old", intermediario: "i-old", descendente: "d-old" },
      },
      rawSubmittedAnswers: { gatilho: "B", intermediario: "ocultar" },
      promoteLegacyIfComplete: false,
    });

    expect(result.persistedAnswers).toEqual({
      gatilho: "B",
      intermediario: "ocultar",
      descendente: "preservado",
    });
    expect(result.answerFieldHashes).toEqual({
      gatilho: "g-new",
      intermediario: "i-old",
      descendente: "d-old",
    });
  });

  it("preserva pai e filho ocultados por uma mudança do schema", () => {
    const fields = [
      field({ name: "gatilho", type: "single", options: ["X"], hash: "g-new" }),
      field({ name: "detalhe", hash: "d-new", condition: { field: "gatilho", equals: "X" } }),
      field({ name: "outro", hash: "o-new" }),
    ];

    const result = buildPersistedResponseSnapshot({
      fields,
      existing: {
        answers: { gatilho: "sim", detalhe: "texto" },
        hashes: { gatilho: "g-old", detalhe: "d-old" },
      },
      rawSubmittedAnswers: { outro: "novo" },
      promoteLegacyIfComplete: false,
    });

    expect(result.persistedAnswers).toEqual({
      gatilho: "sim",
      detalhe: "texto",
      outro: "novo",
    });
    expect(result.answerFieldHashes).toEqual({
      gatilho: "g-old",
      detalhe: "d-old",
      outro: "o-new",
    });
  });

  it.each<AnswerFieldHashes>([null, {}])(
    "mantém o sentinela legacy de uma response já existente (%j)",
    (storedHashes) => {
      // `null`/`{}` significam "não dá para inferir quais campos existiam" e
      // `fieldExistedWhenCoded` os lê como "todos existiam". Estampar chaves aqui
      // inverteria o sentinela em "só os campos que estampei existiam", tornando
      // qualquer codificação antiga trivialmente completa — inclusive as que de
      // fato ficaram com obrigatórios em branco. Ver #520.
      const fields = [
        field({ name: "stale", type: "single", options: ["X"], hash: "stale-new" }),
        field({ name: "outro", hash: "outro-new" }),
      ];

      const result = buildPersistedResponseSnapshot({
        fields,
        existing: { answers: { stale: "A" }, hashes: storedHashes },
        rawSubmittedAnswers: { outro: "novo" },
        promoteLegacyIfComplete: false,
      });

      expect(result.persistedAnswers).toEqual({ stale: "A", outro: "novo" });
      expect(result.answerFieldHashes).toEqual({});
    },
  );

  it("submit explícito que recodifica a response legacy por completo estampa o schema atual (#548)", () => {
    // Único momento em que dá para afirmar que todos os campos de hoje existiam:
    // o submit está completo contra o schema atual. Estampar o mapa inteiro
    // desliga o sentinela e habilita a promoção de versão em buildResponsePayload.
    const fields = [
      field({ name: "q1", type: "single", options: ["a", "b"], hash: "h1" }),
      field({ name: "q2", hash: "h2" }),
    ];

    const result = buildPersistedResponseSnapshot({
      fields,
      existing: { answers: { q1: "a", q2: "velho" }, hashes: null },
      rawSubmittedAnswers: { q1: "b", q2: "novo" },
      promoteLegacyIfComplete: true,
    });

    expect(result.answerFieldHashes).toEqual({ q1: "h1", q2: "h2" });
  });

  it("a proveniência promovida não marca nenhum campo falsamente stale (#548)", () => {
    // Outra metade do par que answer-staleness.ts sustenta: depois que a
    // recodificação completa desliga o sentinela, `isFieldStale` sai do fallback
    // do schema INTEIRO e passa a comparar per-campo. Como o mapa estampado é o
    // schema corrente, todo campo bate consigo mesmo e nada aparece stale — o
    // que é o correto, já que tudo foi recodificado contra o schema de hoje.
    const fields = [
      field({ name: "q1", type: "single", options: ["a", "b"], hash: "h1" }),
      field({ name: "q2", hash: "h2" }),
    ];

    const { answerFieldHashes } = buildPersistedResponseSnapshot({
      fields,
      existing: { answers: { q1: "a", q2: "velho" }, hashes: null },
      rawSubmittedAnswers: { q1: "b", q2: "novo" },
      promoteLegacyIfComplete: true,
    });

    const currentFieldHashes = buildFieldHashMap(fields);
    for (const f of fields) {
      expect(
        isFieldStale({
          answerFieldHashes,
          // O pydantic_hash antigo (legacy) divergiria do atual: se o snapshot
          // per-campo NÃO tivesse sido promovido, o fallback marcaria stale.
          pydanticHash: "hash-legacy",
          fieldName: f.name,
          currentFieldHashes,
          projectPydanticHash: "hash-atual",
        }),
      ).toBe(false);
    }
  });

  it("submit incompleto de response legacy conserva o sentinela mesmo com promoção habilitada (#548)", () => {
    // q2 é obrigatório e ficou em branco: a codificação NÃO está completa contra
    // o schema atual, então não dá para afirmar proveniência — mantém `{}`.
    const fields = [
      field({ name: "q1", type: "single", options: ["a", "b"], hash: "h1" }),
      field({ name: "q2", hash: "h2" }),
    ];

    const result = buildPersistedResponseSnapshot({
      fields,
      existing: { answers: { q1: "a" }, hashes: null },
      rawSubmittedAnswers: { q1: "b" },
      promoteLegacyIfComplete: true,
    });

    expect(result.answerFieldHashes).toEqual({});
  });

  it("auto-save de response legacy nunca promove, ainda que completa (#548)", () => {
    // Auto-save não atesta a codificação inteira: mesmo com todos os obrigatórios
    // respondidos, `promoteLegacyIfComplete: false` conserva o sentinela.
    const fields = [
      field({ name: "q1", type: "single", options: ["a", "b"], hash: "h1" }),
    ];

    const result = buildPersistedResponseSnapshot({
      fields,
      existing: { answers: { q1: "a" }, hashes: null },
      rawSubmittedAnswers: { q1: "b" },
      promoteLegacyIfComplete: false,
    });

    expect(result.answerFieldHashes).toEqual({});
  });

  it("codificação nova estampa o schema atual inteiro", () => {
    // Não há response anterior: o schema de hoje É o schema da codificação, e
    // todo campo obrigatório dele deve ser cobrado (nada a perdoar).
    const fields = [
      field({ name: "respondido", hash: "r-hash" }),
      field({ name: "em_branco", hash: "b-hash" }),
      field({ name: "sem_hash" }),
    ];

    const result = buildPersistedResponseSnapshot({
      fields,
      existing: null,
      rawSubmittedAnswers: { respondido: "x" },
      promoteLegacyIfComplete: false,
    });

    expect(result.answerFieldHashes).toEqual({
      respondido: "r-hash",
      em_branco: "b-hash",
      sem_hash: null,
    });
  });

  it("não estampa campo criado depois da codificação (#520)", () => {
    // O pesquisador reabre um doc codificado antes do bump e toca um campo
    // qualquer. O campo novo nunca foi respondido: estampá-lo faria a
    // codificação antiga "passar a dever" e voltar para a fila de pendentes.
    const fields = [
      field({ name: "antigo", hash: "antigo-hash" }),
      field({ name: "novo_obrigatorio", hash: "novo-hash" }),
    ];

    const result = buildPersistedResponseSnapshot({
      fields,
      existing: { answers: { antigo: "a" }, hashes: { antigo: "antigo-hash" } },
      rawSubmittedAnswers: { antigo: "b" },
      promoteLegacyIfComplete: false,
    });

    expect(result.persistedAnswers).toEqual({ antigo: "b" });
    expect(result.answerFieldHashes).toEqual({ antigo: "antigo-hash" });
  });

  it("campo criado depois entra quando o pesquisador de fato o responde", () => {
    const fields = [
      field({ name: "antigo", hash: "antigo-hash" }),
      field({ name: "novo_obrigatorio", hash: "novo-hash" }),
    ];

    const result = buildPersistedResponseSnapshot({
      fields,
      existing: { answers: { antigo: "a" }, hashes: { antigo: "antigo-hash" } },
      rawSubmittedAnswers: { antigo: "a", novo_obrigatorio: "resposta" },
      promoteLegacyIfComplete: false,
    });

    expect(result.answerFieldHashes).toEqual({
      antigo: "antigo-hash",
      novo_obrigatorio: "novo-hash",
    });
  });

  it("preserva o snapshot bruto quando não há controles no schema", () => {
    const result = buildPersistedResponseSnapshot({
      fields: [],
      existing: { answers: { legado: "valor" }, hashes: { legado: "hash-antigo" } },
      rawSubmittedAnswers: {},
      promoteLegacyIfComplete: false,
    });

    expect(result.persistedAnswers).toEqual({ legado: "valor" });
    expect(result.answerFieldHashes).toEqual({ legado: "hash-antigo" });
  });

  // Caracterização do write path para a resposta em texto de um campo que
  // virou grupo de subcampos (#607). A UI garante que nenhuma tecla descarte
  // esse valor; aqui se fixa a outra metade da garantia — que a projeção
  // apresentada ao formulário não seja a via que o elimina. `keepIfStillPresentable`
  // devolve o valor cru porque esses campos têm `options: null`, e o campo não
  // revisado fica fora de `changedFieldNames`.
  describe("grupo de subcampos com valor coletado em outra forma (#607)", () => {
    const grupo = field({
      name: "q7",
      type: "text",
      options: null,
      hash: "q7-novo",
      subfields: [
        { key: "anos", label: "Anos" },
        { key: "meses", label: "Meses" },
      ],
      subfield_rule: "at_least_one",
    });

    it("o texto legado sobrevive quando o campo não é tocado", () => {
      const result = buildPersistedResponseSnapshot({
        fields: [grupo],
        existing: {
          answers: { q7: "18 anos e 6 meses" },
          hashes: { q7: "q7-antigo" },
        },
        rawSubmittedAnswers: { q7: "18 anos e 6 meses" },
        promoteLegacyIfComplete: false,
      });

      expect(result.persistedAnswers.q7).toBe("18 anos e 6 meses");
      // Hash da época preservado: o campo não entrou como revisado.
      expect(result.answerFieldHashes.q7).toBe("q7-antigo");
    });

    it("mover o texto para um subcampo grava o registro sob o schema de hoje", () => {
      const result = buildPersistedResponseSnapshot({
        fields: [grupo],
        existing: {
          answers: { q7: "18 anos e 6 meses" },
          hashes: { q7: "q7-antigo" },
        },
        rawSubmittedAnswers: { q7: { anos: "18 anos e 6 meses" } },
        promoteLegacyIfComplete: false,
      });

      expect(result.persistedAnswers.q7).toEqual({ anos: "18 anos e 6 meses" });
      expect(result.answerFieldHashes.q7).toBe("q7-novo");
      expect(result.stampsCurrentSchema).toBe(true);
    });
  });
});

describe("buildPersistedResponseSnapshot — stampsCurrentSchema (#529/#548)", () => {
  const single = (name: string, hash: string): PydanticField =>
    field({ name, type: "single", options: ["a", "b"], hash });

  it("false quando o pesquisador re-confirma o mesmo valor (toque/auto-save)", () => {
    // O sinal que autoriza promover as colunas de versão. Re-submeter o valor
    // já apresentado não é revisão: `samePresentedValue` o exclui de
    // changedFieldNames, então nenhum campo ganha o hash de hoje.
    const result = buildPersistedResponseSnapshot({
      fields: [single("q1", "h1")],
      existing: { answers: { q1: "a" }, hashes: { q1: "h1" } },
      rawSubmittedAnswers: { q1: "a" },
      promoteLegacyIfComplete: false,
    });

    expect(result.stampsCurrentSchema).toBe(false);
  });

  it("true quando um valor é de fato alterado (#529)", () => {
    const result = buildPersistedResponseSnapshot({
      fields: [single("q1", "h1")],
      existing: { answers: { q1: "a" }, hashes: { q1: "h1" } },
      rawSubmittedAnswers: { q1: "b" },
      promoteLegacyIfComplete: true,
    });

    expect(result.stampsCurrentSchema).toBe(true);
  });

  it("true quando um campo criado depois é de fato respondido (#529)", () => {
    // Simétrico com o hash: o campo novo ganha o hash de hoje, e o save promove.
    const result = buildPersistedResponseSnapshot({
      fields: [single("antigo", "antigo-hash"), single("novo", "novo-hash")],
      existing: { answers: { antigo: "a" }, hashes: { antigo: "antigo-hash" } },
      rawSubmittedAnswers: { antigo: "a", novo: "b" },
      promoteLegacyIfComplete: true,
    });

    expect(result.stampsCurrentSchema).toBe(true);
  });

  it("false quando a revisão apenas apaga o valor (fora de persistedAnswers)", () => {
    // Limpar um campo muda changedFieldNames, mas o valor não persiste — nada
    // é escrito sob o schema de hoje, então a linha conserva a época.
    const result = buildPersistedResponseSnapshot({
      fields: [single("q1", "h1")],
      existing: { answers: { q1: "a" }, hashes: { q1: "h1" } },
      rawSubmittedAnswers: {},
      promoteLegacyIfComplete: true,
    });

    expect(result.persistedAnswers).toEqual({});
    expect(result.stampsCurrentSchema).toBe(false);
  });

  it("codificação nova com resposta real estampa o schema de hoje", () => {
    const result = buildPersistedResponseSnapshot({
      fields: [single("q1", "h1")],
      existing: null,
      rawSubmittedAnswers: { q1: "a" },
      promoteLegacyIfComplete: true,
    });

    expect(result.stampsCurrentSchema).toBe(true);
  });

  it("true na via de saída legacy: submit completo recodifica e estampa (#548)", () => {
    // A interação que exige o sinal UNIFICADO: aqui `changedFieldNames` pode até
    // estar vazio (valores iguais aos apresentados), mas a recodificação completa
    // desliga o sentinela e estampa o mapa inteiro — então `stampsCurrentSchema`
    // tem de ser true para o gate `latest_major` promover, alinhado ao mapa. Um
    // sinal derivado só de `revisedPersistedFieldNames` (pré-#548) diria false e
    // reverteria a promoção.
    const result = buildPersistedResponseSnapshot({
      fields: [single("q1", "h1")],
      existing: { answers: { q1: "a" }, hashes: null },
      rawSubmittedAnswers: { q1: "a" },
      promoteLegacyIfComplete: true,
    });

    expect(result.answerFieldHashes).toEqual({ q1: "h1" });
    expect(result.stampsCurrentSchema).toBe(true);
  });

  it("false na legacy sob auto-save: conserva a época (#548)", () => {
    // Mesmo cenário, mas auto-save não atesta a codificação inteira: o sentinela
    // é conservado (`{}`) e o sinal fica false, simétrico ao mapa.
    const result = buildPersistedResponseSnapshot({
      fields: [single("q1", "h1")],
      existing: { answers: { q1: "a" }, hashes: null },
      rawSubmittedAnswers: { q1: "a" },
      promoteLegacyIfComplete: false,
    });

    expect(result.answerFieldHashes).toEqual({});
    expect(result.stampsCurrentSchema).toBe(false);
  });
});
