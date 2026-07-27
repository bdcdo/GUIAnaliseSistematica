/**
 * check-invariants.ts — asserções de consistência READ-ONLY contra o banco.
 *
 * Verifica ESTADO, não código: pega drift que nenhum gate estático vê (dado
 * inconsistente deixado por corrida, script de manutenção ou canal de escrita
 * que contorna uma regra da UI). Rodar: `npm run invariants` (cwd frontend/;
 * o alias @/ do import de coding-completeness resolve pelo tsconfig daqui).
 * Precisa de NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY no
 * .env.local (ou SUPABASE_ENV_PATH). Só SELECTs; um FAIL é evidência para
 * investigação — nunca gatilho de correção automática de dado.
 *
 * Quando rodar: após mudança em write path de codificação/comparação, após
 * migration aplicada no remoto, e ao investigar relato de "não salvou".
 *
 * Cada invariante nomeia o bug histórico que a motivou — se ela falhar, a
 * regressão é da mesma família. Origem: diagnóstico de 2026-07-23, em que a
 * primeira execução (então em harness local) encontrou 4 codificações
 * completas presas em "em_andamento" após o dedup de documentos de 2026-06-23.
 */

import { createClient } from "@supabase/supabase-js";
import { isCodingComplete } from "@/lib/coding-completeness";
import {
  buildTimelineFromPersistedVersions,
  type PersistedLogEntryRow,
} from "@/lib/schema-backfill";
import { computeFieldHash } from "@/lib/schema-utils";
import type { AnswerFieldHashes, PydanticField } from "@/lib/types";
import { loadEnv } from "../comentarios-relatorio/load-env";

loadEnv();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "Faltam NEXT_PUBLIC_SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY (frontend/.env.local ou SUPABASE_ENV_PATH).",
  );
  process.exit(2);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

// Paginação manual: PostgREST corta em 1000 linhas por default; sem isso uma
// tabela grande passaria "limpa" por truncamento silencioso. `responses`,
// `assignments` e `reviews` já cruzam a página, então este caminho roda sempre.
//
// O `.order("id")` é requisito da paginação, não estética: sem ORDER BY o
// Postgres não garante a mesma ordem entre a consulta da página 1 e a da
// página 2, e as duas quebras conhecidas produzem FALSO POSITIVO, o pior
// resultado possível aqui (a regra do framework é "FAIL vira issue no mesmo
// dia"). Uma linha pulada entre páginas some do mapa `docOf` e vira
// "chosen_response de doc INEXISTENTE"; uma linha lida duas vezes vira
// "2 responses is_latest: X, X", com o mesmo id repetido. Medido em
// 2026-07-23: 15 passadas sem ORDER BY devolveram o conjunto completo — hoje a
// leitura cai em seq scan de tabela pequena e quiescente, cuja ordem física é
// estável na prática. É hazard latente, não defeito ativo: passa a morder sob
// UPDATE concorrente (que move a versão da linha) — justamente o cenário de
// rodar o checker enquanto pesquisadores codificam — e quando a tabela crescer
// o bastante para o synchronize_seqscans fazer varreduras concorrentes
// começarem em posições diferentes.
//
// O builder fica `any` de propósito: o PostgrestFilterBuilder muda de tipo a
// cada método encadeado e, num helper genérico por nome de tabela, o tsc
// estoura em TS2589 (instanciação excessivamente profunda) antes de qualquer
// checagem útil. A tipagem do resultado vem do parâmetro T de cada chamada.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UntypedSelectBuilder = any;

async function fetchAll<T>(
  table: string,
  columns: string,
  filter?: (q: UntypedSelectBuilder) => UntypedSelectBuilder,
): Promise<T[]> {
  const PAGE = 1000;
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    let q: UntypedSelectBuilder = supabase
      .from(table)
      .select(columns)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) return rows;
  }
}

// Documentos soft-deletados ficam fora das invariantes de fila/status: o dedup
// de 2026-06 deixa de propósito, na cópia excluída, linhas que conflitariam
// com UNIQUE na sobrevivente (ver pipeline-processos/dedup, local). Elas são
// inertes — a UI não as mostra — e não são violação.
async function activeDocIds(): Promise<Set<string>> {
  const docs = await fetchAll<{ id: string }>("documents", "id", (q) => q.is("excluded_at", null));
  return new Set(docs.map((d) => d.id));
}

type Violation = { key: string; detail: string };
type Invariant = { name: string; motivation: string; run: () => Promise<Violation[]> };

const invariants: Invariant[] = [
  {
    name: "responses-is-latest-unica",
    motivation:
      "invariante dos índices responses_one_latest_human_per_document (#609) e responses_one_latest_llm_per_document; até a #609 a regra humana vivia só na aplicação, e a família de duplicatas por corrida/re-import (#490, dedup Zolgensma) nascia daí. FAIL aqui deixou de ser 'mais uma corrida': é índice dropado ou canal de escrita que o contorna",
    run: async () => {
      const rows = await fetchAll<{
        id: string;
        document_id: string;
        respondent_type: string;
        respondent_id: string | null;
        respondent_name: string | null;
      }>(
        "responses",
        "id, document_id, respondent_type, respondent_id, respondent_name",
        (q) => q.eq("is_latest", true),
      );
      const byKey = new Map<string, string[]>();
      for (const r of rows) {
        const key = `${r.document_id}|${r.respondent_type}|${r.respondent_id ?? r.respondent_name ?? "?"}`;
        byKey.set(key, [...(byKey.get(key) ?? []), r.id]);
      }
      return [...byKey.entries()]
        .filter(([, ids]) => ids.length > 1)
        .map(([key, ids]) => ({ key, detail: `${ids.length} responses is_latest: ${ids.join(", ")}` }));
    },
  },
  {
    name: "comparacao-ativa-unica-por-documento",
    motivation:
      "invariante do índice assignments_one_active_comparacao_per_doc (#490/PR #496); FAIL aqui = índice dropado ou canal de escrita que o contorna",
    run: async () => {
      const rows = await fetchAll<{ id: string; document_id: string; status: string | null }>(
        "assignments",
        "id, document_id, status",
        (q) => q.eq("type", "comparacao"),
      );
      // inclui status NULL, como o predicado IS DISTINCT FROM do índice
      const active = rows.filter((r) => r.status !== "concluido");
      const byDoc = new Map<string, string[]>();
      for (const r of active) byDoc.set(r.document_id, [...(byDoc.get(r.document_id) ?? []), r.id]);
      return [...byDoc.entries()]
        .filter(([, ids]) => ids.length > 1)
        .map(([doc, ids]) => ({ key: doc, detail: `${ids.length} comparações ativas: ${ids.join(", ")}` }));
    },
  },
  {
    name: "review-chosen-response-do-mesmo-documento",
    motivation:
      "FK garante existência mas não coerência: chosen_response_id apontando para response de OUTRO documento é corrupção silenciosa do write path (família #425/#427 de identidade trocada)",
    run: async () => {
      const [reviews, responses] = await Promise.all([
        fetchAll<{ id: string; document_id: string; chosen_response_id: string | null }>(
          "reviews",
          "id, document_id, chosen_response_id",
          (q) => q.not("chosen_response_id", "is", null),
        ),
        fetchAll<{ id: string; document_id: string }>("responses", "id, document_id"),
      ]);
      const docOf = new Map(responses.map((r) => [r.id, r.document_id]));
      return reviews
        .filter((rv) => docOf.get(rv.chosen_response_id!) !== rv.document_id)
        .map((rv) => ({
          key: rv.id,
          detail: `review do doc ${rv.document_id} escolheu response do doc ${docOf.get(rv.chosen_response_id!) ?? "INEXISTENTE"}`,
        }));
    },
  },
  {
    name: "codificacao-concluida-tem-response",
    motivation:
      "discriminador escrita-vs-exibição (#425): assignment de codificação 'concluido' em doc ATIVO sem response humana do mesmo usuário = ou escrita perdida, ou status gravado por canal que não exige response",
    run: async () => {
      const active = await activeDocIds();
      const [assignments, responses] = await Promise.all([
        fetchAll<{ id: string; document_id: string; user_id: string }>(
          "assignments",
          "id, document_id, user_id",
          (q) => q.eq("type", "codificacao").eq("status", "concluido"),
        ),
        fetchAll<{ document_id: string; respondent_id: string | null }>(
          "responses",
          "document_id, respondent_id",
          (q) => q.eq("respondent_type", "humano"),
        ),
      ]);
      const has = new Set(responses.map((r) => `${r.document_id}|${r.respondent_id}`));
      return assignments
        .filter((a) => active.has(a.document_id) && !has.has(`${a.document_id}|${a.user_id}`))
        .map((a) => ({ key: a.id, detail: `assignment concluído sem response (doc ${a.document_id}, user ${a.user_id})` }));
    },
  },
  {
    name: "codificacao-completa-marcada-pendente",
    motivation:
      "inversa da anterior — o sintoma que o pesquisador vê como 'não salvou' (caso Naomi/dedup 2026-07-23): response submetida (is_partial=false) e completa pelo critério real do produto (isCodingComplete), em doc ativo, com assignment != concluido. Foi o estado deixado pelo dedup nos 4 casos reparados em 2026-07-23",
    run: async () => {
      const active = await activeDocIds();
      const [projects, responses, assignments] = await Promise.all([
        fetchAll<{ id: string; pydantic_fields: PydanticField[] | null }>("projects", "id, pydantic_fields"),
        fetchAll<{ id: string; project_id: string; document_id: string; respondent_id: string | null }>(
          "responses",
          "id, project_id, document_id, respondent_id",
          (q) => q.eq("respondent_type", "humano").eq("is_latest", true).eq("is_partial", false),
        ),
        fetchAll<{ document_id: string; user_id: string; status: string | null }>(
          "assignments",
          "document_id, user_id, status",
          (q) => q.eq("type", "codificacao"),
        ),
      ]);
      const fieldsOf = new Map(projects.map((p) => [p.id, p.pydantic_fields ?? []]));
      const statusOf = new Map(assignments.map((a) => [`${a.document_id}|${a.user_id}`, a.status]));

      // Fase 1 (metadados leves): candidato = doc ativo + assignment existente não-concluído.
      const candidates = responses.filter((r) => {
        if (!active.has(r.document_id)) return false;
        const st = statusOf.get(`${r.document_id}|${r.respondent_id}`);
        return st !== undefined && st !== "concluido";
      });

      // Fase 2 (campos pesados só dos candidatos): answers/hashes para o replay
      // da regra real de completude do produto — a mesma que gateia o submit.
      // Em lote, não uma consulta por candidato. O bloco é pequeno porque o
      // filtro `in` viaja na query string e cada id é um UUID de 36 caracteres:
      // com 500 a URL passa de 18 mil chars e o fetch falha (medido em
      // 2026-07-23, mutando o filtro de candidatos para exercitar este caminho).
      // 100 ids ≈ 3,7 kB de URL, com folga confortável.
      const CHUNK = 100;
      const heavyOf = new Map<
        string,
        { answers: unknown; answer_field_hashes: unknown }
      >();
      for (let i = 0; i < candidates.length; i += CHUNK) {
        const ids = candidates.slice(i, i + CHUNK).map((c) => c.id);
        const { data, error } = await supabase
          .from("responses")
          .select("id, answers, answer_field_hashes")
          .in("id", ids);
        if (error) throw new Error(`responses(lote de ${ids.length}): ${error.message}`);
        for (const row of data ?? []) heavyOf.set(row.id as string, row);
      }

      const violations: Violation[] = [];
      for (const c of candidates) {
        const data = heavyOf.get(c.id);
        if (!data) throw new Error(`responses(${c.id}): sumiu entre as duas fases`);
        const fields = fieldsOf.get(c.project_id) ?? [];
        if (
          fields.length > 0 &&
          isCodingComplete(
            fields,
            (data.answers ?? {}) as Record<string, unknown>,
            (data.answer_field_hashes ?? undefined) as AnswerFieldHashes | undefined,
          )
        ) {
          violations.push({
            key: c.id,
            detail: `codificação completa com assignment '${statusOf.get(`${c.document_id}|${c.respondent_id}`)}' (doc ${c.document_id}, user ${c.respondent_id})`,
          });
        }
      }
      return violations;
    },
  },
  {
    name: "codificacao-concluida-response-so-rascunho",
    motivation:
      "vão entre as duas invariantes pareadas acima (#552): assignment 'concluido' em doc ATIVO cuja response humana is_latest do par nunca foi submetida (is_partial=true). 'concluida-tem-response' só vê ausência de response; 'completa-marcada-pendente' só olha response submetida (is_partial=false) — nenhuma cobre o rascunho promovido a concluído. Estado que o guard do #538 fechou na criação e do qual keepCodingAssignmentInProgress não regride; FAIL aqui = canal de escrita futuro reintroduziu o vão",
    run: async () => {
      const active = await activeDocIds();
      const [assignments, responses] = await Promise.all([
        fetchAll<{ id: string; document_id: string; user_id: string }>(
          "assignments",
          "id, document_id, user_id",
          (q) => q.eq("type", "codificacao").eq("status", "concluido"),
        ),
        fetchAll<{ document_id: string; respondent_id: string | null; is_partial: boolean | null }>(
          "responses",
          "document_id, respondent_id, is_partial",
          (q) => q.eq("respondent_type", "humano").eq("is_latest", true),
        ),
      ]);
      // is_partial da response is_latest do par (única por (doc, respondente),
      // garantida por 'responses-is-latest-unica'). Quatro estados possíveis, só
      // um é violação: `undefined` = sem is_latest humana no par → caso de
      // 'concluida-tem-response', não deste; `false` = submetida → saudável;
      // `null` = row legada sem o sinal (a coluna é nullable, ver responses.ts) →
      // cai no ramo saudável por design, conservador para não falso-positivar sem
      // prova de rascunho. Só `=== true` (rascunho, nunca enviado) é violação.
      const partialOf = new Map(
        responses.map((r) => [`${r.document_id}|${r.respondent_id}`, r.is_partial]),
      );
      return assignments
        .filter(
          (a) =>
            active.has(a.document_id) &&
            partialOf.get(`${a.document_id}|${a.user_id}`) === true,
        )
        .map((a) => ({
          key: a.id,
          detail: `assignment concluído cuja response is_latest é rascunho, nunca submetida (doc ${a.document_id}, user ${a.user_id})`,
        }));
    },
  },
  {
    name: "versao-carimbada-tem-hash-da-propria-epoca",
    motivation:
      "família #529/#573 (medição #574/#579): antes do #573, o auto-save promovia schema_version_* sem revisão. Sob o critério do #573, carimbar a versão V no save ao vivo exige revisão real sob V — que grava ao menos um hash de V em answer_field_hashes. Uma response live_save cujo carimbo não é sustentado por NENHUM hash da própria época foi promovida por canal que pulou essa regra (ou o log de versões foi reescrito sob os pés dela — também vale investigação)",
    run: async () => {
      const activeDocs = await activeDocIds();
      const projects = await fetchAll<{
        id: string;
        pydantic_fields: PydanticField[] | null;
        schema_version_major: number | null;
        schema_version_minor: number | null;
        schema_version_patch: number | null;
      }>(
        "projects",
        "id, pydantic_fields, schema_version_major, schema_version_minor, schema_version_patch",
      );
      const violations: Violation[] = [];
      for (const p of projects) {
        const fields = p.pydantic_fields ?? [];
        if (fields.length === 0) continue;
        const log = await fetchAll<PersistedLogEntryRow>(
          "schema_change_log",
          "id, field_name, before_value, after_value, created_at, change_type, version_major, version_minor, version_patch",
          (q) => q.eq("project_id", p.id),
        );
        // fetchAll pagina por id; a auditoria de ordem e a síntese do prefixo
        // em buildTimelineFromPersistedVersions exigem ordem (created_at, id).
        log.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
        if (log.length === 0) continue;
        const timeline = buildTimelineFromPersistedVersions(log, fields, {
          major: p.schema_version_major ?? 0,
          minor: p.schema_version_minor ?? 0,
          patch: p.schema_version_patch ?? 0,
        });
        // A timeline inconsistente é achado do projeto, não das responses:
        // reconstruir por cima dela produziria snapshots errados e marcaria em
        // massa linhas honestas — falso positivo, que aqui é o pior resultado.
        if (timeline.status !== "ok") {
          violations.push({ key: p.id, detail: `${timeline.status}: ${timeline.detail}` });
          continue;
        }
        const { hashesByVersion } = timeline;

        // Só `live_save` (actions/responses.ts) carimba a versão como
        // afirmação de revisão real sob ela — é o carimbo que o critério do
        // #573 governa e o único sobre o qual esta invariante tem o que dizer.
        // Os outros três valores de version_inferred_from são inferência
        // retroativa do backfill, e dois deles tornariam a asserção degenerada:
        // `hashes` escolhe a versão MAXIMIZANDO hashes que batem
        // (findBestHashMatch exige score > 0), então nunca pode violar; e
        // `fallback_created_at` é o ramo alcançado justamente porque NENHUMA
        // versão compatível pontuou, então violaria por construção — a
        // condição que ativaria esse falso positivo é rodar o Backfill pela UI
        // num projeto com hashes legados que não batem com versão alguma.
        // `created_at` foi atribuído em bloco pela migration 20260421 a tudo
        // que era NULL, e também não afirma revisão.
        const rows = await fetchAll<{
          id: string;
          document_id: string;
          answer_field_hashes: AnswerFieldHashes | null;
          schema_version_major: number;
          schema_version_minor: number | null;
          schema_version_patch: number | null;
        }>(
          "responses",
          "id, document_id, answer_field_hashes, schema_version_major, schema_version_minor, schema_version_patch",
          (q) =>
            q
              .eq("project_id", p.id)
              .eq("is_latest", true)
              .eq("version_inferred_from", "live_save")
              .not("schema_version_major", "is", null),
        );

        for (const r of rows) {
          // Mesma exclusão de documento soft-deletado das invariantes de
          // fila/status: a cópia excluída do dedup de 2026-06 carrega carimbo e
          // hashes da época e é inerte.
          if (!activeDocs.has(r.document_id)) continue;
          // Sem hash não-nulo não há evidência de época — o sentinela {} das
          // linhas legadas (#528) e mapas só-null ficam fora, não são violação.
          const nonNull = Object.entries(r.answer_field_hashes ?? {}).filter(([, h]) => h !== null);
          if (nonNull.length === 0) continue;
          const stampedKey = `${r.schema_version_major}.${r.schema_version_minor ?? 0}.${r.schema_version_patch ?? 0}`;
          const snap = hashesByVersion.get(stampedKey);
          if (!snap) {
            violations.push({
              key: r.id,
              detail: `carimbo ${stampedKey} não existe na timeline do schema_change_log`,
            });
            continue;
          }
          const epochHashes = nonNull.filter(([name, h]) => snap[name] === h).length;
          if (epochHashes === 0) {
            violations.push({
              key: r.id,
              detail: `carimbo ${stampedKey} sem nenhum hash da própria época (0/${nonNull.length})`,
            });
          }
        }
      }
      return violations;
    },
  },
  {
    name: "arbitragem-contestada-tem-assignment-aberto",
    motivation:
      "a brecha #582: contestação pendente (contesta_llm, final_verdict NULL, superseded NULL) com árbitro designado exige assignment de arbitragem NÃO-concluído do mesmo par — o outbox trocou o DO UPDATE de reabertura por DO NOTHING e a contestação nova ficava gravada mas invisível na fila (a página filtra status <> 'concluido')",
    run: async () => {
      const active = await activeDocIds();
      const [pending, assignments] = await Promise.all([
        fetchAll<{ id: string; document_id: string; arbitrator_id: string }>(
          "field_reviews",
          "id, document_id, arbitrator_id",
          (q) =>
            q
              .eq("self_verdict", "contesta_llm")
              .is("final_verdict", null)
              .is("superseded_at", null)
              .not("arbitrator_id", "is", null),
        ),
        fetchAll<{ document_id: string; user_id: string; status: string | null }>(
          "assignments",
          "document_id, user_id, status",
          (q) => q.eq("type", "arbitragem"),
        ),
      ]);
      const statusOf = new Map(assignments.map((a) => [`${a.document_id}|${a.user_id}`, a.status]));
      return pending
        .filter((fr) => {
          if (!active.has(fr.document_id)) return false;
          const st = statusOf.get(`${fr.document_id}|${fr.arbitrator_id}`);
          return st === undefined || st === "concluido";
        })
        .map((fr) => ({
          key: fr.id,
          detail: `contestação pendente com assignment ${statusOf.get(`${fr.document_id}|${fr.arbitrator_id}`) === "concluido" ? "'concluido'" : "INEXISTENTE"} (doc ${fr.document_id}, árbitro ${fr.arbitrator_id})`,
        }));
    },
  },
  {
    name: "arbitragem-aberta-tem-contestacao-pendente",
    motivation:
      "inversa da anterior (invariantes nascem em pares): assignment de arbitragem aberto em doc ativo sem NENHUMA contestação pendente daquele árbitro é fila fantasma — o árbitro vê o doc na fila, abre, e não há nada a decidir; denunciaria fecho perdido ou rotação de ciclo que resetou arbitrator_id sem sincronizar o assignment",
    run: async () => {
      const active = await activeDocIds();
      const [assignments, pending] = await Promise.all([
        fetchAll<{ id: string; document_id: string; user_id: string; status: string | null }>(
          "assignments",
          "id, document_id, user_id, status",
          (q) => q.eq("type", "arbitragem"),
        ),
        fetchAll<{ document_id: string; arbitrator_id: string }>(
          "field_reviews",
          "document_id, arbitrator_id",
          (q) =>
            q
              .eq("self_verdict", "contesta_llm")
              .is("final_verdict", null)
              .is("superseded_at", null)
              .not("arbitrator_id", "is", null),
        ),
      ]);
      const hasPending = new Set(pending.map((fr) => `${fr.document_id}|${fr.arbitrator_id}`));
      // inclui status NULL, como a invariante de comparação ativa
      return assignments
        .filter(
          (a) =>
            a.status !== "concluido" &&
            active.has(a.document_id) &&
            !hasPending.has(`${a.document_id}|${a.user_id}`),
        )
        .map((a) => ({
          key: a.id,
          detail: `assignment de arbitragem aberto sem contestação pendente (doc ${a.document_id}, árbitro ${a.user_id})`,
        }));
    },
  },
  {
    name: "submetida-mas-incompleta",
    motivation:
      "inversa fina de 'codificacao-completa-marcada-pendente' (causa (d) da auditoria de 2026-07-23): response submetida (is_partial=false) que NÃO passa na régua real do produto (isCodingComplete staleness-aware) indica canal de escrita que pulou o gate de submit — o guard existe desde 61412dc, mas nenhum estado o assere. Responses com proveniência legacy (answer_field_hashes null/{}) ficam fora: sem o mapa não dá para saber sob qual schema foram codificadas, e cobrá-las pelo schema atual fabricaria falso positivo. O corte temporal do legado recarimbado (#520) saiu em 2026-07-24, junto com o reparo que o justificava: chaves recarimbadas removidas por prova de nascimento no schema_change_log, parciais mal rotuladas rebaixadas a is_partial=true e codificações com valor perdido reabertas para recodificação — ver o desfecho da issue #584",
    run: async () => {
      const active = await activeDocIds();
      const [projects, responses] = await Promise.all([
        fetchAll<{ id: string; pydantic_fields: PydanticField[] | null }>("projects", "id, pydantic_fields"),
        fetchAll<{ id: string; project_id: string; document_id: string; respondent_id: string | null }>(
          "responses",
          "id, project_id, document_id, respondent_id",
          (q) =>
            q
              .eq("respondent_type", "humano")
              .eq("is_latest", true)
              .eq("is_partial", false),
        ),
      ]);
      const fieldsOf = new Map(projects.map((p) => [p.id, p.pydantic_fields ?? []]));
      const candidates = responses.filter(
        (r) => active.has(r.document_id) && (fieldsOf.get(r.project_id) ?? []).length > 0,
      );

      // Mesmo fetch em 2 fases (e mesmo teto de 100 ids/lote) da invariante
      // 'codificacao-completa-marcada-pendente' — ver o comentário de lá.
      const CHUNK = 100;
      const violations: Violation[] = [];
      for (let i = 0; i < candidates.length; i += CHUNK) {
        const ids = candidates.slice(i, i + CHUNK).map((c) => c.id);
        const { data, error } = await supabase
          .from("responses")
          .select("id, project_id, document_id, respondent_id, answers, answer_field_hashes")
          .in("id", ids);
        if (error) throw new Error(`responses(lote de ${ids.length}): ${error.message}`);
        for (const row of data ?? []) {
          const hashes = row.answer_field_hashes as AnswerFieldHashes | null;
          if (!hashes || Object.keys(hashes).length === 0) continue; // sentinela legacy
          const fields = fieldsOf.get(row.project_id as string) ?? [];
          if (
            !isCodingComplete(fields, (row.answers ?? {}) as Record<string, unknown>, hashes)
          ) {
            violations.push({
              key: row.id as string,
              detail: `submetida (is_partial=false) mas incompleta pela régua do produto (doc ${row.document_id}, user ${row.respondent_id})`,
            });
          }
        }
      }
      return violations;
    },
  },
  {
    name: "equivalencia-do-mesmo-documento-e-canonica",
    motivation:
      "espelho de 'review-chosen-response-do-mesmo-documento' para a família da causa (e): par de equivalência cujas responses não pertencem ao documento do par é identidade trocada; par fora da ordem canônica (a < b) escapa do UNIQUE e permite duplicata invertida. Hoje o banco torna os dois estados inconstruíveis (CHECK response_equivalences_check + trigger snapshot_response_equivalence_answers, sem isenção para postgres) — como na invariante do índice de comparação, FAIL aqui = guarda dropada por migration futura ou dado anterior às guardas. As direções par↔veredito NÃO são invariantes: auto-revisão e markLlmEquivalent criam par sem review, e review é voto independente de par — a atomicidade do desfazer é garantida pela RPC do #542 e seu teste SQL, não por estado",
    run: async () => {
      const [pairs, responses] = await Promise.all([
        fetchAll<{
          id: string;
          document_id: string;
          response_a_id: string;
          response_b_id: string;
        }>(
          "response_equivalences",
          "id, document_id, response_a_id, response_b_id",
          (q) => q.is("superseded_at", null),
        ),
        fetchAll<{ id: string; document_id: string }>("responses", "id, document_id"),
      ]);
      const docOf = new Map(responses.map((r) => [r.id, r.document_id]));
      const violations: Violation[] = [];
      for (const p of pairs) {
        const docA = docOf.get(p.response_a_id);
        const docB = docOf.get(p.response_b_id);
        if (docA !== p.document_id || docB !== p.document_id) {
          violations.push({
            key: p.id,
            detail: `par do doc ${p.document_id} referencia responses dos docs ${docA ?? "INEXISTENTE"} e ${docB ?? "INEXISTENTE"}`,
          });
        } else if (p.response_a_id >= p.response_b_id) {
          violations.push({
            key: p.id,
            detail: `par fora da ordem canônica (a=${p.response_a_id} >= b=${p.response_b_id})`,
          });
        }
      }
      return violations;
    },
  },
  {
    name: "answer-field-hashes-do-universo-do-projeto",
    motivation:
      "versão fraca-mas-honesta da causa (c) (recarimbo #520): todo hash em answer_field_hashes deve ser derivável do schema do projeto — campos atuais ou qualquer versão registrada em schema_change_log (before/after). Hash fora do universo = mapa estampado com conteúdo que nunca existiu no projeto (corrupção, cruzamento de projeto, ou re-stamp com conteúdo errado). LIMITE DOCUMENTADO: o estado exato do #520 (recarimbo com hashes do schema corrente) é indistinguível de revisão per-campo legítima — a garantia contra ele é o write path (#528/#573/#575) e seus testes, não esta invariante. Também valida o shape (12 hex minúsculos). A allowlist enumera os 6 hashes de versões do Zolgensma anteriores à criação do schema_change_log (2026-04-01), fora do universo reconstruível por definição (triagem de 2026-07-23)",
    run: async () => {
      // Versões de campo editadas antes de o schema_change_log existir não são
      // reconstruíveis — allowlist explícita e datada, não baseline silencioso.
      // Todos do projeto Zolgensma 0c6394da; campo ainda existe com hash novo.
      const PRE_LOG_LEGACY_HASHES = new Set([
        "ecbb97ef88f7", // q12_mencao_parecer_conitec (34 responses)
        "0dba9f18145a", // q6_data_nascimento_paciente (30)
        "06a656f50dcf", // q25_conclusao_evidencias (27)
        "ed1026407a89", // q21_relatorio_recomenda (7)
        "56e24ccd8992", // q25_conclusao_evidencias, outra versão (7)
        "8ec4b5335e4a", // q9_indicacao_conforme_anvisa (7)
      ]);
      const [projects, log] = await Promise.all([
        fetchAll<{ id: string; pydantic_fields: PydanticField[] | null }>("projects", "id, pydantic_fields"),
        fetchAll<{
          project_id: string;
          before_value: Partial<PydanticField> | null;
          after_value: Partial<PydanticField> | null;
        }>("schema_change_log", "project_id, before_value, after_value"),
      ]);

      const hashOf = (f: Partial<PydanticField> | null): string | null => {
        if (!f || typeof f.name !== "string" || typeof f.type !== "string") return null;
        return computeFieldHash(f.name, f.type, f.options ?? null, f.description ?? "");
      };
      const universe = new Map<string, Set<string>>();
      const add = (projectId: string, hash: string | null) => {
        if (!hash) return;
        universe.set(projectId, (universe.get(projectId) ?? new Set()).add(hash));
      };
      for (const p of projects) for (const f of p.pydantic_fields ?? []) add(p.id, hashOf(f));
      for (const entry of log) {
        add(entry.project_id, hashOf(entry.before_value));
        add(entry.project_id, hashOf(entry.after_value));
      }

      const responses = await fetchAll<{
        id: string;
        project_id: string;
        answer_field_hashes: Record<string, unknown> | null;
      }>(
        "responses",
        "id, project_id, answer_field_hashes",
        (q) => q.eq("is_latest", true).not("answer_field_hashes", "is", null),
      );
      const violations: Violation[] = [];
      for (const r of responses) {
        const entries = Object.entries(r.answer_field_hashes ?? {});
        if (entries.length === 0) continue; // sentinela legacy {}
        const known = universe.get(r.project_id) ?? new Set();
        for (const [field, hash] of entries) {
          if (typeof hash !== "string" || !/^[0-9a-f]{12}$/.test(hash)) {
            violations.push({
              key: r.id,
              detail: `hash malformado em '${field}': ${JSON.stringify(hash)}`,
            });
          } else if (!known.has(hash) && !PRE_LOG_LEGACY_HASHES.has(hash)) {
            violations.push({
              key: r.id,
              detail: `hash de '${field}' (${hash}) fora do universo do projeto ${r.project_id}`,
            });
          }
        }
      }
      return violations;
    },
  },
  {
    name: "arbitragem-perdida-exige-sugestao",
    motivation:
      "regra de fluxo da migration 20260513000001: final_verdict='llm' (humano perdeu) exige question_improvement_suggestion; violação = canal de escrita pulando a regra da UI (família 'regra duplicada por fronteira', #486)",
    run: async () => {
      const rows = await fetchAll<{ id: string; question_improvement_suggestion: string | null }>(
        "field_reviews",
        "id, question_improvement_suggestion",
        (q) => q.eq("final_verdict", "llm"),
      );
      return rows
        .filter((r) => !r.question_improvement_suggestion?.trim())
        .map((r) => ({ key: r.id, detail: "final_verdict=llm sem question_improvement_suggestion" }));
    },
  },
];

async function main() {
  let failures = 0;
  console.log(`Invariantes contra ${SUPABASE_URL}\n`);
  for (const inv of invariants) {
    try {
      const violations = await inv.run();
      if (violations.length === 0) {
        console.log(`PASS  ${inv.name}`);
      } else {
        failures++;
        console.log(`FAIL  ${inv.name} — ${violations.length} violação(ões)`);
        console.log(`      motivação: ${inv.motivation}`);
        for (const v of violations.slice(0, 10)) console.log(`      - [${v.key}] ${v.detail}`);
        if (violations.length > 10) console.log(`      ... e mais ${violations.length - 10}`);
      }
    } catch (err) {
      failures++;
      console.log(`ERRO  ${inv.name} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\n${invariants.length - failures}/${invariants.length} invariantes OK`);
  process.exit(failures > 0 ? 1 : 0);
}

void main();
