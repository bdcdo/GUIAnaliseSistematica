# Decisões de UI

Este arquivo registra **decisões de interface e os motivos delas** — o que foi escolhido deliberadamente e por quê, incluindo alternativas que já foram tentadas e abandonadas. É o tipo de informação que não se recupera lendo o código: quem abre `QuestionsPanel.tsx` vê *o que* a tela faz, nunca *por que* ela deixou de fazer outra coisa.

O que este arquivo **não** é: não descreve telas, não cataloga componentes, não fixa medidas em pixels e não enumera atalhos. Regra de manutenção, em uma frase: **se uma afirmação pode ser conferida abrindo um componente, ela não pertence aqui**. Descrição de tela envelhece a cada PR e não há gate automático que detecte prosa divergindo de implementação — foi assim que os antigos `UI_SPEC.md`, `COMPONENTS.md` e `ARCHITECTURE.md` chegaram a descrever uma interface que não existia mais, e por isso foram aposentados (ver [#611](https://github.com/bdcdo/dataframeitGUI/issues/611)).

Princípios gerais de interface — alvo desktop/mouse sem mínimo de toque de 44px, densidade de informação sobre espaçamento, brand color teal, acessibilidade WCAG 2.1 AA, shadcn/ui como única biblioteca de componentes — vivem em `.specify/memory/constitution.md` (Princípio VI e a seção de Restrições) e no `CLAUDE.md`. Não são repetidos aqui.

## Codificação é uma lista vertical de todos os campos

A tela de codificação apresenta todas as perguntas de uma vez, em lista rolável ao lado do texto do documento. O modelo focado — uma pergunta por vez, com banner na parte inferior e navegação por setas — existiu até `ec0f63fb` (16/03/2026) e foi abandonado deliberadamente.

O motivo é a natureza do material: a ordem em que as informações aparecem varia de documento para documento, então quem codifica precisa pular entre perguntas conforme encontra cada trecho, e não avançar numa sequência fixa. Há feedback de pesquisadores contra o modo focado. A decisão foi reafirmada em 27/07/2026, durante a investigação que originou a [#611](https://github.com/bdcdo/dataframeitGUI/issues/611) — onde a documentação desatualizada quase levou a "consertar" a tela de volta ao modelo abandonado.

Não reabrir sem novo levantamento com os pesquisadores que usam a plataforma.

## O código Pydantic é gerado pela GUI e somente-leitura

O schema é editado pelo editor visual; o código Pydantic correspondente é gerado a partir dele e exibido sem permitir edição manual, decisão tomada no PR [#197](https://github.com/bdcdo/dataframeitGUI/pull/197).

É uma decisão de segurança, não de conveniência: o Princípio III da constituição trata a compilação de código Python editável por usuário no backend como superfície de ataque a eliminar, e registra a direção de migrar a representação canônica do schema para JSON declarativo. Enquanto essa migração não ocorre, permitir edição manual do código ampliaria justamente a superfície que se pretende reduzir.

A completude do código gerado continua sendo exigida por outro motivo — o round-trip `UI → pydantic_code → compile_pydantic → UI` e a reconstrução do modelo pelo `llm_runner`. As regras estão no `CLAUDE.md`, na seção de convenções.

## O veredito da Comparação exige confirmação em dois passos

Escolher uma resposta na tela de comparação não grava o veredito: a escolha fica pendente e só é efetivada por uma confirmação explícita. O modelo anterior gravava e avançava no mesmo gesto.

A mudança veio de perda silenciosa observada em produção ([#417](https://github.com/bdcdo/dataframeitGUI/issues/417), [#430](https://github.com/bdcdo/dataframeitGUI/issues/430), corrigida no PR [#434](https://github.com/bdcdo/dataframeitGUI/pull/434)): com gravação implícita, uma navegação que acontecesse antes de a escrita concluir descartava o veredito sem que nada na tela indicasse a falha. O passo de confirmação existe para que o gesto de decidir e o de gravar sejam o mesmo evento, observável pelo usuário.

## A fila de codificação abre no trabalho pendente, e "Ordem de atribuição" ordena por estado

O modo "Ordem de atribuição" não é cronológico — `assignments` não tem `created_at`, então não há ordem de atribuição a recuperar. Ele ordena pelo estado do assignment, com o que exige trabalho primeiro: pendente, em andamento, concluído. Sem `?doc=` na URL, a tela abre na primeira codificação incompleta, com fallback para o primeiro item da ordenação escolhida.

A ordem é declarada em `sortByAssignmentStatus` e não delegada ao banco por um motivo específico: até a [#608](https://github.com/bdcdo/dataframeitGUI/issues/608) a query usava `ORDER BY status`, que ordena pelo **alfabeto do enum** — `concluido` < `em_andamento` < `pendente` —, e por isso a fila abria justamente no que a pesquisadora já tinha terminado. Um enum ordenado por acaso é acoplamento invisível: renomear um dos valores mudaria a fila sem nenhum gate reclamar.

A peça originalmente planejada — abrir no primeiro documento *nunca respondido* — foi descartada depois de medida, em 27/07/2026: nas filas dos dois projetos ativos, nenhum dos 13 pesquisadores tinha documento nunca respondido, e os concluídos da rodada atual já saem no filtro server-side. O que se encontrava na frente da fila eram respostas completas devolvidas por mudança de rodada, que exigem ação. Priorizar o "nunca tocado" não morderia em nenhuma fila real e contradiria o propósito do modo "Codificados recentemente", que existe para retomar de onde parou.

## Onde procurar o que este arquivo não descreve

- **Mapeamento entre tipo de campo e controle de formulário** (incluindo campos de data, grupos de subcampos e a opção "Outro"): `frontend/src/components/coding/FieldRenderer.tsx` — é a fonte única, e reproduzi-lo em prosa apenas criaria uma cópia para divergir.
- **Atalhos de teclado da Comparação**: implementados em `frontend/src/components/compare/useCompareKeyboard.ts` (o caminho de campo `multi` tem tratamento próprio em `MultiOptionReview.tsx`). `KeyboardHints.tsx` é a ajuda exibida ao usuário; as duas listas não são mantidas em sincronia por nenhum gate, então a implementação é que decide.
- **Mapa de telas**: a árvore de rotas em `frontend/src/app/(app)/projects/[id]/`, agrupada por área (`analyze/`, `config/`, `llm/`, `reviews/`).
- **Arquitetura, fluxos de dados e responsabilidades de cada camada**: `CLAUDE.md`.
