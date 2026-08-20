-- Corrige um bloqueio que tornava linhas de rodada encerrada irreparáveis.
--
-- `enforce_current_response_round_write` já trata `round_id` como imutável em
-- UPDATE (23514 abaixo). Logo, num UPDATE a comparação seguinte não confrontava
-- o destino da escrita com a rodada corrente: confrontava a rodada DA PRÓPRIA
-- LINHA. Toda linha de rodada passada passou a falhar em qualquer UPDATE — e o
-- estado era irreparável por construção, porque consertá-la exigia justamente o
-- UPDATE que o trigger recusava.
--
-- Medido em produção em 2026-08-20: 101.580 erros em 20 minutos, todos deste
-- RAISE, vindos de `UPDATE responses SET is_latest = ...` — manutenção de flag,
-- não gravação de resposta. O cliente retentava sem convergir (ver o ERRCODE
-- abaixo) e o banco ficou com 2 vCPU saturados por ~1.700 transações/s das
-- quais 99,9% eram rollback.
--
-- A invariante que o trigger existe para proteger — nenhuma RESPOSTA nova entra
-- em rodada fechada — é sobre conteúdo. Por isso o discriminador passa a ser o
-- conteúdo (`answers`/`justifications`), não a operação: manutenção de
-- `is_latest`, `respondent_*` e afins segue permitida em linha histórica;
-- alterar conteúdo continua exigindo rodada corrente. INSERT não muda em nada.
--
-- Efeito colateral desejado: o caminho de manutenção deixa de tomar o
-- `FOR SHARE` em `projects` a cada linha. Esse lock respondia por dezenas de
-- milhões de varreduras numa tabela de 9 linhas.

BEGIN;

CREATE OR REPLACE FUNCTION public.enforce_current_response_round_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current_round_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.round_id IS DISTINCT FROM OLD.round_id
    THEN
      RAISE EXCEPTION 'project_id e round_id da response sao imutaveis'
        USING ERRCODE = '23514';
    END IF;

    -- Manutenção sai antes de olhar a rodada: é o que mantém reparável a linha
    -- que já ficou para trás. `answers`/`justifications` inalterados definem
    -- "não é conteúdo de resposta" — as demais colunas derivadas (hashes,
    -- schema_version_*) só mudam acompanhando esses dois.
    IF NEW.answers IS NOT DISTINCT FROM OLD.answers
       AND NEW.justifications IS NOT DISTINCT FROM OLD.justifications
    THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Toda escrita de conteúdo se lineariza com a troca de rodada pelo mesmo row
  -- lock de projects. FOR SHARE permite saves concorrentes, mas conflita com o
  -- FOR UPDATE de apply_lottery_assignments. Assim, ou o save termina antes da
  -- ativação, ou observa a nova rodada e falha; nunca grava no histórico depois.
  SELECT project.current_round_id INTO v_current_round_id
  FROM public.projects AS project
  WHERE project.id = NEW.project_id
  FOR SHARE;

  IF NOT FOUND OR v_current_round_id IS NULL THEN
    RAISE EXCEPTION 'projeto sem rodada atual' USING ERRCODE = 'P0002';
  END IF;

  -- Compatibilidade com a release imediatamente anterior. Clientes round-aware
  -- sempre enviam o id exibido e, portanto, passam pela comparacao abaixo.
  IF NEW.round_id IS NULL THEN
    NEW.round_id := v_current_round_id;
  ELSIF NEW.round_id IS DISTINCT FROM v_current_round_id THEN
    -- SQLSTATE próprio, não 40001. `40001` (serialization_failure) promete ao
    -- cliente que repetir a operação pode dar certo, e drivers e schedulers
    -- retentam nele por padrão. Esta condição não é transitória: só sai do
    -- lugar quando um humano recarrega o formulário. Foi essa promessa falsa
    -- que transformou um erro correto em loop de retry infinito. `P0R01` é
    -- dedicado a ela — P0001 é o default de todo RAISE e não discriminaria.
    -- O consumidor é ROUND_CHANGED_SQLSTATE em src/actions/responses.ts.
    RAISE EXCEPTION 'a rodada atual mudou; recarregue o formulario'
      USING ERRCODE = 'P0R01';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_current_response_round_write()
  FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
