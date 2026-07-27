// Cria o projeto E2E dedicado ao smoke de troca de campo na Comparação
// (frontend/e2e/compare-field-switch.smoke.spec.ts) e imprime o
// E2E_COMPARE_PROJECT_ID para colar no .env.e2e.
//
// Versionado (e não deixado no harness local) porque E2E_COMPARE_PROJECT_ID é
// obrigatória no gate de pre-push: sem a receita no repo, um clone novo trava
// no gate sem caminho para destravar. Mesmo raciocínio de
// create-coding-save-fixture.mts.
//
// PROPRIEDADE LOAD-BEARING — os 6 campos têm conjuntos de opções DISJUNTOS,
// prefixados pelo nome do campo (ALFA-opcao-1, BETA-opcao-1, ...). É isso que
// torna "veredito gravado no campo errado" detectável sem ambiguidade: uma
// opção só existe em um campo, então um valor fora do conjunto do campo é
// prova, não indício. Se alguém uniformizar as opções "para simplificar", o
// smoke continua verde e para de testar o que interessa (#613).
//
// Segunda propriedade load-bearing: os 6 campos são `single`. A asserção
// central do spec conta `data-testid="agreement-group"`, que só o
// `AgreementGroup` emite — um campo `multi` renderiza `MultiOptionReview`, sem
// esse testid, e a contagem passaria a valer vacuamente para ele. Ao acrescentar
// campo aqui, ou mantenha `single`, ou dê ao spec uma âncora equivalente.
//
// Idempotente: reutiliza projeto, documentos, membros e respostas pelo nome/
// título, então rodar de novo é seguro e devolve sempre o mesmo id.
//
// Rodar de frontend/:  npm run e2e:fixture:compare
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  applyEnvironment,
  readOptionalEnvironmentFile,
} from "../worktree-env/env-contract.mjs";

// Mesmo par de arquivos, na mesma ordem de precedência, que o
// playwright.config.ts carrega, ancorado no diretório do próprio script (não no
// cwd): rodar da raiz do repo acharia o contrato e nenhum valor.
const frontendDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
applyEnvironment(process.env, readOptionalEnvironmentFile(join(frontendDir, ".env.local")));
applyEnvironment(process.env, readOptionalEnvironmentFile(join(frontendDir, ".env.e2e")), {
  override: true,
});

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes");
}
// Os dois respondentes humanos são os usuários de teste que o contrato já
// exige — evita uma terceira variável de ambiente só para este fixture. O
// coordenador entra como respondente porque a fila de Comparação pede 2
// humanos, e coordenador também codifica no produto.
const COORDINATOR_EMAIL = process.env.E2E_COORDINATOR_EMAIL;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
if (!COORDINATOR_EMAIL || !MEMBER_EMAIL) {
  throw new Error("E2E_COORDINATOR_EMAIL / E2E_MEMBER_EMAIL ausentes (.env.e2e)");
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

export const PROJECT_NAME = "Comparação campo-trocado — teste E2E";
const SCHEMA_HASH = "e2e-campotrocado-schema-hash";
const LETTERS = ["ALFA", "BETA", "GAMA", "DELTA", "EPSILON", "ZETA"];

const FIELDS = LETTERS.map((letter, i) => ({
  hash: `e2e-ct-f${i + 1}`,
  name: `q${i + 1}_${letter.toLowerCase()}`,
  type: "single" as const,
  options: [`${letter}-opcao-1`, `${letter}-opcao-2`, `${letter}-opcao-3`],
  description: `Pergunta ${i + 1} (${letter}) — opções exclusivas deste campo`,
}));

const DOC_TITLES = ["Doc campo-trocado 1", "Doc campo-trocado 2"];

async function profileId(email: string): Promise<string> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id")
    .eq("email", email)
    .single();
  if (error || !data) throw new Error(`profile ${email}: ${error?.message}`);
  return data.id as string;
}

async function main() {
  const [coordId, memberId] = await Promise.all([
    profileId(COORDINATOR_EMAIL!),
    profileId(MEMBER_EMAIL!),
  ]);

  const { data: existing } = await supabase
    .from("projects")
    .select("id")
    .eq("name", PROJECT_NAME)
    .maybeSingle();

  let projectId: string;
  const schema = {
    pydantic_fields: FIELDS,
    pydantic_hash: SCHEMA_HASH,
    automation_mode: "compare_humans",
  };
  if (existing) {
    projectId = existing.id as string;
    const { error } = await supabase.from("projects").update(schema).eq("id", projectId);
    if (error) throw new Error(`update projects: ${error.message}`);
  } else {
    const { data, error } = await supabase
      .from("projects")
      .insert({
        ...schema,
        name: PROJECT_NAME,
        description:
          "Fixture sintético do smoke de troca de campo na Comparação (#613). Opções disjuntas por campo — ver o script que o cria.",
        created_by: coordId,
        schema_version_major: 1,
        schema_version_minor: 0,
        schema_version_patch: 0,
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`insert projects: ${error?.message}`);
    projectId = data.id as string;
  }

  for (const [userId, role] of [
    [coordId, "coordenador"],
    [memberId, "pesquisador"],
  ] as const) {
    const { error } = await supabase
      .from("project_members")
      .upsert({ project_id: projectId, user_id: userId, role }, { onConflict: "project_id,user_id" });
    if (error) throw new Error(`upsert project_members: ${error.message}`);
  }

  const text = "Texto sintetico do documento de teste. ".repeat(30);
  const docIds: string[] = [];
  for (const [i, title] of DOC_TITLES.entries()) {
    const { data: doc } = await supabase
      .from("documents")
      .select("id")
      .eq("project_id", projectId)
      .eq("title", title)
      .maybeSingle();
    if (doc) {
      docIds.push(doc.id as string);
      continue;
    }
    const { data, error } = await supabase
      .from("documents")
      .insert({ project_id: projectId, external_id: `E2E-CT-${i + 1}`, title, text })
      .select("id")
      .single();
    if (error || !data) throw new Error(`insert documents: ${error?.message}`);
    docIds.push(data.id as string);
  }

  // Divergência em TODOS os campos: um respondente sempre na opção 1, o outro
  // sempre na 2. Sem isso a fila não teria 6 campos para navegar.
  for (const docId of docIds) {
    for (const [userId, optionIndex] of [
      [coordId, 0],
      [memberId, 1],
    ] as const) {
      const answers: Record<string, string> = {};
      for (const f of FIELDS) answers[f.name] = f.options[optionIndex];
      const row = {
        project_id: projectId,
        document_id: docId,
        respondent_type: "humano",
        respondent_id: userId,
        answers,
        is_latest: true,
        is_partial: false,
        pydantic_hash: SCHEMA_HASH,
        schema_version_major: 1,
        schema_version_minor: 0,
        schema_version_patch: 0,
      };
      const { data: ex } = await supabase
        .from("responses")
        .select("id")
        .eq("project_id", projectId)
        .eq("document_id", docId)
        .eq("respondent_id", userId)
        .maybeSingle();
      const { error } = ex
        ? await supabase.from("responses").update(row).eq("id", ex.id)
        : await supabase.from("responses").insert(row);
      if (error) throw new Error(`responses: ${error.message}`);
    }
  }

  // O fixture é AUTORITATIVO sobre os respondentes do projeto: qualquer outra
  // resposta humana é removida. Sem isto o projeto acumula respondentes de
  // seeds antigos (aconteceu: o seed descartável do harness usava um par de
  // usuários diferente, e o projeto ficou com três), a contagem de grupos muda
  // e o spec passa a medir uma fila que não é a que o script descreve.
  const { error: pruneError } = await supabase
    .from("responses")
    .delete()
    .eq("project_id", projectId)
    .eq("respondent_type", "humano")
    .not("respondent_id", "in", `(${coordId},${memberId})`);
  if (pruneError) throw new Error(`prune responses: ${pruneError.message}`);

  // A limpeza de `reviews` é responsabilidade do SPEC, não do seed: assim o
  // teste é idempotente sem depender de alguém ter rodado o seed antes.
  console.log(`E2E_COMPARE_PROJECT_ID=${projectId}`);
  console.log(`docs: ${docIds.join(", ")}`);
  console.log(`campos: ${FIELDS.map((f) => f.name).join(", ")}`);
}

await main();
