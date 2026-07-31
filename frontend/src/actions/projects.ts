"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { updateOrThrow } from "@/lib/supabase/rls-guard";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { AutomationMode } from "@/lib/types";

const AUTOMATION_MODE_VALUES: ReadonlyArray<AutomationMode> = Object.freeze([
  "none",
  "auto_review_llm",
  "compare_humans",
  "compare_llm",
]);

export async function createProject(_prev: unknown, formData: FormData) {
  const user = await getAuthUser();
  if (!user) return { error: "Não autenticado" };

  const supabase = await createSupabaseServer();

  const name = formData.get("name") as string;
  const description = formData.get("description") as string;
  const rawMode = formData.get("automation_mode") as string | null;
  const automation_mode: AutomationMode = AUTOMATION_MODE_VALUES.includes(
    rawMode as AutomationMode,
  )
    ? (rawMode as AutomationMode)
    : "auto_review_llm";

  const { data: projectId, error } = await supabase.rpc(
    "create_project_with_initial_round",
    {
      p_name: name,
      p_description: description || null,
      p_created_by: user.id,
      p_automation_mode: automation_mode,
    },
  );

  if (error) return { error: error.message };
  if (!projectId) return { error: "Não foi possível criar o projeto." };

  revalidatePath("/dashboard");
  redirect(`/projects/${projectId}/documents`);
}

// Retorno { error } em vez de throw: o Next mascara a message de erros
// lançados em Server Actions em produção (o client recebe mensagem genérica
// + digest), então a copy pt-BR só chega ao toast pelo retorno.
export async function updateProject(
  projectId: string,
  data: {
    name?: string;
    description?: string;
    resolution_rule?: string;
    min_responses_for_comparison?: number;
    allow_researcher_review?: boolean;
    arbitration_blind?: boolean;
    automation_mode?: AutomationMode;
    comparison_includes_llm?: boolean;
    out_of_scope_enabled?: boolean;
  }
): Promise<{ error?: string }> {
  const supabase = await createSupabaseServer();
  try {
    await updateOrThrow(supabase, "projects", data, { id: projectId }, {
      message: "Sem permissão para alterar as configurações deste projeto.",
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Erro ao salvar o projeto" };
  }
  revalidatePath(`/projects/${projectId}`);
  return {};
}
