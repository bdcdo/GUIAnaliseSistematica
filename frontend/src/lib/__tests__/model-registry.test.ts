import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultModelForProvider,
  getModelCapabilities,
  getModelsForProvider,
  type Provider,
} from "../model-registry";

const MIGRATIONS = join(__dirname, "..", "..", "..", "supabase", "migrations");
const PROVIDERS: Provider[] = ["google_genai", "openai", "anthropic"];

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
    for (const provider of PROVIDERS) {
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
    for (const provider of PROVIDERS) {
      const ids = getModelsForProvider(provider).map((m) => m.model);
      expect(ids).toEqual([...new Set(ids)]);
    }
  });

  it("todo modelo do registry se encontra por getModelCapabilities", () => {
    // Fecha a volta provider+model: uma entrada com o provider errado no campo
    // `provider` sairia na lista de um provider e não seria achada por ele.
    for (const provider of PROVIDERS) {
      for (const model of getModelsForProvider(provider)) {
        expect(getModelCapabilities(provider, model.model).label).toBe(
          model.label,
        );
      }
    }
  });
});
