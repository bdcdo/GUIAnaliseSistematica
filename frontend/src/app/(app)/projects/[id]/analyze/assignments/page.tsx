import { createSupabaseServer } from "@/lib/supabase/server";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { getProjectAccessContext } from "@/lib/auth";
import { requirePageAuthUser } from "@/lib/page-auth";
import { requireResolvedProjectAccess } from "@/lib/project-access";
import { AssignmentTable } from "@/components/assignments/AssignmentTable";
import { LotteryDialog } from "@/components/assignments/LotteryDialog";
import { ClearPendingButton } from "@/components/assignments/ClearPendingButton";
import type { ProjectMember } from "@/lib/types";
import { notFound } from "next/navigation";
import Link from "next/link";
import {
  activeAliasMemberIds,
  clerkMappingAccessStatesByUserId,
  isMemberEmailLinkAccessReady,
  projectMemberAccessState,
  type MemberActivationLink,
} from "@/components/members/member-list-utils";

// Leitura direta, sem unstable_cache: o cache do Next vive no processo, e o
// revalidateTag da Server Action só invalida a instância que a atendeu. Com
// duas Machines (#664), a outra continuaria servindo a lista antiga por até
// 5 min — um documento excluído seguiria aparecendo como atribuível. A query
// lê três colunas com filtro indexado por project_id; não cachear custa menos
// que servir dado errado.
async function listAssignableDocuments(projectId: string) {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("documents")
    .select("id, external_id, title")
    .eq("project_id", projectId)
    .is("excluded_at", null)
    .is("exclusion_pending_at", null)
    .order("created_at", { ascending: true });
  if (error) {
    console.error(
      `[assignments] listAssignableDocuments falhou (projeto ${projectId}): ${error.message}`,
    );
  }
  return data || [];
}

function requireQueryRows<T>(result: {
  data: T[] | null;
  error: { message: string } | null;
}): T[] {
  if (result.error) throw new Error(result.error.message);
  return result.data ?? [];
}

async function getMembers(
  supabase: Awaited<ReturnType<typeof createSupabaseServer>>,
  projectId: string,
) {
  const [membersResult, linksResult] = await Promise.all([
    supabase
      .from("project_members")
      .select(
        "user_id, role, project_id, assignment_weight, assignment_cap, profiles(first_name, email, activated_at)",
      )
      .eq("project_id", projectId),
    supabase
      .from("member_email_links")
      .select(
        "member_user_id, linked_user_id, linked_profile:profiles!member_email_links_linked_user_id_fkey(activated_at)",
      )
      .eq("project_id", projectId),
  ]);
  const members = requireQueryRows(membersResult);
  const links = requireQueryRows(linksResult);
  const identityUserIds = new Set(members.map((member) => member.user_id));
  for (const link of links) {
    if (link.linked_user_id) identityUserIds.add(link.linked_user_id);
  }
  const mappingResult = identityUserIds.size
    ? await createSupabaseAdmin()
        .from("clerk_user_mapping")
        .select("supabase_user_id, access_sync_version, clerk_deleted")
        .in("supabase_user_id", [...identityUserIds])
    : { data: [], error: null };
  return {
    members,
    links,
    mappings: clerkMappingAccessStatesByUserId(requireQueryRows(mappingResult)),
  };
}

export default async function AssignmentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ round?: string }>;
}) {
  const [{ id }, query, user] = await Promise.all([
    params,
    searchParams ?? Promise.resolve<{ round?: string }>({}),
    requirePageAuthUser(),
  ]);
  const access = requireResolvedProjectAccess(
    await getProjectAccessContext(id, user),
  );
  if (!access.project) notFound();

  const supabase = await createSupabaseServer();

  const [documents, memberState, { data: project }, { data: rounds }] = await Promise.all([
    listAssignableDocuments(id),
    getMembers(supabase, id),
    supabase.from("projects").select("current_round_id").eq("id", id).single(),
    supabase.from("rounds").select("id, label, created_at").eq("project_id", id).order("created_at", { ascending: false }),
  ]);
  const selectedRoundId = (rounds ?? []).some((round) => round.id === query.round)
    ? query.round!
    : project?.current_round_id;
  const isCurrentRound = selectedRoundId === project?.current_round_id;
  const { data: assignments } = await (
    supabase
      .from("assignments")
      .select(
        "id, project_id, document_id, user_id, status, type, batch_id, completed_at, round_id",
      )
      .eq("project_id", id)
      .eq("round_id", selectedRoundId ?? "00000000-0000-0000-0000-000000000000")
  );

  type TypedMember = ProjectMember & {
    profiles: {
      first_name: string | null;
      email: string;
      activated_at: string | null;
    };
  };

  const allResearchersForTable =
    memberState.members as unknown as TypedMember[];
  type EmailLinkQueryRow = {
    member_user_id: string;
    linked_user_id: string | null;
    linked_profile: { activated_at: string | null } | null;
  };
  const activeAliasIds = activeAliasMemberIds(
    (memberState.links as unknown as EmailLinkQueryRow[]).map(
      (link): MemberActivationLink => ({
        member_user_id: link.member_user_id,
        accessReady: isMemberEmailLinkAccessReady(
          link.linked_user_id,
          link.linked_profile?.activated_at,
          link.linked_user_id
            ? memberState.mappings.get(link.linked_user_id)
            : undefined,
        ),
      }),
    ),
  );

  const lotteryMembers = allResearchersForTable.map((m) => ({
    userId: m.user_id,
    name: m.profiles.first_name || m.profiles.email,
    role: m.role as "pesquisador" | "coordenador",
    pending:
      projectMemberAccessState(
        m.user_id,
        m.profiles.activated_at,
        memberState.mappings.get(m.user_id),
        activeAliasIds,
      ) !== "ready",
    weight: m.assignment_weight ?? 1,
    cap: m.assignment_cap ?? null,
  }));

  const assignedDocIds = new Set((assignments || []).map((a) => a.document_id));
  const sortedDocuments = (documents || []).toSorted((a, b) => {
    const aHas = assignedDocIds.has(a.id) ? 0 : 1;
    const bHas = assignedDocIds.has(b.id) ? 0 : 1;
    return aHas - bHas;
  });

  const pendingByType = {
    codificacao: (assignments || []).filter(
      (a) => a.status === "pendente" && a.type === "codificacao",
    ).length,
    comparacao: (assignments || []).filter(
      (a) => a.status === "pendente" && a.type === "comparacao",
    ).length,
  };
  const hasPending = pendingByType.codificacao + pendingByType.comparacao > 0;

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h2 className="text-lg font-semibold">Atribuições</h2>
          <span className="text-xs text-muted-foreground">
            Clique cicla: vazio →{" "}
            <span className="text-brand font-medium">C</span> codificação →{" "}
            <span className="text-amber-600 font-medium">R</span> comparação →
            vazio
          </span>
        </div>
        <div className="flex items-center gap-2">
          {(rounds ?? []).map((round) => (
            <Link
              key={round.id}
              href={`/projects/${id}/analyze/assignments?round=${round.id}`}
              className={round.id === selectedRoundId ? "text-sm font-medium text-brand" : "text-sm text-muted-foreground"}
            >
              {round.label}
            </Link>
          ))}
          {access.isCoordinator && isCurrentRound && hasPending && (
            <ClearPendingButton projectId={id} pendingByType={pendingByType} />
          )}
          {access.isCoordinator && isCurrentRound && (
            <LotteryDialog projectId={id} members={lotteryMembers} />
          )}
        </div>
      </div>
      <AssignmentTable
        projectId={id}
        documents={sortedDocuments}
        researchers={allResearchersForTable}
        assignments={assignments || []}
        readOnly={!access.isCoordinator || !isCurrentRound}
      />
    </div>
  );
}
