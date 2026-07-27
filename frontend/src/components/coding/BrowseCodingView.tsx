"use client";

import { Button } from "@/components/ui/button";
import { DocumentPicker } from "./DocumentPicker";
import { type ForwardedCodingProps, BrowseDocCoder, type CodingDraft } from "./BrowseDocCoder";
import type { OutOfScopeConfig } from "./QuestionsPanel";
import type { CodingDocument } from "@/hooks/useDocumentForCoding";
import type { BrowseDocument } from "@/actions/documents";
import type { PydanticField } from "@/lib/types";

interface BrowseCodingViewProps extends ForwardedCodingProps {
  browseLoading: boolean;
  browseError: boolean;
  browseDocId: string | null;
  browseDocuments: BrowseDocument[] | null;
  browseDocLoading: boolean;
  browseDoc: CodingDocument | null | undefined;
  onSelect: (docId: string) => void;
  /** Retry do fetch da lista (modo Explorar falhou ao carregar). */
  onRetry: () => void;
  /** Retry do fetch do doc selecionado (conteúdo falhou ao carregar). */
  onRetryDoc: () => void;
  /** Nonce que força o remount do coder ao retomar um rascunho local (#608). */
  restoreNonce?: number;
}

/** Estado centralizado de falha + ação de retry do modo Explorar (lista e doc
 *  compartilham a mesma marcação). */
function RetryState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Tentar novamente
      </Button>
    </div>
  );
}

/** Corpo do modo Explorar: lista (picker) ou coder do doc selecionado. */
export function BrowseCodingView({
  browseLoading,
  browseError,
  browseDocId,
  browseDocuments,
  browseDocLoading,
  browseDoc,
  onSelect,
  onRetry,
  onRetryDoc,
  fields,
  submitting,
  readOnly,
  isFullscreen,
  title,
  responseCount,
  onToggleFullscreen,
  onReorder,
  onSubmit,
  onDraftChange,
  outOfScope,
  restoreNonce = 0,
}: BrowseCodingViewProps) {
  if (browseError) {
    return (
      <RetryState
        message="Não foi possível carregar os documentos."
        onRetry={onRetry}
      />
    );
  }
  if (browseLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Carregando documentos…
      </div>
    );
  }
  if (!browseDocId) {
    return (
      <DocumentPicker documents={browseDocuments ?? []} onSelect={onSelect} />
    );
  }
  if (browseDocLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Carregando documento…
      </div>
    );
  }
  if (!browseDoc) {
    // browseDoc === null → o fetch do doc falhou (erro de transporte ou
    // documento ausente). Oferece retry em vez de afirmar "não encontrado".
    return (
      <RetryState
        message="Não foi possível carregar o documento."
        onRetry={onRetryDoc}
      />
    );
  }
  return (
    <BrowseDocCoder
      // O nonce força o remount ao retomar um rascunho: é assim que o conteúdo
      // recuperado entra no seed sem setState em effect.
      key={`${browseDocId}:${restoreNonce}`}
      doc={browseDoc}
      fields={fields}
      submitting={submitting}
      readOnly={readOnly}
      isFullscreen={isFullscreen}
      title={title}
      responseCount={responseCount}
      onToggleFullscreen={onToggleFullscreen}
      onReorder={onReorder}
      onSubmit={onSubmit}
      onDraftChange={onDraftChange}
      outOfScope={outOfScope}
    />
  );
}
