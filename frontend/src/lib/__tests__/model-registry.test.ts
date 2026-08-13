import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildKwargsForCapabilities,
  defaultModelForProvider,
  getModelCapabilities,
  getModelsForProvider,
  isProvider,
  PROVIDERS,
  type ModelCapabilities,
} from "../model-registry";

const MIGRATIONS = join(__dirname, "..", "..", "..", "supabase", "migrations");
const PROVIDER_IDS = PROVIDERS.map((p) => p.provider);

/** O DEFAULT vigente de `projects.llm_model`, lido das migrations.
 *
 * Vale a última declaração em ordem de nome de arquivo — que é a ordem em que
 * o Postgres as aplica. Casa as duas formas em que o default aparece: a coluna
 * nascendo no CREATE TABLE (001) e o ALTER COLUMN que a redefine depois.
 */
function llmModelDefaultInSql(): string {
  const declaration =
    /llm_model\s+TEXT\s+DEFAULT\s+'([^']+)'|ALTER\s+COLUMN\s+llm_model\s+SET\s+DEFAULT\s+'([^']+)'/gi;
  let latest: string | null = null;
  for (const file of readdirSync(MIGRATIONS).sort()) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    for (const match of sql.matchAll(declaration)) {
      latest = match[1] ?? match[2];
    }
  }
  if (latest === null) {
    throw new Error("nenhuma migration declara o DEFAULT de projects.llm_model");
  }
  return latest;
}

describe("registry de modelos", () => {
  it("o default do google_genai é o mesmo DEFAULT da coluna projects.llm_model", () => {
    // O SQL não deriva do TypeScript, então esta é a única amarra entre os
    // dois. Quando divergiram, a página de configuração abria num modelo que o
    // próprio registry não conhecia: caía em DEFAULT_CAPABILITIES, escondia o
    // select de raciocínio e seguia mandando thinking_level nos kwargs.
    expect(llmModelDefaultInSql()).toBe(defaultModelForProvider("google_genai"));
  });

  it("todo provider declara ao menos um modelo, e o default é um deles", () => {
    // defaultModelForProvider devolve "" para provider sem modelo — o combobox
    // abriria vazio e o backend mandaria string vazia ao provider.
    for (const provider of PROVIDER_IDS) {
      const models = getModelsForProvider(provider);
      expect(models.length).toBeGreaterThan(0);
      expect(models.map((m) => m.model)).toContain(
        defaultModelForProvider(provider),
      );
    }
  });

  it("não repete id de modelo dentro de um provider", () => {
    // Duplicata daria duas entradas no combobox e tornaria indeterminado qual
    // label/capabilities getModelCapabilities devolve.
    for (const provider of PROVIDER_IDS) {
      const ids = getModelsForProvider(provider).map((m) => m.model);
      expect(ids).toEqual([...new Set(ids)]);
    }
  });

  it("todo modelo do registry se encontra por getModelCapabilities", () => {
    // Fecha a volta provider+model: uma entrada com o provider errado no campo
    // `provider` sairia na lista de um provider e não seria achada por ele.
    for (const provider of PROVIDER_IDS) {
      for (const model of getModelsForProvider(provider)) {
        expect(getModelCapabilities(provider, model.model).label).toBe(
          model.label,
        );
      }
    }
  });
});

/** Veredito da API do Gemini para cada modelo, medido em 2026-08-13.
 *
 * Cada linha é uma chamada real (`ChatGoogleGenerativeAI(...).invoke`) feita da
 * máquina do Fly, onde vive a única GOOGLE_API_KEY. Não dá para reproduzir isso
 * num teste unitário — o que este arquivo trava é a transcrição da medição para
 * o registry, que é onde a divergência causa dano.
 *
 * `thinking_level` não é "toda a linha Gemini": a 2.5 responde
 * `400 INVALID_ARGUMENT: 'Thinking level is not supported for this model.'`.
 * Só a linha 3.x aceita o parâmetro.
 */
const THINKING_LEVEL_NA_API: Record<string, boolean> = {
  "gemini-3.7-flash": true,
  "gemini-3.6-flash": true,
  "gemini-3.5-flash": true,
  "gemini-3.5-flash-lite": true,
  "gemini-2.5-flash": false,
  "gemini-2.5-flash-lite": false,
};

describe("capabilities conferidas contra a API", () => {
  it("supportsThinkingLevel do google_genai reproduz a medição", () => {
    // O dano de errar aqui não é cosmético: a UI injeta thinking_level="medium"
    // ao selecionar o modelo, o backend repassa o kwarg cru ao provider, e o
    // 400 resultante nem sequer aciona o canário — 'INVALID_ARGUMENT' não casa
    // com o padrão 'InvalidArgument' de NON_RECOVERABLE_ERRORS por causa do
    // underscore. O dataframeit trata como recuperável, gasta 3 retries por
    // documento e a run morre em "Run comprometida".
    for (const model of getModelsForProvider("google_genai")) {
      expect(THINKING_LEVEL_NA_API).toHaveProperty(model.model);
      expect({
        model: model.model,
        supportsThinkingLevel: model.supportsThinkingLevel,
      }).toEqual({
        model: model.model,
        supportsThinkingLevel: THINKING_LEVEL_NA_API[model.model],
      });
    }
  });

  it("não oferece modelo que a API recusa para esta chave", () => {
    // gemini-2.5-pro responde "This model models/gemini-2.5-pro is no longer
    // available to new users" — e, ao contrário de gemini-3-flash, ele APARECE
    // no ListModels. Conferir o catálogo não basta; só a chamada revela.
    const ids = getModelsForProvider("google_genai").map((m) => m.model);
    expect(ids).not.toContain("gemini-2.5-pro");
  });
});

describe("isProvider", () => {
  it("aceita os providers do registry e recusa o resto", () => {
    // A coluna projects.llm_provider é TEXT livre. Este guard é o que separa
    // o valor persistido do tipo Provider — sem ele o cast `as Provider` deixa
    // um valor desconhecido chegar a getModelsForProvider, que devolve [] e
    // faz defaultModelForProvider render "".
    for (const provider of PROVIDER_IDS) expect(isProvider(provider)).toBe(true);
    for (const bogus of ["google", "gemini", "", "GOOGLE_GENAI"]) {
      expect(isProvider(bogus)).toBe(false);
    }
    expect(isProvider(null)).toBe(false);
    expect(isProvider(undefined)).toBe(false);
  });
});

describe("buildKwargsForCapabilities", () => {
  const caps = (over: Partial<ModelCapabilities>): ModelCapabilities => ({
    provider: "google_genai",
    model: "m",
    label: "M",
    supportsTemperature: true,
    supportsThinkingLevel: true,
    category: "reasoning",
    ...over,
  });

  it("remove o kwarg que o modelo não aceita", () => {
    // O caso que queimou a run: kwargs herdados de um modelo 3.x seguindo para
    // um 2.5 que recusa o parâmetro.
    expect(
      buildKwargsForCapabilities(
        { thinking_level: "medium", temperature: 0.7 },
        caps({ supportsThinkingLevel: false }),
      ),
    ).toEqual({ temperature: 0.7 });
    expect(
      buildKwargsForCapabilities(
        { thinking_level: "high", temperature: 0.7 },
        caps({ supportsTemperature: false }),
      ),
    ).toEqual({ thinking_level: "high" });
  });

  it("preenche o default só quando o modelo aceita e o valor falta", () => {
    expect(buildKwargsForCapabilities({}, caps({}))).toEqual({
      temperature: 1.0,
      thinking_level: "medium",
    });
  });

  it("não sobrescreve valor já escolhido, inclusive temperatura zero", () => {
    // `temperature: 0` é falsy: um teste de presença por truthiness o
    // substituiria por 1.0 e mudaria o resultado da run em silêncio.
    expect(
      buildKwargsForCapabilities(
        { temperature: 0, thinking_level: "high" },
        caps({}),
      ),
    ).toEqual({ temperature: 0, thinking_level: "high" });
  });

  it("preserva os kwargs que não são de capability", () => {
    // include_justifications, parallel_requests e os thresholds de run passam
    // por aqui e não podem ser descartados na higienização.
    expect(
      buildKwargsForCapabilities(
        { include_justifications: true, parallel_requests: 8 },
        caps({ supportsTemperature: false, supportsThinkingLevel: false }),
      ),
    ).toEqual({ include_justifications: true, parallel_requests: 8 });
  });
});
