"use server";

import { createSupabaseServer, type SupabaseServerClient } from "@/lib/supabase/server";
import { resolveProjectMemberActor } from "@/lib/auth";
import { revalidatePath, revalidateTag } from "next/cache";
import { buildPersistedResponseSnapshot } from "@/lib/response-snapshot";
import { missingRequiredHumanFields } from "@/lib/coding-completeness";
import { syncCodingAssignmentStatus } from "@/lib/coding-sync";
import { deriveProjectVersionContext } from "@/lib/compare-version";
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";

export interface SaveResponseOpts {
  notes?: string;
  /** Rodada exibida quando o formulário foi aberto; evita salvar aba obsoleta. */
  expectedRoundId?: string;
}

export type SaveResponseResult =
  // `missingRequiredFields`: NOMES das obrigatórias ainda em branco no conjunto
  // GRAVADO (vazio = codificação completa). É a mesma avaliação que decide
  // `is_partial`, e vai ao cliente para o feedback distinguir "salvo" de
  // "concluído" (#519) e para apontar QUAL pergunta falta (#608).
  //
  // Nomes, e não uma contagem ao lado deles: `missingRequiredHumanFields` já
  // devolve os campos, e manter os dois permitiria representar contagem e lista
  // em desacordo — o tipo de divergência que a régua única de #519 existe para
  // impossibilitar. A contagem é `.length` no consumidor.
  //
  // OBRIGATÓRIA no membro de sucesso: todo save que grava avalia a régua, então
  // "gravou mas não sei o que falta" não é um estado que exista. O ramo de erro
  // de transporte do adapter `saveCodingResponse` não precisa dela porque é o
  // outro membro da união (`success: false`). Uma resposta legacy (sem schema)
  // chega aqui como lista vazia, não como ausência.
  //
  // União (não interface achatada) pelo mesmo motivo: manter irrepresentável o
  // estado `{ success: true, error }`.
  | { success: true; missingRequiredFields: string[] }
  | { success: false; error: string };

// Response já existente do mesmo respondente para o mesmo documento. `answers`
// e `answer_field_hashes` são lidos porque o save PRESERVA o que a leitura
// descartou (#484) — ver `answersToPersist` em saveResponse.
interface ExistingResponseRow {
  id: string;
  is_partial: boolean | null;
  answers: Record<string, unknown> | null;
  answer_field_hashes: AnswerFieldHashes;
}

// Fetch profile, existing response, and project config in parallel.
// O lookup de existing filtra is_latest: após uma unificação de membros o
// conjunto fundido pode ter respostas antigas (is_latest=false) no mesmo
// documento — .single() sem o filtro erraria com múltiplas linhas. Desde a
// migration 20260727120000 quem garante a linha única é o índice
// responses_one_latest_human_per_document, não este filtro.
//
// O erro DESTA leitura é propagado (existingErr), e não descartado como era
// até a #609: `existing` ausente por falha de rede/RLS levava o save a
// construir o snapshot com storedAnswers indefinido, apagando os valores
// brutos que buildPersistedResponseSnapshot preserva (#484) — e, antes do
// índice, a criar uma linha duplicada por cima.
async function fetchSaveContext(
  supabase: SupabaseServerClient,
  projectId: string,
  documentId: string,
  effectiveId: string,
  expectedRoundId?: string,
) {
  let existingQuery = supabase
    .from("responses")
    .select("id, is_partial, answers, answer_field_hashes")
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .eq("respondent_id", effectiveId)
    .eq("respondent_type", "humano");
  if (expectedRoundId) existingQuery = existingQuery.eq("round_id", expectedRoundId);

  const [
    { data: profile },
    { data: existing, error: existingErr },
    { data: project, error: projErr },
    { data: doc },
  ] = await Promise.all([
    supabase
      .from("profiles")
      .select("first_name, last_name")
      .eq("id", effectiveId)
      .single(),
    existingQuery
      .eq("is_latest", true)
      .maybeSingle<ExistingResponseRow>(),
    supabase
      .from("projects")
      .select(
        "pydantic_hash, pydantic_fields, schema_version_major, schema_version_minor, schema_version_patch, current_round_id, automation_mode",
      )
      .eq("id", projectId)
      .single(),
    supabase
      .from("documents")
      .select("excluded_at")
      .eq("id", documentId)
      .eq("project_id", projectId)
      .maybeSingle(),
  ]);
  return { profile, existing, existingErr, project, projErr, doc };
}

interface SaveResponseProjectFields {
  pydantic_hash: string | null;
  schema_version_major: number | null;
  schema_version_minor: number | null;
  schema_version_patch: number | null;
  current_round_id: string | null;
}

interface BuildResponsePayloadParams {
  /** Régua de completude já aplicada ao conjunto a gravar — ver `saveResponse`. */
  codingIsComplete: boolean;
  answersToPersist: Record<string, unknown>;
  answerFieldHashes: Exclude<AnswerFieldHashes, null>;
  stampsCurrentSchema: boolean;
  project: SaveResponseProjectFields | null | undefined;
  existing: { is_partial: boolean | null } | null | undefined;
  notes?: string;
}

// Decide as colunas de versão (`pydantic_hash`, `schema_version_*`,
// `version_inferred_from`) a gravar. Devolve `{}` — omitindo-as do UPDATE, o que
// PRESERVA os valores já na linha — quando este save não gravou proveniência do
// schema de hoje no mapa per-campo (`!stampsCurrentSchema`). Só vale para UPDATE:
// numa codificação nova (`!existing`) não há proveniência anterior a preservar.
//
// `stampsCurrentSchema` (de `buildPersistedResponseSnapshot`) é o sinal ÚNICO da
// decisão, o mesmo que governa o mapa per-campo — as colunas ficam simétricas ao
// mapa por construção, e não por dois gatilhos mantidos em acordo. Ele é falso, e
// as colunas são preservadas, em dois casos que antes tinham tratamento separado:
//
// 1. STALENESS (legacy, #520/#528/#548). Enquanto a response conserva o sentinela
//    legacy (`answer_field_hashes` vazio), `isFieldStale` cai no fallback do
//    schema INTEIRO e compara `pydantic_hash`. Promovê-lo aqui tornaria o fallback
//    permissivo — a codificação antiga seria lida como feita contra o schema de
//    hoje e nada apareceria stale, reintroduzindo o falso "(vazio)" divergente de
//    answer-staleness.ts. O sentinela só desliga (e `stampsCurrentSchema` fica
//    true) quando um submit explícito RECODIFICA a legacy por completo contra o
//    schema atual (#548) — aí o staleness ser permissivo é o correto, porque tudo
//    foi de fato recodificado.
//
// 2. SEMÂNTICA DE VERSÃO (#529). Numa response não-legacy sem revisão real de
//    valor (auto-save/toque por navegação, ou re-confirmar o mesmo valor), nenhum
//    campo ganha o hash de hoje: os valores seguem da época anterior e o mapa
//    per-campo (#528) já os conserva. Promover só as colunas deixaria a linha
//    assimétrica — hashes de época × versão de hoje — e a faria contar como da
//    versão corrente no gate `latest_major` da Comparação sem revisão alguma.
//
// Custo assumido (#548): preservar prende a linha fora do gate `latest_major` até
// que ela seja de fato recodificada. É o comportamento desejado — uma codificação
// não revisada sob o novo schema não deve contar como da versão nova. A raiz é
// `pydantic_hash` servir a dois consumidores opostos: o staleness quer o hash da
// época, o gate de versão quer o de hoje; os dois só coincidem na recodificação
// completa, e é exatamente aí que `stampsCurrentSchema` vira true.
function resolveSchemaProvenance({
  project,
  stampsCurrentSchema,
  existing,
}: Pick<BuildResponsePayloadParams, "project" | "stampsCurrentSchema" | "existing">) {
  if (!!existing && !stampsCurrentSchema) return {};
  // O fallback {major 0, minor 1, patch 0} é canônico e vive uma única vez em
  // `deriveProjectVersionContext` — reusá-lo evita a duplicação que o cabeçalho
  // de compare-version.ts sinaliza como load-bearing (uma cópia "corrigida" para
  // minor 0 aqui dessincronizaria a fila/fecho da Comparação). O `ctx.pydanticHash`
  // do MESMO helper é `pydantic_hash ?? null`, então hash e versão vêm de uma
  // fonte única — não re-derivar o hash à parte.
  const { version, ctx } = deriveProjectVersionContext(project ?? {});
  return {
    pydantic_hash: ctx.pydanticHash,
    schema_version_major: version.major,
    schema_version_minor: version.minor,
    schema_version_patch: version.patch,
    version_inferred_from: "live_save",
  };
}

function buildResponsePayload({
  codingIsComplete,
  answersToPersist,
  answerFieldHashes,
  stampsCurrentSchema,
  project,
  existing,
  notes,
}: BuildResponsePayloadParams) {
  const justifications = notes ? { _notes: notes } : null;

  const roundIdToPersist = project?.current_round_id ?? null;

  // Para humanos is_partial descreve O QUE FOI GRAVADO: uma resposta só deixa
  // de ser parcial quando o conjunto gravado satisfaz a régua de completude.
  // Enquanto o sinal era função do canal de escrita
  // (`isAutoSave && existing?.is_partial !== false`), um auto-save herdava o
  // `false` de um submit anterior e podia carimbar "submetida" um conjunto que
  // já não estava completo — o estado que fazia o documento voltar à fila com
  // aparência de concluído (#519). Removido o auto-save (#608), o canal deixou
  // de existir como variável: toda escrita é submit explícito, e o conjunto
  // gravado é a condição inteira.
  //
  // `codingIsComplete` chega pronto de `buildSaveWrite`, da MESMA avaliação que
  // produz o `missingRequiredFields` devolvido ao cliente: o sinal gravado no
  // banco e o que o pesquisador lê no toast não podem discordar, e derivá-los de uma
  // avaliação só torna isso verdade por construção, não por acordo entre dois
  // call sites. A régua (staleness-aware contra o carimbo per-campo, para que um
  // campo obrigatório criado depois não rebaixe codificação completa à época)
  // vive em coding-completeness, onde está documentada.
  //
  // Um submit que encolhe o conjunto rebaixa `is_partial` de volta a `true`,
  // mas NÃO rebaixa `assignment.status = "concluido"` — quem sustenta isso é o
  // guard de `keepCodingAssignmentInProgress` (coding-sync). A imutabilidade
  // descrita na migration 20260425000000 vale só para o fluxo LLM.
  const isPartialToWrite = !codingIsComplete;

  const payload = {
    answers: answersToPersist,
    justifications,
    answer_field_hashes: answerFieldHashes,
    ...resolveSchemaProvenance({ project, stampsCurrentSchema, existing }),
    round_id: roundIdToPersist,
    is_partial: isPartialToWrite,
    // Marca a codificacao do pesquisador no tempo — alimenta a ordenacao
    // "codificados recentemente" da navegacao da aba Codificar (issue #108).
    updated_at: new Date().toISOString(),
  };

  return payload;
}

interface PersistResponseRowParams {
  supabase: SupabaseServerClient;
  projectId: string;
  documentId: string;
  effectiveId: string;
  respondentName: string;
  payload: Record<string, unknown>;
  roundId: string;
}

// "conflict" = outra sessão criou a resposta corrente entre o UPDATE e o
// INSERT desta. Não é erro do usuário: o save precisa reler e repetir.
type PersistOutcome =
  | { status: "ok" }
  | { status: "conflict" }
  | { status: "error"; error: string };

// O índice único parcial que sustenta o ramo de conflito abaixo. Conferir o
// nome é o que separa "perdi a corrida, releia" de qualquer outra violação de
// unicidade que a tabela venha a ter.
const HUMAN_LATEST_UNIQUE_INDEX = "responses_one_latest_human_per_document";

// Escrita idempotente sobre a CHAVE LÓGICA (#609). O UPDATE filtra pela chave
// — não por `id` — e o rowcount que ele devolve é quem decide se havia linha
// corrente; a leitura de `existing` deixou de ser o árbitro dessa decisão e
// serve só como insumo do snapshot. A diferença importa porque a leitura
// acontece em outra transação: entre ela e a escrita, a linha pode ter nascido
// ou sido demovida.
//
// Não dá para usar `.upsert({ onConflict })`: o Postgres exige que a
// inferência do arbiter reproduza o predicado do índice parcial
// (`ON CONFLICT (...) WHERE ...`), e o `on_conflict` do PostgREST só transporta
// a lista de colunas. `ON CONFLICT ON CONSTRAINT` também está fora — índice
// parcial não é constraint. Verificado por EXPLAIN contra o índice parcial do
// lado LLM: sem o predicado o Postgres responde "there is no unique or
// exclusion constraint matching the ON CONFLICT specification".
async function persistResponseRow({
  supabase,
  projectId,
  documentId,
  effectiveId,
  respondentName,
  payload,
  roundId,
}: PersistResponseRowParams): Promise<PersistOutcome> {
  // O payload não toca coluna-chave, então este UPDATE não dispara
  // enforce_comparison_response_actor_trigger, que só observa project_id,
  // document_id, respondent_id, respondent_type e is_latest.
  const { data: updated, error: updErr } = await supabase
    .from("responses")
    .update(payload)
    .eq("project_id", projectId)
    .eq("document_id", documentId)
    .eq("respondent_id", effectiveId)
    .eq("respondent_type", "humano")
    .eq("round_id", roundId)
    .eq("is_latest", true)
    .select("id");
  if (updErr) return { status: "error", error: updErr.message };
  if (updated && updated.length > 0) return { status: "ok" };

  const { error: insErr } = await supabase.from("responses").insert({
    project_id: projectId,
    document_id: documentId,
    respondent_id: effectiveId,
    respondent_type: "humano",
    respondent_name: respondentName,
    is_latest: true,
    ...payload,
  });
  if (!insErr) return { status: "ok" };
  if (
    insErr.code === "23505" &&
    insErr.message.includes(HUMAN_LATEST_UNIQUE_INDEX)
  ) {
    return { status: "conflict" };
  }
  return { status: "error", error: insErr.message };
}

// Propaga o efeito do envio para as telas que leem a mesma resposta —
// Comparação, Revisões e o progresso do projeto. Até o #608 o auto-save pulava
// esta função inteira (para não re-buscar o servidor a cada troca de aba, com o
// flicker que isso trazia ao formulário); sem ele, todo save revalida.
function revalidateAfterSave(projectId: string): void {
  revalidatePath(`/projects/${projectId}/analyze/code`);
  revalidatePath(`/projects/${projectId}/analyze/compare`);
  revalidatePath(`/projects/${projectId}/analyze/auto-revisao`);
  revalidatePath(`/projects/${projectId}/analyze/arbitragem`);
  revalidatePath(`/projects/${projectId}/reviews`);
  revalidateTag(`project-${projectId}-progress`, { expire: 60 });
}

interface BuildSaveWriteParams {
  fields: PydanticField[];
  existing: ExistingResponseRow | null | undefined;
  project: SaveResponseProjectFields | null | undefined;
  answers: Record<string, unknown>;
  notes?: string;
}

// Tudo que é derivado do que está gravado AGORA: o snapshot reconciliado, a
// contagem de obrigatórias faltando e o payload. Separado da tentativa porque
// é puro — e porque o retry precisa refazer exatamente estes três a partir da
// releitura, nunca reaproveitar os da tentativa anterior.
function buildSaveWrite({
  fields,
  existing,
  project,
  answers,
  notes,
}: BuildSaveWriteParams) {
  // O formulário devolve um snapshot sanitizado, não um patch. A reconciliação
  // compara esse snapshot com a projeção que foi apresentada e preserva o
  // valor bruto + sua proveniência quando o campo não mudou (#484).
  const snapshot = buildPersistedResponseSnapshot({
    fields,
    existing: existing
      ? { answers: existing.answers, hashes: existing.answer_field_hashes }
      : null,
    rawSubmittedAnswers: answers,
  });

  // Régua de completude aplicada UMA vez, ao conjunto que vai ser gravado
  // (`snapshot.persistedAnswers`) e com o carimbo per-campo da própria escrita —
  // não ao que a tela mostrava. Dela saem os dois consumidores: o `is_partial`
  // gravado e a lista devolvida ao cliente. Se o schema mudou desde o
  // carregamento do formulário, é esta avaliação que impede o feedback de
  // sucesso de anunciar uma conclusão que não houve (#519), e é dela que sai o
  // nome da pergunta até a qual a tela leva a pesquisadora (#608).
  const missingRequiredFields = missingRequiredHumanFields(
    fields,
    snapshot.persistedAnswers,
    snapshot.answerFieldHashes,
  ).map((f) => f.name);

  const payload = buildResponsePayload({
    codingIsComplete: missingRequiredFields.length === 0,
    answersToPersist: snapshot.persistedAnswers,
    answerFieldHashes: snapshot.answerFieldHashes,
    stampsCurrentSchema: snapshot.stampsCurrentSchema,
    project,
    existing,
    notes,
  });

  return { snapshot, missingRequiredFields, payload };
}

// Os motivos para não gravar, avaliados antes de montar qualquer payload.
// Nenhum deles depende do que foi digitado — só do estado do projeto, da
// leitura da resposta corrente e do documento.
function rejectedSaveContext({
  projErr,
  existingErr,
  doc,
}: {
  projErr: { message: string } | null;
  existingErr: { message: string } | null;
  doc: { excluded_at: string | null } | null;
}): SaveResponseResult | null {
  if (projErr) return { success: false, error: projErr.message };

  // Falha ao LER a resposta corrente aborta o save. Seguir como se não
  // existisse gravaria por cima dela um snapshot construído sem os valores
  // preservados (#484) — perda silenciosa, sem rastro. Falhar fechado aqui é
  // o que a #609 corrige junto com o índice.
  if (existingErr) return { success: false, error: existingErr.message };

  // Doc já excluído (soft delete) não aceita mais respostas. Pedido de
  // exclusão apenas PENDENTE não bloqueia: é reversível e o dado humano
  // digitado é preservado.
  if (doc?.excluded_at) {
    return { success: false, error: "Documento removido do escopo do projeto" };
  }

  return null;
}

interface SaveAttemptParams {
  supabase: SupabaseServerClient;
  projectId: string;
  documentId: string;
  effectiveId: string;
  userEmail: string;
  answers: Record<string, unknown>;
  notes?: string;
  expectedRoundId?: string;
}

// Uma tentativa completa de gravação: lê o contexto, monta o snapshot a partir
// do que está gravado AGORA e persiste. Devolve "conflict" quando outra sessão
// criou a resposta corrente no meio do caminho.
//
// A releitura do contexto faz parte da tentativa de propósito. No retry, o
// payload da tentativa anterior foi montado com `existing` ausente (foi por
// isso que ela caiu no INSERT); reaplicá-lo sobrescreveria os `answers` e
// `answer_field_hashes` que a linha vencedora acabou de gravar — exatamente a
// proveniência bruta que buildPersistedResponseSnapshot existe para preservar
// (#484). `is_partial` e `hadCompletedResponse` também dependem do que foi
// lido, e mudam junto.
async function runSaveAttempt({
  supabase,
  projectId,
  documentId,
  effectiveId,
  userEmail,
  answers,
  notes,
  expectedRoundId,
}: SaveAttemptParams): Promise<SaveResponseResult | { conflict: true }> {
  const { profile, existing, existingErr, project, projErr, doc } =
    await fetchSaveContext(
      supabase,
      projectId,
      documentId,
      effectiveId,
      expectedRoundId,
    );

  const rejection = rejectedSaveContext({ projErr, existingErr, doc });
  if (rejection) return rejection;

  if (!project?.current_round_id) {
    return { success: false, error: "O projeto não possui uma rodada atual." };
  }
  if (expectedRoundId && project.current_round_id !== expectedRoundId) {
    return {
      success: false,
      error: "A rodada mudou enquanto este formulário estava aberto. Recarregue a página.",
    };
  }

  const respondentName = resolveRespondentName(profile, userEmail);

  const fields = (project?.pydantic_fields as PydanticField[]) || [];
  const { snapshot, missingRequiredFields, payload } = buildSaveWrite({
    fields,
    existing,
    project,
    answers,
    notes,
  });

  const outcome = await persistResponseRow({
    supabase,
    projectId,
    documentId,
    effectiveId,
    respondentName,
    payload,
    roundId: project.current_round_id,
  });
  if (outcome.status === "error")
    return { success: false, error: outcome.error };
  if (outcome.status === "conflict") return { conflict: true };

  const syncErr = await syncAssignmentAfterSave({
    supabase,
    projectId,
    documentId,
    effectiveId,
    fields,
    project,
    existing,
    snapshot,
    roundId: project.current_round_id,
  });
  if (syncErr) return { success: false, error: syncErr };

  revalidateAfterSave(projectId);
  return { success: true, missingRequiredFields };
}

// Propaga a gravação para a fila de codificação. Projeto sem schema não tem
// fila a sincronizar, e é o único caso em que o sync é pulado.
async function syncAssignmentAfterSave({
  supabase,
  projectId,
  documentId,
  effectiveId,
  fields,
  project,
  existing,
  snapshot,
  roundId,
}: {
  supabase: SupabaseServerClient;
  projectId: string;
  documentId: string;
  effectiveId: string;
  fields: PydanticField[];
  project: { automation_mode?: string | null } | null | undefined;
  existing: { is_partial: boolean | null } | null | undefined;
  snapshot: { submittedAnswers: Record<string, unknown> };
  roundId: string;
}): Promise<string | undefined> {
  if (fields.length === 0) return undefined;
  const { error } = await syncCodingAssignmentStatus(supabase, {
    projectId,
    documentId,
    userId: effectiveId,
    fields,
    sanitizedAnswers: snapshot.submittedAnswers,
    automationMode: project?.automation_mode,
    // Lido ANTES da escrita: distingue "já estava concluída" de "concluiu
    // agora", que é o que impede o rebaixamento descrito em
    // buildResponsePayload.
    hadCompletedResponse: existing?.is_partial === false,
    roundId,
  });
  return error;
}

// Nome exibido como autoria da resposta. O e-mail é o fallback de quem ainda
// não preencheu o perfil.
function resolveRespondentName(
  profile:
    { first_name: string | null; last_name: string | null } | null | undefined,
  userEmail: string,
): string {
  return (
    [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") ||
    userEmail
  );
}

// Duas tentativas, não mais: o conflito só acontece quando outra sessão criou
// a resposta corrente entre a leitura e a escrita desta, e a segunda tentativa
// já enxerga essa linha e cai no ramo de UPDATE. Um terceiro conflito seguido
// indicaria algo além de corrida — girar em cima disso esconderia o problema
// em vez de reportá-lo.
const SAVE_ATTEMPTS = 2;

export async function saveResponse(
  projectId: string,
  documentId: string,
  answers: Record<string, unknown>,
  opts: SaveResponseOpts = {},
): Promise<SaveResponseResult> {
  const { notes, expectedRoundId } = opts;

  try {
    const actor = await resolveProjectMemberActor(projectId);
    if (!actor.ok) return { success: false, error: actor.error };
    const { user, memberUserId: effectiveId } = actor;

    const supabase = await createSupabaseServer();

    for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt++) {
      const result = await runSaveAttempt({
        supabase,
        projectId,
        documentId,
        effectiveId,
        userEmail: user.email,
        answers,
        notes,
        expectedRoundId,
      });
      if (!("conflict" in result)) return result;

      // Sinal de frequência: se isto aparecer com regularidade nos logs, a
      // corrida deixou de ser rara e o caso passa a justificar uma RPC
      // transacional no lugar do par UPDATE/INSERT.
      console.warn(
        `[saveResponse] conflito de resposta corrente (tentativa ${attempt}/${SAVE_ATTEMPTS})`,
        { projectId, documentId, respondentId: effectiveId },
      );
    }

    return {
      success: false,
      error:
        "Outra gravação desta mesma codificação chegou primeiro; tente novamente",
    };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : "Erro desconhecido",
    };
  }
}
