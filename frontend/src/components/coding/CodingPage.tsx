"use client";

import { useState, useCallback } from "react";
import { DocumentNav } from "./DocumentNav";
import { DocumentReader } from "./DocumentReader";
import { QuestionBanner } from "./QuestionBanner";
import { saveResponse } from "@/actions/responses";
import type { PydanticField, Document, Assignment } from "@/lib/types";

interface CodingPageProps {
  projectId: string;
  documents: (Document & { assignment?: Pick<Assignment, "id" | "status"> })[];
  fields: PydanticField[];
  existingAnswers: Record<string, Record<string, any>>; // documentId -> answers
}

export function CodingPage({ projectId, documents, fields, existingAnswers }: CodingPageProps) {
  const [docIndex, setDocIndex] = useState(0);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [allAnswers, setAllAnswers] = useState<Record<string, Record<string, any>>>(existingAnswers);

  const currentDoc = documents[docIndex];
  const docAnswers = allAnswers[currentDoc?.id] || {};

  const handleAnswer = useCallback((fieldName: string, value: any) => {
    setAllAnswers((prev) => ({
      ...prev,
      [currentDoc.id]: { ...prev[currentDoc.id], [fieldName]: value },
    }));
  }, [currentDoc?.id]);

  const handleQuestionNavigate = useCallback(async (newIndex: number) => {
    // Auto-save current answers
    if (currentDoc && Object.keys(docAnswers).length > 0) {
      try {
        await saveResponse(projectId, currentDoc.id, docAnswers);
      } catch (e) {
        console.error("Failed to save:", e);
      }
    }
    setQuestionIndex(Math.max(0, Math.min(newIndex, fields.length - 1)));
  }, [currentDoc, docAnswers, projectId, fields.length]);

  const handleDocNavigate = useCallback(async (newIndex: number) => {
    // Save before switching documents
    if (currentDoc && Object.keys(docAnswers).length > 0) {
      try {
        await saveResponse(projectId, currentDoc.id, docAnswers);
      } catch (e) {
        console.error("Failed to save:", e);
      }
    }
    setDocIndex(Math.max(0, Math.min(newIndex, documents.length - 1)));
    setQuestionIndex(0);
  }, [currentDoc, docAnswers, projectId, documents.length]);

  if (!currentDoc || fields.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Nenhum documento atribuído ou schema não definido.
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-88px)] flex-col">
      <DocumentNav
        title={currentDoc.title || currentDoc.external_id || "Documento"}
        currentIndex={docIndex}
        total={documents.length}
        onNavigate={handleDocNavigate}
      />
      <DocumentReader text={currentDoc.text} />
      <QuestionBanner
        fields={fields}
        currentIndex={questionIndex}
        answers={docAnswers}
        onAnswer={handleAnswer}
        onNavigate={handleQuestionNavigate}
      />
    </div>
  );
}
