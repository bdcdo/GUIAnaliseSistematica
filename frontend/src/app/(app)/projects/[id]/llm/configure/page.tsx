import { createSupabaseServer } from "@/lib/supabase/server";
import { LlmConfigurePane } from "@/components/llm/LlmConfigurePane";
import { defaultModelForProvider, type Provider } from "@/lib/model-registry";
import type { PydanticField } from "@/lib/types";

// fallow-ignore-next-line complexity -- esta mudança só propaga a revisão do schema; a composição preexistente da página permanece fora deste refactor.
export default async function LlmConfigurePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, supabase] = await Promise.all([params, createSupabaseServer()]);

  const [{ data: project }, { count: totalDocs }, { data: llmResponses }] =
    await Promise.all([
      supabase
        .from("projects")
        .select(
          "prompt_template, description, llm_provider, llm_model, llm_kwargs, pydantic_fields, pydantic_code, schema_revision"
        )
        .eq("id", id)
        .single(),
      supabase
        .from("documents")
        .select("id", { count: "exact", head: true })
        .eq("project_id", id)
        .is("excluded_at", null)
        .is("exclusion_pending_at", null),
      // `documents!inner` + filtro excluded_at: conta só respostas de docs não
      // arquivados, alinhado com totalDocs acima (B4 — evita docsWithLlm >
      // totalDocs e pendentes negativo).
      supabase
        .from("responses")
        .select("document_id, documents!inner(excluded_at)")
        .eq("project_id", id)
        .eq("respondent_type", "llm")
        .eq("is_latest", true)
        .is("documents.excluded_at", null)
        .is("documents.exclusion_pending_at", null),
    ]);

  const docsWithLlm = Math.min(
    totalDocs ?? 0,
    new Set(llmResponses?.map((response) => response.document_id)).size,
  );

  // Projeto que nunca teve o modelo tocado na UI cai neste fallback. Ele tem
  // de ser o mesmo default do registry: quando divergiam, a página abria num
  // modelo que o próprio registry não conhecia e, por cair em
  // DEFAULT_CAPABILITIES, escondia o select de raciocínio enquanto seguia
  // mandando thinking_level nos kwargs.
  const provider = (project?.llm_provider || "google_genai") as Provider;

  return (
    <LlmConfigurePane
      projectId={id}
      promptTemplate={project?.prompt_template ?? ""}
      projectDescription={project?.description ?? ""}
      config={{
        llm_provider: provider,
        llm_model: project?.llm_model || defaultModelForProvider(provider),
        llm_kwargs:
          (project?.llm_kwargs as Record<string, unknown>) || {
            temperature: 1.0,
            thinking_level: "medium",
          },
      }}
      pydanticFields={(project?.pydantic_fields as PydanticField[]) || null}
      pydanticCode={(project?.pydantic_code as string | null) ?? null}
      schemaBaseline={{
        revision: project?.schema_revision ?? 0,
      }}
      totalDocs={totalDocs ?? 0}
      docsWithLlm={docsWithLlm}
    />
  );
}
