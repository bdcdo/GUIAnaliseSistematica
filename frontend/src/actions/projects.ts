"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createProject(_prev: unknown, formData: FormData) {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Não autenticado" };

  const name = formData.get("name") as string;
  const description = formData.get("description") as string;

  const { data: project, error } = await supabase
    .from("projects")
    .insert({ name, description, created_by: user.id })
    .select()
    .single();

  if (error) return { error: error.message };

  // Add creator as coordinator
  const { error: memberError } = await supabase
    .from("project_members")
    .insert({
      project_id: project.id,
      user_id: user.id,
      role: "coordenador",
    });

  if (memberError) return { error: memberError.message };

  revalidatePath("/dashboard");
  redirect(`/projects/${project.id}/documents`);
}

export async function updateProject(
  projectId: string,
  data: {
    name?: string;
    description?: string;
    resolution_rule?: string;
    min_responses_for_comparison?: number;
    allow_researcher_review?: boolean;
  }
) {
  const supabase = await createSupabaseServer();
  const { error } = await supabase
    .from("projects")
    .update(data)
    .eq("id", projectId);

  if (error) throw new Error(error.message);
  revalidatePath(`/projects/${projectId}`);
}

export async function deleteProject(projectId: string) {
  const supabase = await createSupabaseServer();
  const { error } = await supabase
    .from("projects")
    .delete()
    .eq("id", projectId);

  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
  redirect("/dashboard");
}
