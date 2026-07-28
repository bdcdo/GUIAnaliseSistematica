import { test, expect, type Page } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { createClient } from "@supabase/supabase-js";
import { withClerkCleanup } from "./clerk-cleanup";

// Regressão da #613: navegar entre campos na Comparação deixava os cards do
// campo ANTERIOR na tela, e clicar num deles gravava aquele valor no campo
// atual — 2 vereditos corrompidos em produção.
//
// A causa foi medida, não suposta: os três filhos do container de scroll do
// `ComparisonPanel` usavam a MESMA `key` (`documentId|fieldName|readOnly`).
// Em `reconcileChildrenArray` o React indexa os filhos antigos por chave, e o
// último duplicado sobrescrevia o primeiro no mapa — então o fiber do
// `AgreementGroup` nunca entrava em `deletions` e a subárvore continuava
// MONTADA, com handlers vivos. Não era DOM órfão: era vazamento de montagem.
// O React avisava (`Encountered two children with the same key`), mas o aviso
// se perdia no console.
//
// Por isso a asserção central é a CONTAGEM DE RAÍZES, não a aparência: é ela
// que pega a duplicação de chave se alguém reintroduzir um irmão keyado igual.
// A segunda asserção fecha a ponta de escrita — o valor que chega ao banco.
//
// O fixture (npm run e2e:fixture:compare) tem uma propriedade que o teste
// depende: os 6 campos têm conjuntos de opções DISJUNTOS, prefixados pelo nome
// do campo. Um veredito fora do conjunto do campo é prova de corrupção, não
// indício. Preservar.
//
// Como o coding-save.smoke, este spec MUTA o projeto de teste dedicado
// (E2E_COMPARE_PROJECT_ID) com a service key. Serial dentro do arquivo (#198).
test.describe.configure({ mode: "default" });

const hasClerkTestingEnv =
  !!process.env.CLERK_SECRET_KEY &&
  !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const hasSupabaseAdminEnv =
  !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
  !!process.env.SUPABASE_SERVICE_ROLE_KEY;

const PROJECT_NAME = "Comparação campo-trocado — teste E2E";
const DOC_TITLES = ["Doc campo-trocado 1", "Doc campo-trocado 2"];
const TOTAL_FIELDS = 6;

function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

interface FixtureField {
  name: string;
  options: string[];
}

/**
 * Interlock de segurança. Este spec apaga linhas de `reviews` com a service key
 * contra o banco de PRODUÇÃO a cada `git push`; se `E2E_COMPARE_PROJECT_ID`
 * apontar para um projeto real (id colado errado, `.env.e2e` copiado de outra
 * máquina), o estrago seria irreversível. As três travas abaixo abortam ANTES
 * de qualquer escrita, e a terceira é a que nenhum projeto real satisfaz.
 */
async function assertFixtureProject(
  admin: ReturnType<typeof createAdminClient>,
  projectId: string,
): Promise<FixtureField[]> {
  const { data: project } = await admin
    .from("projects")
    .select("id, name, pydantic_fields")
    .eq("id", projectId)
    .maybeSingle();

  expect(project, `projeto ${projectId} não existe`).not.toBeNull();
  expect(
    project!.name,
    "E2E_COMPARE_PROJECT_ID não é o projeto do fixture",
  ).toBe(PROJECT_NAME);

  const fields = (project!.pydantic_fields ?? []) as FixtureField[];
  expect(fields).toHaveLength(TOTAL_FIELDS);

  // Opções disjuntas entre TODOS os campos: a propriedade que define o fixture
  // e que nenhum codebook real tem.
  const seen = new Set<string>();
  for (const f of fields) {
    for (const option of f.options ?? []) {
      expect(seen.has(option), `opção "${option}" repetida entre campos`).toBe(
        false,
      );
      seen.add(option);
    }
  }
  return fields;
}

/**
 * Documentos do fixture por TÍTULO EXATO — nunca `.limit(1)` posicional (mesma
 * trava do coding-save). Serve para confirmar que o veredito gravado pertence
 * ao fixture, sem presumir QUAL dos dois a fila exibiu primeiro.
 */
async function fixtureDocIds(
  admin: ReturnType<typeof createAdminClient>,
  projectId: string,
): Promise<string[]> {
  const { data } = await admin
    .from("documents")
    .select("id, title")
    .eq("project_id", projectId)
    .in("title", DOC_TITLES);
  expect(data, "documentos do fixture não encontrados").not.toBeNull();
  expect(data!).toHaveLength(DOC_TITLES.length);
  return data!.map((d) => d.id as string);
}

/**
 * Avança até o campo `target` pela tecla `n`, de forma IDEMPOTENTE: só pressiona
 * enquanto o cabeçalho ainda não chegou lá.
 *
 * Não é preciosismo. A tecla apertada antes da hidratação é engolida em
 * silêncio — o listener de `keydown` ainda não existe —, e não há sinal de DOM
 * confiável para "já hidratou" (`toHaveCount` é satisfeito pelo HTML do
 * servidor). Um `press` único falha de forma intermitente, e um `toPass`
 * envolvendo o press passaria do alvo quando a asserção fosse só lenta. Reler o
 * cabeçalho a cada tentativa resolve os dois: nunca ultrapassa, nunca depende
 * de timing.
 */
async function goToField(page: Page, target: number): Promise<void> {
  const header = page.getByText(new RegExp(`Campo \\d+/${TOTAL_FIELDS}`)).first();
  for (let attempt = 0; attempt < TOTAL_FIELDS * 2; attempt++) {
    // A leitura do cabeçalho vai por `expect.poll` — e não por um `innerText`
    // direto — porque um re-render entre a asserção de visibilidade e a leitura
    // desanexa o nó, e aí o `innerText` cru estoura em vez de tentar de novo.
    let text = "";
    await expect
      .poll(async () => (text = await header.innerText()), { timeout: 10_000 })
      .toContain("Campo");
    if (text.includes(`Campo ${target}/${TOTAL_FIELDS}`)) return;
    await page.keyboard.press("n");
    await expect
      .poll(async () => (await header.innerText()).trim(), { timeout: 3_000 })
      .not.toBe(text.trim())
      .catch(() => {
        /* tecla engolida na hidratação: a próxima volta tenta de novo */
      });
  }
  await expect(header).toHaveText(
    new RegExp(`Campo ${target}/${TOTAL_FIELDS}`),
  );
}

function skipUnlessConfigured() {
  const email = process.env.E2E_COORDINATOR_EMAIL;
  const projectId = process.env.E2E_COMPARE_PROJECT_ID;
  test.skip(
    !hasClerkTestingEnv || !hasSupabaseAdminEnv || !email || !projectId,
    "defina CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, " +
      "NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, " +
      "E2E_COORDINATOR_EMAIL e E2E_COMPARE_PROJECT_ID",
  );
  return { email: email!, projectId: projectId! };
}

test("comparação: navegar entre campos mostra só os cards do campo atual", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { email, projectId } = skipUnlessConfigured();

  const admin = createAdminClient();
  const fields = await assertFixtureProject(admin, projectId);
  await admin.from("reviews").delete().eq("project_id", projectId);

  await setupClerkTestingToken({ page });
  await page.goto("/auth/login");
  await clerk.signIn({ page, emailAddress: email });

  await withClerkCleanup({
    page,
    context: "compare-field-switch/exibicao",
    // `signOut` direto numa página de análise trava no `waitForFunction` de
    // `window.Clerk.loaded`; voltar ao dashboard antes é o padrão dos demais
    // smokes.
    prepareSignOut: async () => {
      await page.goto("/dashboard");
    },
    run: async () => {
      await page.goto(`/projects/${projectId}/analyze/compare?queue=all`);

      await expect(
        page.getByText(new RegExp(`Campo 1/${TOTAL_FIELDS}`)),
      ).toBeVisible({
        timeout: 60_000,
      });
      // Espera a hidratação antes da primeira tecla: sem isso o `n` é engolido e
      // toda a contagem sai deslocada em um campo (medido ao investigar a #613).
      await expect(page.getByTestId("agreement-group")).toHaveCount(1);

      // Posição do topo do primeiro card em cada campo. O critério 1 da #610 é
      // que ela NÃO se mova ao navegar: o cabeçalho fica acima da área rolável,
      // então toda variação de altura dele desloca a lista inteira e o revisor
      // perde a âncora visual a cada `n`. Os campos do fixture variam de
      // propósito em enunciado e help_text — sem essa variação a asserção
      // passaria por acidente.
      const firstCardTops: number[] = [];

      for (let i = 0; i < TOTAL_FIELDS; i++) {
        await expect(
          page.getByText(new RegExp(`Campo ${i + 1}/${TOTAL_FIELDS}`)),
        ).toBeVisible();

        // Critério de aceitação 1 da #613: uma raiz, sempre. Antes do fix isto
        // ia 1, 2, 3, 4, 5, 6.
        await expect(page.getByTestId("agreement-group")).toHaveCount(1);

        // Contagem exata dos cards: a igualdade de CONJUNTO sozinha mascararia um
        // card duplicado com o mesmo rótulo.
        const cards = page.locator("button[data-vote-target]");
        await expect(cards).toHaveCount(2);

        // E o conteúdo é do campo atual — as opções são disjuntas, então isto é
        // um discriminador, não uma coincidência.
        const labels = await cards.evaluateAll((els) =>
          els.map((el) => el.getAttribute("aria-label") ?? ""),
        );
        for (const option of fields[i].options.slice(0, 2)) {
          expect(
            labels.some((l) => l.includes(option)),
            `campo ${fields[i].name}: esperava um card com "${option}", vi ${JSON.stringify(labels)}`,
          ).toBe(true);
        }

        firstCardTops.push(
          await cards.first().evaluate((el) => el.getBoundingClientRect().top),
        );

        if (i < TOTAL_FIELDS - 1) await page.keyboard.press("n");
      }

      // Tolerância de 1px absorve arredondamento subpixel do layout; qualquer
      // coisa acima disso é o cabeçalho mudando de altura. Antes do fix o
      // intervalo media dezenas de pixels.
      const spread = Math.max(...firstCardTops) - Math.min(...firstCardTops);
      expect(
        spread,
        `posição do primeiro card variou entre campos: ${JSON.stringify(firstCardTops)}`,
      ).toBeLessThanOrEqual(1);
    },
  });
});

test("comparação: veredito confirmado após navegar grava no campo exibido", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { email, projectId } = skipUnlessConfigured();

  const admin = createAdminClient();
  const fields = await assertFixtureProject(admin, projectId);
  const fixtureDocs = await fixtureDocIds(admin, projectId);
  await admin.from("reviews").delete().eq("project_id", projectId);

  const targetField = fields[1];

  await setupClerkTestingToken({ page });
  await page.goto("/auth/login");
  await clerk.signIn({ page, emailAddress: email });

  await withClerkCleanup({
    page,
    context: "compare-field-switch/escrita",
    prepareSignOut: async () => {
      await page.goto("/dashboard");
    },
    run: async () => {
      await page.goto(`/projects/${projectId}/analyze/compare?queue=all`);

      // Espera o cabeçalho E os cards antes da primeira tecla: `toHaveCount`
      // sozinho é satisfeito pelo HTML do servidor, e a tecla apertada antes da
      // hidratação é engolida em silêncio — a navegação não acontece e a
      // asserção seguinte falha por um motivo que não é o do teste.
      await expect(
        page.getByText(new RegExp(`Campo 1/${TOTAL_FIELDS}`)),
      ).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId("agreement-group")).toHaveCount(1);

      await goToField(page, 2);

      // Sem rascunho não existe nenhum controle de confirmação: prova em
      // navegador real que a barra fixa do rodapé não voltou (#610).
      await expect(
        page.getByRole("button", { name: /^Confirmar$/ }),
      ).toHaveCount(0);

      // Clica no PRIMEIRO card na tela: é a posição natural do clique e era
      // exatamente onde ficava o card fantasma do campo anterior.
      const firstCard = page.locator("button[data-vote-target]").first();
      await firstCard.click();

      // Confirma DENTRO do card. Além de fixar a ancoragem, este clique é a
      // única prova possível de que a barra fica acima do overlay de voto: em
      // jsdom não há hit-testing, então remover o `z-[2]` do slot não quebra
      // nenhum teste unitário — aqui, o Playwright ou acusa interceptação ou
      // acerta o overlay e nunca chega ao "Veredito salvo!".
      const card = page
        .locator('[data-testid="answer-card"][data-pending="true"]')
        .first();
      await expect(card).toHaveCount(1);
      await card.getByRole("button", { name: /^Confirmar$/ }).click();
      await expect(page.getByText("Veredito salvo!")).toBeVisible({
        timeout: 30_000,
      });
    },
  });

  // A prova é o banco, não o toast. Consulta pelo PROJETO, não por um documento
  // escolhido a priori: qual dos dois a fila exibe primeiro é decisão do
  // servidor (ordena por pendências), então fixar o documento aqui testaria a
  // ordenação em vez do que interessa.
  const { data: reviews } = await admin
    .from("reviews")
    .select("document_id, field_name, verdict")
    .eq("project_id", projectId);

  expect(reviews).toHaveLength(1);
  expect(fixtureDocs).toContain(reviews![0].document_id as string);
  // O coração do teste: o veredito foi para o campo EXIBIDO, com um valor do
  // conjunto desse campo. Como as opções são disjuntas, um valor do campo
  // anterior aqui seria prova de campo trocado — o bug da #613.
  expect(reviews![0].field_name).toBe(targetField.name);
  expect(targetField.options).toContain(reviews![0].verdict as string);
});
