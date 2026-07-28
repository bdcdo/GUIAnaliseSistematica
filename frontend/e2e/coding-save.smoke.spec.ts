import { test, expect } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { createClient } from "@supabase/supabase-js";
import { withClerkCleanup } from "./clerk-cleanup";

// Smoke do fluxo de SALVAMENTO de codificação — proteção de regressão da
// família de bugs "codificação não salva" (#425, dedup de responses). O
// coração do spec é a asserção NO BANCO das duas pontas do par cuja
// dessincronia é o bug histórico: a linha de `responses` (is_latest,
// is_partial, answers) E o `assignments.status` — um toast de sucesso na UI
// não conta como prova de escrita.
//
// Diferente dos demais smokes (read-only), este MUTA o projeto de teste
// dedicado E2E_CODING_PROJECT_ID (criado por
// harness/2026-07-23-e2e-coding-fixture/create-fixture.mts, fora do repo):
// automation_mode='none', 2 campos text ("resumo"/"observacao"), 1 assignment
// de codificação do "Doc E2E save 1" para E2E_MEMBER_EMAIL. Para ser
// idempotente entre runs, o teste faz reset no banco ANTES de navegar —
// via service key (SUPABASE_SERVICE_ROLE_KEY, que playwright.config.ts já
// carrega de .env.local), um mecanismo que os specs existentes não usam:
// eles só leem a UI, este precisa preparar e inspecionar estado do Postgres
// em contexto Node.
//
// Autentica como PESQUISADOR (E2E_MEMBER_EMAIL) via login-por-ticket, como os
// demais smokes. Roda serial dentro do arquivo (mode default) — issue #198.
test.describe.configure({ mode: "default" });

const hasClerkTestingEnv =
  !!process.env.CLERK_SECRET_KEY &&
  !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const hasSupabaseAdminEnv =
  !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
  !!process.env.SUPABASE_SERVICE_ROLE_KEY;

const RESUMO_VALUE = "valor-e2e-resumo";
const OBSERVACAO_VALUE = "valor-e2e-observacao";
const DOC_TITLE = "Doc E2E save 1";
// Valor distinto dos acima: se algum dia vazar para o banco, o texto diz de
// qual caminho veio.
const UNSENT_VALUE = "valor-e2e-nao-enviado";

function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

test("codificação: enviar respostas persiste response e conclui assignment", async ({
  page,
}) => {
  // Primeira visita compila /analyze/code no dev server; o fluxo tem login +
  // submit + renavegação — folga bem acima dos 30s default.
  test.setTimeout(120_000);

  const email = process.env.E2E_MEMBER_EMAIL;
  const projectId = process.env.E2E_CODING_PROJECT_ID;
  test.skip(
    !hasClerkTestingEnv || !hasSupabaseAdminEnv || !email || !projectId,
    "defina CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, " +
      "NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, " +
      "E2E_MEMBER_EMAIL e E2E_CODING_PROJECT_ID",
  );

  const admin = createAdminClient();

  // Resolve o profile do membro e o documento do fixture pelo título — o
  // reset e as asserções de banco precisam dos dois ids.
  //
  // O lookup por TÍTULO EXATO é o interlock de segurança deste spec, não uma
  // conveniência: o reset abaixo apaga linhas de `responses` com a service key
  // contra o banco de produção, a cada `git push`. Se E2E_CODING_PROJECT_ID
  // apontar para um projeto real (id colado errado, .env.e2e copiado de outra
  // máquina), nenhum documento se chama DOC_TITLE, o expect logo abaixo falha e
  // o teste aborta ANTES de qualquer DELETE. Não trocar por lookup posicional
  // (`.limit(1)`, primeiro doc do projeto): isso remove a trava e faz o raio do
  // DELETE passar a ser "qualquer projeto que o id apontar".
  const [{ data: member }, { data: doc }] = await Promise.all([
    admin.from("profiles").select("id").eq("email", email!).single(),
    admin
      .from("documents")
      .select("id")
      .eq("project_id", projectId!)
      .eq("title", DOC_TITLE)
      .single(),
  ]);
  expect(
    member,
    `profile de ${email} não encontrado — confira o fixture E2E_CODING_PROJECT_ID`,
  ).toBeTruthy();
  expect(
    doc,
    `documento "${DOC_TITLE}" não encontrado no projeto ${projectId}`,
  ).toBeTruthy();
  const memberId = member!.id as string;
  const documentId = doc!.id as string;

  // Reset idempotente: apaga as responses do membro no doc e devolve o
  // assignment a "pendente" — o run anterior (verde) deixa response
  // submetida + assignment concluído, e sem reset o doc nem apareceria na
  // fila padrão (filtro "current" esconde current_done).
  const { error: delErr } = await admin
    .from("responses")
    .delete()
    .eq("project_id", projectId!)
    .eq("document_id", documentId)
    .eq("respondent_id", memberId)
    .eq("respondent_type", "humano");
  expect(delErr, `reset de responses falhou: ${delErr?.message}`).toBeNull();
  const { error: assignErr } = await admin
    .from("assignments")
    .update({ status: "pendente", completed_at: null })
    .eq("project_id", projectId!)
    .eq("document_id", documentId)
    .eq("user_id", memberId)
    .eq("type", "codificacao");
  expect(assignErr, `reset do assignment falhou: ${assignErr?.message}`).toBeNull();

  await setupClerkTestingToken({ page });
  await page.goto("/auth/login");
  // Estratégia ticket: dispensa senha e a verificação de "novo dispositivo"
  // da instância dev (ver lottery.smoke.spec.ts).
  await clerk.signIn({ page, emailAddress: email! });

  await withClerkCleanup({
    page,
    context: "coding-save",
    run: async () => {
      await page.goto(`/projects/${projectId}/analyze/code`);

      // Doc do fixture na fila de Atribuídos, com as duas perguntas do schema.
      await expect(
        page.getByText("Resumo do documento"),
        "pergunta 'Resumo do documento' não apareceu — confira o fixture e o reset",
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("Observação livre")).toBeVisible();

      // Campos text renderizam como Textarea com placeholder fixo
      // (FieldRenderer); a ordem na página segue a ordem dos campos no
      // schema do projeto: resumo (1ª) e observacao (2ª).
      const textareas = page.getByPlaceholder("Digite sua resposta...");
      await expect(textareas).toHaveCount(2);
      await textareas.nth(0).fill(RESUMO_VALUE);
      await textareas.nth(1).fill(OBSERVACAO_VALUE);

      await page.getByRole("button", { name: "Enviar respostas" }).click();
      await expect(
        page.getByText("Respostas salvas!"),
        "toast de sucesso não apareceu após Enviar respostas",
      ).toBeVisible({ timeout: 15_000 });

      // === Coração do spec: asserção no BANCO. O toast acima só prova que a
      // Server Action retornou success; aqui provamos que ela ESCREVEU. O
      // saveResponse conclui o upsert e o sync do assignment ANTES de
      // retornar success, então a leitura é determinística (sem poll).
      const { data: response, error: respErr } = await admin
        .from("responses")
        .select("answers, is_latest, is_partial")
        .eq("project_id", projectId!)
        .eq("document_id", documentId)
        .eq("respondent_id", memberId)
        .eq("respondent_type", "humano")
        .maybeSingle();
      expect(respErr, `leitura de responses falhou: ${respErr?.message}`).toBeNull();
      expect(
        response,
        "a UI reportou sucesso mas NENHUMA response foi escrita no banco — " +
          "regressão do salvamento de codificação",
      ).toBeTruthy();
      expect(response!.is_latest).toBe(true);
      expect(response!.is_partial).toBe(false);
      const answers = response!.answers as Record<string, unknown>;
      expect(answers.resumo).toBe(RESUMO_VALUE);
      expect(answers.observacao).toBe(OBSERVACAO_VALUE);

      const { data: assignment, error: readAssignErr } = await admin
        .from("assignments")
        .select("status, completed_at")
        .eq("project_id", projectId!)
        .eq("document_id", documentId)
        .eq("user_id", memberId)
        .eq("type", "codificacao")
        .single();
      expect(
        readAssignErr,
        `leitura do assignment falhou: ${readAssignErr?.message}`,
      ).toBeNull();
      expect(
        assignment!.status,
        "response escrita mas assignment não concluiu — dessincronia do par " +
          "responses×assignments (família #425)",
      ).toBe("concluido");
      expect(assignment!.completed_at).toBeTruthy();

      // Round-trip pela UI: recarrega com ?round=all (o filtro padrão
      // "current" esconde docs concluídos da rodada atual) e confere que os
      // valores persistidos voltam pré-preenchidos no formulário.
      await page.goto(`/projects/${projectId}/analyze/code?round=all`);
      const reloaded = page.getByPlaceholder("Digite sua resposta...");
      await expect(reloaded.nth(0)).toHaveValue(RESUMO_VALUE, {
        timeout: 30_000,
      });
      await expect(reloaded.nth(1)).toHaveValue(OBSERVACAO_VALUE);
    },
    // signOut direto na página de codificação pode travar no waitForFunction
    // de window.Clerk.loaded (mesmo padrão do lottery.smoke) — voltar ao
    // dashboard antes.
    prepareSignOut: async () => {
      await page.goto("/dashboard");
    },
  });
});


// Contraparte do teste acima, e o discriminador do #608: prova que editar SEM
// enviar não produz escrita nenhuma no banco — e que o trabalho, mesmo assim,
// não se perde. Enquanto existia o salvamento automático, sair da tela gravava
// pelas costas (com `is_partial: true`, sem concluir o assignment); é essa
// escrita fantasma que o PR remove, e é a ausência dela que este teste fixa.
//
// Escrita-vs-exibição: a asserção que importa é a do banco. Ver o formulário
// repovoado só provaria que a tela lembra, não que o servidor foi (ou não foi)
// tocado.
test("codificação: editar e sair sem enviar não grava, e o rascunho local retém", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const email = process.env.E2E_MEMBER_EMAIL;
  const projectId = process.env.E2E_CODING_PROJECT_ID;
  test.skip(
    !hasClerkTestingEnv || !hasSupabaseAdminEnv || !email || !projectId,
    "mesmas variáveis do teste acima",
  );

  const admin = createAdminClient();
  const [{ data: member }, { data: doc }] = await Promise.all([
    admin.from("profiles").select("id").eq("email", email!).single(),
    admin
      .from("documents")
      .select("id")
      .eq("project_id", projectId!)
      .eq("title", DOC_TITLE)
      .single(),
  ]);
  // Mesmo interlock do teste acima: sem o documento de título exato, aborta
  // antes do DELETE.
  expect(member).toBeTruthy();
  expect(doc, `documento "${DOC_TITLE}" não encontrado`).toBeTruthy();
  const memberId = member!.id as string;
  const documentId = doc!.id as string;

  const { error: delErr } = await admin
    .from("responses")
    .delete()
    .eq("project_id", projectId!)
    .eq("document_id", documentId)
    .eq("respondent_id", memberId)
    .eq("respondent_type", "humano");
  expect(delErr, `reset de responses falhou: ${delErr?.message}`).toBeNull();
  const { error: assignErr } = await admin
    .from("assignments")
    .update({ status: "pendente", completed_at: null })
    .eq("project_id", projectId!)
    .eq("document_id", documentId)
    .eq("user_id", memberId)
    .eq("type", "codificacao");
  expect(assignErr, `reset do assignment falhou: ${assignErr?.message}`).toBeNull();

  await setupClerkTestingToken({ page });
  await page.goto("/auth/login");
  await clerk.signIn({ page, emailAddress: email! });

  await withClerkCleanup({
    page,
    context: "coding-save-unsent",
    run: async () => {
      await page.goto(`/projects/${projectId}/analyze/code`);
      await expect(page.getByText("Resumo do documento")).toBeVisible({
        timeout: 30_000,
      });

      const textareas = page.getByPlaceholder("Digite sua resposta...");
      await expect(textareas).toHaveCount(2);
      await textareas.nth(0).fill(UNSENT_VALUE);

      // A edição acende o indicador permanente.
      await expect(page.getByText("Alterações não enviadas").first()).toBeVisible();

      // Esconder a aba é o gatilho que o autosave usava para gravar por
      // `sendBeacon` (`visibilitychange` → hidden). Simulá-lo aqui é o que
      // torna a asserção de banco lá embaixo DISCRIMINANTE: sem este passo,
      // "nenhuma response" passaria mesmo com o autosave de volta, porque
      // nenhum dos quatro gatilhos cobria navegação SPA — o buraco que motivou
      // a issue. Com ele, reintroduzir o hook deixa o teste vermelho.
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          value: "hidden",
          configurable: true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          value: "visible",
          configurable: true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      // Provar AUSÊNCIA de escrita exige esperar a janela em que ela
      // aconteceria. Medi que sem isto o teste era enganoso: com o gatilho
      // reintroduzido, a Server Action gravava — mas depois da leitura, e a
      // asserção passava verde sobre um banco que estava prestes a mudar.
      // `networkidle` ancora a espera na request real, em vez de num
      // `waitForTimeout` arbitrário.
      await page.waitForLoadState("networkidle");

      // Sair pela aba do projeto — a navegação SPA que o autosave NUNCA cobriu,
      // e que era o buraco central do mecanismo removido.
      await page.getByRole("link", { name: "Revisar" }).click();

      const dialog = page.getByRole("alertdialog");
      await expect(
        dialog,
        "sair com alterações não enviadas deveria pedir confirmação",
      ).toBeVisible();

      // "Ficar" mantém a pessoa na tela, com o texto preservado.
      await dialog.getByRole("button", { name: "Ficar" }).click();
      await expect(dialog).toBeHidden();
      await expect(page).toHaveURL(/\/analyze\/code/);
      await expect(textareas.nth(0)).toHaveValue(UNSENT_VALUE);

      // Agora sair de fato.
      await page.getByRole("link", { name: "Revisar" }).click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Sair sem enviar" })
        .click();
      await expect(page).toHaveURL(/\/reviews/, { timeout: 15_000 });

      // === Coração deste spec: NADA foi escrito. Antes do #608, chegar até
      // aqui deixava uma response parcial no banco sem que ninguém pedisse.
      const { data: rows, error: readErr } = await admin
        .from("responses")
        .select("id")
        .eq("project_id", projectId!)
        .eq("document_id", documentId)
        .eq("respondent_id", memberId)
        .eq("respondent_type", "humano");
      expect(readErr, `leitura de responses falhou: ${readErr?.message}`).toBeNull();
      expect(
        rows ?? [],
        "editar sem enviar gravou no banco — algum gatilho de salvamento " +
          "automático voltou (a aba foi escondida acima justamente para " +
          "acordar o `visibilitychange`)",
      ).toHaveLength(0);

      // O assignment também não avançou.
      const { data: assignment } = await admin
        .from("assignments")
        .select("status")
        .eq("project_id", projectId!)
        .eq("document_id", documentId)
        .eq("user_id", memberId)
        .eq("type", "codificacao")
        .maybeSingle();
      expect(assignment!.status).toBe("pendente");

      // E o trabalho não se perdeu: de volta à codificação, a faixa oferece o
      // rascunho. É a metade que justifica a outra — remover a gravação
      // automática só é seguro porque esta rede existe.
      await page.goto(`/projects/${projectId}/analyze/code`);
      await expect(
        page.getByRole("button", { name: "Retomar rascunho" }),
        "o rascunho local não foi oferecido de volta",
      ).toBeVisible({ timeout: 30_000 });

      await page.getByRole("button", { name: "Retomar rascunho" }).click();
      await expect(page.getByPlaceholder("Digite sua resposta...").nth(0)).toHaveValue(
        UNSENT_VALUE,
      );

      // Segunda leitura, no fim de tudo: a primeira mede a janela imediata, esta
      // fecha a porta para uma escrita atrasada — inclusive a que só apareceria
      // depois do round-trip de voltar à tela.
      const { data: after } = await admin
        .from("responses")
        .select("id")
        .eq("project_id", projectId!)
        .eq("document_id", documentId)
        .eq("respondent_id", memberId)
        .eq("respondent_type", "humano");
      expect(
        after ?? [],
        "uma escrita apareceu no banco depois do fluxo — nenhum caminho desta " +
          "tela deve gravar sem o envio explícito",
      ).toHaveLength(0);
    },
  });
});
