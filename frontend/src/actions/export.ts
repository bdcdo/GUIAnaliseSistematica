"use server";

// Server action do export completo (feature 004). Só exports async vivem aqui —
// export síncrono em módulo "use server" quebra o deploy silenciosamente e nenhum
// gate local pega (lição do PR #412); a montagem pura mora em lib/export/assemble.
import { createSupabaseServer } from "@/lib/supabase/server";
import { requireCoordinator } from "@/lib/auth";
import type { PydanticField } from "@/lib/types";
import { fetchAllPaged } from "@/lib/supabase/fetch-all-paged";
import {
  assembleExport,
  type ExportDataset,
  type ExportDocument,
  type ExportResponse,
  type ExportReview,
} from "@/lib/export/assemble";

export type GetExportDatasetResult = ExportDataset | { error: string };

// Retorna o conjunto completo do projeto (documentos + respostas + gabarito)
// já montado como planilhas de strings. Gate coordinator-only (fail-closed);
// lê documents.metadata APENAS aqui — nunca na listagem da página. As 4 queries
// são paralelas e usam colunas explícitas (Princípio II de velocidade).
export async function getExportDataset(
  projectId: string
): Promise<GetExportDatasetResult> {
  const gate = await requireCoordinator(
    projectId,
    "Apenas coordenadores podem exportar os dados do projeto."
  );
  if (!gate.ok) return { error: gate.error };

  const supabase = await createSupabaseServer();

  const [
    { data: project, error: projectError },
    { data: documents, error: documentsError },
    { data: responses, error: responsesError },
    { data: reviews, error: reviewsError },
  ] = await Promise.all([
    supabase
      .from("projects")
      .select("name, pydantic_fields, min_responses_for_comparison")
      .eq("id", projectId)
      .single(),
    // Base exportada: documentos não excluídos. Exclusão apenas pendente
    // (exclusion_pending_at) continua na base até ser confirmada. Paginado para
    // não truncar em projetos grandes (ver fetchAllPaged).
    fetchAllPaged<ExportDocument>(() =>
      supabase
        .from("documents")
        .select("id, external_id, title, created_at, metadata")
        .eq("project_id", projectId)
        .is("excluded_at", null),
      ["id"],
    ),
    fetchAllPaged<ExportResponse>(() =>
      supabase
        .from("responses")
        .select("document_id, respondent_name, respondent_type, answers")
        .eq("project_id", projectId)
        .eq("is_latest", true),
      ["id"],
    ),
    fetchAllPaged<ExportReview>(() =>
      supabase
        .from("reviews")
        .select("document_id, field_name, verdict, comment")
        .eq("project_id", projectId),
      ["id"],
    ),
  ]);

  const error = [
    projectError,
    documentsError,
    responsesError,
    reviewsError,
  ].find(Boolean);
  if (error) return { error: error.message };
  if (!project) return { error: "Projeto não encontrado." };

  // documents/responses/reviews já são arrays (fetchAllPaged nunca devolve null).
  return assembleExport({
    projectName: project.name || "Projeto",
    fields: (project.pydantic_fields || []) as PydanticField[],
    minResponses: project.min_responses_for_comparison || 2,
    documents,
    responses,
    reviews,
  });
}
