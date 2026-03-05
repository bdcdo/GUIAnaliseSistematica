"use client";

import { removeMember, changeRole } from "@/actions/members";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import type { ProjectMember, Profile } from "@/lib/types";

interface MemberListProps {
  projectId: string;
  members: (ProjectMember & { profiles: Profile })[];
  currentUserId: string;
}

export function MemberList({ projectId, members, currentUserId }: MemberListProps) {
  const handleRemove = async (memberId: string) => {
    const result = await removeMember(projectId, memberId);
    if (result?.error) {
      toast.error(result.error);
    } else {
      toast.success("Membro removido");
    }
  };

  const handleChangeRole = async (memberId: string, newRole: "coordenador" | "pesquisador") => {
    const result = await changeRole(memberId, newRole, projectId);
    if (result?.error) {
      toast.error(result.error);
    } else {
      toast.success("Papel atualizado");
    }
  };

  return (
    <div className="space-y-2">
      {members.map((m) => (
        <div key={m.id} className="flex items-center justify-between rounded-lg border p-3">
          <div>
            <p className="text-sm font-medium">
              {m.profiles.first_name || m.profiles.email}
            </p>
            <p className="text-xs text-muted-foreground">{m.profiles.email}</p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={m.role}
              onChange={(e) => handleChangeRole(m.id, e.target.value as "coordenador" | "pesquisador")}
              className="rounded-md border bg-background px-2 py-1 text-xs"
              disabled={m.user_id === currentUserId}
            >
              <option value="coordenador">Coordenador</option>
              <option value="pesquisador">Pesquisador</option>
            </select>
            {m.user_id !== currentUserId && (
              <Button variant="ghost" size="sm" onClick={() => handleRemove(m.id)} className="text-destructive">
                Remover
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
