/**
 * Providers oferecidos pela UI, com o rótulo do select. A união `Provider`
 * deriva desta lista: declarar as duas coisas em separado é a forma de drift
 * que este arquivo existe para evitar — o `<Select>` de provedor chegou a
 * repetir estes três valores em JSX.
 */
export const PROVIDERS = [
  { provider: "google_genai", label: "Google GenAI" },
  { provider: "openai", label: "OpenAI" },
  { provider: "anthropic", label: "Anthropic" },
] as const;

export type Provider = (typeof PROVIDERS)[number]["provider"];

/**
 * `projects.llm_provider` é TEXT livre, então todo valor vindo do banco entra
 * como `string`. Este guard é a única fronteira entre esse valor e o tipo
 * `Provider`; sem ele, um cast deixa um provider desconhecido chegar a
 * `getModelsForProvider`, que devolve `[]` — e aí `defaultModelForProvider`
 * rende `""` e a página abre sem modelo.
 */
export function isProvider(value: string | null | undefined): value is Provider {
  return PROVIDERS.some((p) => p.provider === value);
}

export interface ModelCapabilities {
  provider: Provider;
  model: string;
  label: string;
  supportsTemperature: boolean;
  /**
   * Aceita `thinking_level` nos kwargs. Independente de `category`: o
   * `gemini-3.5-flash-lite` entra no grupo "Padrão" pelo porte e aceita o
   * parâmetro. A divisão real é por geração — a linha Gemini 2.5 responde
   * `400 INVALID_ARGUMENT: 'Thinking level is not supported for this model.'`,
   * a 3.x aceita. O select da UI oferece low/medium/high (a 3.x também aceita
   * `minimal`).
   *
   * Declarar `true` para um modelo que recusa não é engano cosmético: a UI
   * injeta `thinking_level: "medium"` ao selecionar, o backend repassa o kwarg
   * cru, e o 400 resultante nem aciona o canário de `llm_runner` — o texto
   * `INVALID_ARGUMENT` não casa com o padrão `InvalidArgument` de
   * `NON_RECOVERABLE_ERRORS` por causa do underscore, então o dataframeit o
   * trata como recuperável e gasta os retries de cada documento antes de a run
   * morrer em "Run comprometida".
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
 * Entradas conferidas em 2026-08-13 por chamada real à API, a partir da máquina
 * do Fly (onde vive a chave). Consultar o catálogo — a doc ou o `ListModels` —
 * NÃO basta: `gemini-2.5-pro` aparece listado e mesmo assim responde "no longer
 * available to new users", então só a chamada distingue catálogo de acesso. Um
 * modelo indisponível queima a run inteira, como aconteceu com `gemini-3-flash`
 * (que nunca existiu: o preview chamava-se `gemini-3-flash-preview`).
 *
 * As entradas de `openai` e `anthropic` seguem não medidas — não há chave
 * desses providers no ambiente. Ver issue de follow-up.
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
    supportsThinkingLevel: false,
    category: "reasoning",
  },
  // `gemini-2.5-pro` saiu daqui: a API responde "This model models/gemini-2.5-pro
  // is no longer available to new users". Nenhuma resposta gravada usou o
  // modelo, então remover não degrada rótulo de histórico nenhum.
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
    supportsThinkingLevel: false,
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
 * Ajusta os kwargs ao que o modelo aceita: descarta o parâmetro que ele recusa
 * e preenche o default do que ele aceita e ainda não tem valor. As demais
 * chaves (`include_justifications`, `parallel_requests`, os thresholds de run)
 * passam intactas.
 *
 * Mora aqui, e não no componente, porque a mesma regra vale na escrita: a UI a
 * aplica ao trocar de modelo, e `saveLlmConfig` a reaplica antes de gravar. Uma
 * segunda cópia divergiria — e é justamente a divergência que manda ao provider
 * um kwarg que o modelo recusa.
 */
export function buildKwargsForCapabilities(
  currentKwargs: Record<string, unknown>,
  caps: ModelCapabilities
): Record<string, unknown> {
  const newKwargs = { ...currentKwargs };
  if (!caps.supportsTemperature) delete newKwargs.temperature;
  // `== null` de propósito: `temperature: 0` é um valor escolhido, e um teste
  // por truthiness o trocaria por 1.0 mudando o resultado da run em silêncio.
  else if (newKwargs.temperature == null) newKwargs.temperature = 1.0;
  if (!caps.supportsThinkingLevel) delete newKwargs.thinking_level;
  else if (!newKwargs.thinking_level) newKwargs.thinking_level = "medium";
  return newKwargs;
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
