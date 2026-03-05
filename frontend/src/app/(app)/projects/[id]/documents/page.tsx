import { createSupabaseServer } from "@/lib/supabase/server";
import { DocumentUpload } from "@/components/documents/DocumentUpload";
import { DocumentsPageClient } from "@/components/documents/DocumentsPageClient";

export default async function DocumentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createSupabaseServer();

  const [{ data: documents }, { data: responseCounts }] = await Promise.all([
    supabase
      .from("documents")
      .select("id, external_id, title, created_at")
      .eq("project_id", id)
      .order("created_at", { ascending: true }),
    supabase
      .from("responses")
      .select("document_id")
      .eq("project_id", id),
  ]);

  const countMap = new Map<string, number>();
  responseCounts?.forEach((r: { document_id: string }) => {
    countMap.set(r.document_id, (countMap.get(r.document_id) || 0) + 1);
  });

  const docsWithCounts = (documents || []).map((d) => ({
    ...d,
    responseCount: countMap.get(d.id) || 0,
  }));

  return (
    <div className="p-6">
      <div className="mb-6">
        <DocumentUpload projectId={id} />
      </div>
      <DocumentsPageClient documents={docsWithCounts} />
    </div>
  );
}
