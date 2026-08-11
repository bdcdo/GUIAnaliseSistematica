-- llm_runs.round_id: a coluna que o backend escreve desde o #642 e que nenhuma
-- migration criou.
--
-- O #642 (20260731120000_explicit_assignment_rounds.sql) deu rodada explicita a
-- `assignments`, `assignment_batches` e `responses`, e no mesmo commit
-- `_persist_run_snapshot` (backend/services/llm_runner.py) passou a gravar
-- `round_id` em `llm_runs` — tabela que aquela migration nao menciona uma unica
-- vez. Como essa funcao re-lanca a excecao de proposito ("nao engolir erro"), o
-- PGRST204 abortava a run inteira antes do primeiro documento. Medicao de
-- 2026-08-11: 1 run desde o deploy do #642, falhada; ultima bem sucedida em
-- 2026-07-02.
--
-- A coluna nasce NOT NULL como as tres tabelas irmas. Run sem rodada ja era
-- inutil na pratica: `publish_latest_llm_response` recusa `round_id` nulo, entao
-- ela nunca chegaria a publicar resposta. O NOT NULL apenas antecipa a falha
-- para antes de gastar token de provider.

ALTER TABLE public.llm_runs
  ADD COLUMN round_id uuid;

-- Runs historicas herdam a rodada atual do projeto — mesmo criterio do backfill
-- de responses/assignments em 20260731120000, onde a "Rodada inicial" representa
-- retroativamente todo o historico anterior as rodadas.
UPDATE public.llm_runs AS run
SET round_id = project.current_round_id
FROM public.projects AS project
WHERE project.id = run.project_id;

-- FK composta, e nao `REFERENCES rounds(id)`: a simples aceitaria uma run de um
-- projeto carimbada com rodada de outro. Ancora na UNIQUE (project_id, id) que
-- 20260731120000 criou em `rounds` justamente para servir de alvo a essas FKs.
--
-- Sem `ON DELETE` (NO ACTION) de proposito: `llm_runs.project_id` e
-- `rounds.project_id` ja cascateiam de `projects`, e a checagem de integridade
-- de uma FK NO ACTION roda no fim do statement, quando o cascade ja removeu a
-- run. Trocar por RESTRICT quebraria a exclusao de projeto (checagem imediata).
ALTER TABLE public.llm_runs
  ALTER COLUMN round_id SET NOT NULL,
  ADD CONSTRAINT llm_runs_project_round_fk
    FOREIGN KEY (project_id, round_id)
    REFERENCES public.rounds(project_id, id);

-- `_persist_run_insert` cria a linha no POST /api/llm/run sem `round_id`: a
-- rodada so e lida depois, ja dentro do background task. Sem preenchimento
-- automatico o NOT NULL inverteria o bug — o INSERT passaria a falhar com 23502
-- e a run ficaria invisivel na aba Execucoes, exatamente o que a docstring
-- daquela funcao diz querer evitar.
--
-- A funcao ja existe desde 20260731120000 e serve sem alteracao: le
-- `NEW.project_id`, so preenche quando `NEW.round_id IS NULL` e nunca sobrescreve
-- valor explicito — o UPDATE do snapshot continua mandando na rodada final.
CREATE TRIGGER llm_runs_fill_current_round
BEFORE INSERT ON public.llm_runs
FOR EACH ROW EXECUTE FUNCTION public.fill_current_round_id();
