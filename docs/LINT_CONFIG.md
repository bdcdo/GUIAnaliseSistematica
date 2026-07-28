# Configuração do react-doctor

> Este documento cobre **só o react-doctor**. Para a stack de qualidade completa — fallow (grafo do codebase), typescript-eslint type-checked (tipos), ruff (backend Python), React Scan (runtime), Dependabot/semgrep (segurança) e o mapa de qual hook dispara o quê — ver [`docs/CODE_QUALITY_TOOLING.md`](CODE_QUALITY_TOOLING.md).

O [react-doctor](https://react.doctor) é tratado como um linter da toolchain do frontend, no mesmo espírito do eslint/mypy: é uma `devDependency` **pinada** (`react-doctor@0.7.8` em `frontend/package.json`), roda via script `npm run`, e o arquivo `frontend/doctor.config.json` cumpre o papel de um `mypy.ini`/`.eslintrc` — fonte única de configuração (o config na raiz do repo foi removido para evitar drift, já que os scripts npm e o hook de pre-commit rodam escopados a `frontend/`).

> **Nome do arquivo de config:** desde a 0.5, o react-doctor procura `doctor.config.*` (ou a chave `reactDoctor` em `package.json`); o nome antigo `react-doctor.config.json` deixou de ser reconhecido. O arquivo foi renomeado para `doctor.config.json` no bump 0.2.11 → 0.5.6. O schema (`ignore.overrides` + `rules`) é o mesmo.

## Como rodar

```bash
cd frontend
npm run react-doctor          # scan completo do app (report)
npm run react-doctor:diff     # só os arquivos do branch atual vs origin/main (check manual)
```

A config é lida do diretório de execução (o react-doctor resolve o projeto via `findNearestPackageDirectory`, e só `frontend/` tem `package.json`), por isso os comandos rodam de dentro de `frontend/`.

## Gate local de pre-commit — bloqueante para código novo, não para o legado

O gate roda **localmente, antes do commit** (estilo flake8/mypy), não no CI. `.pre-commit-config.yaml` define um hook `repo: local` que executa `frontend/scripts/react-doctor-gate.sh` em commits que tocam arquivos `frontend/**/*.{ts,tsx}`. O script invoca `react-doctor . --scope changed --base HEAD --blocking warning`. Como `--scope changed --base HEAD` reporta só issues nas *linhas* alteradas vs HEAD e `--blocking warning` falha em diagnósticos *warning* e *error*, o gate **bloqueia quando o commit toca uma linha que produz qualquer diagnóstico**. O débito legado fica grandfathered: editar uma linha qualquer de um arquivo que já tem um diagnóstico em *outra* linha não barra o commit.

> **Endurecido para `--blocking warning` em 2026-07-23**, depois que os 10 errors e os 27 warnings do bump 0.7.8 foram zerados (contagem em 0). Até então o gate rodava `--blocking error`, e com a contagem de errors zerada ele não barrava nada — a "decisão natural" que este doc já apontava. Provado com um `no-array-index-as-key` numa linha nova: barra com exit 1, onde antes passava. O script também **falha fechado se o `react-doctor` instalado divergir do pino** do `package.json`: o hook invoca o binário pinado direto (não `npx`), e nada detectava um `node_modules` stale — um checkout preso na 0.5.8 enquanto o pino já era 0.7.8 media com a ferramenta errada, contagem e número de linha divergentes, em silêncio.

> **O bump 0.7.3 → 0.7.8 (#531) trouxe 9 errors, todos pagos ou auditados aqui (2026-07-23).** Seis regras novas em nível `error` (`no-impure-state-updater`, `no-ref-current-in-render`, `no-effect-with-fresh-deps`, `no-hydration-branch-on-browser-global`, `effect-needs-cleanup`, `no-prop-callback-in-render`) passaram a disparar sobre código que já estava no repo — medição pareada em #534, mesma árvore, só a ferramenta variando: 1 error na 0.7.3 contra 10 na 0.7.8. Dos 10, **cinco eram defeito real e foram corrigidos** (dois `useCallback` em `ComparePage`, o `localStorage.setItem` dentro do updater em `AutoReviewFooter`, o `setGabaritoOverride` aninhado em `AgreementGroup`, e a divergência de hidratação de `DocumentList`) e **cinco eram falso-positivo, suprimidos com justificativa** na seção "Supressões da 0.7.8" abaixo. O décimo error não veio do bump: `supabase-client-owned-authz-field` em `src/lib/compare-sync.ts` entrou por código, em `0f978cb` (#499, 2026-07-16), e ficou de fora da tabela original de #534.

> **Mudança de flag (histórico):** a flag `--fail-on <level>` da 0.2.x foi removida na 0.5; o substituto é `--blocking <level>` (`error` | `warning` | `none`; default já é `error`). O hook e os scripts foram migrados no bump.

Por ser **local e opt-in** — cada clone precisa rodar o setup abaixo, e `git commit --no-verify` o ignora —, este gate é uma rede de proteção para quem desenvolve, não um portão de merge no servidor: ele não protege a `main` de forma incondicional. A opção por pre-commit em vez de um job de CI é deliberada, para manter a toolchain leve enquanto a baseline de errors é zero; promover o gate a um check de CI bloqueante é o passo natural caso o enforcement no servidor passe a ser necessário.

### Setup (1x por clone)

```bash
cd frontend && npm install      # instala o react-doctor pinado (binário em node_modules/.bin)
uv tool install pre-commit      # ou: pipx install pre-commit — `pre-commit` é um utilitário Python externo
pre-commit install              # da raiz do repo: grava o hook em .git/hooks
```

### Detalhes de implementação

- **`--scope changed --base HEAD`, não `--staged`**: o react-doctor tem um modo `--staged` próprio para pre-commit, mas ele é *file-scoped* (escaneia o arquivo staged inteiro), o que quebraria o grandfathering — tocar uma linha qualquer de um arquivo com error legado em *outra* linha barraria o commit. Usamos `--scope changed --base HEAD`, que é *line-scoped* (só as linhas alteradas vs HEAD); o grandfathering foi reproduzido empiricamente na 0.5.8 (tocar linha limpa de arquivo com diagnóstico em outras linhas não bloqueia; tocar linha que produz diagnóstico bloqueia) e as flags seguem aceitas na 0.7.8. Com o gate agora em `--blocking warning` e a contagem zerada, a reprodução voltou a ser fácil por *warning*: um `no-array-index-as-key` numa linha nova barra com exit 1. Como o pre-commit faz auto-stash dos arquivos unstaged antes de rodar o hook, o working tree fica idêntico ao staged, então o diff vs HEAD enxerga exatamente o que vai ser commitado.
- **Migração de `--diff` → `--scope changed`**: até a 0.5.6 o hook e o script `react-doctor:diff` usavam `--diff [ref]`. A **0.5.7 deprecou `--diff`** (passou a imprimir um warning a cada run; [#844](https://github.com/millionco/react-doctor/pull/844)) em favor de `--scope changed` (`--base <ref>` para fixar a base). As duas flags foram verificadas equivalentes para o gate na 0.5.8 (mesmo comportamento line-scoped), então a migração foi semanticamente neutra.
- O gate vive em `frontend/scripts/react-doctor-gate.sh` (não inline no YAML, pra evitar inferno de aspas). O script se ancora em `frontend/` (o react-doctor resolve config e escopo pelo diretório de execução) e invoca **diretamente** o binário pinado em `frontend/node_modules/.bin/react-doctor` — não via `npx`, que baixaria a versão mais recente do registry caso as deps não estivessem instaladas, furando o pin. Se o binário estiver ausente, falha fechado pedindo `npm install`. E compara a versão instalada (`node_modules/react-doctor/package.json`) com o pino (`package.json`), falhando fechado na divergência: sem essa guarda, um `node_modules` stale mediria com a versão errada em silêncio — foi como um checkout preso na 0.5.8 rodou o gate por duas minors enquanto o pino já era 0.7.8.

## Como medir a baseline

```bash
cd frontend && npm run react-doctor           # scan completo, contagem por categoria
cd frontend && npm run react-doctor -- --verbose   # cada regra e cada arquivo
```

> **Confiabilidade do scan (0.7.3):** quando o oxlint derruba arquivos por pressão de memória, o react-doctor agora os reprocessa em série, um a um, em vez de reportar um scan parcial como se fosse completo. Só os que falham sozinhos seguem fora, e são reportados. Vale para o mesmo tipo de cegueira que o fallow corrigiu na 3.3 (ver `CODE_QUALITY_TOOLING.md`): antes, a ferramenta podia estar medindo menos do que dizia.

**Este documento não publica a contagem.** Versões anteriores fixavam aqui o score e o número de errors/warnings; toda vez o número envelheceu em silêncio — o bump seguinte, ou qualquer PR de refactor, movia a conta sem que ninguém lembrasse de reeditar a doc, e o leitor passava a confiar num retrato falso. O total vive no comando acima, que leva segundos. O que esta seção documenta é o que o comando **não** conta: por que cada supressão existe (seções abaixo).

Ordens de grandeza, como referência histórica datada — não como estado atual: 17 errors na 0.5.6 (2026-06-15), 8 errors / 118 warnings na 0.5.8 (2026-06-23), 22 warnings e **nenhum error** na 0.7.3 (2026-07-16), 10 errors / 27 warnings na 0.7.8 logo após o bump (2026-07-23), zerados os errors no mesmo dia. A subida daquela penúltima linha veio quase inteira da versão, não do código — o mesmo commit medido com 0.7.3 dá 1 error, com 0.7.8 dá 10 —, e o único error de origem própria (`compare-sync.ts`) passou despercebido porque o `node_modules` do checkout onde o hook rodava estava em 0.5.8, duas minors atrás do pin. A queda anterior dos errors, ao contrário, não veio da versão: o cluster Security foi auditado como FP e silenciado (#203/#242), e o cluster State & Effects (`no-adjust-state-on-prop-change`, `exhaustive-deps`) foi pago por fixes reais nos PRs do épico #239 — `key={identidade}` no pai em vez de effect de sincronização, constante de módulo em vez de dependência instável.

Consequência prática de a contagem estar zerada (errors e warnings): o gate foi endurecido para `--blocking warning`, então agora ele barra qualquer diagnóstico novo — error ou warning — na linha tocada (ver o aviso na seção do gate, acima). O único `no-giant-component` que resta é o de `ComparePage.tsx`, suprimido por arquivo com justificativa e rastreado em #564.

**Rodar sempre o binário pinado, nunca `npx react-doctor@<versão>`.** As duas coisas divergem quando o `node_modules` está stale, e a divergência não é só de contagem: numa medição via `npx` sobre um checkout com 0.5.8 instalado, o `js-set-map-lookups` de `src/actions/assignments.ts` foi reportado na linha 391 — dentro de um bloco de comentário —, enquanto o `.includes()` em loop que o dispara está na linha 650. Com o binário pinado corretamente instalado, a linha sai exata.

## Por que `server-auth-actions` está silenciada em `src/actions/**`

A regra `react-doctor/server-auth-actions` verifica se Server Actions chamam um helper de autenticação reconhecido (por padrão, `auth()` do Clerk). O projeto usa um wrapper próprio, `getAuthUser()` (definido em `frontend/src/lib/auth.ts`), que internamente chama `auth()` mas adiciona resolução do usuário no Supabase. A heurística do react-doctor não reconhece esse wrapper, o que gera dezenas de falsos positivos em actions que estão corretamente autenticadas.

A silenciagem está restrita a `src/actions/**` (escopo onde o padrão é universal e auditável por code review). Não silenciar globalmente.

Se o react-doctor passar a aceitar custom auth helpers (ou se o projeto adotar `auth()` direto), remover este override.

## `only-export-components` ignorada em `src/components/ui/**`

Os componentes shadcn/ui (`ui/button`, `ui/badge`, `ui/tabs`) exportam, além do componente, suas variantes CVA (`buttonVariants`, `badgeVariants` etc.) — convenção intencional do shadcn. A regra `react-doctor/only-export-components` (orientada a Fast Refresh) acusa isso como error. O override silencia a regra **apenas em `src/components/ui/**`** (onde o padrão é da própria biblioteca), mantendo-a ativa no resto do app. Na 0.2.x estes eram os únicos errors do codebase, junto com `server-auth-actions`; com os overrides, a baseline daquela versão era 0 errors. Na 0.5.6 o ruleset expandido introduziu novos errors, desde então pagos (ver "Como medir a baseline"), mas estes dois overrides continuam necessários e ativos.

## Por que `supabase-client-owned-authz-field` está silenciada nos arquivos auditados

A regra `react-doctor/supabase-client-owned-authz-field` acusa código client Supabase que escreve campos de `user`/`tenant`/`owner`/`role` que deveriam ser enforçados pela RLS. Os 4 disparos da baseline foram auditados em #203 e confirmados como FP heurístico — silenciados **por arquivo** (não pela regra inteira, nem por `src/actions/**`), para que a regra continue pegando actions novas:

- `src/lib/auto-review.ts` — a escrita (`assignments.status`, `field_reviews`) passa pelo **admin client** (service-role), que ignora a RLS por design; `status` é estado de workflow, não autz. O uso do admin é deliberado e comentado no arquivo (a policy de `assignments` restringe INSERT a coordenadores; o pesquisador precisa criar a própria fila de revisão).
- `src/actions/assignments.ts` — a regra aponta o parâmetro `userId`; as escritas gravam `type`/`assignment_weight`/`assignment_cap` (operacionais) e são barradas pela policy `Coordinators manage assignments`.
- `src/actions/members.ts` — escreve `role`/`can_resolve`/`can_arbitrate`/`can_compare` via client autenticado, mas a policy `Coordinators manage members` (`USING project_id IN auth_user_coordinator_or_creator_project_ids() OR is_master()`) barra qualquer não-coordenador: o UPDATE afeta 0 linhas e o código retorna "Sem permissão". Não há auto-escalação explorável. A ausência de um *column-level guard* em `project_members` (defesa em profundidade, presente em `projects`/`project_comments`/`schema_change_log`) é a única lacuna real, rastreada em issue-filha de #203 — não é vulnerabilidade, e fechá-la embute decisão de produto (se um coordenador pode alternar as próprias flags).
- `src/actions/projects.ts` — `role: "coordenador"` inserido no bootstrap criador→coordenador, gated pela policy `Creator inserts members` (só permite inserir em projeto cujo `created_by = clerk_uid()`). Intencional; ninguém entra em projeto alheio.

Casos posteriores seguem a mesma política: suprimir no menor escopo possível, com justificativa explícita. Em `src/lib/arbitragem-sync.ts`, a regra aponta o parâmetro `userId`, mas ele é usado só como filtro em `.eq("arbitrator_id", userId)` e `.eq("user_id", userId)` para restringir SELECT/UPDATE às linhas permitidas pelas policies RLS já citadas no arquivo. O payload do UPDATE escreve apenas `status` e `completed_at`; não há escrita client-fornecida de `user_id`, `arbitrator_id`, `role` ou outro campo de autorização. Em `src/lib/coding-sync.ts`, o parâmetro `userId` segue o mesmo padrão nos updates de `assignments` e também é repassado ao gatilho de auto-revisão, cuja escrita via admin client já está auditada em `src/lib/auto-review.ts`. As supressões ficam inline para manter a regra ativa no restante dos arquivos.

`src/lib/compare-sync.ts` entrou na mesma lista em 2026-07-23, pelo motivo mais direto de todos: o arquivo abre com `import "server-only"` na linha 1 — não é código client —, e a linha acusada é a declaração `userId: string;` dentro de uma `interface` de parâmetros. O `userId` é usado como filtro (`.eq(...)`) e o UPDATE escreve apenas `status` e `completed_at`, exatamente o padrão já auditado em `arbitragem-sync.ts` e `coding-sync.ts` no parágrafo acima.

Se algum desses fluxos migrar para depender de coluna client-fornecida sem RLS, **remover o override ou a supressão inline do trecho afetado** e corrigir.

## Por que `supabase-table-missing-rls` está silenciada nas 2 migrations auditadas

A regra `react-doctor/supabase-table-missing-rls` acusa `CREATE TABLE` que não habilita RLS **na mesma migration**. Os 2 disparos (`migrations/20260401000000_clerk_user_mapping.sql` e `migrations/20260402000000_master_users.sql`) foram auditados em #203 e são FP: ambas as tabelas têm RLS habilitada numa migration posterior (`20260407000000_enable_rls_system_tables.sql`) somada a `REVOKE ALL ... FROM anon, authenticated`, e são acessadas só via service-role (`lib/clerk-sync.ts` e `lib/auth.ts`). A proteção existe — só está distribuída entre arquivos, padrão que a heurística não reconhece. Editar migrations já aplicadas em produção para re-habilitar RLS seria no-op.

O override é escopado **às duas migrations específicas**, de propósito: uma `CREATE TABLE` nova sem RLS deve continuar falhando.

## `js-combine-iterations` desligada globalmente

22 ocorrências de `.filter().map()` (e cadeias afins) sobre arrays pequenos — cosmético, sem impacto real de performance no domínio do projeto. Desligada via `rules` (severidade global `off`), não via ignore por caminho.

## `no-multi-comp` ignorada em `src/components/ui/**`

Os compound components do shadcn/Radix declaram, por convenção da biblioteca, vários componentes no mesmo arquivo: `ui/collapsible` (`Collapsible` + `CollapsibleTrigger` + `CollapsibleContent`) e `ui/resizable` (`ResizablePanelGroup` + `ResizablePanel` + `ResizableHandle`). A regra `react-doctor/no-multi-comp` (Maintainability) pede mover cada componente secundário para o seu próprio arquivo, o que quebraria o padrão de import único da lib. O override silencia a regra **apenas em `src/components/ui/**`** (×4 ocorrências na 0.5.6), mesmo escopo e justificativa de `only-export-components`. Fora de `ui/**` a regra continua ativa, onde múltiplos componentes por arquivo é sinal real de arquivo grande demais.

## `exhaustive-deps` suprimida em `src/components/coding/QuestionsPanel.tsx`

Os dois `useEffect` de `QuestionsPanel.tsx` (linhas 179 e 205 na 0.5.6) têm deps estreitas **deliberadas**, já anotadas com `// eslint-disable-next-line react-hooks/exhaustive-deps` no código: um anula respostas de campos condicionais que ficaram invisíveis (FR-203), reagindo só a `visibleNames` para evitar cascata; o outro rola até o campo condicional recém-revelado, também disparando só por `visibleNames`. Incluir as demais deps (`fields`, `answers`, refs) reintroduziria os efeitos em cascata que o design evita. O `eslint-disable` cobre o ESLint, mas o react-doctor mantém a sua própria regra `exhaustive-deps`; o override por arquivo silencia **só este arquivo**. As outras 5 ocorrências de `exhaustive-deps` no app (`MultiOptionReview`, `LlmConfigurePane`, `ReviewCommentsView`, `MyVerdictsView`) **não** foram avaliadas como deliberadas e ficam para a issue de hooks / State & Effects — não suprimir em bloco.

## `js-length-check-first` suprimida em `src/lib/date-parts.ts`

`arePartsValid` (linha 39) faz `parts.every((p, i) => ...)` sobre `DateParts`, uma tuple de **tamanho fixo 3** garantida pelo tipo (`[day, month, year]`). A regra `react-doctor/js-length-check-first` (Performance) sugere checar `.length` antes de iterar — otimização morta aqui, já que o comprimento é constante de tipo e não há array vazio possível. Override por arquivo.

## a11y (`prefer-tag-over-role`, `prefer-html-dialog`, `no-noninteractive-element-interactions`) — avaliada, **não** suprimida

As ocorrências dessas três regras na 0.5.6 — `shell/MobileWarning.tsx:21` (`<div role="dialog">`) e `compare/AnswerCard.tsx` (`<div role="button">` e handler em elemento não-interativo) — são **HTML cru de código de app, não primitivas Radix vendidas**. Diferente de um `role` herdado de uma primitiva da lib (que seria convenção a silenciar), aqui o caminho correto é **refatorar** para o elemento semântico nativo (`<dialog>`, `<button>`). Por isso ficam fora desta supressão de convenção e seguem para a issue de a11y (refactor), não para o `doctor.config.json`. Os FPs antigos da #152 `js-min-max-loop` (`AssignmentTable.tsx`) e `jsx-a11y/label-has-associated-control` (`MemberList.tsx`) não reproduzem mais na 0.5.6 e não exigiram supressão.

## `async-await-in-loop` suprimida inline no upload serial de `useDocumentUpload`

A regra `react-doctor/async-await-in-loop` (Performance) recomenda coletar os itens e usar `await Promise.all(items.map(...))` para rodar trabalho independente em paralelo. Em `src/hooks/useDocumentUpload.ts`, o loop de upload em chunks (`doUpload`) é **serial de propósito** e não pode paralelizar: o progresso é reportado sequencialmente (`setPhase({ kind: "uploading", current: processed, ... })`), e a flag `isLast` é o 3º argumento `revalidate` de `uploadDocuments` — passá-la `true` só no último chunk revalida o cache de documentos uma vez, em vez de uma vez por chunk. Disparar os chunks juntos quebraria as duas garantias.

A supressão é **inline e por linha** — `// react-doctor-disable-next-line react-doctor/async-await-in-loop` imediatamente acima da chamada `await uploadDocuments(...)` —, não um override por arquivo no `doctor.config.json`. Inline é mais estreito: a regra continua ativa no resto do hook (pega qualquer `await`-em-loop novo). A justificativa fica numa linha de comentário **separada** acima da diretiva (o parser da diretiva trata o texto após o nome da regra como rule-ids adicionais, então não se usa o sufixo `-- ...` do ESLint aqui).

O segundo `async-await-in-loop` que existia no mesmo arquivo (o loop de `checkDuplicates`) **não** foi suprimido: como os chunks de hash são independentes e a agregação é comutativa, foi paralelizado de fato (#254, Onda 4) — com teto de concorrência via `mapWithConcurrency` (`src/lib/upload-chunking.ts`, limite `MAX_HASH_CHECK_CONCURRENCY = 6`), para que um CSV gigante não dispare centenas de Server Actions de uma vez. Se o progresso sequencial deixar de ser necessário e a revalidação migrar para fora do loop, remover esta supressão e paralelizar o upload também.

## Bugs residual (Onda 5, #305) — supressões por arquivo

O re-scan da 0.5.8 (2026-06-23) deixou 36 diagnósticos da categoria **Bugs** sem dono (épico #239). A maioria virou fix real (ver PRs de #305): o error `no-adjust-state-on-prop-change` em `AutoReviewFieldPanel` foi resolvido com `key={currentKey}` no pai (remonta ao trocar de doc/campo, dispensando o effect de sincronização) e o `exhaustive-deps` em `ReviewCommentsView` saiu movendo `splitSources` para constante de módulo. Os 4 `server-sequential-independent-await` que apareciam como Bugs na 0.5.8 foram tratados na #236 (PR #307): `reviews.ts` e `suggestions.ts` viraram `Promise.all` de awaits genuinamente independentes, e `equivalences.ts` (read-then-delete de ordem obrigatória) ganhou supressão inline — por isso não há override deles aqui. As supressões abaixo cobrem só os diagnósticos confirmados como FP ou design intencional, auditados contra o validation-prompt canônico de cada regra.

- **`no-event-handler` (foco pós-render)** em `AutoReviewJustificationInput.tsx` e `ComparisonPanel.tsx` (os arquivos listados no `doctor.config.json`): os effects focam um elemento (`textarea`/`button`) **depois** que uma escolha/conclusão o renderiza. A recipe da regra ("mover para o handler que mudou o state") não se aplica: o alvo do foco só existe no DOM após o re-render disparado pela mudança de state, então `focus()` precisa rodar num effect, não no handler. Override por arquivo.
- **`no-event-handler` (subscription externa)** em `usePinnedDoc.ts:43,58`: o state lido (`pinnedDocId`) vem de `useSyncExternalStore` subscrito a eventos de `sessionStorage`/`PINNED_DOC_EVENT`. É o FP explícito do validation-prompt (state de subscription externa que o handler não observa). O effect faz cleanup legítimo do doc órfão. Override por arquivo.
- **`no-event-handler` (revalidação do Server Component)** em `useCompareNavigation.ts:92`: o effect reage a `documents`, atualizado pela revalidação do Server Component (`revalidatePath`) — não por um handler local do componente — para disparar um toast único quando o doc fixado some da fila. Mesmo FP explícito do `usePinnedDoc.ts` acima (state setado por sistema externo que o handler não observa). Diagnóstico introduzido pelo PR #347 (2026-07-02), fora do escopo original do épico #239/#339; fechado aqui como cauda residual. Override por arquivo.
- **`no-chain-state-updates` + `no-derived-state`** em `useDocumentText.ts:76`: `setCache` e `setFailed` ficam em `.then`/`.catch` **independentes** do mesmo fetch — não há encadeamento síncrono nem derivação de state. `loading`/`error` já são derivados em render (não há useState para eles). O hook é bespoke por decisão registrada (mapa `failed` separado do `cache` para retry semântico — erro não envenena o cache; não migra para `useCachedResource`). Override por arquivo, duas regras.
- **`no-array-index-as-key`** em `AssignmentTable.tsx:201`, `OptionsEditor.tsx:54`, `ValidationErrorPanel.tsx:76` e `ExportPanel.tsx:229`: nenhum dos quatro perde estado de React no reorder. `AssignmentTable` mapeia um array local append-only (`tooltipParts`) montado a cada render; `ValidationErrorPanel` (`<li>`) e `ExportPanel` (preview `<td>`) são listas read-only sem estado por item; `OptionsEditor` renderiza `<Input value={opt}>` **controlado** pelas props (sem estado interno a perder) sobre `string[]` que pode duplicar — sem identidade estável possível, e a remoção já move o foco para o botão. Override por arquivo.

## Quick wins (Fase 0, #353) — supressões documentadas

Fase 0 do épico #239 (rastreada por #339): PR de baixo risco que remove 5 warnings baratos da 0.5.8 **sem decompor componentes**. Um foi resolvido por deleção de causa raiz, os outros 4 por supressão auditada.

- **`deslop/unused-file`** em `src/lib/supabase/client.ts`: **deletado, não suprimido.** Órfão (zero imports em `src`); a única export `createBrowserClient` usava o template JWT antigo `getToken({ template: "supabase" })`, morto após a migração de auth RS256 (#299/#309). Fix de causa raiz.
- **`no-giant-component`** em `src/app/(app)/projects/[id]/analyze/compare/page.tsx:59` (`ComparePageRoute`, 491 linhas) e `src/app/(app)/projects/[id]/reviews/comments/page.tsx:8` (`CommentsPage`, 433 linhas): override **por arquivo**, escopado só a estes 2 **page-level route components** (a #339 endossa suprimir esses — são fronteiras de rota, não unidades reusáveis a decompor). A regra segue ativa nos disparos que **não** são route components (`LotteryDialog.tsx`, `DocumentsPageClient.tsx`), que ficam para refactor real numa fase posterior — desligar a regra global os mascararia.
- **`no-giant-component`** em `src/components/compare/ComparePage.tsx` (497 linhas, cognitive 89): override **por arquivo**, com a ressalva de que **este é um componente reusável, não um route component** — a política acima manda refatorar, não suprimir. A supressão é **temporária e rastreada em #564**. No bump 0.7.8 tentei a decomposição de fato (extrair a orquestração num hook `useComparePageController`): reduzia o máximo de cognitive de 89 para 42+29, passava em react-doctor, typecheck e nos 127 testes de `compare`, mas **esbarrava no gate `new-only` do fallow** — a complexidade transplantada conta como introduzida e um único controller a cognitive 42 segue acima do limiar. Passar exigiria fatiar o controller em 3–4 sub-hooks focados, refactor de risco alto no hot-path da Comparação que não cabia num PR de limpeza de lint feito sem supervisão. O `SchemaEditor`, o outro `no-giant-component` do mesmo bump, **foi decomposto** (costura limpa: 4 handlers de ação → `useSchemaEditorActions`, sem achado novo no fallow) — por isso não aparece aqui. Ao decompor o `ComparePage` (via #564), remover este override.
- **`no-json-parse-stringify-clone`** em `src/lib/__tests__/lottery-utils.test.ts:518`: supressão **inline**. Deep clone (`JSON.parse(JSON.stringify(...))`) de uma fixture plana de `coOccurrence` para snapshot do teste de imutabilidade — FP legítimo em arquivo de teste; o objeto não tem `Date`/`Map`/`undefined` que o round-trip perderia.
- **`async-defer-await`** em `src/components/shared/RunLlmButton.tsx:62`: supressão **inline**. O `await requireSupabaseToken(getToken)` roda antes do guard de cancelamento **de propósito** — o token do template expira em ~60s e precisa estar fresco quando a request de status parte a cada poll; mover o await para baixo do guard atrasaria a renovação. Mesma razão da supressão inline que já existia logo abaixo, no `await fetchFastAPI` do mesmo `poll` (esta é a 2ª ocorrência da regra no mesmo bloco; diagnóstico novo, não previsto na #339).

## Supressões da 0.7.8 (#534) — regras novas contra padrões deliberados

As três supressões abaixo têm uma característica em comum que vale registrar: **o código que elas acusam foi escrito exatamente para satisfazer outras regras**, do próprio react-doctor ou do `eslint-plugin-react-hooks`. Não são dívida técnica; são a ferramenta discordando de si mesma entre gerações de regra. Antes de "corrigir" qualquer um destes trechos de volta, ler o comentário que já existe no código — ele nomeia a regra que a forma anterior violava.

- **`effect-needs-cleanup`** em `src/hooks/useLlmRunProgress.ts:159`: FP verificável. O effect **tem** cleanup — `return () => { cancelled = true; if (timer) clearTimeout(timer); }` no fim do bloco —, mas a regra não consegue seguir o `timer` porque ele é declarado com `let` fora de `tick` e reatribuído dentro do closure a cada reagendamento do polling. A forma que a regra reconheceria (`const id = setTimeout(...)` no corpo do effect) é incompatível com um timer auto-reagendado. Override por arquivo.
- **`no-prop-callback-in-render`** em `src/hooks/useResetOnKeyChange.ts:22`: é o padrão que a documentação do React chama de "adjusting state when a prop changes", e a docstring do hook (linhas 5–14) já enumera por que as duas alternativas não servem — `useRef` como espelho do valor anterior cai em `react-hooks/refs` (refs não podem ser lidas/escritas no corpo do hook), e um `useEffect` dispararia um render **depois** da troca da chave, pintando um frame stale. Override por arquivo.
- **`no-ref-current-in-render`** em `src/components/compare/ComparePage.tsx:194,207`: os dois guards de render que re-semeiam o comentário e descartam o veredito pendente ao trocar o par (doc, campo). O comentário nas linhas 173–182 registra a cadeia de decisões: o guard de render substituiu um `useEffect` **para zerar `no-derived-state`**, e o prev-tracker é `useRef` em vez de `useState` **para não recair em `rerender-state-only-in-handlers`**. Migrar para `useResetOnKeyChange` (que usa `useState`) só trocaria este diagnóstico pelo `no-prop-callback-in-render` do item anterior. Override por arquivo.

Os outros cinco errors da 0.7.8 eram defeito real e foram corrigidos, não suprimidos — os dois `no-effect-with-fresh-deps` de `ComparePage` (arrows inline no array de deps de `useCompareKeyboard` religavam o listener de `keydown` a cada render; viraram `useCallback`, o que também matou os dois `exhaustive-deps` das mesmas linhas), os dois `no-impure-state-updater` (`AutoReviewFooter`, `AgreementGroup`) e o `no-hydration-branch-on-browser-global` de `DocumentList`. Este último era divergência de hidratação de verdade: a URL do botão de copiar era montada no render com `window.location.origin`, que o servidor emite como `""`. A correção eliminou o estado em vez de sincronizá-lo — `CopyLinkButton` passou a resolver a URL absoluta **no clique**, via `new URL(url, window.location.href)`, o que serve tanto às URLs relativas do app quanto às absolutas de `parecerUrl` sem ramo por tipo.

## `js-set-map-lookups` suprimida em `clerk-sync.ts` e `schema-utils.ts`

A regra acusa `array.includes()` dentro de laço e pede um `Set`. Ela pressupõe que o array pesquisado é **compartilhado** entre as iterações — é aí que a troca paga. Dos 11 disparos da 0.7.8, oito eram desse tipo e viraram `Set` de fato. Os três suprimidos aqui não são:

- `src/lib/clerk-sync.ts:450` — `getVerifiedEmailIdentity(user)?.verifiedEmails.includes(email)` roda dentro de `users.filter(...)`, mas `verifiedEmails` é a lista **daquele usuário**: um `Set` teria de ser construído por iteração, para uma única consulta, o que é estritamente pior que o `includes`. Some-se que o `getUserList` acima limita a busca a `limit: 2`.
- `src/lib/schema-utils.ts:278,290` — `c.in.includes(removedOption)` e `c.not_in.includes(removedOption)` percorrem a condição **de cada campo**, procurando um único valor. Mesmo caso: array por item, uma consulta só.

Se algum desses laços passar a consultar um array compartilhado, remover o override — a regra continua ativa no resto do projeto e pegou os oito casos legítimos sem ajuda.

## Regras que deixaram de ser FP

`server-no-mutable-module-state` deixou de ser FP após o uso de `Object.freeze()` em `TAG_PROFILE` (ver `actions/documents.ts` e `actions/members.ts`) e em `AUTOMATION_MODE_VALUES` (`actions/projects.ts`).
