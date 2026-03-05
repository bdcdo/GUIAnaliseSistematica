"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

export async function saveResponse(
  projectId: string,
  documentId: string,
  answers: Record<string, unknown>
) {
  const supabase = await createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { data: profile } = await supabase
    .from("profiles")
    .select("first_name, last_name")
    .eq("id", user.id)
    .single();

  const respondentName = [profile?.first_name, profile?.last_name]
    .filter(Boolean)
    .join(" ") || user.email;

  // Upsert: find existing response for this user/document
  const { data: existing } = await supabase
    .from("responses")
    .select("id")
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .eq("respondent_id", user.id)
    .eq("respondent_type", "humano")
    .single();

  if (existing) {
    await supabase
      .from("responses")
      .update({ answers })
      .eq("id", existing.id);
  } else {
    await supabase.from("responses").insert({
      project_id: projectId,
      document_id: documentId,
      respondent_id: user.id,
      respondent_type: "humano",
      respondent_name: respondentName,
      answers,
      is_current: true,
    });
  }

  // Check if all fields answered -> update assignment status
  const { data: project } = await supabase
    .from("projects")
    .select("pydantic_fields")
    .eq("id", projectId)
    .single();

  if (project?.pydantic_fields) {
    const fields = project.pydantic_fields as { name: string }[];
    const allAnswered = fields.every(
      (f) => answers[f.name] !== undefined && answers[f.name] !== null && answers[f.name] !== ""
    );

    if (allAnswered) {
      await supabase
        .from("assignments")
        .update({ status: "concluido" })
        .eq("project_id", projectId)
        .eq("document_id", documentId)
        .eq("user_id", user.id);
    } else {
      await supabase
        .from("assignments")
        .update({ status: "em_andamento" })
        .eq("project_id", projectId)
        .eq("document_id", documentId)
        .eq("user_id", user.id);
    }
  }

  revalidatePath(`/projects/${projectId}`, "layout");
}
