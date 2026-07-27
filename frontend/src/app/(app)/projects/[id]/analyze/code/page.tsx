import { Suspense } from "react";
import { createSupabaseServer } from "@/lib/supabase/server";
import {
  getProjectAccessContext,
  resolveProjectQueueIdentity,
} from "@/lib/auth";
import { requirePageAuthUser } from "@/lib/page-auth";
import { requireResolvedProjectAccess } from "@/lib/project-access";
import { CodingPage } from "@/components/coding/CodingPage";
import { sanitizeStoredAnswers } from "@/lib/response-snapshot";
import type {
  Document,
  Assignment,
  PydanticField,
  Round,
  RoundStrategy,
} from "@/lib/types";
import {
  classifyDocStatus,
  versionLabel,
  getCurrentRoundDescriptor,
  compareVersionLabels,
  resolveRoundFilter,
  CURRENT_FILTER_VALUE,
  type RoundContext,
  type ResponseRoundFields,
  type SchemaVersion,
} from "@/lib/rounds";

export default async function CodePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ viewAsUser?: string; round?: string }>;
}) {
  const [{ id }, sp, user] = await Promise.all([
    params,
    searchParams,
    requirePageAuthUser(),
  ]);

  // Impersonação master (viewAsUser) tem precedência; sem ela, contas
  // vinculadas trabalham como o membro canônico do projeto (spec 002).
  // resolveProjectQueueIdentity é a fonte única dessa precedência, compartilhada
  // com Comparação e Arbitragem.
  const access = requireResolvedProjectAccess(
    await getProjectAccessContext(id, user),
  );
  // `ownMemberUserId` é quem ESCREVE; `queueUserId` é só a fila exibida. O
  // rascunho local se chaveia pelo primeiro — chavear pelo observado faria o
  // master, sob impersonação, depositar trabalho no slot da pesquisadora.
  const { ownMemberUserId, queueUserId, isImpersonating } =
    resolveProjectQueueIdentity(access, sp.viewAsUser);
  const roundParam = sp.round ?? CURRENT_FILTER_VALUE;

  const supabase = await createSupabaseServer();

  const [
    { data: project },
    { data: assignments },
    { data: rounds },
    { data: pendingExclusions },
  ] = await Promise.all([
    supabase
      .from("projects")
      .select(
        "pydantic_fields, round_strategy, current_round_id, schema_version_major, schema_version_minor, schema_version_patch, out_of_scope_enabled",
      )
      .eq("id", id)
      .single(),
    supabase
      .from("assignments")
      .select("id, status, document_id, documents!inner(id, external_id, title, text)")
      .eq("project_id", id)
      .eq("user_id", queueUserId)
      .eq("type", "codificacao")
      .is("documents.excluded_at", null)
      .order("status", { ascending: true }),
    supabase
      .from("rounds")
      .select("id, project_id, label, created_at")
      .eq("project_id", id)
      .order("created_at", { ascending: true }),
    // Sinalizações "fora do escopo" pendentes do projeto: as do próprio
    // usuário mantêm o doc na fila (bloqueado, com opção de desfazer);
    // as de outros escondem o doc até o coordenador decidir.
    supabase
      .from("project_comments")
      .select("document_id, author_id, body")
      .eq("project_id", id)
      .eq("kind", "exclusion_request")
      .is("resolved_at", null)
      .is("rejected_at", null),
  ]);

  const pendingExclusionByDoc: Record<string, string> = {};
  const pendingByOthers = new Set<string>();
  for (const pc of pendingExclusions ?? []) {
    if (!pc.document_id) continue;
    // Pedidos preservam autoria da conta bruta, mas a fila é da identidade
    // canônica: o pedido criado pela conta-irmã da MESMA fila (canônica vs.
    // alias, ou o pesquisador visto sob viewAsUser) é "próprio" para efeito
    // de exibição — sem o braço queueUserId, o doc sumia da única fila do
    // membro em vez de aparecer bloqueado com opção de desfazer (regressão
    // sobre o comportamento da main, que casava o effectiveUserId).
    if (pc.author_id === user.id || pc.author_id === queueUserId) {
      pendingExclusionByDoc[pc.document_id] = pc.body as string;
    } else {
      pendingByOthers.add(pc.document_id);
    }
  }

  const allDocuments = (assignments || [])
    .map((a) => ({
      ...(a.documents as unknown as Document),
      assignment: { id: a.id, status: a.status } as Pick<Assignment, "id" | "status">,
    }))
    // Doc em revisão de escopo por OUTRO pesquisador sai da fila; com pedido
    // do próprio usuário permanece (o formulário fica bloqueado).
    .filter(
      (d) => !pendingByOthers.has(d.id) || pendingExclusionByDoc[d.id] !== undefined,
    );

  // Responses incluem agora round_id e schema_version para classificacao por rodada.
  // Filtra respondent_type=humano: respostas LLM usam respondent_id NULL, mas o
  // filtro explícito alinha com saveResponse e protege contra colisões futuras.
  const docIds = allDocuments.map((d) => d.id);
  const { data: responses } = await supabase
    .from("responses")
    .select(
      "document_id, answers, justifications, round_id, schema_version_major, schema_version_minor, schema_version_patch, is_partial, updated_at",
    )
    .eq("project_id", id)
    .eq("respondent_id", queueUserId)
    .eq("respondent_type", "humano")
    .in("document_id", docIds.length > 0 ? docIds : ["__none__"]);

  const responseByDoc = new Map<
    string,
    ResponseRoundFields & {
      answers: Record<string, unknown>;
      justifications: Record<string, unknown> | null;
    }
  >();
  responses?.forEach((r) => {
    responseByDoc.set(r.document_id, {
      answers: (r.answers as Record<string, unknown>) ?? {},
      justifications: (r.justifications as Record<string, unknown> | null) ?? null,
      round_id: r.round_id,
      schema_version_major: r.schema_version_major,
      schema_version_minor: r.schema_version_minor,
      schema_version_patch: r.schema_version_patch,
      is_partial: r.is_partial,
    });
  });

  // Quando o pesquisador codificou cada documento (responses.updated_at) —
  // alimenta a ordenacao "codificados recentemente" da navegacao (issue #108).
  const codedAtByDoc: Record<string, string> = {};
  responses?.forEach((r) => {
    if (r.updated_at) codedAtByDoc[r.document_id] = r.updated_at;
  });

  const currentVersion: SchemaVersion = {
    major: project?.schema_version_major ?? 0,
    minor: project?.schema_version_minor ?? 1,
    patch: project?.schema_version_patch ?? 0,
  };
  const strategy: RoundStrategy =
    (project?.round_strategy as RoundStrategy) ?? "schema_version";
  const ctx: RoundContext = {
    strategy,
    currentRoundId: project?.current_round_id ?? null,
    currentVersion,
    rounds: (rounds ?? []) as Round[],
  };
  const roundsById = new Map(ctx.rounds.map((r) => [r.id, r]));

  // Versoes anteriores presentes em responses — so faz sentido em schema_version.
  // Em manual, o select de rodadas anteriores vem da tabela `rounds`.
  // Sort numerico (compareVersionLabels) para ordenar 0.9.0 < 0.10.0 corretamente.
  const previousVersions =
    strategy === "schema_version"
      ? Array.from(
          new Set(
            (responses ?? [])
              .map((r) => {
                const m = r.schema_version_major;
                const n = r.schema_version_minor;
                const p = r.schema_version_patch;
                if (m == null || n == null || p == null) return null;
                const v = versionLabel({ major: m, minor: n, patch: p });
                if (v === versionLabel(currentVersion)) return null;
                return v;
              })
              .filter((v): v is string => v != null),
          ),
        ).sort(compareVersionLabels)
      : [];

  const { key: currentRoundKey, label: currentRoundLabel } =
    getCurrentRoundDescriptor(ctx, roundsById);

  // Normaliza ?round= para evitar lista vazia silenciosa (URL manipulada,
  // troca de estrategia com filtro stale, ou ?round=<currentRoundKey>).
  const effectiveRound = resolveRoundFilter(
    roundParam,
    ctx,
    currentRoundKey,
    previousVersions,
  );

  // Filtro server-side conforme effectiveRound
  const filteredDocuments = allDocuments.filter((d) => {
    const resp = responseByDoc.get(d.id);
    const status = classifyDocStatus(ctx, resp ?? null, roundsById);

    if (effectiveRound === "all") return true;
    if (effectiveRound === CURRENT_FILTER_VALUE) {
      // Padrao: mostra docs que ainda precisam ser respondidos na rodada atual
      // (sem resposta OU resposta de rodada anterior). Concluidos da atual saem.
      return status.kind !== "current_done";
    }
    // Rodada especifica: id (manual) ou label (schema_version)
    if (strategy === "manual") {
      return resp?.round_id === effectiveRound;
    }
    return (
      status.kind === "previous" && status.label === effectiveRound
    );
  });

  const allFields = (project?.pydantic_fields || []) as PydanticField[];
  const fields = allFields.filter(
    (f) => f.target !== "llm_only" && f.target !== "none",
  );
  const existingAnswers: Record<string, Record<string, unknown>> = {};
  const existingJustifications: Record<string, Record<string, unknown>> = {};
  for (const d of filteredDocuments) {
    const r = responseByDoc.get(d.id);
    if (!r) continue;
    // Fronteira de leitura do modo Atribuídos — mesma primitiva do modo
    // Explorar (getDocumentForCoding), que lê o mesmo dado por outro caminho.
    existingAnswers[d.id] = sanitizeStoredAnswers(allFields, r.answers);
    if (r.justifications) {
      existingJustifications[d.id] = r.justifications;
    }
  }

  // Quando filtra por rodada anterior, painel fica readOnly para evitar
  // que pesquisador edite achando que ainda esta na rodada antiga.
  // (Salvar promove para a rodada atual de qualquer jeito.)
  const isViewingPreviousRound =
    effectiveRound !== CURRENT_FILTER_VALUE && effectiveRound !== "all";

  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Carregando…</div>}>
      <CodingPage
        projectId={id}
        userId={ownMemberUserId}
        documents={filteredDocuments}
        codedAtByDoc={codedAtByDoc}
        fields={fields}
        existingAnswers={existingAnswers}
        existingJustifications={existingJustifications}
        hasAssignments={allDocuments.length > 0}
        canRunLlm={access.isCoordinator}
        outOfScopeEnabled={project?.out_of_scope_enabled ?? true}
        pendingExclusionByDoc={pendingExclusionByDoc}
        readOnly={isImpersonating || isViewingPreviousRound}
        roundFilter={{
          strategy,
          currentRoundKey,
          currentRoundLabel,
          rounds: ctx.rounds,
          previousVersions,
          selected: effectiveRound,
        }}
      />
    </Suspense>
  );
}
