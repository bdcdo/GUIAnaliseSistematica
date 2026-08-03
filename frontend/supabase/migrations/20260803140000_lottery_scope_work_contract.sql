-- Unifica o contrato de trabalho aberto usado pela pre-visualizacao e pela
-- aplicacao do sorteio. A contagem pertence a uma rodada e distingue
-- documentos ativos daqueles cuja exclusao ainda aguarda decisao; documentos
-- ja excluidos preservam o historico, mas nao bloqueiam uma rodada nova.

CREATE OR REPLACE VIEW public.lottery_round_work_counts
WITH (security_invoker = true) AS
SELECT
  assignment.project_id,
  assignment.round_id,
  assignment.type AS assignment_type,
  CASE
    WHEN document.exclusion_pending_at IS NULL THEN 'active'
    ELSE 'pending_scope'
  END AS scope_state,
  count(*)::integer AS open_count
FROM public.assignments AS assignment
JOIN public.documents AS document
  ON document.id = assignment.document_id
 AND document.project_id = assignment.project_id
WHERE assignment.status IN ('pendente', 'em_andamento')
  AND document.excluded_at IS NULL
GROUP BY
  assignment.project_id,
  assignment.round_id,
  assignment.type,
  CASE
    WHEN document.exclusion_pending_at IS NULL THEN 'active'
    ELSE 'pending_scope'
  END;

REVOKE ALL ON public.lottery_round_work_counts FROM PUBLIC, anon;
GRANT SELECT ON public.lottery_round_work_counts TO authenticated, service_role;

CREATE INDEX IF NOT EXISTS idx_assignments_open_work_by_round
  ON public.assignments (project_id, round_id, document_id, type)
  WHERE status IN ('pendente', 'em_andamento');

-- O nome anterior dizia "alguma vez", mas a elegibilidade do sorteio passou a
-- ser por rodada. Renomear antes do CREATE OR REPLACE preserva dependencias da
-- view sem manter duas representacoes concorrentes da mesma informacao.
ALTER VIEW public.lottery_doc_stats
  RENAME COLUMN has_any_assignment_ever TO has_assignment_in_current_round;

CREATE OR REPLACE VIEW public.lottery_doc_stats
WITH (security_invoker = true) AS
SELECT
  document.id,
  document.project_id,
  document.external_id,
  document.title,
  COALESCE(response_stats.human_coding_count, 0)::integer AS human_coding_count,
  COALESCE(response_stats.has_llm_response, false) AS has_llm_response,
  COALESCE(assignment_stats.active_codificacao, 0)::integer AS active_codificacao,
  COALESCE(assignment_stats.active_comparacao, 0)::integer AS active_comparacao,
  COALESCE(assignment_stats.has_assignment_in_current_round, false)
    AS has_assignment_in_current_round,
  COALESCE(assignment_stats.batch_ids, ARRAY[]::uuid[]) AS batch_ids
FROM public.documents AS document
JOIN public.projects AS project ON project.id = document.project_id
LEFT JOIN LATERAL (
  SELECT
    count(DISTINCT response.respondent_id)
      FILTER (WHERE response.respondent_type = 'humano') AS human_coding_count,
    bool_or(response.respondent_type = 'llm') AS has_llm_response
  FROM public.responses AS response
  WHERE response.document_id = document.id
    AND response.project_id = document.project_id
    AND response.round_id = project.current_round_id
    AND response.is_latest = true
) AS response_stats ON true
LEFT JOIN LATERAL (
  SELECT
    count(*) FILTER (
      WHERE assignment.type = 'codificacao'
        AND assignment.status IN ('pendente', 'em_andamento')
    ) AS active_codificacao,
    count(*) FILTER (
      WHERE assignment.type = 'comparacao'
        AND assignment.status IN ('pendente', 'em_andamento')
    ) AS active_comparacao,
    count(*) > 0 AS has_assignment_in_current_round,
    array_agg(DISTINCT assignment.batch_id)
      FILTER (WHERE assignment.batch_id IS NOT NULL) AS batch_ids
  FROM public.assignments AS assignment
  WHERE assignment.document_id = document.id
    AND assignment.project_id = document.project_id
    AND assignment.round_id = project.current_round_id
) AS assignment_stats ON true
WHERE document.excluded_at IS NULL
  AND document.exclusion_pending_at IS NULL;

REVOKE ALL ON public.lottery_doc_stats FROM PUBLIC, anon;
GRANT SELECT ON public.lottery_doc_stats TO authenticated, service_role;

-- O payload novo carrega a fotografia das contagens exibidas ao coordenador.
-- A RPC repete a leitura depois de travar projeto e documentos, impedindo que
-- uma confirmacao dada sobre N trabalhos autorize silenciosamente outro N.
-- `p_confirm_open_work` permanece apenas como compatibilidade com a release
-- anterior, que ainda nao envia `open_work_snapshot`.
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
  v_created_by uuid;
  v_inserted integer;
  v_requested integer;
  v_preserved integer;
  v_open_active integer := 0;
  v_open_pending_scope integer := 0;
  v_expected_active integer;
  v_expected_pending_scope integer;
  v_confirm_active boolean;
  v_confirm_pending_scope boolean;
  v_open_work_snapshot jsonb;
  v_has_snapshot boolean := false;
  v_label text;
BEGIN
  IF p_type NOT IN ('codificacao', 'comparacao') THEN
    RAISE EXCEPTION 'tipo de sorteio invalido: %', p_type USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_batch) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'batch deve ser um objeto JSON' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_assignments) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'assignments deve ser um array JSON' USING ERRCODE = '22023';
  END IF;

  v_requested := jsonb_array_length(p_assignments);
  IF v_requested = 0 THEN
    RAISE EXCEPTION 'assignments nao pode ser vazio' USING ERRCODE = '22023';
  END IF;

  v_open_work_snapshot := p_batch->'open_work_snapshot';
  IF v_open_work_snapshot IS NOT NULL THEN
    IF jsonb_typeof(v_open_work_snapshot) IS DISTINCT FROM 'object'
       OR NOT (v_open_work_snapshot ? 'active_count')
       OR NOT (v_open_work_snapshot ? 'pending_scope_count') THEN
      RAISE EXCEPTION 'open_work_snapshot deve informar active_count e pending_scope_count'
        USING ERRCODE = '22023';
    END IF;

    v_expected_active := (v_open_work_snapshot->>'active_count')::integer;
    v_expected_pending_scope := (v_open_work_snapshot->>'pending_scope_count')::integer;
    IF v_expected_active < 0 OR v_expected_pending_scope < 0 THEN
      RAISE EXCEPTION 'contagens de trabalho aberto nao podem ser negativas'
        USING ERRCODE = '22023';
    END IF;
    v_has_snapshot := true;
  END IF;

  v_created_by := public.clerk_uid();
  IF v_created_by IS NULL THEN
    RAISE EXCEPTION 'identidade autenticada indisponivel' USING ERRCODE = '28000';
  END IF;

  SELECT project.current_round_id INTO v_current_round_id
  FROM public.projects AS project
  WHERE project.id = p_project_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'projeto inexistente ou inacessivel' USING ERRCODE = 'P0002';
  END IF;
  IF v_current_round_id IS DISTINCT FROM p_expected_round_id THEN
    RAISE EXCEPTION 'a rodada atual mudou; recarregue o sorteio' USING ERRCODE = '40001';
  END IF;

  -- Ordem global: projects -> documents. O lock estabiliza o estado de escopo
  -- antes de a contagem canonica ser relida e antes de qualquer escrita.
  PERFORM 1
  FROM public.documents AS document
  WHERE document.project_id = p_project_id
    AND document.excluded_at IS NULL
  ORDER BY document.id
  FOR UPDATE;

  -- A pre-visualizacao so propoe documentos ativos. Revalidar o proprio
  -- payload sob o lock torna impossivel criar fila para um documento excluido
  -- ou colocado em revisao de escopo entre a pre-visualizacao e a gravacao.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_assignments) AS proposed(entry)
    LEFT JOIN public.documents AS document
      ON document.id = (proposed.entry->>'document_id')::uuid
     AND document.project_id = p_project_id
     AND document.excluded_at IS NULL
     AND document.exclusion_pending_at IS NULL
    WHERE document.id IS NULL
  ) THEN
    RAISE EXCEPTION
      'o escopo dos documentos mudou; recarregue o sorteio'
      USING ERRCODE = '40001';
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

    SELECT
      COALESCE(sum(work.open_count) FILTER (WHERE work.scope_state = 'active'), 0)::integer,
      COALESCE(sum(work.open_count) FILTER (WHERE work.scope_state = 'pending_scope'), 0)::integer
    INTO v_open_active, v_open_pending_scope
    FROM public.lottery_round_work_counts AS work
    WHERE work.project_id = p_project_id
      AND work.round_id = v_current_round_id;

    IF v_has_snapshot
       AND (v_open_active IS DISTINCT FROM v_expected_active
            OR v_open_pending_scope IS DISTINCT FROM v_expected_pending_scope) THEN
      RAISE EXCEPTION
        'o trabalho aberto mudou (ativos: % -> %, revisao de escopo: % -> %); recarregue o sorteio',
        v_expected_active, v_open_active,
        v_expected_pending_scope, v_open_pending_scope
        USING ERRCODE = '40001';
    END IF;

    v_confirm_active := COALESCE(
      (v_open_work_snapshot->>'confirm_active')::boolean,
      p_confirm_open_work,
      false
    );
    v_confirm_pending_scope := COALESCE(
      (v_open_work_snapshot->>'confirm_pending_scope')::boolean,
      p_confirm_open_work,
      false
    );

    IF v_open_active > 0 AND NOT v_confirm_active THEN
      RAISE EXCEPTION 'a rodada atual possui % trabalhos abertos em documentos ativos',
        v_open_active USING ERRCODE = 'P0001';
    END IF;
    IF v_open_pending_scope > 0 AND NOT v_confirm_pending_scope THEN
      RAISE EXCEPTION
        'a rodada atual possui % trabalhos abertos em revisao de escopo',
        v_open_pending_scope USING ERRCODE = 'P0001';
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
    v_created_by,
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
  IF v_inserted <> v_requested THEN
    RAISE EXCEPTION
      'o conjunto do sorteio mudou; seriam criadas % de % atribuicoes; recarregue o sorteio',
      v_inserted, v_requested
      USING ERRCODE = '40001';
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

REVOKE ALL ON FUNCTION public.apply_lottery_assignments(
  uuid, text, uuid, jsonb, boolean
) FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION public.apply_lottery_assignments(uuid, text, uuid, jsonb, boolean);
