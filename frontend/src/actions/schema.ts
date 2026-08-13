"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";
import { revalidatePath, revalidateTag } from "next/cache";
import { fetchFastAPIServer } from "@/lib/api-server";
import type {
  PydanticField,
  SchemaBaselineIdentity,
  SchemaSaveResult,
  SchemaSnapshot,
} from "@/lib/types";
import {
  bumpVersion,
  planSchemaPersistence,
  PROJECT_LOG_FIELD_NAME,
  type SchemaPersistencePlan,
} from "@/lib/schema-utils";
import { updateOrThrow } from "@/lib/supabase/rls-guard";
import { errorMessage } from "@/lib/utils";
import {
  parsePydanticFields,
  parseSaveablePydanticFields,
} from "@/lib/pydantic-field";
import {
  buildKwargsForCapabilities,
  getModelCapabilities,
  getModelsForProvider,
  isProvider,
} from "@/lib/model-registry";
import {
  classifyLogEntries,
  reconstructSnapshotsByVersion,
  matchResponsesToVersions,
  computeHashesFromSnapshot,
  type BackfillStats,
  type LogEntryRow,
  type ResponseRow,
} from "@/lib/schema-backfill";

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServer>>;

interface SchemaProjectRow {
  pydantic_fields: PydanticField[];
  pydantic_code: string | null;
  pydantic_hash: string | null;
  schema_version_major: number | null;
  schema_version_minor: number | null;
  schema_version_patch: number | null;
  // `projects.schema_revision` é NOT NULL DEFAULT 0 desde
  // 20260715180000_schema_revision_atomic_rpcs. Tipar como anulável obrigaria
  // todo leitor a inventar um significado para o nulo — e os dois que existiam
  // discordavam entre si (um mapeava para 0, o outro para conflito).
  schema_revision: number;
}

const SCHEMA_PROJECT_SELECT =
  "pydantic_fields, pydantic_code, pydantic_hash, schema_version_major, schema_version_minor, schema_version_patch, schema_revision";

// Todo caminho que vá escrever schema recusa antes de escrever quando o que
// está persistido não passa no Zod. O backfill é o caso que obriga a copy a ser
// compartilhada: ele é a ferramenta de projeto legado, logo é o mais provável de
// encontrar o estado inválido, e a RPC dele commita antes de o chamador ver o
// retorno — validar só o retorno reportaria como falha uma escrita que ocorreu.
const PERSISTED_SCHEMA_INVALID =
  "O schema persistido é inválido e precisa ser corrigido antes da edição.";

function projectVersion(project: Partial<SchemaProjectRow>): {
  major: number;
  minor: number;
  patch: number;
} {
  return {
    major: project.schema_version_major ?? 0,
    minor: project.schema_version_minor ?? 1,
    patch: project.schema_version_patch ?? 0,
  };
}

function versionString(version: { major: number; minor: number; patch: number }): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function projectSnapshot(
  project: Pick<
    SchemaProjectRow,
    | "pydantic_fields"
    | "schema_version_major"
    | "schema_version_minor"
    | "schema_version_patch"
    | "schema_revision"
  >,
): SchemaSnapshot {
  return {
    fields: project.pydantic_fields,
    version: versionString(projectVersion(project)),
    revision: project.schema_revision,
  };
}

interface SchemaSaveContext {
  project: SchemaProjectRow;
  oldFields: PydanticField[];
  current: { major: number; minor: number; patch: number };
}

type SchemaContextLoad =
  | { context: SchemaSaveContext }
  | { result: SchemaSaveResult };

type AuthenticatedSchemaContextLoad =
  | {
      supabase: SupabaseServerClient;
      userId: string;
      context: SchemaSaveContext;
    }
  | { result: SchemaSaveResult };

async function loadSchemaSaveContext(
  supabase: SupabaseServerClient,
  projectId: string,
  expectedBaseline: SchemaBaselineIdentity,
): Promise<SchemaContextLoad> {
  // O snapshot completo também atende a publicação MAJOR, que reapresenta o
  // mesmo código e os mesmos campos à RPC ao alterar somente a versão.
  // `maybeSingle` e não `single`: com `single`, zero linhas é um ERRO
  // (`PGRST116`, 406), então nenhuma leitura conseguiria separar "projeto
  // inexistente ou filtrado pela RLS" de "a query falhou" sem casar com o código
  // do erro no call site. `maybeSingle` faz da ausência um valor (`data` nulo,
  // `error` nulo), e aí `error` passa a significar só o que não deveria
  // acontecer.
  const { data, error } = await supabase
    .from("projects")
    .select(SCHEMA_PROJECT_SELECT)
    .eq("id", projectId)
    .maybeSingle();
  // Falha de query — timeout num projeto grande, conexão caída — não é "sem
  // permissão". Mesma regra do mapRpcError e da paginação do backfill: o texto
  // do Postgres é diagnóstico de servidor, some do toast, mas não pode sumir do
  // log.
  if (error) {
    console.error("[schema] leitura do projeto falhou", {
      code: error.code,
      message: error.message,
    });
    return {
      result: {
        status: "error",
        message: "Não foi possível ler o schema do projeto. Tente novamente.",
      },
    };
  }
  if (!data) {
    return {
      result: {
        status: "error",
        message: "Projeto não encontrado ou sem permissão",
      },
    };
  }

  const project = data as SchemaProjectRow;
  const persistedFields = parsePydanticFields(project.pydantic_fields);
  if (!persistedFields) {
    return {
      result: { status: "error", message: PERSISTED_SCHEMA_INVALID },
    };
  }
  project.pydantic_fields = persistedFields;
  const remoteBaseline = projectSnapshot(project);
  if (expectedBaseline.revision !== remoteBaseline.revision) {
    return { result: { status: "conflict", current: remoteBaseline } };
  }

  return {
    context: {
      project,
      oldFields: persistedFields,
      current: projectVersion(project),
    },
  };
}

async function loadAuthenticatedSchemaContext(
  projectId: string,
  expectedBaseline: SchemaBaselineIdentity,
): Promise<AuthenticatedSchemaContextLoad> {
  const [supabase, user] = await Promise.all([
    createSupabaseServer(),
    getAuthUser(),
  ]);
  if (!user) return { result: { status: "error", message: "Não autenticado" } };

  const loaded = await loadSchemaSaveContext(supabase, projectId, expectedBaseline);
  if ("result" in loaded) return loaded;
  return { supabase, userId: user.id, context: loaded.context };
}

interface SchemaCommitRow {
  status: string;
  schema_revision: number;
  pydantic_fields: PydanticField[];
  schema_version_major: number;
  schema_version_minor: number;
  schema_version_patch: number;
}

function commitSnapshot(row: SchemaCommitRow): SchemaSnapshot | null {
  const fields = parsePydanticFields(row.pydantic_fields);
  if (!fields) return null;
  return {
    fields,
    revision: row.schema_revision,
    version: versionString({
      major: row.schema_version_major,
      minor: row.schema_version_minor,
      patch: row.schema_version_patch,
    }),
  };
}

type SchemaCommitRpc =
  | "commit_project_schema"
  | "approve_schema_suggestion"
  | "resolve_schema_suggestion"
  | "apply_schema_backfill";

interface SchemaRpcCopy {
  generic: string;
  byCode: Record<string, string>;
}

// As RAISE EXCEPTION das RPCs são de duas naturezas, e só uma delas interessa ao
// usuário. Violação de contrato (22023, 23514, 42501: payload malformado, log
// vazio, salto semver incompatível) um cliente correto não produz — a mensagem
// do Postgres é diagnóstico de desenvolvedor, vai para o log do servidor, e o
// usuário recebe copy genérica porque não há ação que ele possa tomar. Já P0001
// descreve uma condição real de negócio e merece copy própria. O mapeamento é
// por (rpc, código) e não só por código porque P0001 é ambíguo entre as RPCs:
// significa "sugestão não pendente" numa e "cobertura mudou" na outra.
const SCHEMA_RPC_COPY: Record<SchemaCommitRpc, SchemaRpcCopy> = {
  commit_project_schema: {
    generic: "Não foi possível salvar o schema. Tente novamente.",
    byCode: {},
  },
  approve_schema_suggestion: {
    generic: "Não foi possível aplicar a sugestão. Tente novamente.",
    byCode: { P0001: "Sugestão não encontrada ou já resolvida." },
  },
  resolve_schema_suggestion: {
    generic: "Não foi possível aplicar a sugestão. Tente novamente.",
    byCode: { P0001: "Sugestão não encontrada ou já resolvida." },
  },
  apply_schema_backfill: {
    generic: "Não foi possível reconstruir o histórico. Tente novamente.",
    byCode: {
      P0001:
        "Os dados do projeto mudaram durante a reconstrução. Tente novamente.",
    },
  },
};

interface SchemaRpcError {
  code?: string;
  message: string;
}

function mapRpcError(
  rpc: SchemaCommitRpc,
  error: SchemaRpcError,
): SchemaSaveResult {
  const copy = SCHEMA_RPC_COPY[rpc];
  const specific = error.code ? copy.byCode[error.code] : undefined;
  if (!specific) {
    console.error(`[schema] ${rpc} falhou`, {
      code: error.code,
      message: error.message,
    });
  }
  return { status: "error", message: specific ?? copy.generic };
}

function mapCommitResult(
  rpc: SchemaCommitRpc,
  data: SchemaCommitRow | null,
  error: SchemaRpcError | null,
): SchemaSaveResult {
  if (error) return mapRpcError(rpc, error);
  if (!data) {
    return { status: "error", message: "A operação não retornou o estado do schema." };
  }
  if (data.status === "saved") {
    const snapshot = commitSnapshot(data);
    return snapshot
      ? { status: "saved", snapshot }
      : { status: "error", message: "A operação retornou um schema inválido." };
  }
  if (data.status === "conflict") {
    const current = commitSnapshot(data);
    return current
      ? { status: "conflict", current }
      : { status: "error", message: "O schema remoto em conflito é inválido." };
  }
  if (data.status === "forbidden") {
    return {
      status: "error",
      message: "Sem permissão para alterar o schema deste projeto.",
    };
  }
  if (data.status === "not_found") {
    return { status: "error", message: "Projeto não encontrado." };
  }
  return {
    status: "error",
    message: `Resultado desconhecido ao salvar o schema: ${data.status}`,
  };
}

function revalidateSchemaConsumers(projectId: string): void {
  revalidatePath(`/projects/${projectId}/analyze/code`);
  revalidatePath(`/projects/${projectId}/analyze/compare`);
  revalidatePath(`/projects/${projectId}/reviews`);
  revalidatePath(`/projects/${projectId}/llm/configure`);
  revalidateTag(`project-${projectId}-progress`, { expire: 60 });
}

// `fields` é o que o FastAPI devolveu, não um `PydanticField[]` provado: o
// genérico de `fetchFastAPIServer` é uma afirmação sobre a resposta, e quem a
// verifica é o parse abaixo. Tipar como `unknown` é o que impede o call site de
// pular essa verificação.
interface RecoverResponse {
  valid: boolean;
  fields: unknown;
  model_name: string | null;
  errors: string[];
}

// Repopula os campos a partir do `pydantic_code` ARMAZENADO do projeto (lido no
// backend via service key, não enviado pelo cliente — logo sem vetor do #163).
// Usado quando um projeto legado tem código mas o editor visual abre vazio.
// fetchFastAPIServer (não fetchFastAPI): o endpoint /recover-fields passou a
// exigir auth de coordenador (#195), então a server action injeta o token JWT.
export async function recoverFieldsFromStoredCode(
  projectId: string,
): Promise<{ fields?: PydanticField[]; error?: string }> {
  try {
    const result = await fetchFastAPIServer<RecoverResponse>(
      "/api/pydantic/recover-fields",
      { method: "POST", body: JSON.stringify({ project_id: projectId }) },
    );
    if (!result.valid) {
      return {
        error:
          result.errors[0] ||
          "Não foi possível reconstruir os campos a partir do código armazenado.",
      };
    }
    // A validação é aqui, na fronteira, e não no componente: era o único ponto
    // do fluxo que entregava campos ao estado do editor sem passar pelo Zod, e
    // um campo malformado só apareceria depois — no save, contra a copy genérica
    // de "schema enviado é inválido", já com o rascunho local gravado por cima
    // do trabalho anterior.
    const fields = parsePydanticFields(result.fields);
    if (!fields) {
      return {
        error:
          "O código armazenado reconstruiu campos que não são válidos. Corrija o schema no banco antes de recuperar.",
      };
    }
    return { fields };
  } catch (e) {
    return { error: errorMessage(e) || "Erro ao recuperar campos do código" };
  }
}

// As actions tratam erros na fronteira: o Next mascara mensagens lançadas em
// Server Actions em produção, então a copy pt-BR precisa voltar no resultado.

export async function savePrompt(
  projectId: string,
  promptTemplate: string,
): Promise<{ error?: string }> {
  const supabase = await createSupabaseServer();
  try {
    await updateOrThrow(
      supabase,
      "projects",
      { prompt_template: promptTemplate },
      { id: projectId },
      { message: "Não foi possível salvar o prompt: sem permissão para alterar este projeto." },
    );
  } catch (e) {
    return { error: errorMessage(e) || "Erro ao salvar o prompt" };
  }
  revalidatePath(`/projects/${projectId}/analyze/code`);
  revalidatePath(`/projects/${projectId}/llm/configure`);
  return {};
}

// ---------- Save from GUI ----------
//
// Orquestrador fino: lê o estado antigo, delega o cálculo a
// planSchemaPersistence (lib/schema-utils.ts, pura) e faz os writes. A mesma
// função é usada por apply-decisions.ts (fora do Next runtime) para eliminar
// drift — ver #63/PR #352.

interface PreparedSchemaCommit {
  plan: SchemaPersistencePlan;
  targetVersion: { major: number; minor: number; patch: number };
}

// Os campos submetidos não mudam nada no schema atual. Não é erro nem estado
// degenerado: quem edita e desfaz cai aqui, e também quem aprova uma sugestão
// depois de já ter aplicado a mudança à mão. Quem decide o desfecho é o
// chamador, porque ele difere — sem sugestão não há o que fazer, com sugestão
// ainda há a sugestão a resolver.
type PreparedSchema =
  | PreparedSchemaCommit
  | { unchanged: true }
  | { result: SchemaSaveResult };

function prepareSchemaCommit(
  fields: PydanticField[],
  context: SchemaSaveContext,
): PreparedSchema {
  const parsedFields = parseSaveablePydanticFields(fields);
  if (!parsedFields) {
    return { result: {
      status: "error",
      message: "O schema enviado é inválido. Revise os campos e tente novamente.",
    } };
  }
  const plan = planSchemaPersistence(
    context.oldFields,
    parsedFields,
    context.current,
  );
  if (!plan.changeType && plan.logEntries.length === 0) {
    return { unchanged: true };
  }
  return {
    plan,
    targetVersion: plan.changeType ? plan.bumped : context.current,
  };
}

function schemaCommitArgs(
  projectId: string,
  expectedRevision: number,
  userId: string,
  prepared: PreparedSchemaCommit,
  suggestionId?: string,
) {
  const { plan, targetVersion } = prepared;
  return {
    ...(suggestionId && { p_suggestion_id: suggestionId }),
    p_project_id: projectId,
    p_expected_revision: expectedRevision,
    p_pydantic_fields: plan.fieldsWithHash,
    p_pydantic_code: plan.code,
    p_version_major: targetVersion.major,
    p_version_minor: targetVersion.minor,
    p_version_patch: targetVersion.patch,
    p_change_type: plan.changeType ?? "patch",
    p_log_entries: plan.logEntries,
    p_changed_by: userId,
  };
}

// Aprova a sugestão sem tocar no schema, que já contém o que ela pedia. A RPC
// confere a autorização e o mesmo compare-and-swap por revisão das demais: não
// há commit, mas há a janela entre a leitura do contexto e esta escrita, e
// aprovar contra um schema que mudou nesse meio-tempo registraria como atendida
// uma sugestão que deixou de ser.
async function resolveSuggestionWithoutCommit(
  supabase: SupabaseServerClient,
  projectId: string,
  suggestionId: string,
  expectedBaseline: SchemaBaselineIdentity,
  userId: string,
): Promise<SchemaSaveResult> {
  const { data, error } = await supabase
    .rpc("resolve_schema_suggestion", {
      p_suggestion_id: suggestionId,
      p_project_id: projectId,
      p_expected_revision: expectedBaseline.revision,
      p_resolved_by: userId,
    })
    .single();
  return mapCommitResult(
    "resolve_schema_suggestion",
    data as SchemaCommitRow | null,
    error,
  );
}

async function persistSchema(
  projectId: string,
  fields: PydanticField[],
  expectedBaseline: SchemaBaselineIdentity,
  loaded: Exclude<AuthenticatedSchemaContextLoad, { result: SchemaSaveResult }>,
  suggestionId?: string,
): Promise<SchemaSaveResult> {
  const { supabase, userId, context } = loaded;
  const prepared = prepareSchemaCommit(fields, context);
  if ("result" in prepared) return prepared.result;
  if ("unchanged" in prepared) {
    if (!suggestionId) {
      return { status: "saved", snapshot: projectSnapshot(context.project) };
    }
    const resolved = await resolveSuggestionWithoutCommit(
      supabase,
      projectId,
      suggestionId,
      expectedBaseline,
      userId,
    );
    // Sem commit não há consumidor de schema a revalidar: o que mudou foi só o
    // status da sugestão, e quem o mostra é a página revalidada pelo chamador.
    return resolved;
  }

  const rpc: SchemaCommitRpc = suggestionId
    ? "approve_schema_suggestion"
    : "commit_project_schema";
  const { data, error } = await supabase
    .rpc(
      rpc,
      schemaCommitArgs(
        projectId,
        expectedBaseline.revision,
        userId,
        prepared,
        suggestionId,
      ),
    )
    .single();
  const result = mapCommitResult(rpc, data as SchemaCommitRow | null, error);
  if (result.status === "saved") revalidateSchemaConsumers(projectId);
  return result;
}

export async function saveSchemaFromGUI(
  projectId: string,
  fields: PydanticField[],
  expectedBaseline: SchemaBaselineIdentity,
): Promise<SchemaSaveResult> {
  const loaded = await loadAuthenticatedSchemaContext(projectId, expectedBaseline);
  if ("result" in loaded) return loaded.result;
  return persistSchema(projectId, fields, expectedBaseline, loaded);
}

export async function saveSchemaAndApproveSuggestion(
  projectId: string,
  suggestionId: string,
  fields: PydanticField[],
  expectedBaseline: SchemaBaselineIdentity,
): Promise<SchemaSaveResult> {
  const loaded = await loadAuthenticatedSchemaContext(projectId, expectedBaseline);
  if ("result" in loaded) return loaded.result;
  return persistSchema(
    projectId,
    fields,
    expectedBaseline,
    loaded,
    suggestionId,
  );
}

// ---------- Backfill retroativo usando schema_change_log ----------
// Reconstrói a versão do projeto a partir do histórico já registrado.
// - Classifica entries não classificadas (minor/patch), respeita majors já setados.
// - Reconstrói snapshots do schema em cada versão (reverter diffs do atual).
// - Atribui versão a cada resposta usando answer_field_hashes quando disponível;
//   cai em created_at quando não (responses pré-hash).
// - Rastreia o método em responses.version_inferred_from.
// Idempotente.
//
// As etapas puras (classificação, snapshots, matching) vivem em
// @/lib/schema-backfill — "use server" só pode exportar funções async, então
// o que é puro e testável fica fora deste arquivo.

export type BackfillSchemaResult =
  | { status: "saved"; stats: BackfillStats; snapshot: SchemaSnapshot }
  | { status: "conflict"; current: SchemaSnapshot }
  | { status: "error"; message: string };

export async function backfillSchemaVersionHistory(
  projectId: string,
  expectedBaseline: SchemaBaselineIdentity,
): Promise<BackfillSchemaResult> {
  try {
    return await runBackfill(projectId, expectedBaseline);
  } catch (e) {
    return {
      status: "error",
      message: errorMessage(e) || "Erro ao reconstruir o histórico de versões",
    };
  }
}

const BACKFILL_PAGE_SIZE = 500;

interface BackfillPage<T> {
  data: T[] | null;
  error: { message: string } | null;
}

async function fetchAllPages<T>(
  loadPage: (from: number, to: number) => Promise<BackfillPage<T>>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += BACKFILL_PAGE_SIZE) {
    // A próxima página depende de a anterior estar cheia; o total não é
    // conhecido sem uma consulta adicional que também poderia ficar stale.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const { data, error } = await loadPage(from, from + BACKFILL_PAGE_SIZE - 1);
    if (error) {
      // Estes SELECT precedem a RPC, então escapam do mapeamento por (rpc,
      // errcode) — e eram o único ponto do backfill que entregava texto cru do
      // Postgres ao toast pt-BR ("canceling statement due to statement
      // timeout", num projeto grande). Vale a mesma regra do mapRpcError: o
      // texto é diagnóstico de desenvolvedor e vai para o log do servidor.
      console.error("[schema] paginação do backfill falhou", {
        message: error.message,
      });
      throw new Error(SCHEMA_RPC_COPY.apply_schema_backfill.generic);
    }
    if (!data || data.length === 0) return rows;
    rows.push(...data);
    if (data.length < BACKFILL_PAGE_SIZE) return rows;
  }
}

function fetchAllResponses(
  supabase: SupabaseServerClient,
  projectId: string,
): Promise<ResponseRow[]> {
  return fetchAllPages(async (from, to) => {
    const { data, error } = await supabase
      .from("responses")
      .select("id, created_at, answer_field_hashes, version_inferred_from")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
    return { data: data as unknown as ResponseRow[] | null, error };
  });
}

function fetchAllLogEntries(
  supabase: SupabaseServerClient,
  projectId: string,
): Promise<LogEntryRow[]> {
  return fetchAllPages(async (from, to) => {
    const { data, error } = await supabase
      .from("schema_change_log")
      .select("id, field_name, before_value, after_value, created_at, change_type")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
    return { data: data as unknown as LogEntryRow[] | null, error };
  });
}

// Só a ausência da linha é um estado real: a coluna é NOT NULL, então uma linha
// visível sempre traz revisão.
async function runBackfill(
  projectId: string,
  expectedBaseline: SchemaBaselineIdentity,
): Promise<BackfillSchemaResult> {
  const user = await getAuthUser();
  if (!user) throw new Error("Não autenticado");

  const supabase = await createSupabaseServer();

  const [{ data: project }, log, responses] = await Promise.all([
    supabase
      .from("projects")
      .select(
        "pydantic_fields, schema_version_major, schema_version_minor, schema_version_patch, schema_revision",
      )
      .eq("id", projectId)
      .single(),
    fetchAllLogEntries(supabase, projectId),
    fetchAllResponses(supabase, projectId),
  ]);

  if (!project) throw new Error("Projeto não encontrado ou sem permissão");

  // O CAS compara contra a revisão que a ABA observou, como em
  // publishMajorVersion — não contra a leitura fresca deste request. Ler o
  // servidor aqui mascararia a defasagem da aba: um editor stale receberia o
  // snapshot novo, stateAfterSave o trataria como rascunho próprio e o save
  // seguinte reverteria em silêncio o schema salvo por outra sessão.
  if (expectedBaseline.revision !== project.schema_revision) {
    return { status: "conflict", current: projectSnapshot(project) };
  }

  // `apply_schema_backfill` commita e só então devolve os campos persistidos,
  // que `mapCommitResult` valida. Sem esta recusa prévia, um schema inválido no
  // banco produzia a escrita completa (log reclassificado, respostas versionadas,
  // revisão avançada) e mesmo assim uma resposta de erro ao usuário, com o
  // revalidate pulado — a repetição só reencontra o mesmo erro. O snapshot
  // reconstruído parte destes campos, então a validação também é o que sustenta
  // o cast que reconstructSnapshotsByVersion recebe.
  const persistedFields = parsePydanticFields(project.pydantic_fields);
  if (!persistedFields) {
    return { status: "error", message: PERSISTED_SCHEMA_INVALID };
  }

  const { enriched, finalVersion } = classifyLogEntries(log);

  const snapByVersion = reconstructSnapshotsByVersion(
    persistedFields,
    enriched,
    finalVersion,
  );

  const hashesByVersion = new Map<string, Record<string, string>>();
  for (const [k, snap] of snapByVersion) {
    hashesByVersion.set(k, computeHashesFromSnapshot(snap));
  }

  const { updates, byMethod } = matchResponsesToVersions(responses, hashesByVersion, enriched);
  const stats: BackfillStats = {
    finalVersion,
    logEntriesUpdated: enriched.length,
    responsesProcessed: responses.length,
    byMethod,
  };
  const { data, error } = await supabase
    .rpc("apply_schema_backfill", {
      p_project_id: projectId,
      p_expected_revision: expectedBaseline.revision,
      p_final_major: finalVersion.major,
      p_final_minor: finalVersion.minor,
      p_final_patch: finalVersion.patch,
      p_log_updates: enriched.map((entry) => ({
        id: entry.id,
        change_type: entry.changeType,
        version_major: entry.version.major,
        version_minor: entry.version.minor,
        version_patch: entry.version.patch,
      })),
      p_response_updates: [...updates.values()].map((bucket) => ({
        ids: bucket.ids,
        version_major: bucket.version.major,
        version_minor: bucket.version.minor,
        version_patch: bucket.version.patch,
        version_inferred_from: bucket.method,
      })),
    })
    .single();
  const commit = mapCommitResult(
    "apply_schema_backfill",
    data as SchemaCommitRow | null,
    error,
  );
  if (commit.status === "error") return commit;
  if (commit.status === "conflict") return commit;
  revalidateSchemaConsumers(projectId);
  revalidatePath(`/projects/${projectId}/config/schema`);
  return { status: "saved", stats, snapshot: commit.snapshot };
}

// ---------- MAJOR version bump (manual) ----------

export async function publishMajorVersion(
  projectId: string,
  expectedBaseline: SchemaBaselineIdentity,
): Promise<SchemaSaveResult> {
  const loaded = await loadAuthenticatedSchemaContext(projectId, expectedBaseline);
  if ("result" in loaded) return loaded.result;
  const { supabase, userId, context } = loaded;
  const typedProject = context.project;
  // Publicar MAJOR reapresenta à RPC o código já armazenado, sem regerá-lo. Um
  // projeto sem código não tem o que publicar, e deixar passar gravaria
  // `pydantic_hash` nulo — que `compare-version.ts` lê como "anterior ao
  // versionamento", rebaixando silenciosamente o projeto recém-publicado.
  const storedCode = typedProject.pydantic_code;
  if (!storedCode) {
    return {
      status: "error",
      message:
        "Este projeto ainda não tem um schema salvo para publicar. Salve o schema antes de publicar uma versão MAJOR.",
    };
  }
  const current = projectVersion(typedProject);
  const bumped = bumpVersion(current, "major");
  const fields = typedProject.pydantic_fields;
  const { data, error } = await supabase
    .rpc("commit_project_schema", {
      p_project_id: projectId,
      p_expected_revision: expectedBaseline.revision,
      p_pydantic_fields: fields,
      p_pydantic_code: storedCode,
      p_version_major: bumped.major,
      p_version_minor: bumped.minor,
      p_version_patch: bumped.patch,
      p_change_type: "major",
      p_log_entries: [{
        field_name: PROJECT_LOG_FIELD_NAME,
        change_summary: `Nova versão MAJOR publicada: ${versionString(bumped)}`,
        before_value: current,
        after_value: bumped,
      }],
      p_changed_by: userId,
    })
    .single();
  const result = mapCommitResult(
    "commit_project_schema",
    data as SchemaCommitRow | null,
    error,
  );
  if (result.status === "saved") revalidateSchemaConsumers(projectId);
  return result;
}

export async function toggleLlmField(
  projectId: string,
  fieldDef: PydanticField,
  enabled: boolean,
  expectedBaseline: SchemaBaselineIdentity,
): Promise<SchemaSaveResult> {
  const loaded = await loadAuthenticatedSchemaContext(projectId, expectedBaseline);
  if ("result" in loaded) return loaded.result;
  let fields = loaded.context.oldFields;

  if (enabled) {
    if (!fields.some((f) => f.name === fieldDef.name)) {
      fields = [...fields, fieldDef];
    }
  } else {
    fields = fields.filter((f) => f.name !== fieldDef.name);
  }

  return persistSchema(projectId, fields, expectedBaseline, loaded);
}

/**
 * Único escritor de `projects.llm_provider` / `llm_model` / `llm_kwargs` no
 * sistema — o backend só lê essas colunas. É por isso que a validação mora
 * aqui: é a fronteira onde dá para tornar o estado ruim inconstruível, em vez
 * de detectá-lo depois, na run, quando o provider já recusou.
 *
 * O `llm_model` gravado ia cru para o provider, sem validação em ponto algum do
 * caminho — foi assim que um ID inexistente queimou 26 chamadas em produção.
 * Recusar o que não está no registry, em vez de sanear em silêncio, mantém o
 * erro visível: `RunCard` já aborta a run quando esta action devolve `error`.
 */
export async function saveLlmConfig(
  projectId: string,
  config: {
    llm_provider: string;
    llm_model: string;
    llm_kwargs: Record<string, unknown>;
  }
): Promise<{ error?: string }> {
  const { llm_provider, llm_model, llm_kwargs } = config;
  if (!isProvider(llm_provider)) {
    return { error: `Provedor de LLM desconhecido: "${llm_provider}".` };
  }
  const known = getModelsForProvider(llm_provider).map((m) => m.model);
  if (!known.includes(llm_model)) {
    return {
      error:
        `O modelo "${llm_model}" não é oferecido por ${llm_provider}. ` +
        `Escolha um destes: ${known.join(", ")}.`,
    };
  }
  // Higieniza os kwargs pela mesma regra que a UI aplica ao trocar de modelo.
  // Sem isto, um `thinking_level` herdado de outro modelo sobrevive na coluna:
  // `buildKwargsForCapabilities` só roda nos handlers de troca, nunca no mount,
  // então config antiga nunca passaria por limpeza nenhuma.
  const sanitized = {
    llm_provider,
    llm_model,
    llm_kwargs: buildKwargsForCapabilities(
      llm_kwargs,
      getModelCapabilities(llm_provider, llm_model)
    ),
  };

  const supabase = await createSupabaseServer();
  try {
    await updateOrThrow(supabase, "projects", sanitized, { id: projectId }, {
      message:
        "Não foi possível salvar a configuração do LLM: sem permissão para alterar este projeto.",
    });
  } catch (e) {
    return { error: errorMessage(e) || "Erro ao salvar a configuração do LLM" };
  }
  revalidatePath(`/projects/${projectId}/llm/configure`);
  revalidatePath(`/projects/${projectId}/config`);
  return {};
}
