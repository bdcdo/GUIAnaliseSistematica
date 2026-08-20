# dataframeitGUI

Plataforma web para analise de conteudo de documentos. Coordenadores definem perguntas (Pydantic), atribuem documentos a pesquisadores, rodam LLM. Pesquisadores codificam e revisam. Comparacoes automaticas quando ha N+ respostas para o mesmo documento.

Documento normativo do projeto: `.specify/memory/constitution.md` (constituicao v1.0.0 — principios de usabilidade, velocidade, seguranca, RLS, testes, a11y, schema e simplicidade de stack). Em conflito, a constituicao prevalece sobre este guia.

## Arquitetura

```
Browser  →  Next.js 16 (Vercel)  ←→  Supabase (Postgres + RLS)
                |                            ^
                | Clerk (Auth + JWT)         |
                | HTTP (LLM + Pydantic)      |
                v                            |
            FastAPI (Fly.io)  ───────────────┘
              |-- dataframeit           (service key)
              |-- Pydantic compiler
```

## Convencoes

- **Portugues** para UI (labels, mensagens), **ingles** para codigo (vars, funcs, types)
- **Brand color**: teal #2F6868 = `oklch(0.44 0.08 185)`
- **Alvo e desktop/mouse, nao toque**: a plataforma e acessada via computador. Otimizar densidade e alvos de clique para mouse — nao aplicar o minimo de 44px de toque. Em caso de tradeoff, priorizar densidade de informacao.
- **shadcn/ui** para todos os componentes de UI
- **Decisoes de UI e seus porques** (codificacao em lista e deliberada, codigo Pydantic somente-leitura, veredito em dois passos): **`docs/UI.md`**. Antes de propor mudanca de interface que pareca "corrigir uma regressao", conferir la se a forma atual nao e escolha registrada. O arquivo so guarda intencao — descricao de tela e medida em pixel vivem no codigo, deliberadamente (ver #611).
- **Server Actions** para mutations, **RSC** para reads
- Auth: Clerk (`lib/auth.ts` para `getAuthUser()`, `lib/clerk-sync.ts` para sync Clerk↔Supabase)
- Supabase client: `lib/supabase/server.ts` (server, autenticado via Clerk JWT) e `lib/supabase/admin.ts` (service key)
- **FastAPI** so para LLM e Pydantic (nao para CRUD)
- **EditFieldDialog**: toda config de schema acessivel na aba Schema deve ser igualmente acessivel via `EditFieldDialog` inline (Comentarios e LLM Insights). Ao adicionar um campo novo a `PydanticField`, garantir que ambos os editores (FieldCard e EditFieldDialog) o exponham.
- **Pydantic = fonte de verdade do schema**: toda propriedade de `PydanticField` (inferida do schema Zod em `frontend/src/lib/pydantic-field.ts`) deve ser transportada no codigo Pydantic gerado — via annotation, `Field(...)` ou `json_schema_extra={...}`. E proibido depender apenas do JSON em `projects.pydantic_fields` para reconstruir um campo. Motivo: garantir que `projects.pydantic_code` seja fonte de verdade reconstruivel — o `llm_runner` recria o modelo a partir dele (via `build_model_from_code`) para rodar o LLM, e o round-trip `UI -> pydantic_code -> compile_pydantic -> UI` precisa ser completo sem depender do JSON. (A edicao manual do codigo Pydantic foi descontinuada no PR #197: o codigo e read-only na UI e sempre gerado pela GUI; ainda assim a completude e exigida para a reconstrucao no backend e para o round-trip.) Ao adicionar um campo novo a `PydanticField`, atualize:
  - (a) `generatePydanticCode()` em `frontend/src/lib/schema-utils.ts` para emitir a propriedade;
  - (b) `compile_pydantic()` em `backend/services/pydantic_compiler.py` para le-la de volta;
  - (c) as primitivas de versionamento/auditoria em `frontend/src/lib/schema-utils.ts` — `snapshotOf`, `diffFields`, `fieldDiffIsStructural` — para que a mudanca da propriedade seja classificada (minor/patch) e registrada em `schema_change_log`. Essas primitivas sao puras e compartilhadas entre `saveSchemaFromGUI` e scripts fora do Next runtime, justamente para evitar drift (ver #63). **Nao edite `classifyChange`**: ele e derivado de `diffFields` + `fieldDiffIsStructural`, e e essa derivacao que sustenta a invariante `classifyChange != null ⇒ diffFields != []` de que o save depende (a RPC recusa log vazio);
  - (c2) se a propriedade tiver **default implicito** (ausente significa um valor, e nao "sem valor"), declare o default uma unica vez como resolvedor em `frontend/src/lib/pydantic-field.ts` — junto dos que ja existem, cuja lista canonica e o proprio arquivo — e use o resolvedor em todo consumidor; nunca re-derive o default com `?? x` / `!== y` / `Boolean(...)` no call site. Motivo: `snapshotOf` e a serializacao canonica que define "campo igual" para a deteccao de dirty, para `sameFieldContent` e — propriedade a propriedade — para `mergeFieldProperties`, enquanto `diffFields` decide o versionamento e o diff de historico le o payload gravado; quando esses pontos normalizavam diferente, um campo sem `target` divergia de um com `target: "all"` e o merge acusava "editado remotamente" sem edicao, `Boolean(null)` fazia o historico nao renderizar a mudanca de obrigatoriedade, e um campo legado sem `subfield_rule` virava MINOR quando o `EditFieldDialog` promovia o default a explicito. Nao use `.default()` no Zod: o codigo depende de `undefined` ser distinguivel (a UI grava `required: undefined` para "obrigatorio").
    **Nao crie uma segunda tabela propriedade→resolvedor.** `mergeFieldProperties` (`schema-merge.ts`) compara indexando `snapshotOf`, e nao os campos crus, justamente para que a normalizacao seja unica por construcao em vez de por acordo mantido a mao — o teste em `schema-draft.test.ts` fixa a equivalencia de chaves de que isso depende. Uma tabela paralela ali ja fabricou conflito de merge tres vezes (`hash`, `target`, `subfield_rule`), uma por rodada de revisao;
  - (d) o diff de historico em `frontend/src/lib/schema-change-diff.ts` (`FieldPropertyDiff`, `diffPydanticField`) e `frontend/src/lib/schema-change-format.ts` (`PROPERTY_LABELS`), consumidos pelo renderizador `FieldChangeDiff.tsx`.
  - (e) o schema Zod fail-closed em `frontend/src/lib/pydantic-field.ts`, que define `PydanticField`, valida os dados persistidos e recupera rascunhos locais sem aceitar propriedades desconhecidas. A propriedade nova deve ser declarada uma unica vez nesse schema e ganhar teste de round-trip do draft.

  **Cuidado com o `pydantic_hash`**: `projects.pydantic_hash` e sha256 do **texto** do codigo gerado, entao emitir uma chave nova em `json_schema_extra` muda o hash de todo projeto afetado no proximo save — e respostas LLM legadas (sem `answer_field_hashes` e sem semver gravado) tem esse hash como unico vinculo com o schema, logo saem da fila de Comparacao (ver `20260505000001_revive_orphan_llm_responses.sql`). Por isso o padrao e **emitir apenas o caso nao-default**: assim o texto fica byte-identico para quem nao usa a propriedade. `computeFieldHash` (`name|type|options|description`) nao e afetado.

  **Direcao registrada (constituicao, Principios III e VII)**: por seguranca, a representacao canonica do schema deve migrar de codigo Pydantic (Python compilado no backend a partir de texto editavel por usuario) para JSON declarativo. Ate essa migracao acontecer, todas as regras (a)–(e) acima valem integralmente; qualquer migracao deve preservar o round-trip completo e o versionamento em `schema_change_log`.
- Testes: **Vitest** (frontend), **pytest** (backend)

## Supabase CLI

Projeto remoto: `nryebmwlmxuwvynfuzsv` (extraido de `NEXT_PUBLIC_SUPABASE_URL` em `frontend/.env.local`).

Antes de rodar qualquer comando `supabase` (db push, migration list, etc.):

```bash
cd frontend
# Exportar token (obrigatorio para CLI)
export SUPABASE_ACCESS_TOKEN=$(grep SUPABASE_ACCESS_TOKEN .env.local | cut -d= -f2)
# Linkar se necessario (idempotente, nao falha se ja linkado)
npx supabase link --project-ref nryebmwlmxuwvynfuzsv
```

Para aplicar migrations pendentes: `npx supabase db push`

## Deploy

Deploy e automatico a partir de merge no branch `main`. Frontend: Fly.io (app `gui-analise-sistematica-frontend`), servindo `dataframeit.com.br` — o cutover de dominio ja ocorreu, e foi a queda dessa app que tirou o site do ar em 2026-08-10. Backend: Fly.io (app `gui-analise-sistematica-api`) via workflow quando ha mudanca em `backend/**`. A partir de 2026-04-20, **preferir branch + PR** ao push direto na main. Fluxo recomendado:

1. **Criar git worktree isolado** para a tarefa (ver secao "Workspace isolado" abaixo) — nao trabalhar no diretorio principal
2. Criar branch descritiva (`feat/...`, `fix/...`, `perf/...`) na worktree
3. Commitar nela
4. Ao final, abrir PR contra `main` via `gh pr create`
5. Deixar o usuario revisar o PR
6. Remover a worktree apos o merge

Merge do PR pode ser feito pelo Claude quando o usuario pedir explicitamente.

## Workspace isolado (worktree)

**Sempre trabalhar em git worktree separado**, nunca no diretorio principal. Motivo: o usuario pode continuar trabalhando em outra branch no diretorio principal em paralelo. Se Claude usar `git checkout` para trocar de branch ali, sobrescreve o working tree do usuario; e se o usuario trocar a branch enquanto Claude edita, os arquivos editados ficam "perdidos" no historico de outra branch.

Criar a worktree no inicio da tarefa:

```bash
git worktree add ../worktrees/<descricao-curta> -b <branch-name>
cd ../worktrees/<descricao-curta>
```

Trabalhar la (todos os edits, commits, push, `gh pr create`). Apos o merge do PR:

```bash
cd /home/brunodcdo/Desktop/OpenClaw/LabDados/dataframeitGUI
git worktree remove ../worktrees/<descricao-curta>
```

Excecao: tarefas read-only puras (responder duvida, ler codigo, explicar arquitetura) podem ser feitas no diretorio principal sem worktree.

## Como rodar

```bash
# Backend (nao esta em script de manifest)
cd backend && uv run uvicorn main:app --reload
```

Demais comandos: scripts em `frontend/package.json` (`dev`, `lint`, `typecheck`, `lint:types`, `react-doctor`, `fallow`, `scan`, `test:e2e`, `invariants`, `test:db:*`). Duas ressalvas que o script nao conta: o `scan` precisa de `npm run dev` rodando, e o `test:e2e` roda permissivo na mao mas como gate fail-closed no pre-push.

A stack de qualidade cobre quatro eixos — react-doctor (React no arquivo), **fallow** (grafo do codebase), **typescript-eslint type-checked** (tipos), **React Scan** (runtime) — mais **ruff** no backend Python, **actionlint** e o teste comportamental dos workflows de deploy, **Vitest/Playwright/pytest** (testes) e **Dependabot + semgrep** (segurança, sobre o gitleaks já existente). O princípio é que **nada depende de lembrar de rodar**: os hooks de `.pre-commit-config.yaml` disparam sozinhos, divididos em dois estágios — pre-commit (leve/file-scoped: gitleaks, ruff, actionlint, deploy notifier, react-doctor) e pre-push (pesado/grafo: typecheck, vitest, e2e-smoke, lint:types, fallow audit, semgrep, backend-pytest, mypy). Setup (1x): `cd frontend && npm install && uv tool install pre-commit && pre-commit install` (instala os dois estágios). Cada gate grandfathers o débito legado quando aplicável (new-only no fallow/semgrep, file-scoped no ruff/lint:types/mypy, line-scoped no react-doctor); vitest, e2e-smoke e backend-pytest rodam como gates de teste. Decisão completa, baselines e o que foi diferido (tsgo, mypy, Biome) em **`docs/CODE_QUALITY_TOOLING.md`**; baseline e regras silenciadas do react-doctor em `docs/LINT_CONFIG.md`.

**Estratégia de verificação** (o que exige qual nível de verificação; práticas anti-"codificação não salva": discriminador escrita-vs-exibição, prova do vermelho, replay com dados de produção, invariantes de banco via `npm run invariants`): **`docs/VERIFICATION.md`**. Antes de tocar o write path de codificações/comparações, RLS ou migrations, classificar a mudança pela escala de tiers de lá.

O **react-doctor** roda como hook **local de pre-commit**, line-scoped, via `frontend/scripts/react-doctor-gate.sh` nos commits que tocam `frontend/**/*.{ts,tsx}`: **bloqueia se a linha alterada produzir qualquer diagnóstico** — error ou warning. O débito legado fica grandfathered. O script também falha fechado quando o `react-doctor` instalado diverge do pino do `package.json`, caso em que um `node_modules` stale mediria com a ferramenta errada. Por ser local e opt-in, é rede de proteção do dev, não portão de merge no servidor. Versão pinada, config (fonte única) e regras silenciadas: `frontend/package.json`, `frontend/doctor.config.json` e `docs/LINT_CONFIG.md`.

## Scripts one-off de dados / específicos de projeto

Scripts pontuais que operam sobre os dados de **um projeto específico** (dedup, correção de import, migração de dados ad hoc, re-OCR) **não vão para o repositório geral**: vivem em `pipeline-processos/` (gitignored), junto dos outros utilitários locais do Zolgensma. Motivo: carregam IDs e suposições de um projeto/dataset, não são reutilizáveis nem revisáveis como código de produto, e versioná-los polui o repo e expõe dados do banco (backups). Quando precisar resolver o `.env.local`, use caminho canônico do `frontend/` ou a env var `SUPABASE_ENV_PATH` — nunca suba a árvore de diretórios.

Vai para o repo (PR normal) só a **correção de causa raiz genérica** que decorre desse trabalho — migration, mudança de comportamento no app, teste. Exemplo concreto (2026-06-23): as duplicatas de `documents` por re-import (projetos Zolgensma `0c6394da` e Zolgensma-Judiciário `00779233`) foram resolvidas por scripts locais em `pipeline-processos/dedup/`; o que entrou no repo foi a **migration do índice único parcial** `documents_project_external_id_active_uniq` (`UNIQUE(project_id, external_id) WHERE external_id IS NOT NULL AND excluded_at IS NULL`) + o **filtro defensivo** `filterActiveExternalIdConflicts` em `uploadDocuments`, que pula external_ids já ativos ou repetidos no lote em vez de deixar o INSERT em lote falhar inteiro.

## Performance — Regras de Arquitetura

Seguir estas regras para evitar regressoes de performance:

### Queries Supabase
- **Nunca usar `.select("*")`** — sempre listar colunas explicitas (ex: `.select("id, title, created_at")`)
- **Nunca buscar todos os registros sem `.limit()`** em paginas que podem ter muitos dados
- **Usar `count()` do Supabase** ao inves de buscar registros so para contar: `.select("*", { count: "exact", head: true })`
- **Usar agregacao via join** quando possivel: `.select("id, responses(count)")` ao inves de query separada
- **Paralelizar queries independentes** com `Promise.all()` — nunca fazer queries sequenciais que nao dependem uma da outra
- **Evitar N+1** — nunca fazer UPDATE/INSERT em loop. Usar `Promise.all()` para batch ou queries `.in()`
- **Fetch em 2 fases para dados pesados** — primeiro buscar metadados leves para filtrar, depois buscar campos pesados (ex: `text`) so do que precisa

### Componentes pesados
- **Lazy-load Monaco** via `dynamic()` — ja feito corretamente
- **Nao adicionar dependencias pesadas** sem lazy-load (monaco, markdown renderers)
- **Manter `'use client'` o mais baixo possivel** na arvore de componentes

### Supabase indexes
- Toda nova tabela que participa de RLS precisa de index nas colunas usadas por `auth_user_project_ids()` (tipicamente `user_id` e `project_id`)
- Queries frequentes com `.eq()` em colunas sem index devem ter index criado via migration

## Fase atual: 10 - Todas as fases implementadas (scaffold completo)

Ver `docs/PHASES.md` para roadmap completo.

<!-- SPECKIT START -->
For additional context about technologies to be used, project structure, shell commands, and other important information, read the current plan: `specs/004-export-original-metadata/plan.md` (feature ativa; artefatos em `specs/004-export-original-metadata/`).
<!-- SPECKIT END -->
