import { describe, it, expect } from "vitest";
import {
  isCodingComplete,
  isFieldAnswered,
  requiredHumanFields,
} from "@/lib/coding-completeness";
import type { PydanticField } from "@/lib/types";

// Helper: monta um PydanticField com defaults mínimos.
function field(partial: Partial<PydanticField> & { name: string }): PydanticField {
  return {
    type: "single",
    options: ["a", "b"],
    description: "",
    ...partial,
  } as PydanticField;
}

describe("isCodingComplete", () => {
  it("todos os campos obrigatórios respondidos → true", () => {
    const fields = [field({ name: "q1" }), field({ name: "q2" })];
    expect(isCodingComplete(fields, { q1: "a", q2: "b" })).toBe(true);
  });

  it("campo obrigatório ausente → false", () => {
    const fields = [field({ name: "q1" }), field({ name: "q2" })];
    expect(isCodingComplete(fields, { q1: "a" })).toBe(false);
  });

  it("campo obrigatório com string vazia → false", () => {
    const fields = [field({ name: "q1" })];
    expect(isCodingComplete(fields, { q1: "" })).toBe(false);
  });

  it("sem campos → true (nada exigido)", () => {
    expect(isCodingComplete([], {})).toBe(true);
  });

  it("campo required:false ausente → true (não exigido)", () => {
    const fields = [field({ name: "q1", required: false })];
    expect(isCodingComplete(fields, {})).toBe(true);
  });

  it("campo target=llm_only ausente → true (não é do humano)", () => {
    const fields = [field({ name: "q1", target: "llm_only" })];
    expect(isCodingComplete(fields, {})).toBe(true);
  });

  it("campo target=none ausente → true (oculto)", () => {
    const fields = [field({ name: "q1", target: "none" })];
    expect(isCodingComplete(fields, {})).toBe(true);
  });

  it("condicional não-visível ausente → true (não exigido)", () => {
    const fields = [
      field({ name: "q1" }),
      field({ name: "q2", condition: { field: "q1", equals: "sim" } }),
    ];
    // q1='nao' → q2 invisível → não exigido, mesmo ausente
    expect(isCodingComplete(fields, { q1: "nao" })).toBe(true);
  });

  it("condicional visível não respondido → false", () => {
    const fields = [
      field({ name: "q1" }),
      field({ name: "q2", condition: { field: "q1", equals: "sim" } }),
    ];
    // q1='sim' → q2 visível e exigido, mas ausente
    expect(isCodingComplete(fields, { q1: "sim" })).toBe(false);
    // q2 preenchido → completo
    expect(isCodingComplete(fields, { q1: "sim", q2: "a" })).toBe(true);
  });

  it("multi com array vazio → false", () => {
    const fields = [field({ name: "q1", type: "multi" })];
    expect(isCodingComplete(fields, { q1: [] })).toBe(false);
  });

  it("multi preenchido → true", () => {
    const fields = [field({ name: "q1", type: "multi" })];
    expect(isCodingComplete(fields, { q1: ["a"] })).toBe(true);
  });

  it("single com 'Outro: ' incompleto → false", () => {
    const fields = [field({ name: "q1", allow_other: true })];
    expect(isCodingComplete(fields, { q1: "Outro: " })).toBe(false);
    expect(isCodingComplete(fields, { q1: "Outro: cibavax" })).toBe(true);
  });

  it("multi com 'Outro: ' incompleto na lista → false", () => {
    const fields = [field({ name: "q1", type: "multi", allow_other: true })];
    expect(isCodingComplete(fields, { q1: ["a", "Outro: "] })).toBe(false);
    expect(isCodingComplete(fields, { q1: ["a", "Outro: x"] })).toBe(true);
  });

  it("codificação quase vazia (1 de vários) → false", () => {
    const fields = [
      field({ name: "q1" }),
      field({ name: "q2" }),
      field({ name: "q3", type: "text", options: null }),
      field({ name: "q4" }),
    ];
    expect(isCodingComplete(fields, { q1: "a" })).toBe(false);
  });
});

// Staleness-awareness (#174 follow-up): quando answer_field_hashes é fornecido,
// um campo obrigatório ausente do snapshot não existia quando a resposta foi
// codificada e não deve reprovar a completude. Sem isto, um campo adicionado ao
// schema depois (ex.: `medicamento`) tornaria toda codificação antiga
// falsamente "incompleta" na avaliação retroativa do backlog.
describe("isCodingComplete — staleness-aware", () => {
  it("campo obrigatório ausente do schema da época (não está nos hashes) → não exigido → true", () => {
    const fields = [field({ name: "q1" }), field({ name: "medicamento", type: "multi" })];
    // hashes da época só tinha q1 → medicamento não existia → não exigir
    const hashes = { q1: "h1" };
    expect(isCodingComplete(fields, { q1: "a" }, hashes)).toBe(true);
  });

  it("campo obrigatório que existia (está nos hashes) mas não respondido → false", () => {
    const fields = [field({ name: "q1" }), field({ name: "q2" })];
    const hashes = { q1: "h1", q2: "h2" };
    expect(isCodingComplete(fields, { q1: "a" }, hashes)).toBe(false);
    expect(isCodingComplete(fields, { q1: "a", q2: "b" }, hashes)).toBe(true);
  });

  it("hashes vazios = legacy → exige todos (comportamento staleness-blind)", () => {
    const fields = [field({ name: "q1" }), field({ name: "medicamento", type: "multi" })];
    expect(isCodingComplete(fields, { q1: "a" }, {})).toBe(false);
  });

  it("sem hashes = legacy → exige todos (comportamento staleness-blind do save-time)", () => {
    const fields = [field({ name: "q1" }), field({ name: "medicamento", type: "multi" })];
    expect(isCodingComplete(fields, { q1: "a" })).toBe(false);
  });

  it("campo da época respondido + campo novo (fora dos hashes) ausente → true", () => {
    const fields = [
      field({ name: "q1" }),
      field({ name: "q2" }),
      field({ name: "medicamento", type: "multi" }),
    ];
    const hashes = { q1: "h1", q2: "h2" };
    // q1/q2 respondidos, medicamento (novo) ausente → completo
    expect(isCodingComplete(fields, { q1: "a", q2: "b" }, hashes)).toBe(true);
  });
});

// Primitivas exportadas para que a UI (useQuestionValidation) derive contagem e
// bloqueio desta mesma fonte, em vez de manter uma cópia paralela que pode divergir.
describe("isFieldAnswered", () => {
  it("vazio (undefined/null/'') → false", () => {
    const f = field({ name: "q1" });
    expect(isFieldAnswered(f, undefined)).toBe(false);
    expect(isFieldAnswered(f, null)).toBe(false);
    expect(isFieldAnswered(f, "")).toBe(false);
  });

  it("single com valor → true; 'Outro: ' incompleto → false", () => {
    const f = field({ name: "q1", allow_other: true });
    expect(isFieldAnswered(f, "a")).toBe(true);
    expect(isFieldAnswered(f, "Outro: ")).toBe(false);
    expect(isFieldAnswered(f, "Outro: x")).toBe(true);
  });

  it("multi vazio → false; com item → true; com 'Outro: ' incompleto → false", () => {
    const f = field({ name: "q1", type: "multi", allow_other: true });
    expect(isFieldAnswered(f, [])).toBe(false);
    expect(isFieldAnswered(f, ["a"])).toBe(true);
    expect(isFieldAnswered(f, ["a", "Outro: "])).toBe(false);
  });
});

describe("requiredHumanFields", () => {
  it("exclui llm_only, none e required:false; inclui obrigatório visível", () => {
    const fields = [
      field({ name: "humano" }),
      field({ name: "so_llm", target: "llm_only" }),
      field({ name: "oculto", target: "none" }),
      field({ name: "opcional", required: false }),
    ];
    const names = requiredHumanFields(fields, {}).map((f) => f.name);
    expect(names).toEqual(["humano"]);
  });

  it("condicional só é exigido quando visível", () => {
    const fields = [
      field({ name: "q1" }),
      field({ name: "q2", condition: { field: "q1", equals: "sim" } }),
    ];
    expect(requiredHumanFields(fields, { q1: "nao" }).map((f) => f.name)).toEqual(["q1"]);
    expect(requiredHumanFields(fields, { q1: "sim" }).map((f) => f.name)).toEqual(["q1", "q2"]);
  });

  it("sem answerFieldHashes = staleness-blind (todos os campos existentes contam)", () => {
    const fields = [field({ name: "q1" }), field({ name: "novo", type: "multi" })];
    expect(requiredHumanFields(fields, {}).map((f) => f.name)).toEqual(["q1", "novo"]);
    // Com hashes da época sem "novo", ele deixa de ser exigido.
    expect(requiredHumanFields(fields, {}, { q1: "h1" }).map((f) => f.name)).toEqual(["q1"]);
  });
});

// Um campo com subcampos guarda um objeto, e `isFieldAnswered` só checava se o
// valor era vazio: qualquer objeto não-vazio passava, inclusive um em que o
// subcampo obrigatório está em branco. O asterisco do FieldRenderer e o texto
// "pelo menos um" da UI não tinham contrapartida em régua nenhuma — nem aqui,
// nem no gate inline do saveResponse, nem no backlog de auto-revisão (#491).
describe("isFieldAnswered — grupos de subcampos", () => {
  const grupo = (
    subfields: { key: string; label: string; required?: boolean }[],
    subfield_rule?: "all" | "at_least_one",
  ) =>
    field({
      name: "q5",
      type: "text",
      options: null,
      subfields,
      subfield_rule,
    });

  describe('regra "at_least_one"', () => {
    const f = grupo(
      [
        { key: "doenca", label: "Doença", required: true },
        { key: "cid", label: "CID", required: true },
      ],
      "at_least_one",
    );

    it("um subcampo preenchido basta", () => {
      expect(isFieldAnswered(f, { doenca: "AME tipo 1", cid: "" })).toBe(true);
    });

    it("nenhum subcampo preenchido → não respondido", () => {
      expect(isFieldAnswered(f, { doenca: "", cid: "" })).toBe(false);
    });

    it("objeto vazio → não respondido", () => {
      expect(isFieldAnswered(f, {})).toBe(false);
    });

    it("só espaço em branco não conta como preenchido", () => {
      expect(isFieldAnswered(f, { doenca: "   ", cid: "" })).toBe(false);
    });
  });

  describe('regra "all" (default)', () => {
    const f = grupo([
      { key: "ano", label: "Ano", required: true },
      { key: "meses", label: "Meses" },
    ]);

    it("subcampo obrigatório preenchido basta — o opcional não é exigido", () => {
      expect(isFieldAnswered(f, { ano: "2019", meses: "" })).toBe(true);
    });

    it("subcampo obrigatório em branco → não respondido", () => {
      expect(isFieldAnswered(f, { ano: "", meses: "3" })).toBe(false);
    });

    // O par que impede a régua de virar "todo subcampo é obrigatório": um grupo
    // sem nenhum subcampo obrigatório continua valendo por presença, como antes.
    it("grupo sem subcampo obrigatório continua valendo por presença", () => {
      const semObrigatorio = grupo([{ key: "obs", label: "Observação" }]);
      expect(isFieldAnswered(semObrigatorio, { obs: "" })).toBe(true);
    });

    // `required` ausente é opcional (resolveSubfieldRequired), o oposto do
    // default de campo — não pode ser lido como obrigatório aqui.
    it("subcampo legado sem a chave `required` não é exigido", () => {
      const legado = grupo([{ key: "cid", label: "CID" }]);
      expect(isFieldAnswered(legado, { cid: "" })).toBe(true);
    });
  });

  it("a régua sobe para isCodingComplete", () => {
    const f = grupo([{ key: "cid", label: "CID", required: true }]);
    expect(isCodingComplete([f], { q5: { cid: "" } })).toBe(false);
    expect(isCodingComplete([f], { q5: { cid: "G12.0" } })).toBe(true);
  });
});

// A fronteira da régua, achada pelo replay com dados de produção: 125
// codificações concluídas do Zolgensma guardam `q7_idade_paciente` como string
// porque o campo era texto simples quando foram coletadas e virou grupo depois.
// `computeFieldHash` exclui as propriedades estruturais de propósito — mexer
// nelas não invalida resposta já coletada —, então a régua de subcampo não pode
// ser a peça que rebaixa essas codificações.
describe("isFieldAnswered — grupo cujo valor foi coletado em outra forma", () => {
  const grupo = field({
    name: "q7",
    type: "text",
    options: null,
    subfields: [
      { key: "ano", label: "Ano", required: true },
      { key: "meses", label: "Meses", required: true },
    ],
    subfield_rule: "at_least_one",
  });

  it("valor string de antes do grupo continua respondido", () => {
    expect(isFieldAnswered(grupo, "01 ano")).toBe(true);
  });

  it("string vazia continua não respondida", () => {
    expect(isFieldAnswered(grupo, "")).toBe(false);
  });

  // O par: a tolerância é à FORMA antiga, não ao grupo vazio na forma nova.
  it("objeto vazio na forma do grupo continua não respondido", () => {
    expect(isFieldAnswered(grupo, { ano: "", meses: "" })).toBe(false);
  });

  // A anistia é MAIS LARGA que o texto legado que o FieldRenderer sabe exibir
  // (`readLegacyGroupText`): ela alcança qualquer valor fora da forma do grupo.
  // Estreitá-la para casar com o display rebaixaria codificações que o #606
  // preservou de propósito — os dois predicados divergem por decisão, não por
  // descuido (#607).
  it("a anistia alcança qualquer valor fora da forma do grupo", () => {
    expect(isFieldAnswered(grupo, 42)).toBe(true);
    expect(isFieldAnswered(grupo, ["a"])).toBe(true);
    expect(isFieldAnswered(grupo, "Não informada")).toBe(true);
  });

  // A ordem dos guards é o que mantém `null` fora da anistia: `typeof null` é
  // "object", então trocar a fronteira por um predicado que testa null muda o
  // que aconteceria AQUI se o guard de cima saísse.
  it("null continua não respondido", () => {
    expect(isFieldAnswered(grupo, null)).toBe(false);
  });
});

// O que acontece quando a pesquisadora move o texto legado para um subcampo
// (#607). Sob `at_least_one` — a regra dos três campos reais — a codificação
// segue completa; sob `all` ela é rebaixada, e isso é correto: a anistia
// descrevia um valor que ninguém tinha tocado, e no formato novo a resposta
// está de fato incompleta. Por isso o FieldRenderer anuncia a pendência antes
// do clique em vez de deixá-la ser descoberta depois.
describe("isFieldAnswered — depois de mover o valor legado para um subcampo", () => {
  const subfields = [
    { key: "anos", label: "Anos", required: true },
    { key: "meses", label: "Meses", required: true },
  ];

  it("sob at_least_one, mover para um subcampo mantém a codificação completa", () => {
    const grupo = field({
      name: "q7",
      type: "text",
      options: null,
      subfields,
      subfield_rule: "at_least_one",
    });
    expect(isFieldAnswered(grupo, { anos: "18 anos e 6 meses" })).toBe(true);
  });

  it("sob all, mover deixa os outros obrigatórios pendentes", () => {
    const grupo = field({
      name: "q7",
      type: "text",
      options: null,
      subfields,
      subfield_rule: "all",
    });
    expect(isFieldAnswered(grupo, { anos: "18 anos e 6 meses" })).toBe(false);
  });
});
