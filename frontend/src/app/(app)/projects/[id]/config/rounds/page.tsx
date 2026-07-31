import { createSupabaseServer } from "@/lib/supabase/server";
import { getProjectAccessContext } from "@/lib/auth";
import { requirePageAuthUser } from "@/lib/page-auth";
import { RoundsConfig } from "@/components/config/RoundsConfig";
import { requireResolvedProjectAccess } from "@/lib/project-access";
import type { Round } from "@/lib/types";

export default async function RoundsConfigPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, user, supabase] = await Promise.all([
    params,
    requirePageAuthUser(),
    createSupabaseServer(),
  ]);

  const [{ data: project }, { data: rounds }, accessResult] = await Promise.all([
    supabase
      .from("projects")
      .select("current_round_id")
      .eq("id", id)
      .single(),
    supabase
      .from("rounds")
      .select("id, project_id, label, created_at")
      .eq("project_id", id)
      .order("created_at", { ascending: true }),
    getProjectAccessContext(id, user),
  ]);

  requireResolvedProjectAccess(accessResult);

  return (
    <div className="mx-auto max-w-3xl p-6">
      <RoundsConfig
        currentRoundId={project?.current_round_id ?? null}
        rounds={(rounds ?? []) as Round[]}
      />
    </div>
  );
}
