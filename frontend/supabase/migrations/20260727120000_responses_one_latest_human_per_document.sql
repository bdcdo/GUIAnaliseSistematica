-- Unicidade da resposta humana corrente em `responses` (issue #609).
--
-- Até aqui o único índice único da tabela cobria o LLM
-- (`responses_one_latest_llm_per_document`, 20260717120000). A chave lógica
-- equivalente para humanos — uma resposta corrente por (projeto, documento,
-- respondente) — vivia SÓ na aplicação, no SELECT de `fetchSaveContext`
-- (frontend/src/actions/responses.ts), aplicado num read-then-write sem trava:
-- o SELECT que decide "existe linha?" e o INSERT que age sobre essa decisão
-- são requests PostgREST separados, em transações distintas. O estado "duas
-- linhas is_latest=true da mesma pessoa no mesmo documento" era construível.
--
-- O que torna a duplicata perigosa não é ela existir, é ela não ser detectada:
-- com duas linhas ativas o `.maybeSingle()` do save passa a errar sempre, o
-- erro era descartado, e cada gravação seguinte caía no ramo de INSERT
-- acrescentando mais uma linha. A jusante, quatro consumidores contam LINHAS e
-- não PESSOAS (auto-comparison, compare-divergence, useCompareFieldData,
-- compare-queue), então duas linhas da mesma pessoa satisfariam o gate
-- minHumans=2 e disparariam auto-comparação sobre um respondente só.
--
-- Medição em produção (2026-07-27, harness/2026-07-27-duplicatas-responses/
-- medir-duplicatas.mts, read-only, 1.180 linhas): 0 duplicatas humanas ativas,
-- 0 duplicatas LLM (controle do índice existente), 0 respostas humanas com
-- respondent_id NULL, sobre 629 humanas correntes. Esta migration fecha uma
-- garantia ausente, não repara estrago em curso.

BEGIN;

-- Estabiliza o conjunto entre o preflight e a restrição. Sem ele existe janela
-- entre medir e restringir — que é exatamente a corrida read-then-write que
-- esta migration fecha. Não bloqueia leitura. Mesmo protocolo de
-- 20260716154500_responses_llm_actor_integrity.sql.
LOCK TABLE public.responses IN SHARE ROW EXCLUSIVE MODE;

-- ========== Preflight: abortar nomeando o resíduo, nunca sanear ============
--
-- Demover `is_latest` NÃO é uma operação inerte nesta tabela: dispara o
-- trigger AFTER UPDATE `archive_review_dependencies_on_response_change`
-- (20260717120000), que APAGA field_reviews e response_equivalences cujo
-- snapshot ficou obsoleto e reconcilia assignments de auto_revisao/arbitragem.
-- Destruir revisão humana não pode ser efeito colateral silencioso de um
-- `db push`. Por isso aqui se aborta, ao contrário do bloco de dedupe do lado
-- LLM (20260717120000:846-868), onde a linha rebaixada era resposta de máquina
-- regenerável.
--
-- Se o primeiro bloco disparar, o reparo determinístico — a MESMA regra de
-- desempate que unify_project_members já usa — é este, para ser rodado
-- conscientemente, sabendo do efeito em cascata acima:
--
--   WITH ranked AS (
--     SELECT id, ROW_NUMBER() OVER (
--              PARTITION BY project_id, document_id, respondent_id
--              ORDER BY COALESCE(updated_at, created_at) DESC, id DESC) AS rn
--     FROM public.responses
--     WHERE respondent_type = 'humano' AND is_latest
--       AND respondent_id IS NOT NULL
--   )
--   UPDATE public.responses r SET is_latest = false
--   FROM ranked WHERE r.id = ranked.id AND ranked.rn > 1;
--
-- O segundo bloco (autoria ausente) não tem reparo automático possível:
-- inventar autor é falsificar autoria, e demover para is_latest=false
-- esconderia a codificação de alguém. Exige decisão humana.
DO $preflight$
DECLARE
  v_offenders TEXT;
BEGIN
  SELECT pg_catalog.string_agg(
           pg_catalog.format('(%s, %s): %s linhas',
                             offender.document_id, offender.respondent_id,
                             offender.total),
           '; ' ORDER BY offender.document_id)
    INTO v_offenders
  FROM (
    SELECT response.document_id,
           response.respondent_id,
           pg_catalog.count(*) AS total
    FROM public.responses AS response
    WHERE response.respondent_type = 'humano'
      AND response.is_latest
      AND response.respondent_id IS NOT NULL
    GROUP BY response.project_id, response.document_id, response.respondent_id
    HAVING pg_catalog.count(*) > 1
  ) AS offender;

  IF v_offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'responses tem resposta humana corrente duplicada por (documento, respondente): %',
      v_offenders
      USING ERRCODE = '23505',
            HINT = 'Ver o reparo determinístico no comentário desta migration; ele APAGA field_reviews/response_equivalences dependentes via trigger.';
  END IF;
END;
$preflight$;

DO $preflight_actor$
DECLARE
  v_offenders TEXT;
BEGIN
  SELECT pg_catalog.string_agg(response.id::text, ', ' ORDER BY response.id)
    INTO v_offenders
  FROM public.responses AS response
  WHERE response.respondent_type = 'humano'
    AND response.is_latest
    AND response.respondent_id IS NULL;

  IF v_offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'responses tem resposta humana corrente sem respondent_id: %', v_offenders
      USING ERRCODE = '23514',
            HINT = 'Autoria não se conserta sozinha: identifique quem codificou antes de aplicar.';
  END IF;
END;
$preflight_actor$;

-- ========== A restrição ====================================================
--
-- O CHECK não é acessório do índice, é o que faz o índice restringir: NULL
-- nunca colide em índice único, então N respostas humanas correntes sem autor
-- passariam pelo índice abaixo sem violar nada — a restrição existiria e não
-- restringiria. O braço `NOT is_latest` isenta histórico antigo sem autor, se
-- houver. Fecha o par com responses_llm_has_no_human_actor_check
-- (20260716154500): LLM nunca tem autor, humano corrente sempre tem.
--
-- Descartado NULLS NOT DISTINCT no índice (disponível desde o PG15): ele
-- colapsaria todos os anônimos de um documento num slot só, confundindo duas
-- pessoas diferentes numa — decisão sobre o dado disfarçada de constraint. O
-- CHECK diz a coisa certa: resposta humana corrente sem autor é
-- irrepresentável.
ALTER TABLE public.responses
  ADD CONSTRAINT responses_human_latest_has_actor_check CHECK (
    respondent_type <> 'humano' OR NOT is_latest OR respondent_id IS NOT NULL
  );

-- Espelha responses_one_latest_llm_per_document, com respondent_id na chave:
-- dois humanos DISTINTOS correntes no mesmo documento continuam permitidos —
-- é a dupla independente, o método do produto. O que fica proibido é a MESMA
-- pessoa duas vezes.
--
-- `AND is_latest` sem `= true` é seguro porque a coluna é NOT NULL desde
-- 20260716160100:54-59. Não se aplica aqui o motivo do IS DISTINCT FROM de
-- assignments_one_active_comparacao_per_doc, que existia por causa de status
-- nulo caindo FORA do predicado.
--
-- Sem IF NOT EXISTS: mascararia um índice homônimo com predicado diferente, e
-- este é novo. Sem CONCURRENTLY: não roda dentro de transação, e a transação
-- (lock + preflight + índice) é justamente o ponto; a tabela é pequena.
--
-- project_id na chave é redundante em teoria (document_id já identifica o
-- projeto) e é mantido por simetria com o índice LLM e com os .eq() do app.
-- Residual assumido, idêntico ao do índice LLM: duas responses do mesmo
-- documento com project_id divergente não seriam pegas.
CREATE UNIQUE INDEX responses_one_latest_human_per_document
  ON public.responses (project_id, document_id, respondent_id)
  WHERE respondent_type = 'humano' AND is_latest;

-- ========== unify_project_members: demover ANTES de repontar ===============
--
-- Esta função CONSTRÓI o estado agora proibido, de propósito, e só depois o
-- desfaz: em 20260716155000 o bloco `-- ===== responses =====` primeiro
-- reatribui respondent_id do source para o target e só então demove as
-- perdedoras. Esse primeiro UPDATE é exatamente o que produz duas linhas
-- (project_id, document_id, target, 'humano', is_latest) quando source e
-- target codificaram o mesmo documento — o caso central da unificação.
--
-- Índice parcial NÃO pode ser DEFERRABLE (UNIQUE CONSTRAINT não aceita WHERE),
-- então a checagem é imediata, dentro do statement do repoint: sem esta
-- reordenação a unificação passaria a estourar 23505 para o coordenador em
-- runtime, e preview_project_member_unification não avisaria — ele só antecipa
-- colisões de review, arbitragem e comparação, não de responses.
--
-- A correção rankeia sobre a UNIÃO source ∪ target e demove antes de repontar.
-- Mesmo vencedor, mesmo desempate (COALESCE(updated_at, created_at) DESC,
-- id DESC): nenhuma semântica nova, a mesma decisão movida para antes. O corpo
-- abaixo é o de 20260716155000 com esse único bloco trocado.
CREATE OR REPLACE FUNCTION public.unify_project_members(
  p_project_id UUID,
  p_source_user_id UUID,
  p_target_user_id UUID,
  p_linked_user_id UUID,
  p_link_email TEXT,
  p_acting_user_id UUID,
  p_expected_snapshot_version BIGINT
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_locked_membership_count INTEGER;
  v_review_conflicts BIGINT;
  v_arbitration_conflicts BIGINT;
  v_comparison_conflicts BIGINT;
BEGIN
  IF p_source_user_id = p_target_user_id THEN
    RAISE EXCEPTION 'source e target devem ser membros distintos';
  END IF;
  IF btrim(p_link_email) = '' THEN
    RAISE EXCEPTION 'e-mail do vínculo não pode ser vazio';
  END IF;
  IF p_linked_user_id = p_target_user_id THEN
    RAISE EXCEPTION 'a conta vinculada já é o membro de destino'
      USING ERRCODE = '23514';
  END IF;

  -- A gestão de identidade toma o lock global antes de qualquer linha.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('canonical-project-identity', 0)
  );

  PERFORM public.assert_identity_write_proof(
    p_linked_user_id,
    p_link_email,
    p_expected_snapshot_version
  );
  IF p_linked_user_id <> p_source_user_id THEN
    PERFORM public.assert_identity_write_proof(
      p_source_user_id,
      p_link_email,
      NULL
    );
  END IF;

  -- A ordem global dos UUIDs evita deadlocks entre unificações sobrepostas.
  -- Depois de aguardar um lock, READ COMMITTED reavalia a linha atualizada ou
  -- removida; por isso a contagem também é a validação de membership.
  PERFORM pm.user_id
  FROM public.project_members pm
  WHERE pm.project_id = p_project_id
    AND pm.user_id IN (p_source_user_id, p_target_user_id)
  ORDER BY pm.user_id
  FOR UPDATE;
  GET DIAGNOSTICS v_locked_membership_count = ROW_COUNT;

  IF v_locked_membership_count <> 2 THEN
    RAISE EXCEPTION 'source e target devem ser membros do projeto';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.member_email_links mel
    WHERE mel.project_id = p_project_id
      AND mel.email = lower(btrim(p_link_email))
      AND mel.member_user_id NOT IN (p_source_user_id, p_target_user_id)
  ) THEN
    RAISE EXCEPTION 'e-mail já está vinculado a outro membro do projeto'
      USING ERRCODE = '23514';
  END IF;

  -- DML já em voo termina antes destes locks; novo DML espera o commit da
  -- unificação. A ordem membership→tabelas acompanha as RPCs de permissão e
  -- remoção, evitando ciclo com transações que já bloquearam a membership.
  -- field_reviews precede assignments porque as RPCs de arbitragem atualizam
  -- essas duas tabelas nessa ordem; reviews e responses precedem assignments
  -- para acompanhar replace_and_add_documents.
  LOCK TABLE
    public.field_reviews,
    public.reviews,
    public.responses,
    public.assignments,
    public.researcher_field_orders,
    public.response_equivalences,
    public.verdict_acknowledgments
  IN SHARE ROW EXCLUSIVE MODE;

  SELECT
    preview.review_conflicts,
    preview.arbitration_conflicts,
    preview.comparison_conflicts
  INTO STRICT
    v_review_conflicts,
    v_arbitration_conflicts,
    v_comparison_conflicts
  FROM public.preview_project_member_unification(
    p_project_id,
    p_source_user_id,
    p_target_user_id
  ) preview;

  IF v_arbitration_conflicts > 0 THEN
    RAISE EXCEPTION
      'source e target participam da mesma arbitragem pendente'
      USING ERRCODE = '23514';
  END IF;

  IF v_review_conflicts > 0 THEN
    RAISE EXCEPTION
      'source e target possuem revisões do mesmo campo; a unificação preserva ambas e deve ser cancelada'
      USING ERRCODE = '23514';
  END IF;

  IF v_comparison_conflicts > 0 THEN
    RAISE EXCEPTION
      'source e target tornariam revisor e codificador da mesma comparação a mesma pessoa'
      USING ERRCODE = '23514';
  END IF;

  -- ===== assignments (colisão: target prevalece) =====
  -- Precedência do target vale para a identidade e para o progresso: uma
  -- codificação concluída do target supera uma em andamento do source, e o
  -- DELETE abaixo descarta a do source sem dó.
  --
  -- Auto-revisão e arbitragem são as exceções, porque o trabalho delas não
  -- vive no assignment e sim nos field_reviews, que a fusão transfere logo
  -- adiante: field_reviews é
  -- UNIQUE(document_id, field_name), então source e target podem deter campos
  -- distintos do MESMO documento. Se o target já concluiu a fila daquele
  -- documento e o source deixou campos sem veredito, descartar o assignment do
  -- source faria os field_reviews pendentes migrarem para uma fila fechada —
  -- estado que a pós-condição de 20260716160300 trata como erro de deploy, e
  -- que sumiria o documento da fila do target sem volta. Reabrir só quando há
  -- pendência real migrando mantém a regra estreita: nenhum outro tipo é
  -- tocado, e nada é reaberto sem trabalho a fazer.
  UPDATE public.assignments t
  SET status = 'pendente',
      completed_at = NULL
  WHERE t.project_id = p_project_id
    AND t.user_id = p_target_user_id
    AND t.type = 'auto_revisao'
    AND t.status = 'concluido'
    AND EXISTS (
      SELECT 1
      FROM public.field_reviews fr
      WHERE fr.project_id = p_project_id
        AND fr.document_id = t.document_id
        AND fr.self_reviewer_id = p_source_user_id
        AND fr.self_verdict IS NULL
    );

  -- A arbitragem tem a MESMA anatomia (trabalho nos field_reviews, não no
  -- assignment) e o mesmo buraco: campos contestados de levas distintas podem
  -- deixar o source com fila pendente enquanto o target já concluiu a dele no
  -- mesmo documento. Sem reabrir, o DELETE abaixo migraria final_verdict IS
  -- NULL para debaixo de assignment 'concluido' — e nenhum caminho reabre
  -- arbitragem depois (assign_arbitration_if_eligible só pega arbitrator_id
  -- IS NULL; sync_arbitration_assignment_status só fecha): o documento
  -- sumiria da fila de arbitragem para sempre.
  UPDATE public.assignments t
  SET status = 'pendente',
      completed_at = NULL
  WHERE t.project_id = p_project_id
    AND t.user_id = p_target_user_id
    AND t.type = 'arbitragem'
    AND t.status = 'concluido'
    AND EXISTS (
      SELECT 1
      FROM public.field_reviews fr
      WHERE fr.project_id = p_project_id
        AND fr.document_id = t.document_id
        AND fr.arbitrator_id = p_source_user_id
        AND fr.final_verdict IS NULL
    );

  DELETE FROM public.assignments s
  WHERE s.project_id = p_project_id
    AND s.user_id = p_source_user_id
    AND EXISTS (
      SELECT 1 FROM public.assignments t
      WHERE t.project_id = p_project_id
        AND t.user_id = p_target_user_id
        AND t.document_id = s.document_id
        AND t.type = s.type
    );
  UPDATE public.assignments
  SET user_id = p_target_user_id
  WHERE project_id = p_project_id AND user_id = p_source_user_id;

  -- ===== responses =====
  -- Demover ANTES de repontar (#609). O repoint sozinho produz duas linhas
  -- correntes do target no mesmo documento sempre que source e target
  -- codificaram o mesmo doc, e responses_one_latest_human_per_document é
  -- imediato — índice parcial não pode ser DEFERRABLE. Rankear sobre a UNIÃO
  -- source ∪ target dá o mesmo vencedor que o rank pós-repoint dava sobre o
  -- conjunto fundido, com o mesmo desempate; só a ordem das duas mutações
  -- mudou. Manter nesta ordem.
  WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY document_id
             ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
           ) AS rn
    FROM public.responses
    WHERE project_id = p_project_id
      AND respondent_id IN (p_source_user_id, p_target_user_id)
      AND respondent_type = 'humano'
      AND is_latest
  )
  UPDATE public.responses r
  SET is_latest = false
  FROM ranked
  WHERE r.id = ranked.id AND ranked.rn > 1;

  UPDATE public.responses
  SET respondent_id = p_target_user_id
  WHERE project_id = p_project_id AND respondent_id = p_source_user_id;

  -- ===== reviews =====
  -- Colisões foram rejeitadas antes da primeira mutação para que nenhuma
  -- revisão histórica seja descartada.
  UPDATE public.reviews
  SET reviewer_id = p_target_user_id
  WHERE project_id = p_project_id AND reviewer_id = p_source_user_id;

  -- ===== verdict_acknowledgments (target prevalece) =====
  DELETE FROM public.verdict_acknowledgments s
  WHERE s.respondent_id = p_source_user_id
    AND s.review_id IN (
      SELECT id FROM public.reviews WHERE project_id = p_project_id
    )
    AND EXISTS (
      SELECT 1 FROM public.verdict_acknowledgments t
      WHERE t.review_id = s.review_id
        AND t.respondent_id = p_target_user_id
    );
  UPDATE public.verdict_acknowledgments
  SET respondent_id = p_target_user_id
  WHERE respondent_id = p_source_user_id
    AND review_id IN (
      SELECT id FROM public.reviews WHERE project_id = p_project_id
    );

  -- ===== field_reviews =====
  UPDATE public.field_reviews
  SET self_reviewer_id = p_target_user_id
  WHERE project_id = p_project_id AND self_reviewer_id = p_source_user_id;
  UPDATE public.field_reviews
  SET arbitrator_id = p_target_user_id
  WHERE project_id = p_project_id AND arbitrator_id = p_source_user_id;

  -- ===== response_equivalences =====
  UPDATE public.response_equivalences
  SET reviewer_id = p_target_user_id
  WHERE project_id = p_project_id AND reviewer_id = p_source_user_id;

  -- Preferência pessoal do source não é herdada.
  DELETE FROM public.researcher_field_orders
  WHERE project_id = p_project_id AND user_id = p_source_user_id;

  -- Vínculos que tinham o source como identidade canônica passam ao target.
  UPDATE public.member_email_links
  SET member_user_id = p_target_user_id
  WHERE project_id = p_project_id AND member_user_id = p_source_user_id;

  -- A membership precisa sair antes do alias source→target: o trigger torna a
  -- coexistência irrepresentável. Falha posterior reverte toda a transação.
  DELETE FROM public.project_members
  WHERE project_id = p_project_id AND user_id = p_source_user_id;

  INSERT INTO public.member_email_links
    (project_id, member_user_id, email, linked_user_id, created_by)
  VALUES
    (
      p_project_id,
      p_target_user_id,
      lower(btrim(p_link_email)),
      p_linked_user_id,
      p_acting_user_id
    )
  ON CONFLICT (project_id, email) DO UPDATE
  SET member_user_id = EXCLUDED.member_user_id,
      linked_user_id = EXCLUDED.linked_user_id,
      created_by = EXCLUDED.created_by;
END;
$$;

COMMIT;
