"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export async function addMember(
  projectId: string,
  email: string,
  role: "coordenador" | "pesquisador"
) {
  const supabase = await createSupabaseServer();

  // Find user by email
  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .eq("email", email)
    .single();

  if (!profile) {
    return { error: "Usuário não encontrado. O email precisa estar cadastrado." };
  }

  const { error } = await supabase.from("project_members").insert({
    project_id: projectId,
    user_id: profile.id,
    role,
  });

  if (error) {
    if (error.code === "23505") {
      return { error: "Usuário já é membro deste projeto." };
    }
    return { error: error.message };
  }

  revalidatePath(`/projects/${projectId}`);
}

export async function removeMember(projectId: string, memberId: string) {
  const supabase = await createSupabaseServer();
  const { error } = await supabase
    .from("project_members")
    .delete()
    .eq("id", memberId);

  if (error) return { error: error.message };
  revalidatePath(`/projects/${projectId}`);
}

export async function changeRole(
  memberId: string,
  role: "coordenador" | "pesquisador",
  projectId: string
) {
  const supabase = await createSupabaseServer();
  const { error } = await supabase
    .from("project_members")
    .update({ role })
    .eq("id", memberId);

  if (error) return { error: error.message };
  revalidatePath(`/projects/${projectId}`);
}
