# Roadmap: Fases 11-15

> **Copiar este conteudo para criar a issue #6 no GitHub.**
> Titulo: `Roadmap: Fases 11-15`

---

## Estado atual

Fases 0-10 completas (scaffold funcional end-to-end): auth, projetos, documentos, atribuicoes, codificacao humana, classificacao LLM, comparacao/revisao, stats e export. Agora o foco e resolver as **5 issues abertas** reportadas por usuarios e adicionar testes.

## Mapa de issues → fases

| Issue | Titulo | Complexidade | Fase |
|-------|--------|:------------:|:----:|
| #3 | Centralizar bolinhas de perguntas | S | 11 |
| #2 | Tornar codificacao mais responsiva e adicionar atalhos | M | 11 |
| #1 | Gerar URL unico por documento | M | 12 |
| #4 | Permitir que algumas perguntas sejam so para robo | L | 13 |
| #5 | Trocar para o WorkOS | L | 14 |
| — | Testes (Vitest + pytest) | M | 15 |

---

## Fase 11 — Quick Wins (issues #3, #2)

### #3 Centralizar bolinhas de perguntas
- Ajustar CSS do `ProgressDots` e seu container no `QuestionBanner` para centralizacao visual perfeita
- **Arquivos:** `ProgressDots.tsx`, `QuestionBanner.tsx`

### #2 Codificacao responsiva + atalhos
- Atalhos de teclado no `FieldRenderer`: teclas `1-9` para selecionar opcao em single-select, `Enter` avanca, `Backspace` volta
- Layout responsivo mobile: `QuestionBanner` (max-h adaptativo), `DocumentReader` (fonte/padding), `DocumentNav` (stack vertical em telas pequenas)
- Overlay de ajuda de atalhos (dialog ativado por `?`)
- **Arquivos:** `FieldRenderer.tsx`, `QuestionBanner.tsx`, `CodingPage.tsx`, `DocumentReader.tsx`, `DocumentNav.tsx`

---

## Fase 12 — URL unico por documento (issue #1)

- Criar rota `/projects/[id]/documents/[docId]` mostrando texto completo, metadata, respostas existentes, e link para codificar
- Botao copiar URL na `DocumentList`
- Deep link para codificacao via query param `?doc=<docId>` (usar `nuqs`)
- **Arquivos:** nova page `documents/[docId]/page.tsx`, `DocumentList.tsx`, `CodingPage.tsx`

---

## Fase 13 — Perguntas so para robo (issue #4)

- Novo campo `respondent_scope: "all" | "human" | "llm"` no tipo `PydanticField`
- UI no `PydanticEditor` para configurar scope por campo (toggle pessoa/robo/ambos)
- `CodingPage` filtra campos para mostrar apenas `all` e `human` a pesquisadores
- LLM runner usa todos os campos (incluindo llm-only)
- Badge visual na `ComparePage` para campos llm-only
- Sem migration necessaria (JSONB ja flexivel)
- **Arquivos:** `types.ts`, `PydanticEditor.tsx`, `schema.ts`, `CodingPage.tsx`, `pydantic_compiler.py`, `llm_runner.py`, `ComparePage.tsx`

---

## Fase 14 — Migrar para WorkOS (issue #5)

- Instalar `@workos-inc/nextjs`
- Criar `lib/workos.ts` e `lib/auth.ts` centralizados
- Substituir magic link (Supabase Auth) por WorkOS AuthKit
- Migrar middleware para verificacao de sessao WorkOS
- Nova migration: desvincular `profiles.id` de `auth.users`, adicionar `workos_user_id`
- Adaptar RLS helper functions para usar service role com user ID do WorkOS
- Manter Supabase apenas para DB (sem auth)
- **Arquivos:** `middleware.ts`, `login/page.tsx`, `callback/route.ts`, `server.ts`, `client.ts`, nova migration SQL

> **Nota:** Issue mais complexa. Requer mudancas em quase todos os arquivos que usam auth.

---

## Fase 15 — Testes

- **Frontend (Vitest):** `ProgressDots`, `FieldRenderer`, `QuestionBanner`, Server Actions (mock Supabase)
- **Backend (pytest):** `pydantic_compiler` (parse + scope), `llm_runner` (filtragem por scope)
- **Arquivos a criar:** `frontend/src/__tests__/`, `backend/tests/`

---

## Ordem de execucao

```
Fase 11 (Quick wins)  →  Fase 12 (URL unico)  →  Fase 13 (Perguntas robo)  →  Fase 14 (WorkOS)  →  Fase 15 (Testes)
```

Cada fase e independente e pode ser implementada em uma PR separada.
