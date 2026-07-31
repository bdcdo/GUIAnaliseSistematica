-- Rodadas explicitas para sorteios repetidos do mesmo formulario.
--
-- A migration e deliberadamente fail-fast: a estrategia manual nunca foi
-- ativada em producao e `rounds` ainda estava vazia na auditoria que originou
-- esta mudanca. Se esse estado mudar antes do deploy, o backfill precisa ser
-- redesenhado com os dados reais em vez de inferir a rodada historica.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.projects WHERE round_strategy <> 'schema_version') THEN
    RAISE EXCEPTION 'explicit rounds: projeto com round_strategy inesperada; revise o backfill';
  END IF;
  IF EXISTS (SELECT 1 FROM public.rounds) THEN
    RAISE EXCEPTION 'explicit rounds: rounds ja contem dados; revise o backfill';
  END IF;
END $$;

ALTER TABLE public.rounds
  ADD CONSTRAINT rounds_project_id_id_key UNIQUE (project_id, id);

INSERT INTO public.rounds (project_id, label)
SELECT id, 'Rodada inicial'
FROM public.projects;

UPDATE public.projects AS project
SET current_round_id = round.id
FROM public.rounds AS round
WHERE round.project_id = project.id;

ALTER TABLE public.assignment_batches
  ADD COLUMN round_id uuid,
  ADD COLUMN type text;

ALTER TABLE public.assignments
  ADD COLUMN round_id uuid;

UPDATE public.assignment_batches AS batch
SET round_id = project.current_round_id,
    type = COALESCE(
      (SELECT CASE WHEN count(DISTINCT assignment.type) = 1 THEN min(assignment.type) END
       FROM public.assignments AS assignment
       WHERE assignment.batch_id = batch.id),
      'legado'
    )
FROM public.projects AS project
WHERE project.id = batch.project_id;

UPDATE public.assignments AS assignment
SET round_id = project.current_round_id
FROM public.projects AS project
WHERE project.id = assignment.project_id;

UPDATE public.responses AS response
SET round_id = project.current_round_id
FROM public.projects AS project
WHERE project.id = response.project_id;

ALTER TABLE public.assignment_batches
  ALTER COLUMN project_id SET NOT NULL,
  ALTER COLUMN round_id SET NOT NULL,
  ALTER COLUMN type SET NOT NULL,
  ALTER COLUMN type SET DEFAULT 'legado',
  ADD CONSTRAINT assignment_batches_type_check
    CHECK (type IN ('codificacao', 'comparacao', 'legado')),
  ADD CONSTRAINT assignment_batches_project_round_fk
    FOREIGN KEY (project_id, round_id)
    REFERENCES public.rounds(project_id, id);

ALTER TABLE public.assignments
  ALTER COLUMN project_id SET NOT NULL,
  ALTER COLUMN round_id SET NOT NULL,
  ADD CONSTRAINT assignments_project_round_fk
    FOREIGN KEY (project_id, round_id)
    REFERENCES public.rounds(project_id, id);

ALTER TABLE public.responses
  ALTER COLUMN project_id SET NOT NULL,
  ALTER COLUMN round_id SET NOT NULL,
  ADD CONSTRAINT responses_project_round_fk
    FOREIGN KEY (project_id, round_id)
    REFERENCES public.rounds(project_id, id);

ALTER TABLE public.projects DROP CONSTRAINT projects_current_round_fk;
ALTER TABLE public.projects
  ADD CONSTRAINT projects_current_round_fk
  FOREIGN KEY (id, current_round_id)
  REFERENCES public.rounds(project_id, id);

ALTER TABLE public.assignments
  DROP CONSTRAINT assignments_document_id_user_id_type_key;
ALTER TABLE public.assignments
  ADD CONSTRAINT assignments_document_user_type_round_key
  UNIQUE (document_id, user_id, type, round_id);

-- Funcoes de revisao criadas por migrations anteriores reabrem assignments com
-- ON CONFLICT. O alvo precisa acompanhar a nova chave; manter a assinatura
-- antiga faria a funcao falhar em runtime assim que o indice global fosse
-- substituido pelo indice por rodada.
DO $$
DECLARE
  v_function record;
  v_definition text;
BEGIN
  FOR v_function IN
    SELECT p.oid
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND pg_get_functiondef(p.oid) LIKE '%ON CONFLICT (document_id, user_id, type)%'
  LOOP
    v_definition := replace(
      pg_get_functiondef(v_function.oid),
      'ON CONFLICT (document_id, user_id, type)',
      'ON CONFLICT (document_id, user_id, type, round_id)'
    );
    EXECUTE v_definition;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND pg_get_functiondef(p.oid) LIKE '%ON CONFLICT (document_id, user_id, type)%'
  ) THEN
    RAISE EXCEPTION 'explicit rounds: funcao ainda usa conflito global de assignments';
  END IF;
END;
$$;

DROP INDEX public.assignments_one_active_comparacao_per_doc;
CREATE UNIQUE INDEX assignments_one_active_comparacao_per_doc_round
  ON public.assignments (document_id, round_id)
  WHERE type = 'comparacao' AND status IS DISTINCT FROM 'concluido';

DROP INDEX public.responses_one_latest_human_per_document;
CREATE UNIQUE INDEX responses_one_latest_human_per_document
  ON public.responses (project_id, round_id, document_id, respondent_id)
  WHERE respondent_type = 'humano' AND is_latest;

CREATE INDEX idx_assignments_project_round_queue
  ON public.assignments (project_id, round_id, type, status);
CREATE INDEX idx_assignment_batches_project_round
  ON public.assignment_batches (project_id, round_id, created_at DESC);

-- Projetos novos ja nascem com uma rodada valida. O trigger e SECURITY DEFINER
-- porque a policy de rounds exige que o projeto ja seja visivel ao criador, o
-- que nem sempre e verdade durante o AFTER INSERT do proprio projeto.
CREATE OR REPLACE FUNCTION public.create_initial_project_round()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_round_id uuid;
BEGIN
  INSERT INTO public.rounds (project_id, label)
  VALUES (NEW.id, 'Rodada inicial')
  RETURNING id INTO v_round_id;

  UPDATE public.projects SET current_round_id = v_round_id WHERE id = NEW.id;
  NEW.current_round_id := v_round_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER projects_create_initial_round
AFTER INSERT ON public.projects
FOR EACH ROW
EXECUTE FUNCTION public.create_initial_project_round();

REVOKE ALL ON FUNCTION public.create_initial_project_round() FROM PUBLIC, anon, authenticated;

-- Caminho canonico de criacao: projeto, membership do criador e rodada inicial
-- pertencem a mesma transacao. O trigger acima continua cobrindo imports e a
-- release anterior do frontend durante a janela de compatibilidade.
CREATE OR REPLACE FUNCTION public.create_project_with_initial_round(
  p_name text,
  p_description text,
  p_created_by uuid,
  p_automation_mode text DEFAULT 'auto_review_llm'
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_project_id uuid;
BEGIN
  INSERT INTO public.projects (name, description, created_by, automation_mode)
  VALUES (p_name, p_description, p_created_by, p_automation_mode)
  RETURNING id INTO v_project_id;

  INSERT INTO public.project_members (project_id, user_id, role)
  VALUES (v_project_id, p_created_by, 'coordenador');

  IF NOT EXISTS (
    SELECT 1 FROM public.projects
    WHERE id = v_project_id AND current_round_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'projeto criado sem rodada inicial';
  END IF;

  RETURN v_project_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_project_with_initial_round(text, text, uuid, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.create_project_with_initial_round(text, text, uuid, text) TO authenticated;

ALTER TABLE public.projects
  DROP CONSTRAINT projects_round_strategy_check;
UPDATE public.projects SET round_strategy = 'manual';
ALTER TABLE public.projects
  ALTER COLUMN round_strategy SET DEFAULT 'manual';

-- Compatibilidade de escrita para a release anterior. Valor explicito nunca e
-- sobrescrito: clientes round-aware mantem a protecao contra abas obsoletas;
-- somente payloads legados, que omitem round_id, recebem a rodada atual.
CREATE OR REPLACE FUNCTION public.fill_current_round_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.round_id IS NULL THEN
    SELECT current_round_id INTO NEW.round_id
    FROM public.projects WHERE id = NEW.project_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER assignment_batches_fill_current_round
BEFORE INSERT ON public.assignment_batches
FOR EACH ROW EXECUTE FUNCTION public.fill_current_round_id();

CREATE TRIGGER assignments_fill_current_round
BEFORE INSERT ON public.assignments
FOR EACH ROW EXECUTE FUNCTION public.fill_current_round_id();

CREATE TRIGGER responses_fill_current_round
BEFORE INSERT ON public.responses
FOR EACH ROW EXECUTE FUNCTION public.fill_current_round_id();

REVOKE ALL ON FUNCTION public.fill_current_round_id() FROM PUBLIC, anon, authenticated;

-- Nova operacao atomica. `p_new_round_label IS NULL` opera na rodada atual;
-- quando ha label, cria e ativa uma rodada antes do sorteio. Qualquer excecao,
-- inclusive zero insercoes, reverte rodada, arquivamento, lote e assignments.
CREATE OR REPLACE FUNCTION public.apply_lottery_assignments(
  p_project_id uuid,
  p_type text,
  p_expected_round_id uuid,
  p_new_round_label text,
  p_confirm_open_work boolean,
  p_batch jsonb,
  p_assignments jsonb,
  p_replace boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_current_round_id uuid;
  v_target_round_id uuid;
  v_batch_id uuid;
  v_inserted integer;
  v_preserved integer;
  v_open_work integer;
  v_label text;
BEGIN
  IF p_type NOT IN ('codificacao', 'comparacao') THEN
    RAISE EXCEPTION 'tipo de sorteio invalido: %', p_type USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_assignments) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'assignments deve ser um array JSON' USING ERRCODE = '22023';
  END IF;

  SELECT current_round_id INTO v_current_round_id
  FROM public.projects
  WHERE id = p_project_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'projeto inexistente ou inacessivel' USING ERRCODE = 'P0002';
  END IF;
  IF v_current_round_id IS DISTINCT FROM p_expected_round_id THEN
    RAISE EXCEPTION 'a rodada atual mudou; recarregue o sorteio' USING ERRCODE = '40001';
  END IF;

  v_target_round_id := v_current_round_id;
  IF p_new_round_label IS NOT NULL THEN
    IF p_type <> 'codificacao' THEN
      RAISE EXCEPTION 'somente sorteio de codificacao pode iniciar rodada' USING ERRCODE = '22023';
    END IF;
    v_label := btrim(p_new_round_label);
    IF v_label = '' THEN
      RAISE EXCEPTION 'nome da rodada nao pode ser vazio' USING ERRCODE = '22023';
    END IF;

    SELECT count(*) INTO v_open_work
    FROM public.assignments
    WHERE project_id = p_project_id
      AND round_id = v_current_round_id
      AND type = 'codificacao'
      AND status IN ('pendente', 'em_andamento');

    IF v_open_work > 0 AND NOT p_confirm_open_work THEN
      RAISE EXCEPTION 'a rodada atual possui % atribuicoes abertas', v_open_work
        USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.rounds (project_id, label)
    VALUES (p_project_id, v_label)
    RETURNING id INTO v_target_round_id;

    UPDATE public.responses
    SET is_latest = false
    WHERE project_id = p_project_id
      AND round_id = v_current_round_id
      AND is_latest;

    UPDATE public.projects
    SET current_round_id = v_target_round_id,
        round_strategy = 'manual'
    WHERE id = p_project_id;
  END IF;

  INSERT INTO public.assignment_batches (
    project_id, round_id, type, created_by, researchers_per_doc,
    docs_per_researcher, doc_subset_size, label, mode, balancing, filters
  ) VALUES (
    p_project_id,
    v_target_round_id,
    p_type,
    NULLIF(p_batch->>'created_by', '')::uuid,
    COALESCE((p_batch->>'researchers_per_doc')::integer, 2),
    NULLIF(p_batch->>'docs_per_researcher', '')::integer,
    NULLIF(p_batch->>'doc_subset_size', '')::integer,
    NULLIF(p_batch->>'label', ''),
    COALESCE(NULLIF(p_batch->>'mode', ''), CASE WHEN p_replace THEN 'replace' ELSE 'append' END),
    COALESCE(NULLIF(p_batch->>'balancing', ''), 'history'),
    p_batch->'filters'
  ) RETURNING id INTO v_batch_id;

  IF p_replace THEN
    DELETE FROM public.assignments
    WHERE project_id = p_project_id
      AND round_id = v_target_round_id
      AND status = 'pendente'
      AND type = p_type;
  END IF;

  SELECT count(*) INTO v_preserved
  FROM public.assignments
  WHERE project_id = p_project_id
    AND round_id = v_target_round_id
    AND type = p_type;

  INSERT INTO public.assignments (
    project_id, round_id, document_id, user_id, batch_id, type, status, completed_at
  )
  SELECT p_project_id,
         v_target_round_id,
         (entry->>'document_id')::uuid,
         (entry->>'user_id')::uuid,
         v_batch_id,
         p_type,
         COALESCE(entry->>'status', 'pendente'),
         (entry->>'completed_at')::timestamptz
  FROM jsonb_array_elements(p_assignments) AS entry
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RAISE EXCEPTION 'o sorteio nao criou nenhuma atribuicao' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'round_id', v_target_round_id,
    'batch_id', v_batch_id,
    'inserted', v_inserted,
    'preserved', v_preserved
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_lottery_assignments(
  uuid, text, uuid, text, boolean, jsonb, jsonb, boolean
) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.apply_lottery_assignments(
  uuid, text, uuid, text, boolean, jsonb, jsonb, boolean
) TO authenticated;

-- Compatibilidade de uma release com o frontend anterior: lote e assignments
-- recebem a rodada atual mesmo quando o chamador ainda usa a assinatura antiga.
CREATE OR REPLACE FUNCTION public.apply_lottery_assignments(
  p_project_id uuid,
  p_type text,
  p_batch_id uuid,
  p_assignments jsonb,
  p_replace boolean
) RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_round_id uuid;
  v_inserted integer;
BEGIN
  SELECT current_round_id INTO v_round_id
  FROM public.projects WHERE id = p_project_id;

  IF p_batch_id IS NOT NULL THEN
    UPDATE public.assignment_batches
    SET round_id = v_round_id,
        type = CASE WHEN type = 'legado' THEN p_type ELSE type END
    WHERE id = p_batch_id AND project_id = p_project_id;
  END IF;

  IF p_replace THEN
    DELETE FROM public.assignments
    WHERE project_id = p_project_id AND round_id = v_round_id
      AND status = 'pendente' AND type = p_type;
  END IF;

  INSERT INTO public.assignments (
    project_id, round_id, document_id, user_id, batch_id, type, status, completed_at
  )
  SELECT p_project_id, v_round_id, (entry->>'document_id')::uuid,
         (entry->>'user_id')::uuid, p_batch_id, p_type,
         COALESCE(entry->>'status', 'pendente'),
         (entry->>'completed_at')::timestamptz
  FROM jsonb_array_elements(p_assignments) AS entry
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;
