export type Provider = "google_genai" | "openai" | "anthropic";

export interface ModelCapabilities {
  provider: Provider;
  model: string;
  label: string;
  supportsTemperature: boolean;
  /**
   * Aceita `thinking_level` nos kwargs. Independente de `category`: os
   * Flash-Lite entram no grupo "Padrão" pelo porte, mas aceitam o parâmetro.
   * O select da UI só oferece low/medium/high — subconjunto que vale para
   * toda a linha Gemini (os 3.5/3.6 também aceitam `minimal`).
   */
  supportsThinkingLevel: boolean;
  /** Só agrupa a lista do combobox por porte do modelo. */
  category: "standard" | "reasoning";
}

/**
 * O PRIMEIRO modelo de cada provider é o default dele — ver
 * `defaultModelForProvider`. Trocar o default é reordenar esta lista, não
 * manter uma tabela provider→modelo em paralelo.
 *
 * IDs conferidos em https://ai.google.dev/gemini-api/docs/models. Um ID que
 * não exista lá vira 404 no provider e queima a run inteira (foi o que
 * aconteceu com `gemini-3-flash`, que nunca existiu: o preview chamava-se
 * `gemini-3-flash-preview`).
 */
const MODEL_REGISTRY: ModelCapabilities[] = [
  // --- Google GenAI ---
  {
    provider: "google_genai",
    model: "gemini-3.7-flash",
    label: "Gemini 3.7 Flash",
    supportsTemperature: true,
    supportsThinkingLevel: true,
    category: "reasoning",
  },
  {
    provider: "google_genai",
    model: "gemini-3.6-flash",
    label: "Gemini 3.6 Flash",
    supportsTemperature: true,
    supportsThinkingLevel: true,
    category: "reasoning",
  },
  {
    provider: "google_genai",
    model: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    supportsTemperature: true,
    supportsThinkingLevel: true,
    category: "reasoning",
  },
  {
    provider: "google_genai",
    model: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    supportsTemperature: true,
    supportsThinkingLevel: true,
    category: "reasoning",
  },
  {
    provider: "google_genai",
    model: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    supportsTemperature: true,
    supportsThinkingLevel: true,
    category: "reasoning",
  },
  {
    provider: "google_genai",
    model: "gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash Lite",
    supportsTemperature: true,
    supportsThinkingLevel: true,
    category: "standard",
  },
  {
    provider: "google_genai",
    model: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash Lite",
    supportsTemperature: true,
    supportsThinkingLevel: true,
    category: "standard",
  },

  // --- OpenAI ---
  {
    provider: "openai",
    model: "gpt-5.4",
    label: "GPT-5.4",
    supportsTemperature: false,
    supportsThinkingLevel: true,
    category: "reasoning",
  },
  {
    provider: "openai",
    model: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    supportsTemperature: false,
    supportsThinkingLevel: true,
    category: "reasoning",
  },
  {
    provider: "openai",
    model: "gpt-4.1",
    label: "GPT-4.1",
    supportsTemperature: true,
    supportsThinkingLevel: false,
    category: "standard",
  },
  {
    provider: "openai",
    model: "gpt-4.1-mini",
    label: "GPT-4.1 Mini",
    supportsTemperature: true,
    supportsThinkingLevel: false,
    category: "standard",
  },
  {
    provider: "openai",
    model: "o3",
    label: "o3",
    supportsTemperature: false,
    supportsThinkingLevel: true,
    category: "reasoning",
  },
  {
    provider: "openai",
    model: "o4-mini",
    label: "o4-mini",
    supportsTemperature: false,
    supportsThinkingLevel: true,
    category: "reasoning",
  },

  // --- Anthropic ---
  {
    provider: "anthropic",
    model: "claude-opus-4-6",
    label: "Claude Opus 4.6",
    supportsTemperature: true,
    supportsThinkingLevel: true,
    category: "reasoning",
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    supportsTemperature: true,
    supportsThinkingLevel: true,
    category: "reasoning",
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    label: "Claude Sonnet 4.5",
    supportsTemperature: true,
    supportsThinkingLevel: true,
    category: "reasoning",
  },
  {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    supportsTemperature: true,
    supportsThinkingLevel: true,
    category: "reasoning",
  },
];

export function getModelsForProvider(provider: Provider): ModelCapabilities[] {
  return MODEL_REGISTRY.filter((m) => m.provider === provider);
}

/**
 * Modelo default de um provider: o primeiro que ele declara no registry.
 * Usado tanto ao trocar de provider na UI quanto como fallback para projeto
 * cuja coluna `llm_model` veio vazia.
 *
 * O DEFAULT da coluna `projects.llm_model` precisa acompanhar este valor para
 * `google_genai` — o SQL não deriva do TypeScript, então a migration que troca
 * um lado tem de trocar o outro.
 */
export function defaultModelForProvider(provider: Provider): string {
  return getModelsForProvider(provider)[0]?.model ?? "";
}

const DEFAULT_CAPABILITIES: Omit<ModelCapabilities, "provider" | "model"> = {
  label: "",
  supportsTemperature: true,
  supportsThinkingLevel: false,
  category: "standard",
};

export function getModelCapabilities(
  provider: Provider,
  model: string
): ModelCapabilities {
  const found = MODEL_REGISTRY.find(
    (m) => m.provider === provider && m.model === model
  );
  if (found) return found;
  return { ...DEFAULT_CAPABILITIES, provider, model, label: model };
}

/**
 * Converts "google_genai/gemini-2.5-flash" → "Gemini 2.5 Flash"
 * Falls back to the raw model name if not found in registry.
 */
export function formatModelLabel(respondentName: string): string {
  const parts = respondentName.split("/");
  if (parts.length !== 2) return respondentName;
  const [provider, model] = parts;
  const found = MODEL_REGISTRY.find(
    (m) => m.provider === provider && m.model === model
  );
  return found?.label ?? model;
}
