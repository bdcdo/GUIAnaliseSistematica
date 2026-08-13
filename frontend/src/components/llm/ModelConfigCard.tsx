"use client";

import {
  useOptimistic,
  useTransition,
  type Dispatch,
  type SetStateAction,
} from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Info } from "lucide-react";
import { toast } from "sonner";
import { toggleLlmField } from "@/actions/schema";
import { LLM_AMBIGUITIES_FIELD } from "@/lib/standard-questions";
import {
  defaultModelForProvider,
  getModelCapabilities,
  type ModelCapabilities,
  type Provider,
} from "@/lib/model-registry";
import { ModelCombobox } from "./ModelCombobox";
import { AdvancedParamsSection } from "./AdvancedParamsSection";
import type { LlmConfig, SchemaBaselineIdentity } from "@/lib/types";

interface ModelConfigCardProps {
  projectId: string;
  config: LlmConfig;
  setConfig: Dispatch<SetStateAction<LlmConfig>>;
  pydanticFields: { name: string }[] | null;
  schemaBaseline: SchemaBaselineIdentity;
}

function buildKwargsForCapabilities(
  currentKwargs: Record<string, unknown>,
  caps: ModelCapabilities,
): Record<string, unknown> {
  const newKwargs = { ...currentKwargs };
  if (!caps.supportsTemperature) delete newKwargs.temperature;
  else if (newKwargs.temperature == null) newKwargs.temperature = 1.0;
  if (!caps.supportsThinkingLevel) delete newKwargs.thinking_level;
  else if (!newKwargs.thinking_level) newKwargs.thinking_level = "medium";
  return newKwargs;
}

export function ModelConfigCard({
  projectId,
  config,
  setConfig,
  pydanticFields,
  schemaBaseline,
}: ModelConfigCardProps) {
  const capabilities = getModelCapabilities(
    config.llm_provider as Provider,
    config.llm_model,
  );

  const includeJustifications = !!config.llm_kwargs.include_justifications;

  // useOptimistic: o Switch reflete imediatamente o valor escolhido enquanto o
  // toggleLlmField roda. A base é derivada da prop `pydanticFields` no render;
  // no sucesso o revalidatePath atualiza a prop, no erro o valor reverte
  // automaticamente ao fim da transição. Mexer só no state do cliente preserva
  // o round-trip Pydantic (toggleLlmField → saveSchemaFromGUI).
  const ambiguitiesEnabled =
    pydanticFields?.some((f) => f.name === "llm_ambiguidades") ?? false;
  const [optimisticAmbiguities, setOptimisticAmbiguities] =
    useOptimistic(ambiguitiesEnabled);
  const [isPending, startTransition] = useTransition();

  const setKwarg = (key: string, value: number) => {
    setConfig((c) => ({
      ...c,
      llm_kwargs: { ...c.llm_kwargs, [key]: value },
    }));
  };

  const handleSelectModel = (model: string) => {
    const caps = getModelCapabilities(config.llm_provider as Provider, model);
    setConfig((c) => ({
      ...c,
      llm_model: model,
      llm_kwargs: buildKwargsForCapabilities(c.llm_kwargs, caps),
    }));
  };

  const handleChangeProvider = (provider: string) => {
    const defaultModel = defaultModelForProvider(provider as Provider);
    const caps = getModelCapabilities(provider as Provider, defaultModel);
    setConfig({
      llm_provider: provider,
      llm_model: defaultModel,
      llm_kwargs: buildKwargsForCapabilities(config.llm_kwargs, caps),
    });
  };

  const handleToggleJustifications = (checked: boolean) => {
    setConfig((c) => ({
      ...c,
      llm_kwargs: { ...c.llm_kwargs, include_justifications: checked },
    }));
  };

  const handleToggleAmbiguities = (checked: boolean) => {
    startTransition(async () => {
      setOptimisticAmbiguities(checked);
      try {
        const r = await toggleLlmField(
          projectId,
          LLM_AMBIGUITIES_FIELD,
          checked,
          schemaBaseline,
        );
        if (r.status === "error") {
          toast.error(r.message);
          return;
        }
        if (r.status === "conflict") {
          toast.error(
            "O schema mudou em outra sessão. Recarregue a página antes de alterar este campo.",
          );
          return;
        }
        toast.success(
          checked
            ? "Campo de ambiguidades adicionado"
            : "Campo de ambiguidades removido",
        );
      } catch (e: unknown) {
        toast.error(e instanceof Error ? e.message : "Erro ao atualizar campo");
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Configuração do Modelo</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-sm">Provedor</Label>
            <Select
              value={config.llm_provider}
              onValueChange={handleChangeProvider}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="google_genai">Google GenAI</SelectItem>
                <SelectItem value="openai">OpenAI</SelectItem>
                <SelectItem value="anthropic">Anthropic</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">Modelo</Label>
            <ModelCombobox
              provider={config.llm_provider}
              model={config.llm_model}
              triggerLabel={capabilities.label}
              onSelectModel={handleSelectModel}
            />
          </div>
          {capabilities.supportsTemperature && (
            <div className="space-y-1.5">
              <Label className="text-sm">Temperatura</Label>
              <Input
                type="number"
                step={0.1}
                min={0}
                max={2}
                value={
                  (config.llm_kwargs.temperature as number | undefined) ?? 1.0
                }
                onChange={(e) => {
                  const parsed = parseFloat(e.target.value);
                  if (!isNaN(parsed)) setKwarg("temperature", parsed);
                }}
              />
            </div>
          )}
          {capabilities.supportsThinkingLevel && (
            <div className="space-y-1.5">
              <Label className="text-sm">Nível de raciocínio</Label>
              <Select
                value={
                  (config.llm_kwargs.thinking_level as string | undefined) ??
                  "medium"
                }
                onValueChange={(v) =>
                  setConfig((c) => ({
                    ...c,
                    llm_kwargs: { ...c.llm_kwargs, thinking_level: v },
                  }))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Baixo</SelectItem>
                  <SelectItem value="medium">Médio</SelectItem>
                  <SelectItem value="high">Alto</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {!capabilities.supportsTemperature &&
            !capabilities.supportsThinkingLevel && (
              <div className="col-span-2 flex items-center gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                <Info className="size-4 shrink-0" />
                Este modelo não possui parâmetros configuráveis adicionais.
              </div>
            )}
        </div>

        {/* Behavior toggles */}
        <div className="space-y-3 pt-2">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-0.5">
              <Label className="text-sm">
                Pedir justificativas para cada resposta
              </Label>
              <p className="text-xs text-muted-foreground">
                O LLM explicará o raciocínio por trás de cada classificação.
              </p>
            </div>
            <Switch
              checked={includeJustifications}
              onCheckedChange={handleToggleJustifications}
            />
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="space-y-0.5">
              <Label className="text-sm">
                Registrar ambiguidades e dificuldades
              </Label>
              <p className="text-xs text-muted-foreground">
                O LLM reportará incertezas nas instruções e dificuldades na
                classificação. (campo llm_only)
              </p>
            </div>
            <Switch
              checked={optimisticAmbiguities}
              onCheckedChange={handleToggleAmbiguities}
              disabled={isPending}
            />
          </div>
        </div>

        <AdvancedParamsSection
          kwargs={config.llm_kwargs}
          onChangeKwarg={setKwarg}
        />
      </CardContent>
    </Card>
  );
}
