import { createSupabaseServer } from "@/lib/supabase/server";
import { Header } from "@/components/shell/Header";
import { ProjectTabs } from "@/components/shell/ProjectTabs";
import { notFound, redirect } from "next/navigation";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createSupabaseServer();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/auth/login");

  const [{ data: project }, { data: membership }, { data: profile }] =
    await Promise.all([
      supabase
        .from("projects")
        .select("id, name, created_by")
        .eq("id", id)
        .single(),
      supabase
        .from("project_members")
        .select("role")
        .eq("project_id", id)
        .eq("user_id", user.id)
        .single(),
      supabase
        .from("profiles")
        .select("first_name")
        .eq("id", user.id)
        .single(),
    ]);

  if (!project) notFound();

  const isCoordinator =
    membership?.role === "coordenador" || project.created_by === user.id;

  return (
    <div className="flex min-h-screen flex-col">
      <Header
        projectName={project.name}
        user={{ email: user.email!, firstName: profile?.first_name }}
      />
      <ProjectTabs projectId={id} isCoordinator={isCoordinator} />
      <main className="flex-1">{children}</main>
    </div>
  );
}
