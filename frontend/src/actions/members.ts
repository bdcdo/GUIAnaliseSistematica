"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { revalidatePath } from "next/cache";

export async function addMember(
  projectId: string,
  email: string,
  role: "coordenador" | "pesquisador"
): Promise<{ error?: string; invited?: boolean }> {
  const supabase = await createSupabaseServer();

  // Verify authentication
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Não autenticado." };

  // Verify caller is coordinator (via normal client, RLS applies)
  const { data: callerMember } = await supabase
    .from("project_members")
    .select("role")
    .eq("project_id", projectId)
    .eq("user_id", user.id)
    .single();
  if (callerMember?.role !== "coordenador") {
    return { error: "Apenas coordenadores podem adicionar membros." };
  }

  // Admin client for lookup + invite + insert (bypasses RLS)
  const admin = createSupabaseAdmin();
  const { data: profile } = await admin
    .from("profiles")
    .select("id")
    .eq("email", email)
    .single();

  let userId: string;
  let invited = false;

  if (profile) {
    userId = profile.id;
  } else {
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email);
    if (error) return { error: `Erro ao convidar: ${error.message}` };
    userId = data.user.id;
    invited = true;
  }

  const { error } = await admin.from("project_members").insert({
    project_id: projectId,
    user_id: userId,
    role,
  });

  if (error) {
    if (error.code === "23505") {
      return { error: "Usuário já é membro deste projeto." };
    }
    return { error: error.message };
  }

  revalidatePath(`/projects/${projectId}`);
  return { invited };
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
