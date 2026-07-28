"use client";

import { Suspense, useCallback, useMemo, useState } from "react";
import { applyFieldOrder } from "@/lib/field-order";
import { sortByRecent } from "@/lib/coding-sort";
import type { DocRoundStatus } from "@/lib/rounds";
import { useUrlState } from "@/hooks/useUrlState";
import { useFieldOrder } from "@/hooks/useFieldOrder";
import { useFullscreen } from "@/hooks/useFullscreen";
import { useDirtyDocs, useDirtyDocsCount } from "@/hooks/useDirtyDocs";
import { useUnsavedWorkGuard } from "@/hooks/useUnsavedWorkGuard";
import { UnsavedWorkDialog } from "./UnsavedWorkDialog";
import { useCodingDrafts } from "@/hooks/useCodingDrafts";
import { useCodingDraftWiring } from "./useCodingDraftWiring";
import {
  CodingDraftBanner,
  CodingDraftUnavailableBanner,
  UnsentChangesBadge,
} from "./CodingDraftBanner";
import { CodingHeader, type DocSection } from "./CodingHeader";
import { CodingEmptyStates } from "./CodingEmptyStates";
import { AssignedCodingView } from "./AssignedCodingView";
import { BrowseCodingView } from "./BrowseCodingView";
import { useAssignedCoding } from "./useAssignedCoding";
import { useBrowseCoding } from "./useBrowseCoding";
import type { OutOfScopeConfig } from "./QuestionsPanel";
import type {
  PydanticField,
  AssignedDoc,
  Round,
  RoundStrategy,
} from "@/lib/types";

export interface RoundFilterData {
  strategy: RoundStrategy;
  currentRoundKey: string;
  currentRoundLabel: string;
  rounds: Round[];
  previousVersions: string[];
  selected: string;
}

export type CodingSortMode = "default" | "recent";

interface InitialCodingState {
  mode: "assigned" | "browse";
  docIndex: number;
}

/** Estado inicial derivado do `?doc=` da URL (mount apenas — ver comentário no
 *  `useState` que chama esta função). */
function computeInitialCodingState(
  docParam: string | null,
  sortedDocuments: AssignedDoc[],
  hasAssignments: boolean,
  statusByDoc: Record<string, DocRoundStatus>,
): InitialCodingState {
  if (docParam) {
    const assignedIdx = sortedDocuments.findIndex((d) => d.id === docParam);
    if (assignedIdx >= 0) {
      return { mode: "assigned", docIndex: assignedIdx };
    }
    return { mode: "browse", docIndex: 0 };
  }
  // Sem `?doc=`, abre na primeira codificação INCOMPLETA — trabalho que a
  // pesquisadora começou e não terminou vem antes de resposta completa que
  // voltou à fila por mudança de schema (#608). Medido em 2026-07-27: nenhuma
  // fila dos projetos ativos tem documento nunca respondido, então o critério
  // "não abrir no que já foi respondido" só é acionável nesta forma — e os
  // concluídos da rodada atual já saem server-side, no filtro de rodada.
  //
  // Fallback para o índice 0 quando não há parcial: aí a ordem escolhida pelo
  // sort é a melhor resposta que existe (em "recent", o último documento que ela
  // mexeu — retomar de onde parou).
  const firstPending = sortedDocuments.findIndex(
    (d) => statusByDoc[d.id]?.kind === "current_pending",
  );
  return {
    mode: hasAssignments ? "assigned" : "browse",
    docIndex: firstPending < 0 ? 0 : firstPending,
  };
}

const EMPTY_CODED_AT: Record<string, string> = {};
const EMPTY_STATUS_BY_DOC: Record<string, DocRoundStatus> = {};
const EMPTY_JUSTIFICATIONS: Record<string, Record<string, unknown>> = {};
const EMPTY_PENDING_EXCLUSIONS: Record<string, string> = {};

/** Config da pergunta "fora do escopo?" (QuestionsPanel), compartilhada pelos
 *  dois modos. Renderiza quando o recurso está ligado no projeto OU quando o
 *  doc já tem sinalização pendente (setting desligado não anula pendências
 *  existentes). `documentExists` cobre o caso do modo Explorar, em que o
 *  `documentId` (da URL) pode existir antes do conteúdo do doc carregar. */
function buildOutOfScopeConfig({
  documentId,
  documentExists,
  outOfScopeEnabled,
  projectId,
  documentTitle,
  pending,
}: {
  documentId: string | null | undefined;
  documentExists: boolean;
  outOfScopeEnabled: boolean;
  projectId: string;
  documentTitle: string;
  pending: { mine: boolean; reason?: string } | undefined;
}): OutOfScopeConfig | undefined {
  if (!documentId || !documentExists) return undefined;
  if (!outOfScopeEnabled && !pending) return undefined;
  return {
    projectId,
    documentId,
    documentTitle,
    initialState: pending
      ? { status: pending.mine ? "pending_mine" : "pending_other", reason: pending.reason }
      : { status: "normal" },
  };
}

/** Prop `doc` do `CodingHeader`: qual variante mostrar (atribuído/Explorar) e
 *  com quais dados, conforme o modo ativo. */
function buildHeaderDocSection(
  mode: "assigned" | "browse",
  assigned: {
    doc: AssignedDoc | undefined;
    title: string;
    docIndex: number;
    total: number;
    onNavigate: (index: number) => void;
    parecerUrl?: string;
    roundStatus: DocRoundStatus | undefined;
  },
  browse: {
    docId: string | null;
    title: string;
    responseCount: number;
    onBack: () => void;
    onRandom: () => void;
    submitting: boolean;
    parecerUrl?: string;
    projectId: string;
  },
): DocSection | undefined {
  if (mode === "assigned" && assigned.doc) {
    return {
      variant: "assigned",
      title: assigned.title,
      index: assigned.docIndex,
      total: assigned.total,
      onNavigate: assigned.onNavigate,
      parecerUrl: assigned.parecerUrl,
      roundStatus: assigned.roundStatus,
    };
  }
  if (mode === "browse" && browse.docId) {
    return {
      variant: "browse",
      title: browse.title,
      responseCount: browse.responseCount,
      onBack: browse.onBack,
      onRandom: browse.onRandom,
      submitting: browse.submitting,
      parecerUrl: browse.parecerUrl,
      projectId: browse.projectId,
      documentId: browse.docId,
    };
  }
  return undefined;
}

interface CodingPageProps {
  projectId: string;
  /** Membro DONO das escritas (`ownMemberUserId`), não o observado sob
   *  impersonação: é a identidade do slot do rascunho local. Ver
   *  `CodingDraftScope` em `lib/coding-draft.ts`. */
  userId: string;
  documents: AssignedDoc[];
  codedAtByDoc?: Record<string, string>;
  /** Por que cada documento está na fila — mesma classificação que a decidiu
   *  (`classifyDocStatus`, no servidor). Ver `CodingHeader`. */
  statusByDoc?: Record<string, DocRoundStatus>;
  fields: PydanticField[];
  existingAnswers: Record<string, Record<string, unknown>>;
  existingJustifications?: Record<string, Record<string, unknown>>;
  hasAssignments?: boolean;
  readOnly?: boolean;
  roundFilter?: RoundFilterData;
  /** Coordenador do projeto? Gate do botão "Rodar LLM" no header (#195). */
  canRunLlm?: boolean;
  /** projects.out_of_scope_enabled — mostra a pergunta "fora do escopo?". */
  outOfScopeEnabled?: boolean;
  /** Sinalizações pendentes DO PRÓPRIO usuário (docId → justificativa) nos
   *  docs atribuídos; pendências de outros já saem filtradas no servidor. */
  pendingExclusionByDoc?: Record<string, string>;
}

export function CodingPage(props: CodingPageProps) {
  // useSearchParams precisa de boundary de Suspense (react-doctor
  // nextjs-no-use-search-params-without-suspense).
  return (
    <Suspense fallback={null}>
      <CodingPageInner {...props} />
    </Suspense>
  );
}

function CodingPageInner({
  projectId,
  userId,
  documents,
  codedAtByDoc = EMPTY_CODED_AT,
  statusByDoc = EMPTY_STATUS_BY_DOC,
  fields,
  existingAnswers,
  existingJustifications = EMPTY_JUSTIFICATIONS,
  hasAssignments = false,
  readOnly = false,
  roundFilter,
  canRunLlm = false,
  outOfScopeEnabled = false,
  pendingExclusionByDoc = EMPTY_PENDING_EXCLUSIONS,
}: CodingPageProps) {
  const { get: getParam, set: setParams } = useUrlState();
  const docParam = getParam("doc");

  // Ordenacao da navegacao de documentos atribuidos (issue #108). Padrao e
  // "recent" — ordena pelo responses.updated_at do proprio pesquisador, para o
  // pesquisador cair direto no ultimo documento que mexeu. "default" (opt-in
  // via ?sort=default) mantem a ordem do servidor (status do assignment).
  const sortMode: CodingSortMode =
    getParam("sort") === "default" ? "default" : "recent";
  const sortedDocuments = useMemo(
    () =>
      sortMode === "recent" ? sortByRecent(documents, codedAtByDoc) : documents,
    [documents, sortMode, codedAtByDoc],
  );

  // Lazy initializer: roda só no mount, capturando docParam/sortedDocuments/
  // hasAssignments iniciais — intencional: navegação posterior não deve
  // recomputar o estado inicial (era um useCallback com deps [] + eslint-disable).
  const [initial] = useState(() =>
    computeInitialCodingState(docParam, sortedDocuments, hasAssignments, statusByDoc),
  );

  const [mode, setMode] = useState<"assigned" | "browse">(initial.mode);
  const [submitting, setSubmitting] = useState(false);

  const { isFullscreen, toggleFullscreen } = useFullscreen();

  // Ordem custom de perguntas do pesquisador (debounce/flush/guard no hook).
  const { fieldOrder, handleReorder } = useFieldOrder(projectId);
  const orderedFields = useMemo(
    () => applyFieldOrder(fields, fieldOrder),
    [fields, fieldOrder],
  );

  // Sujeira compartilhada entre os modos. O store é imperativo para os handlers
  // e reativo para a tela (ver `useDirtyDocs`): o indicador de "não enviado" sai
  // DAQUI, nunca do resultado da persistência local.
  const dirtyDocs = useDirtyDocs();
  const { markDirty, markClean, isDirty } = dirtyDocs;

  const updateDocParam = useCallback(
    (docId: string | null) => {
      setParams({ doc: docId }, { scroll: false });
    },
    [setParams],
  );

  // Rede local (#608). Instanciado ANTES dos hooks de modo porque eles precisam
  // do `recordDraft`; em troca, o documento aberto — que só é conhecido depois —
  // entra por `openDocument`, num effect mais abaixo.
  const drafts = useCodingDrafts({
    projectId,
    userId,
    // Sob impersonação ou rodada anterior a tela é read-only: guardar rascunho
    // ali depositaria trabalho num slot que ninguém vai enviar.
    enabled: !readOnly,
    fields,
  });

  const assigned = useAssignedCoding({
    projectId,
    documents,
    // `orderedFields`, e não `fields`: o toast de pendência nomeia a primeira
    // obrigatória em aberto NESTA ordem, que é a mesma em que o painel procura o
    // card para o qual rolar (`pointAtFields` sobre `visibleFields`). Com o
    // schema cru aqui e a ordem custom lá, o toast nomearia uma pergunta e a tela
    // saltaria para outra. O outro consumidor (`clearHiddenConditionalAnswers`)
    // é indiferente à ordem — é o mesmo conjunto.
    fields: orderedFields,
    sortedDocuments,
    codedAtByDoc,
    existingAnswers,
    existingJustifications,
    initialDocIndex: initial.docIndex,
    setSubmitting,
    markDirty,
    markClean,
    isDirty,
    recordDraft: drafts.recordDraft,
    restoreDraft: drafts.restoreDraft,
    submitConfirmed: drafts.submitConfirmed,
    updateDocParam,
    setParams,
  });

  const browse = useBrowseCoding({
    projectId,
    documents,
    // Mesma razão do modo Atribuídos: a ordem daqui é a que o toast nomeia.
    fields: orderedFields,
    mode,
    docParam,
    setSubmitting,
    markDirty,
    markClean,
    recordDraft: drafts.recordDraft,
    submitConfirmed: drafts.submitConfirmed,
    updateDocParam,
  });

  // Troca de modo (Atribuídos↔Explorar). Ao SAIR do Explorar, esquece o rascunho
  // de browse EM MEMÓRIA: o BrowseDocCoder (keyed) desmonta e, ao voltar,
  // re-semeia do cache pré-edição, então manter o ref preenchido descolaria o que
  // a tela mostra do que o container acha que está editado.
  //
  // Até o #608 isto também zerava a sujeira, para evitar "ghost save" — o
  // autosave gravando uma edição que a tela já tinha descartado. Sem autosave não
  // há o que gravar, e o dirty passa a sobreviver à troca de modo de propósito: a
  // edição continua no rascunho local, logo continua não enviada.
  const discardBrowseDraft = browse.discardDraft;
  const handleModeChange = useCallback(
    (next: "assigned" | "browse") => {
      if (mode === "browse" && next !== "browse") discardBrowseDraft();
      setMode(next);
    },
    [mode, discardBrowseDraft],
  );

  const activeDocId =
    mode === "assigned" ? assigned.currentDoc?.id ?? null : browse.browseDocId;

  // Aviso de saída (#608). Conta DOCUMENTOS com alterações não enviadas, não só
  // o aberto: quem edita três documentos e clica em "Revisar" precisa saber dos
  // três. A contagem sai do store de sujeira, nunca do que conseguiu ser
  // gravado no `localStorage` — ver `useDirtyDocs`. Um documento sem cópia local
  // é justamente o que MAIS precisa do aviso; derivar a contagem do storage o
  // esconderia.
  const unsentDocsCount = useDirtyDocsCount(dirtyDocs);

  // O que o aviso pode AFIRMAR sobre o destino do trabalho, medido no instante
  // do clique. O `flushAll` vem primeiro por dois motivos: sair por navegação
  // SPA não dispara nenhum dos três gatilhos em que o rascunho já era gravado
  // (`beforeunload`, `pagehide`, `visibilitychange`), então sem ele a última
  // edição digitada dentro da janela do debounce ficaria de fora; e medir antes
  // de gravar responderia sobre um estado que a própria saída ia mudar.
  const describeUnsentWork = useCallback(() => {
    drafts.flushAll();
    const dirtyIds = dirtyDocs.getDirtyDocIds();
    return {
      allHaveLocalCopy:
        dirtyIds.length > 0 && dirtyIds.every((id) => drafts.hasStoredDraft(id)),
    };
  }, [drafts, dirtyDocs]);

  const { isPrompting, pendingInfo, confirmLeave, cancelLeave } =
    useUnsavedWorkGuard(unsentDocsCount > 0, describeUnsentWork);

  const {
    activeDocUnsent,
    handleRestoreDraft,
    handleDiscardDraft,
    browseDocForCoder,
    browseRestoreNonce,
  } = useCodingDraftWiring({
    mode,
    activeDocId,
    drafts,
    dirtyDocs,
    markDirty,
    restoreAssignedDraft: assigned.handleRestoreDraft,
    browseDocId: browse.browseDocId,
    browseDoc: browse.browseDoc,
    existingAnswers,
    existingJustifications,
  });

  if (fields.length === 0) {
    return <CodingEmptyStates kind="no-fields" />;
  }

  const assignedTitle =
    assigned.currentDoc?.title || assigned.currentDoc?.external_id || "Documento";
  const browseTitle =
    browse.browseDocInfo?.title ||
    browse.browseDocInfo?.external_id ||
    browse.browseDoc?.document.title ||
    browse.browseDoc?.document.external_id ||
    "Documento";

  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
  const assignedParecerUrl = assigned.currentDoc
    ? `${baseUrl}/projects/${projectId}/analyze/code?doc=${assigned.currentDoc.id}`
    : undefined;
  const browseParecerUrl = browse.browseDocId
    ? `${baseUrl}/projects/${projectId}/analyze/code?doc=${browse.browseDocId}`
    : undefined;

  const handleExploreMore = () => {
    setMode("browse");
    assigned.resetAllDone();
  };

  // Sinalização pendente DO PRÓPRIO usuário no doc atribuído atual (pendências
  // de outros já saem filtradas no servidor — por isso sempre "mine" aqui).
  const assignedPendingReason = assigned.currentDoc
    ? pendingExclusionByDoc[assigned.currentDoc.id]
    : undefined;
  const assignedOutOfScope = buildOutOfScopeConfig({
    documentId: assigned.currentDoc?.id,
    documentExists: !!assigned.currentDoc,
    outOfScopeEnabled,
    projectId,
    documentTitle: assignedTitle,
    pending:
      assignedPendingReason !== undefined
        ? { mine: true, reason: assignedPendingReason }
        : undefined,
  });

  const browsePending = browse.browseDoc?.document.exclusionPending ?? null;
  const browseOutOfScope = buildOutOfScopeConfig({
    documentId: browse.browseDocId,
    documentExists: !!browse.browseDoc,
    outOfScopeEnabled,
    projectId,
    documentTitle: browseTitle,
    pending: browsePending
      ? { mine: browsePending.mine, reason: browsePending.reason ?? undefined }
      : undefined,
  });

  return (
    <div
      className={
        isFullscreen
          ? "fixed inset-0 z-50 flex flex-col bg-background"
          : "flex h-[calc(100vh-96px)] flex-col"
      }
    >
      {!isFullscreen && (
        <CodingHeader
          mode={mode}
          onModeChange={handleModeChange}
          assignedCount={documents.length}
          sortMode={sortMode}
          onSortChange={assigned.handleSortChange}
          roundFilter={roundFilter}
          canRunLlm={canRunLlm}
          doc={buildHeaderDocSection(
            mode,
            {
              doc: assigned.currentDoc,
              title: assignedTitle,
              docIndex: assigned.docIndex,
              total: documents.length,
              onNavigate: assigned.handleDocNavigate,
              parecerUrl: assignedParecerUrl,
              roundStatus: assigned.currentDoc
                ? statusByDoc[assigned.currentDoc.id]
                : undefined,
            },
            {
              docId: browse.browseDocId,
              title: browseTitle,
              responseCount: browse.browseDocInfo?.responseCount ?? 0,
              onBack: () => void browse.handleBrowseBack(),
              onRandom: browse.handleBrowseRandom,
              submitting,
              parecerUrl: browseParecerUrl,
              projectId,
            },
          )}
          onToggleFullscreen={toggleFullscreen}
        />
      )}

      {/* Fora do bloco de fullscreen abaixo de propósito: o aviso de saída vale
          em qualquer modo de exibição, e esconder-lo em fullscreen deixaria a
          navegação retida sem nada em cena para resolvê-la. */}
      <UnsavedWorkDialog
        open={isPrompting}
        unsentDocsCount={unsentDocsCount}
        // Fail-safe no `?? false`: sem instantâneo não há o que afirmar, e a
        // frase cautelosa é a única honesta.
        allHaveLocalCopy={pendingInfo?.allHaveLocalCopy ?? false}
        onLeave={confirmLeave}
        onStay={cancelLeave}
      />

      {/* Faixas do rascunho local (#608), abaixo do header e acima das duas
          views: a oferta de recuperação e o aviso de que a cópia local não está
          funcionando. Nenhuma das duas se aplica em fullscreen, onde o header
          também não aparece. */}
      {!isFullscreen && (
        <>
          {/* Um único indicador para os dois modos, junto das faixas do
              rascunho: permanente enquanto houver pendência, some quando o envio
              é confirmado. Fica aqui — e não dentro do painel de perguntas —
              porque o sinal é da PÁGINA (o documento aberto), e porque duplicá-lo
              por modo obrigava cada view a repassá-lo. */}
          {activeDocUnsent && (
            <div className="flex items-center gap-2 border-b px-4 py-1.5">
              <UnsentChangesBadge visible />
            </div>
          )}
          <CodingDraftBanner
            recovery={drafts.recovery}
            fields={fields}
            onRestore={handleRestoreDraft}
            onDiscard={handleDiscardDraft}
          />
          <CodingDraftUnavailableBanner
            visible={!drafts.storageAvailable && activeDocUnsent}
          />
        </>
      )}

      {mode === "assigned" && (
        <AssignedCodingView
          doc={assigned.currentDoc}
          title={assignedTitle}
          docIndex={assigned.docIndex}
          total={documents.length}
          isFullscreen={isFullscreen}
          onNavigate={assigned.handleDocNavigate}
          onExitFullscreen={toggleFullscreen}
          fields={orderedFields}
          answers={assigned.docAnswers}
          onAnswer={assigned.handleAnswer}
          // Sem `void`: o retorno É o veredito do servidor, e é ele que faz o
          // painel rolar até a obrigatória que ficou em aberto (#608). O
          // `no-floating-promises` fica satisfeito porque a Promise passa a ser
          // devolvida, não descartada.
          onSubmit={() => assigned.handleSubmit()}
          submitting={submitting}
          notes={assigned.docNotes}
          onNotesChange={assigned.handleNotesChange}
          readOnly={readOnly}
          onReorder={handleReorder}
          outOfScope={assignedOutOfScope}
          allDone={assigned.allDone}
          onExploreMore={handleExploreMore}
          hasAssignments={hasAssignments}
          roundFilter={roundFilter}
        />
      )}

      {mode === "browse" && (
        <BrowseCodingView
          browseLoading={browse.browseLoading}
          browseError={browse.browseError}
          browseDocId={browse.browseDocId}
          browseDocuments={browse.browseDocuments}
          browseDocLoading={browse.browseDocLoading}
          browseDoc={browseDocForCoder}
          onSelect={browse.handleBrowseSelect}
          onRetry={browse.retryBrowse}
          onRetryDoc={browse.retryBrowseDoc}
          fields={orderedFields}
          submitting={submitting}
          readOnly={readOnly}
          isFullscreen={isFullscreen}
          title={browseTitle}
          responseCount={browse.browseDocInfo?.responseCount ?? 0}
          onToggleFullscreen={toggleFullscreen}
          onReorder={handleReorder}
          onSubmit={(draft) => browse.handleBrowseSubmit(draft)}
          onDraftChange={browse.handleDraftChange}
          outOfScope={browseOutOfScope}
          restoreNonce={browseRestoreNonce}
        />
      )}
    </div>
  );
}
