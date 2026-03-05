import { createSupabaseServer } from "@/lib/supabase/server";
import { StatsOverview } from "@/components/stats/StatsOverview";
import { FieldProgress } from "@/components/stats/FieldProgress";
import { VerdictChart } from "@/components/stats/VerdictChart";

export default async function StatsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createSupabaseServer();

  const { data: project } = await supabase
    .from("projects")
    .select("pydantic_fields")
    .eq("id", id)
    .single();

  const fields = (project?.pydantic_fields || []) as {
    name: string;
    description: string;
  }[];

  const [
    { count: totalAssignments },
    { count: completedAssignments },
    { data: reviews },
    { data: questionMeta },
    { data: responses },
  ] = await Promise.all([
    supabase
      .from("assignments")
      .select("*", { count: "exact", head: true })
      .eq("project_id", id),
    supabase
      .from("assignments")
      .select("*", { count: "exact", head: true })
      .eq("project_id", id)
      .eq("status", "concluido"),
    supabase
      .from("reviews")
      .select("field_name, verdict")
      .eq("project_id", id),
    supabase
      .from("question_meta")
      .select("field_name, priority")
      .eq("project_id", id),
    supabase
      .from("responses")
      .select("document_id, answers")
      .eq("project_id", id)
      .eq("is_current", true),
  ]);

  const priorityMap = new Map(
    questionMeta?.map((q) => [q.field_name, q.priority]) || []
  );

  let totalComparisons = 0;
  let agreements = 0;

  const responsesByDoc = new Map<string, any[]>();
  responses?.forEach((r) => {
    if (!responsesByDoc.has(r.document_id))
      responsesByDoc.set(r.document_id, []);
    responsesByDoc.get(r.document_id)!.push(r);
  });

  for (const [, docResponses] of responsesByDoc) {
    if (docResponses.length < 2) continue;
    for (const field of fields) {
      totalComparisons++;
      const answers = docResponses.map((r) =>
        JSON.stringify(r.answers?.[field.name])
      );
      if (new Set(answers).size === 1) agreements++;
    }
  }

  const agreement =
    totalComparisons > 0 ? Math.round((agreements / totalComparisons) * 100) : 0;

  // Field progress for chart
  const reviewsByField = new Map<string, { agreed: number; divergent: number; reviewed: number }>();
  reviews?.forEach((r) => {
    if (!reviewsByField.has(r.field_name)) {
      reviewsByField.set(r.field_name, { agreed: 0, divergent: 0, reviewed: 0 });
    }
    const entry = reviewsByField.get(r.field_name)!;
    entry.reviewed++;
  });

  const chartData = fields.slice(0, 20).map((f) => ({
    field: f.name.replace(/^q\d+_\d+_/, "").slice(0, 15),
    ...(reviewsByField.get(f.name) || { agreed: 0, divergent: 0, reviewed: 0 }),
  }));

  const fieldProgressData = fields.map((f) => {
    const reviewed = reviewsByField.get(f.name)?.reviewed || 0;
    const docsNeedingReview = responsesByDoc.size || 0;
    const progress = docsNeedingReview > 0
      ? Math.round((reviewed / docsNeedingReview) * 100)
      : 0;
    return {
      name: f.name,
      description: f.description,
      progress: Math.min(progress, 100),
      priority: (priorityMap.get(f.name) as "ALTA" | "MEDIA" | "BAIXA") || "MEDIA",
    };
  });

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <StatsOverview
        coded={completedAssignments || 0}
        totalCoding={totalAssignments || 0}
        agreement={agreement}
        reviews={reviews?.length || 0}
        totalReviews={fields.length * (responsesByDoc.size || 0)}
      />
      <div>
        <h3 className="mb-3 text-lg font-semibold">Progresso por Campo</h3>
        <FieldProgress fields={fieldProgressData} />
      </div>
      <div>
        <h3 className="mb-3 text-lg font-semibold">Vereditos por Campo</h3>
        <VerdictChart data={chartData} />
      </div>
    </div>
  );
}
