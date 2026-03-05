"use client";

import { useState } from "react";
import { DocumentList } from "@/components/documents/DocumentList";
import { DocumentPreview } from "@/components/documents/DocumentPreview";
import type { Document } from "@/lib/types";

type DocumentSummary = Pick<Document, "id" | "external_id" | "title" | "created_at"> & {
  responseCount?: number;
};

interface DocumentsPageClientProps {
  documents: DocumentSummary[];
}

export function DocumentsPageClient({ documents }: DocumentsPageClientProps) {
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const selectedDoc = documents.find((d) => d.id === selectedDocId) ?? null;

  return (
    <>
      <DocumentList documents={documents} onSelect={(doc) => setSelectedDocId(doc.id)} />
      <DocumentPreview
        documentId={selectedDoc?.id ?? null}
        title={selectedDoc?.title ?? selectedDoc?.external_id ?? "Documento"}
        open={!!selectedDoc}
        onClose={() => setSelectedDocId(null)}
      />
    </>
  );
}
