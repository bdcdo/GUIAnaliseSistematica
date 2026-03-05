import { createSupabaseServer } from "@/lib/supabase/server";
import { AssignmentTable } from "@/components/assignments/AssignmentTable";
import { RandomizeDialog } from "@/components/assignments/RandomizeDialog";
import type { ProjectMember } from "@/lib/types";

export default async function AssignmentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createSupabaseServer();

  const [{ data: documents }, { data: researchers }, { data: assignments }] =
    await Promise.all([
      supabase
        .from("documents")
        .select("id, external_id, title")
        .eq("project_id", id)
        .order("created_at", { ascending: true }),
      supabase
        .from("project_members")
        .select("*, profiles(*)")
        .eq("project_id", id)
        .eq("role", "pesquisador"),
      supabase
        .from("assignments")
        .select("*")
        .eq("project_id", id),
    ]);

  const typedResearchers = (researchers || []) as unknown as (ProjectMember & {
    profiles: { first_name: string | null; email: string };
  })[];

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Atribuições</h2>
        <RandomizeDialog projectId={id} />
      </div>
      <AssignmentTable
        projectId={id}
        documents={documents || []}
        researchers={typedResearchers}
        assignments={assignments || []}
      />
    </div>
  );
}
