"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { applyFieldOrder } from "@/lib/field-order";
import { sortByRecent } from "@/lib/coding-sort";
import { useUrlState } from "@/hooks/useUrlState";
import { useFieldOrder } from "@/hooks/useFieldOrder";
import { useAutosaveOnExit } from "@/hooks/useAutosaveOnExit";
import { useFullscreen } from "@/hooks/useFullscreen";
import { useDirtyDocs, useIsDocDirty } from "@/hooks/useDirtyDocs";
import { useCodingDrafts } from "@/hooks/useCodingDrafts";
import {
  CodingDraftBanner,
  CodingDraftUnavailableBanner,
} from "./CodingDraftBanner";
import type { CodingSnapshot } from "@/lib/coding-draft";
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
): InitialCodingState {
  if (docParam) {
    const assignedIdx = sortedDocuments.findIndex((d) => d.id === docParam);
    if (assignedIdx >= 0) {
      return { mode: "assigned", docIndex: assignedIdx };
    }
    return { mode: "browse", docIndex: 0 };
  }
  return { mode: hasAssignments ? "assigned" : "browse", docIndex: 0 };
}

const EMPTY_CODED_AT: Record<string, string> = {};
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
    computeInitialCodingState(docParam, sortedDocuments, hasAssignments),
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
    fields,
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
    mode,
    docParam,
    setSubmitting,
    markDirty,
    markClean,
    isDirty,
    recordDraft: drafts.recordDraft,
    submitConfirmed: drafts.submitConfirmed,
    updateDocParam,
  });

  // Troca de modo (Atribuídos↔Explorar). Ao SAIR do Explorar, descarta o
  // rascunho de browse não salvo: o BrowseDocCoder (keyed) desmonta e, ao voltar,
  // re-semeia do cache pré-edição; sem zerar o draft/dirty aqui, a edição sumiria
  // da tela mas ainda seria salva no autosave-on-exit / "Voltar" (ghost save).
  const discardBrowseDraft = browse.discardDraft;
  const handleModeChange = useCallback(
    (next: "assigned" | "browse") => {
      if (mode === "browse" && next !== "browse") discardBrowseDraft();
      setMode(next);
    },
    [mode, discardBrowseDraft],
  );

  // --- Auto-save on exit (#14, #28) ---
  // Instância única; o payload e a sujeira saem do modo ativo. `getIsDirty` é
  // um getter (lido no unload) para não acessar o ref do dirty no render.
  const activeDocId =
    mode === "assigned" ? assigned.currentDoc?.id ?? null : browse.browseDocId;
  const getIsDirty = useCallback(
    () => isDirty(activeDocId),
    [isDirty, activeDocId],
  );
  const getAssignedPayload = assigned.getPayload;
  const getBrowsePayload = browse.getPayload;
  const getPayload = useCallback(
    () => (mode === "assigned" ? getAssignedPayload() : getBrowsePayload()),
    [mode, getAssignedPayload, getBrowsePayload],
  );
  useAutosaveOnExit({ activeDocId, getIsDirty, getPayload });

  // --- Rascunho local (#608) ---
  // O baseline do documento aberto é o que o SERVIDOR entregou, nunca o que está
  // na tela: é contra ele que se decide se o rascunho ainda vale e o que ele
  // sobrescreveria. Em Explorar o conteúdo vem do fetch do doc; em Atribuídos,
  // das props do RSC.
  const remoteSnapshot: CodingSnapshot | null = useMemo(() => {
    if (!activeDocId) return null;
    if (mode === "assigned") {
      return {
        answers: existingAnswers[activeDocId] ?? {},
        notes:
          typeof existingJustifications[activeDocId]?._notes === "string"
            ? (existingJustifications[activeDocId]._notes as string)
            : "",
      };
    }
    const doc = browse.browseDoc;
    if (!doc || doc.document.id !== activeDocId) return null;
    return { answers: doc.initialAnswers, notes: doc.initialNotes };
  }, [activeDocId, mode, existingAnswers, existingJustifications, browse.browseDoc]);

  const openDocument = drafts.openDocument;
  useEffect(() => {
    // Em Explorar o baseline só existe depois do fetch; abrir antes classificaria
    // o rascunho contra um documento vazio e anunciaria como sobrescrita tudo o
    // que o servidor já tinha.
    if (mode === "browse" && activeDocId && !remoteSnapshot) return;
    openDocument(activeDocId, remoteSnapshot);
  }, [openDocument, activeDocId, mode, remoteSnapshot]);

  // Indicador de "não enviado": vem da sujeira em memória, não do storage — ver
  // o comentário em `useDirtyDocs`.
  const activeDocUnsent = useIsDocDirty(dirtyDocs, activeDocId);

  // "Retomar" no modo Explorar entra por REMOUNT do filho keyed, e não por
  // setState: `BrowseDocCoder` é construído sem estado derivado e sem setState em
  // effect, e empurrar valor para dentro dele quebraria essa propriedade.
  const [browseRestoreNonce, setBrowseRestoreNonce] = useState(0);
  const [browseRestored, setBrowseRestored] = useState<CodingSnapshot | null>(null);
  const restoreDraft = drafts.restoreDraft;
  const handleRestoreDraft = useCallback(() => {
    if (mode === "assigned") {
      assigned.handleRestoreDraft();
      return;
    }
    if (!browse.browseDocId) return;
    const restored = restoreDraft(browse.browseDocId);
    if (!restored) return;
    setBrowseRestored(restored);
    setBrowseRestoreNonce((n) => n + 1);
    markDirty(browse.browseDocId);
  }, [mode, assigned, browse.browseDocId, restoreDraft, markDirty]);

  const discardDraft = drafts.discardDraft;
  const handleDiscardDraft = useCallback(() => {
    if (activeDocId) discardDraft(activeDocId);
  }, [activeDocId, discardDraft]);

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

      {/* Faixas do rascunho local (#608), abaixo do header e acima das duas
          views: a oferta de recuperação e o aviso de que a cópia local não está
          funcionando. Nenhuma das duas se aplica em fullscreen, onde o header
          também não aparece. */}
      {!isFullscreen && (
        <>
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
          onSubmit={() => void assigned.handleSubmit()}
          submitting={submitting}
          notes={assigned.docNotes}
          onNotesChange={assigned.handleNotesChange}
          readOnly={readOnly}
          onReorder={handleReorder}
          outOfScope={assignedOutOfScope}
          unsent={activeDocUnsent}
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
          browseDoc={browse.browseDoc}
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
          onSubmit={(draft) => void browse.handleBrowseSubmit(draft)}
          onDraftChange={browse.handleDraftChange}
          outOfScope={browseOutOfScope}
          unsent={activeDocUnsent}
          restoredDraft={browseRestored}
          restoreNonce={browseRestoreNonce}
        />
      )}
    </div>
  );
}
