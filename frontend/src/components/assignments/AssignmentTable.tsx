"use client";

import { toggleAssignment } from "@/actions/assignments";
import { cn } from "@/lib/utils";
import type { Document, ProjectMember, Assignment } from "@/lib/types";

interface AssignmentTableProps {
  projectId: string;
  documents: Pick<Document, "id" | "external_id">[];
  researchers: (ProjectMember & { profiles: { first_name: string | null; email: string } })[];
  assignments: Assignment[];
}

export function AssignmentTable({ projectId, documents, researchers, assignments }: AssignmentTableProps) {
  const assignmentSet = new Set(assignments.map((a) => `${a.document_id}:${a.user_id}`));

  const handleToggle = async (documentId: string, userId: string) => {
    await toggleAssignment(projectId, documentId, userId);
  };

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="px-3 py-2 text-left font-medium">Documento</th>
            {researchers.map((r) => (
              <th key={r.user_id} className="px-3 py-2 text-center font-medium">
                {r.profiles?.first_name || r.profiles?.email?.split("@")[0]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {documents.map((doc) => (
            <tr key={doc.id} className="border-b">
              <td className="px-3 py-1.5 font-mono text-xs">{doc.external_id || doc.id.slice(0, 8)}</td>
              {researchers.map((r) => {
                const isAssigned = assignmentSet.has(`${doc.id}:${r.user_id}`);
                return (
                  <td key={r.user_id} className="px-3 py-1.5 text-center">
                    <button
                      onClick={() => handleToggle(doc.id, r.user_id)}
                      className={cn(
                        "h-5 w-5 rounded border transition-colors",
                        isAssigned ? "bg-brand border-brand" : "border-muted-foreground/30 hover:border-brand/50"
                      )}
                    >
                      {isAssigned && <span className="text-xs text-brand-foreground">✓</span>}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="bg-muted/30">
            <td className="px-3 py-1.5 font-medium">Total</td>
            {researchers.map((r) => (
              <td key={r.user_id} className="px-3 py-1.5 text-center font-medium">
                {assignments.filter((a) => a.user_id === r.user_id).length}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
