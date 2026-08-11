-- #670: a outbox de auto-revisão deixa de conseguir representar "codificação
-- humana suja sem geração LLM para comparar".
--
-- O ramo humano de enqueue_auto_review_reconciliation (20260717120000:759)
-- enfileirava com llm_response_id NULL quando o documento ainda não tinha
-- geração LLM corrente, e validate_auto_review_reconciliation_request aceitava
-- esse estado de propósito. Nenhum worker pode satisfazer essa linha — não
-- existe o par a reconciliar —, então ela vivia em retry perpétuo com o backoff
-- de record_auto_review_reconciliation_failure saturado no teto de 1 h. E em
-- silêncio: o outcome `deferred` não conta como `failed`, e a rota interna só
-- devolve 503 em `failed`. Medido em 2026-08-10 no projeto Zolgensma-Judiciário:
-- 25 linhas, todas com o mesmo last_error, uma delas com 136 tentativas.
--
-- A correção é pela origem, não por teto de tentativas: um teto trocaria o loop
-- infinito por abandono silencioso, e a request sumiria sem que a reconciliação
-- fosse feita. Sem geração LLM corrente o produtor não enfileira, e a coluna
-- vira NOT NULL — o estado deixa de ser construível por qualquer canal, não só
-- pelo que passa pelo trigger.
--
-- Nada se perde, por duas propriedades do desenho existente:
--   (a) o ramo LLM do trigger não tem gate algum, e a única porta de entrada de
--       geração LLM corrente é publish_latest_llm_response, que apaga as
--       requests do documento e insere a geração nova — logo TODA transição
--       para "existe LLM corrente completa" enfileira;
--   (b) a request não carrega snapshot humano: o dreno relê as respostas
--       humanas correntes no momento em que processa (auto-review-reconciler.ts,
--       readReconciliationInputs). A request só diz QUAL geração LLM comparar.
-- Junto com o mutex `FOR UPDATE` na linha de documents, compartilhado entre o
-- trigger e a publicação, isso fecha também a corrida "humano submete no
-- instante em que o run LLM publica": nas duas ordens possíveis sobra uma
-- request com a geração preenchida.
--
-- O reparo dos resíduos vem ANTES do SET NOT NULL e na MESMA transação da
-- redefinição do produtor: não existe instante com a constraint viva e o
-- produtor antigo ainda inserindo NULL.
BEGIN;

-- O SET NOT NULL pega ACCESS EXCLUSIVE na tabela. Falhar rápido é melhor que
-- enfileirar atrás de uma transação longa segurando o lock, o que bloquearia
-- todo save humano do produto enquanto esperasse.
SET LOCAL lock_timeout = '10s';

-- Resíduo cujo documento TEM geração corrente: só a coluna estava vazia. Aponta
-- para a geração que o produtor novo teria gravado e zera o backoff acumulado.
-- O índice parcial responses_one_latest_llm_per_document garante no máximo uma
-- candidata por documento, então o UPDATE é determinístico. Uma colisão com o
-- UNIQUE de llm_response_id abortaria a migration inteira — fail-closed, que é
-- o comportamento certo aqui.
UPDATE public.auto_review_reconciliation_requests AS request
SET llm_response_id = llm.id,
    requested_at = pg_catalog.now(),
    next_attempt_at = pg_catalog.now(),
    attempt_count = 0,
    last_error = NULL
FROM public.responses AS llm
WHERE request.llm_response_id IS NULL
  AND llm.project_id = request.project_id
  AND llm.document_id = request.document_id
  AND llm.respondent_type = 'llm'
  AND llm.is_latest = true
  AND llm.is_partial = false;

-- Resíduo cujo documento NÃO tem geração corrente: nenhuma reconciliação é
-- computável por esta linha, hoje ou depois. Quem publicar a próxima geração
-- reenfileira o documento com o id certo, e o dreno lerá as respostas humanas
-- correntes de então. Os dois passos são escritos por construção, não pelo
-- censo do dia: em 2026-08-10 o UPDATE acertaria zero linhas e o DELETE, 25.
DELETE FROM public.auto_review_reconciliation_requests
WHERE llm_response_id IS NULL;

ALTER TABLE public.auto_review_reconciliation_requests
  ALTER COLUMN llm_response_id SET NOT NULL;

CREATE OR REPLACE FUNCTION public.enqueue_auto_review_reconciliation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_allow_new_cycles BOOLEAN;
  v_llm_response_id UUID;
BEGIN
  IF NEW.respondent_type NOT IN ('humano', 'llm')
     OR NEW.is_latest IS DISTINCT FROM true
     OR NEW.is_partial IS DISTINCT FROM false THEN
    RETURN NEW;
  END IF;

  -- The document row is the publication mutex shared with
  -- publish_latest_llm_response. This function is VOLATILE, so under READ
  -- COMMITTED each of its statements takes a fresh snapshot: the LLM lookup
  -- below runs after the lock and therefore sees a publication that just
  -- committed.
  PERFORM 1
  FROM public.documents AS document
  WHERE document.id = NEW.document_id
    AND document.project_id = NEW.project_id
  FOR UPDATE;

  SELECT project.automation_mode = 'auto_review_llm'
  INTO v_allow_new_cycles
  FROM public.projects AS project
  WHERE project.id = NEW.project_id;

  IF NEW.respondent_type = 'humano' THEN
    IF NOT COALESCE(v_allow_new_cycles, false)
       AND NOT EXISTS (
         SELECT 1 FROM public.field_reviews AS review
         WHERE review.project_id = NEW.project_id
           AND review.document_id = NEW.document_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.field_review_cycle_history_entries AS history
         WHERE history.project_id = NEW.project_id
           AND history.document_id = NEW.document_id
       ) THEN
      RETURN NEW;
    END IF;

    SELECT llm.id INTO v_llm_response_id
    FROM public.responses AS llm
    WHERE llm.project_id = NEW.project_id
      AND llm.document_id = NEW.document_id
      AND llm.respondent_type = 'llm'
      AND llm.is_latest = true
      AND llm.is_partial = false;

    -- #670: sem geração LLM corrente não existe o par a reconciliar, e
    -- enfileirar aqui cria trabalho que nenhum worker consegue concluir. Este
    -- save não se perde: publish_latest_llm_response apaga e reinsere a request
    -- com o id da geração nova, e o dreno relê as respostas humanas correntes
    -- daquele instante.
    IF v_llm_response_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    v_llm_response_id := NEW.id;
  END IF;

  INSERT INTO public.auto_review_reconciliation_requests (
    document_id, project_id, llm_response_id, allow_new_cycles
  ) VALUES (
    NEW.document_id, NEW.project_id, v_llm_response_id,
    COALESCE(v_allow_new_cycles, false)
  )
  ON CONFLICT (document_id) DO UPDATE
  SET project_id = EXCLUDED.project_id,
      llm_response_id = EXCLUDED.llm_response_id,
      allow_new_cycles = EXCLUDED.allow_new_cycles,
      requested_at = pg_catalog.now(),
      next_attempt_at = pg_catalog.now(),
      attempt_count = 0,
      last_error = NULL;

  RETURN NEW;
END;
$$;

-- Some o ramo que legitimava o NULL. Com a coluna NOT NULL, o EXISTS da geração
-- passa a ser total: toda request referencia a LLM corrente e completa do seu
-- documento. A checagem da resposta humana some junto — ela existia só para dar
-- alguma âncora ao caso sem LLM, e o dreno relê os humanos de qualquer forma.
CREATE OR REPLACE FUNCTION public.validate_auto_review_reconciliation_request()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.documents AS document
    WHERE document.id = NEW.document_id
      AND document.project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'reconciliation request document does not belong to project';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.responses AS llm
    WHERE llm.id = NEW.llm_response_id
      AND llm.project_id = NEW.project_id
      AND llm.document_id = NEW.document_id
      AND llm.respondent_type = 'llm'
      AND llm.is_latest = true
      AND llm.is_partial = false
  ) THEN
    RAISE EXCEPTION 'reconciliation request must reference its current complete LLM response';
  END IF;

  RETURN NEW;
END;
$$;

-- Sem NULL na coluna, "pendente" passa a significar exatamente uma geração. O
-- ramo `llm_response_id IS NULL` casava com QUALQUER geração consultada; era
-- alcançável apenas para documentos sem LLM corrente, que final_answers nem
-- emite (a view é ancorada em responses LLM com is_latest = true).
CREATE OR REPLACE FUNCTION public.is_auto_review_reconciliation_pending(
  p_project_id UUID,
  p_document_id UUID,
  p_llm_response_id UUID
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT (
    SESSION_USER = 'postgres'
    OR auth.role() = 'service_role'
    OR p_project_id IN (SELECT public.auth_user_accessible_project_ids())
  ) AND EXISTS (
    SELECT 1
    FROM public.auto_review_reconciliation_requests AS request
    WHERE request.project_id = p_project_id
      AND request.document_id = p_document_id
      AND request.llm_response_id = p_llm_response_id
  );
$$;

-- Fecha o último lugar onde NULL tinha significado: com IS NOT DISTINCT FROM,
-- um chamador que passasse NULL casaria a linha de um documento sem geração;
-- com `=`, não casa nada. O backoff em si fica intacto — sem estado terminal na
-- fila, o que ainda falha é falha de verdade e merece retry.
CREATE OR REPLACE FUNCTION public.record_auto_review_reconciliation_failure(
  p_document_id UUID,
  p_llm_response_id UUID,
  p_error TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.auto_review_reconciliation_requests AS request
  SET attempt_count = request.attempt_count + 1,
      last_error = pg_catalog.left(p_error, 4000),
      next_attempt_at = pg_catalog.now() + pg_catalog.make_interval(
        secs => LEAST(
          3600,
          (5 * pg_catalog.power(2, LEAST(request.attempt_count, 10)))::INTEGER
        )
      )
  WHERE request.document_id = p_document_id
    AND request.llm_response_id = p_llm_response_id;
  RETURN FOUND;
END;
$$;

-- Segundo produtor, usado pelo reparo do coordenador (regenerateAutoReviewBacklog).
-- O LEFT JOIN LATERAL era a outra fonte de linhas sem geração; com JOIN LATERAL,
-- documento sem LLM corrente simplesmente não entra no backlog.
CREATE OR REPLACE FUNCTION public.enqueue_auto_review_reconciliation_for_project(
  p_project_id UUID
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_enqueued INTEGER;
BEGIN
  -- Share the same per-document publication mutex used by the response trigger
  -- and publish_latest_llm_response. The repair action cannot enqueue a stale
  -- LLM generation while a rerun is being published.
  PERFORM 1
  FROM public.documents AS document
  WHERE document.project_id = p_project_id
  ORDER BY document.id
  FOR UPDATE;

  INSERT INTO public.auto_review_reconciliation_requests (
    document_id, project_id, llm_response_id, allow_new_cycles
  )
  SELECT
    document.id,
    document.project_id,
    llm.id,
    project.automation_mode = 'auto_review_llm'
  FROM public.documents AS document
  JOIN public.projects AS project ON project.id = document.project_id
  JOIN LATERAL (
    SELECT response.id
    FROM public.responses AS response
    WHERE response.project_id = document.project_id
      AND response.document_id = document.id
      AND response.respondent_type = 'llm'
      AND response.is_latest = true
      AND response.is_partial = false
    LIMIT 1
  ) AS llm ON true
  WHERE document.project_id = p_project_id
    AND EXISTS (
      SELECT 1
      FROM public.responses AS human
      WHERE human.project_id = document.project_id
        AND human.document_id = document.id
        AND human.respondent_type = 'humano'
        AND human.is_latest = true
        AND human.is_partial = false
    )
    AND (
      project.automation_mode = 'auto_review_llm'
      OR EXISTS (
        SELECT 1 FROM public.field_reviews AS review
        WHERE review.project_id = document.project_id
          AND review.document_id = document.id
      )
      OR EXISTS (
        SELECT 1 FROM public.field_review_cycle_history_entries AS history
        WHERE history.project_id = document.project_id
          AND history.document_id = document.id
      )
    )
  ON CONFLICT (document_id) DO UPDATE
  SET project_id = EXCLUDED.project_id,
      llm_response_id = EXCLUDED.llm_response_id,
      allow_new_cycles = EXCLUDED.allow_new_cycles,
      requested_at = pg_catalog.now(),
      next_attempt_at = pg_catalog.now(),
      attempt_count = 0,
      last_error = NULL;

  GET DIAGNOSTICS v_enqueued = ROW_COUNT;
  RETURN v_enqueued;
END;
$$;

COMMIT;
