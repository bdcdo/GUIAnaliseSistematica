"use client";

import { Suspense } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { guardedLinkClick, navigateGuarded } from "@/lib/unsaved-work-guard";
import { Eye, EyeOff, Users } from "lucide-react";
import { LlmRunningBadge } from "@/components/llm/LlmRunningBadge";

interface ProjectMember {
  userId: string;
  name: string;
  email: string;
  role: string;
}

interface ProjectTabsProps {
  projectId: string;
  isCoordinator: boolean;
  isMaster?: boolean;
  projectMembers?: ProjectMember[];
  isLlmRunning?: boolean;
}

const EMPTY_MEMBERS: ProjectMember[] = [];

const tabs = [
  { label: "Analisar", href: "analyze" },
  { label: "Revisar", href: "reviews" },
  { label: "LLM", href: "llm", coordinatorOnly: true },
  { label: "Configurações", href: "config", coordinatorOnly: true },
];

export function ProjectTabs(props: ProjectTabsProps) {
  // useSearchParams precisa de boundary de Suspense (react-doctor
  // nextjs-no-use-search-params-without-suspense).
  return (
    <Suspense fallback={null}>
      <ProjectTabsInner {...props} />
    </Suspense>
  );
}

function ProjectTabsInner({
  projectId,
  isCoordinator,
  isMaster = false,
  projectMembers = EMPTY_MEMBERS,
  isLlmRunning = false,
}: ProjectTabsProps) {
  const pathname = usePathname();
  const { push } = useRouter();
  const searchParams = useSearchParams();

  // Auto-revisão é sempre da própria conta — impersonate (viewAsUser /
  // viewAs=pesquisador) não tem efeito ali, então esconder controles e
  // banners de impersonate evita sugerir uma capacidade inexistente.
  // `endsWith` em vez de `includes` para não casar acidentalmente com
  // futuras subrotas tipo `/analyze/auto-revisao-historico`.
  const isAutoRevisaoRoute = pathname.endsWith("/analyze/auto-revisao");

  const viewAsUserId = isMaster ? searchParams.get("viewAsUser") : null;
  const viewAsResearcher =
    isCoordinator &&
    !viewAsUserId &&
    searchParams.get("viewAs") === "pesquisador";
  const effectiveIsCoordinator = isCoordinator && !viewAsResearcher;

  const impersonatedMember = viewAsUserId
    ? projectMembers.find((m) => m.userId === viewAsUserId)
    : null;

  const visibleTabs = tabs.filter(
    (tab) => !tab.coordinatorOnly || effectiveIsCoordinator
  );

  // Toda saída daqui passa pelo guard de trabalho não enviado (#608). Fora da
  // codificação nenhum guard está registrado e a navegação segue de imediato,
  // então isto é inerte no resto do app.
  //
  // `navigateGuarded` (e não `requestNavigation` cru) porque estes dois callers
  // são botões: sem navegação nativa a que recorrer, quem não for interceptado
  // precisa ser empurrado pelo `proceed`.
  const guardedPush = (url: string) => {
    navigateGuarded(() => push(url));
  };

  const toggleViewAs = () => {
    const params = new URLSearchParams(searchParams.toString());
    if (viewAsResearcher) {
      params.delete("viewAs");
    } else {
      params.set("viewAs", "pesquisador");
    }
    params.delete("viewAsUser");
    const qs = params.toString();
    guardedPush(`${pathname}${qs ? `?${qs}` : ""}`);
  };

  const selectImpersonation = (userId: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (userId) {
      params.set("viewAsUser", userId);
      params.delete("viewAs");
    } else {
      params.delete("viewAsUser");
    }
    const qs = params.toString();
    guardedPush(`${pathname}${qs ? `?${qs}` : ""}`);
  };

  return (
    <div>
      {viewAsUserId && impersonatedMember && !isAutoRevisaoRoute && (
        <div className="bg-violet-50 text-violet-800 text-xs text-center py-1 dark:bg-violet-950/50 dark:text-violet-200">
          Visualizando como{" "}
          <span className="font-medium">{impersonatedMember.name}</span>
          {" "}({impersonatedMember.role}),{" "}
          <button
            type="button"
            onClick={() => selectImpersonation(null)}
            className="underline hover:no-underline font-medium"
          >
            voltar para master
          </button>
        </div>
      )}
      {viewAsResearcher && !viewAsUserId && !isAutoRevisaoRoute && (
        <div className="bg-amber-50 text-amber-800 text-xs text-center py-1 dark:bg-amber-950/50 dark:text-amber-200">
          Visualizando como pesquisador,{" "}
          <button
            type="button"
            onClick={toggleViewAs}
            className="underline hover:no-underline font-medium"
          >
            voltar para coordenador
          </button>
        </div>
      )}
      <nav className="flex h-10 items-center gap-1 border-b px-4">
        {visibleTabs.map((tab) => {
          const qs = searchParams.toString();
          const href = `/projects/${projectId}/${tab.href}${qs ? `?${qs}` : ""}`;
          const isActive = pathname.startsWith(`/projects/${projectId}/${tab.href}`);

          return (
            <Link
              key={tab.href}
              href={href}
              onClick={(event) => guardedLinkClick(event, () => push(href))}
              className={cn(
                "relative px-3 py-1.5 text-sm transition-colors",
                isActive
                  ? "font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {tab.label}
              {tab.href === "llm" && isLlmRunning && <LlmRunningBadge />}
              {isActive && (
                <span className="absolute inset-x-1 -bottom-[5px] h-0.5 rounded-full bg-brand" />
              )}
            </Link>
          );
        })}

        <div className="ml-auto flex items-center gap-2">
          {isMaster && !isAutoRevisaoRoute && projectMembers.length > 0 && (
            <div className="relative flex items-center gap-1.5">
              <Users className="size-3.5 text-muted-foreground" />
              <select
                aria-label="Visualizar a plataforma como outro membro"
                value={viewAsUserId || ""}
                onChange={(e) =>
                  selectImpersonation(e.target.value || null)
                }
                className={cn(
                  "h-7 rounded-md border bg-background px-2 text-xs transition-colors",
                  viewAsUserId
                    ? "border-violet-300 text-violet-800 dark:border-violet-700 dark:text-violet-200"
                    : "border-input text-muted-foreground"
                )}
              >
                <option value="">Ver como…</option>
                {projectMembers.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name} ({m.role})
                  </option>
                ))}
              </select>
            </div>
          )}

          {isCoordinator && !isMaster && !isAutoRevisaoRoute && (
            <button
              type="button"
              onClick={toggleViewAs}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors",
                viewAsResearcher
                  ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {viewAsResearcher ? (
                <EyeOff className="size-3.5" />
              ) : (
                <Eye className="size-3.5" />
              )}
              {viewAsResearcher ? "Visão Coordenador" : "Ver como Pesquisador"}
            </button>
          )}
        </div>
      </nav>
    </div>
  );
}
