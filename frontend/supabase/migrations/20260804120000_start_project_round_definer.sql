-- A troca de rodada do sorteio (#642, refinada em #645) nunca funcionou em
-- producao: `apply_lottery_assignments` e SECURITY INVOKER e o ramo de rodada
-- nova executa `UPDATE responses SET is_latest = false` sobre TODA a rodada
-- corrente, como o proprio coordenador.
--
-- A policy "Users manage own responses" (20260716155000) tem braco de
-- coordenador apenas no USING. O WITH CHECK exige `respondent_type = 'humano'`
-- E autoria do proprio chamador, de proposito: e a guarda do #483, que veda
-- resposta atribuida ao LLM com autoria humana. Em UPDATE, USING decide quais
-- linhas o chamador alcanca e WITH CHECK decide se a linha resultante pode
-- existir sob a identidade dele — o coordenador alcanca as respostas alheias e
-- reprova ao grava-las. Toda resposta de LLM e toda resposta humana de terceiro
-- na rodada faz o sorteio abortar com 42501.
--
-- Nao ha perda de dado (a excecao reverte a transacao inteira), mas o efeito e
-- que nenhuma troca de rodada chegou a commitar: na medicao de 2026-08-04, os 9
-- projetos tinham exatamente uma rodada cada, todas 'Rodada inicial'.
--
-- Correcao: a transicao de rodada e uma operacao privilegiada e multi-tabela;
-- expressar sua autorizacao como a intersecao das policies de quatro tabelas e
-- o erro de desenho. Ela passa a viver numa funcao SECURITY DEFINER com gate
-- explicito, como `publish_latest_llm_response` e
-- `create_project_with_initial_round` (20260731120000) ja fazem. O WITH CHECK de
-- `responses` fica intocado.

-- `p_expected_active`/`p_expected_pending_scope` NULL significam "sem
-- fotografia" (release anterior ao #645), nao zero. Receber as contagens ja
-- decompostas — em vez do jsonb cru de `open_work_snapshot` — evita repetir
-- aqui a validacao de forma que o chamador faz, e mantem a checagem de trabalho
-- aberto valendo tambem para quem chame esta funcao direto pelo PostgREST.
-- A contrapartida e que a validacao de forma no chamador precisa recusar
-- contagem nula: NULL aqui desliga a checagem de concorrencia otimista, entao
-- so pode chegar de fotografia ausente, nunca de fotografia malformada.
CREATE OR REPLACE FUNCTION public.start_project_round(
  p_project_id uuid,
  p_expected_round_id uuid,
  p_label text,
  p_expected_active integer,
  p_expected_pending_scope integer,
  p_confirm_active boolean,
  p_confirm_pending_scope boolean
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current_round_id uuid;
  v_new_round_id uuid;
  v_open_active integer;
  v_open_pending_scope integer;
  v_label text;
BEGIN
  -- SECURITY DEFINER ignora a RLS: sem este gate, `authenticated` trocaria a
  -- rodada de qualquer projeto. Mesmo predicado da policy "Coordinators manage
  -- rounds" (20260612090200), declarado uma vez.
  IF NOT (
    p_project_id IN (SELECT public.auth_user_coordinator_or_creator_project_ids())
    OR public.is_master()
  ) THEN
    RAISE EXCEPTION 'apenas coordenadores podem iniciar uma rodada'
      USING ERRCODE = '42501';
  END IF;

  v_label := pg_catalog.btrim(p_label);
  IF v_label = '' OR v_label IS NULL THEN
    RAISE EXCEPTION 'nome da rodada nao pode ser vazio' USING ERRCODE = '22023';
  END IF;

  -- Relock dos dois niveis: no-op quando `apply_lottery_assignments` ja travou
  -- as mesmas linhas nesta transacao, e o que mantem a funcao correta se
  -- chamada isolada pelo PostgREST — sem o lock de `documents`, a contagem
  -- abaixo leria um escopo que outra transacao ainda pode mudar, e a
  -- confirmacao dada sobre N trabalhos autorizaria silenciosamente outro N (a
  -- corrida que o #645 fechou para o caminho da UI). A ordem global de locks
  -- (projects -> documents) e a mesma nos dois casos.
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

  PERFORM 1
  FROM public.documents AS document
  WHERE document.project_id = p_project_id
    AND document.excluded_at IS NULL
  ORDER BY document.id
  FOR UPDATE;

  SELECT
    COALESCE(sum(work.open_count) FILTER (WHERE work.scope_state = 'active'), 0)::integer,
    COALESCE(sum(work.open_count) FILTER (WHERE work.scope_state = 'pending_scope'), 0)::integer
  INTO v_open_active, v_open_pending_scope
  FROM public.lottery_round_work_counts AS work
  WHERE work.project_id = p_project_id
    AND work.round_id = v_current_round_id;

  IF p_expected_active IS NOT NULL
     AND (v_open_active IS DISTINCT FROM p_expected_active
          OR v_open_pending_scope IS DISTINCT FROM p_expected_pending_scope) THEN
    RAISE EXCEPTION
      'o trabalho aberto mudou (ativos: % -> %, revisao de escopo: % -> %); recarregue o sorteio',
      p_expected_active, v_open_active,
      p_expected_pending_scope, v_open_pending_scope
      USING ERRCODE = '40001';
  END IF;

  IF v_open_active > 0 AND NOT COALESCE(p_confirm_active, false) THEN
    RAISE EXCEPTION 'a rodada atual possui % trabalhos abertos em documentos ativos',
      v_open_active USING ERRCODE = 'P0001';
  END IF;
  IF v_open_pending_scope > 0 AND NOT COALESCE(p_confirm_pending_scope, false) THEN
    RAISE EXCEPTION
      'a rodada atual possui % trabalhos abertos em revisao de escopo',
      v_open_pending_scope USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.rounds (project_id, label)
  VALUES (p_project_id, v_label)
  RETURNING id INTO v_new_round_id;

  -- A ordem importa e nao pode ser invertida: o trigger
  -- `responses_enforce_current_round_write` (20260731120000) rejeita com 40001
  -- toda escrita de response cuja `round_id` difira da rodada corrente do
  -- projeto. Arquivar enquanto `projects.current_round_id` ainda aponta para a
  -- rodada antiga e o que faz estas linhas passarem. O
  -- `archive_review_dependencies_on_response_change` (20260717120000) dispara
  -- aqui e arquiva equivalencias, auto-revisoes e arbitragens dependentes.
  -- Esse trigger casa por (project_id, document_id) SEM filtro de rodada, entao
  -- o arquivamento tambem precisa preceder a criacao das atribuicoes da rodada
  -- nova: inverter as duas apagaria arbitragens recem-criadas.
  UPDATE public.responses
  SET is_latest = false
  WHERE project_id = p_project_id
    AND round_id = v_current_round_id
    AND is_latest;

  UPDATE public.projects
  SET current_round_id = v_new_round_id,
      round_strategy = 'manual'
  WHERE id = p_project_id;

  RETURN v_new_round_id;
END;
$$;

-- O GRANT a `authenticated` e obrigatorio: a chamada parte de dentro de
-- `apply_lottery_assignments`, que e SECURITY INVOKER, entao o EXECUTE e
-- checado contra o papel da sessao, nao contra o dono da funcao.
REVOKE ALL ON FUNCTION public.start_project_round(
  uuid, uuid, text, integer, integer, boolean, boolean
) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.start_project_round(
  uuid, uuid, text, integer, integer, boolean, boolean
) TO authenticated;

-- Recriada a partir de 20260803140000 com uma unica diferenca: o bloco de
-- transicao de rodada vira uma chamada a `start_project_round`. Continua
-- SECURITY INVOKER — lote e atribuicoes tem braco de coordenador na RLS e
-- devem continuar filtrados por ela —, e a atomicidade nao muda: tudo segue na
-- mesma transacao, e qualquer excecao reverte rodada, arquivamento, lote e
-- atribuicoes.
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
  v_expected_active integer;
  v_expected_pending_scope integer;
  v_open_work_snapshot jsonb;
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
    -- Checar o tipo, e nao a presenca da chave: `jsonb ? 'k'` responde TRUE
    -- para {"k": null}, e o cast de um JSON null devolve NULL, que
    -- `start_project_round` interpreta como "sem fotografia" e usa para pular a
    -- checagem de concorrencia otimista. Presenca da chave nao distingue
    -- fotografia malformada de fotografia ausente; o tipo distingue.
    IF jsonb_typeof(v_open_work_snapshot) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_open_work_snapshot->'active_count') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_open_work_snapshot->'pending_scope_count') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION
        'open_work_snapshot deve informar active_count e pending_scope_count numericos'
        USING ERRCODE = '22023';
    END IF;

    v_expected_active := (v_open_work_snapshot->>'active_count')::integer;
    v_expected_pending_scope := (v_open_work_snapshot->>'pending_scope_count')::integer;
    IF v_expected_active < 0 OR v_expected_pending_scope < 0 THEN
      RAISE EXCEPTION 'contagens de trabalho aberto nao podem ser negativas'
        USING ERRCODE = '22023';
    END IF;
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

    v_target_round_id := public.start_project_round(
      p_project_id,
      v_current_round_id,
      p_new_round_label,
      v_expected_active,
      v_expected_pending_scope,
      COALESCE(
        (v_open_work_snapshot->>'confirm_active')::boolean,
        p_confirm_open_work,
        false
      ),
      COALESCE(
        (v_open_work_snapshot->>'confirm_pending_scope')::boolean,
        p_confirm_open_work,
        false
      )
    );
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
