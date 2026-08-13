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

-- Preflight, na mesma idiomatica fail-fast de 20260731120000: o backfill abaixo
-- carimba a rodada CORRENTE em toda run historica, e isso so e verdade sob a
-- premissa daquela migration — "a Rodada inicial representa retroativamente
-- todo o historico". A diferenca e que a premissa deixou de ser automatica em
-- 20260804120000: ate ali nenhuma troca de rodada chegava a commitar (o proprio
-- cabecalho daquela migration mede os 9 projetos com exatamente uma rodada
-- cada), e a partir dali passou a commitar. Num projeto que ja trocou de
-- rodada, o historico anterior a troca nao pertence a corrente, e carimba-lo
-- assim seria mentira silenciosa.
--
-- A clausula `count(*) > 1` e carga, nao decoracao: as "Rodada inicial" foram
-- todas criadas pelo backfill do #642 em 2026-07-31, depois das runs que elas
-- representam. Medicao de 2026-08-13 contra producao — sem essa clausula o
-- preflight abortaria 8 das 9 runs existentes; com ela, nenhuma, e a unica run
-- de projeto multi-rodada (Zolgensma-Judiciario, segunda rodada em 2026-08-05,
-- run em 2026-08-10) e legitimamente da rodada corrente.
--
-- O que este bloco NAO cobre: projeto com `current_round_id IS NULL` some no
-- JOIN e passa batido aqui — ele aborta adiante, no SET NOT NULL. Esse estado
-- continua representavel (ver issue #687); torna-lo irrepresentavel exige
-- CONSTRAINT TRIGGER deferida, porque `create_initial_project_round` e AFTER
-- INSERT (logo NOT NULL na coluna quebraria a criacao de projeto) e CHECK nao
-- aceita DEFERRABLE no Postgres.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.llm_runs AS run
    JOIN public.projects AS project ON project.id = run.project_id
    JOIN public.rounds AS current_round ON current_round.id = project.current_round_id
    WHERE run.started_at < current_round.created_at
      AND (
        SELECT count(*) FROM public.rounds AS project_round
        WHERE project_round.project_id = run.project_id
      ) > 1
  ) THEN
    RAISE EXCEPTION 'llm_runs round_id: run anterior a rodada corrente em projeto multi-rodada; derive o backfill dos dados reais';
  END IF;
END $$;

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
