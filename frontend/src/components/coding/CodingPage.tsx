"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DocumentNav } from "./DocumentNav";
import { DocumentReader } from "./DocumentReader";
import { QuestionBanner } from "./QuestionBanner";
import { DocumentPicker } from "./DocumentPicker";
import { BrowseDocumentNav } from "./BrowseDocumentNav";
import { FullscreenNav } from "./FullscreenNav";
import { saveResponse } from "@/actions/responses";
import { getDocumentsForBrowse, getDocumentForCoding } from "@/actions/documents";
import type { BrowseDocument } from "@/actions/documents";
import type { PydanticField, Document, Assignment } from "@/lib/types";

interface CodingPageProps {
  projectId: string;
  documents: (Document & { assignment?: Pick<Assignment, "id" | "status"> })[];
  fields: PydanticField[];
  existingAnswers: Record<string, Record<string, any>>;
  hasAssignments?: boolean;
}

export function CodingPage({
  projectId,
  documents,
  fields,
  existingAnswers,
  hasAssignments = false,
}: CodingPageProps) {
  // Assigned mode state
  const [docIndex, setDocIndex] = useState(0);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [allAnswers, setAllAnswers] = useState<Record<string, Record<string, any>>>(existingAnswers);

  // Mode state
  const [mode, setMode] = useState<"assigned" | "browse">(hasAssignments ? "assigned" : "browse");

  // Fullscreen state
  const [isFullscreen, setIsFullscreen] = useState(false);
  const toggleFullscreen = useCallback(() => setIsFullscreen((prev) => !prev), []);

  // Browse mode state
  const [browseDocuments, setBrowseDocuments] = useState<BrowseDocument[] | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [selectedBrowseDoc, setSelectedBrowseDoc] = useState<{
    id: string;
    external_id: string | null;
    title: string | null;
    text: string;
  } | null>(null);
  const [browseQuestionIndex, setBrowseQuestionIndex] = useState(0);
  const [browseAnswers, setBrowseAnswers] = useState<Record<string, any>>({});
  const browseFetchedRef = useRef(false);

  // Lazy-load browse documents
  useEffect(() => {
    if (mode === "browse" && !browseFetchedRef.current) {
      browseFetchedRef.current = true;
      setBrowseLoading(true);
      getDocumentsForBrowse(projectId)
        .then(setBrowseDocuments)
        .finally(() => setBrowseLoading(false));
    }
  }, [mode, projectId]);

  // Fullscreen keyboard shortcuts
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isFullscreen) {
        setIsFullscreen(false);
      }
      if (e.key === "F" && e.ctrlKey && e.shiftKey) {
        e.preventDefault();
        setIsFullscreen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isFullscreen]);

  // --- Assigned mode handlers ---
  const currentDoc = documents[docIndex];
  const docAnswers = allAnswers[currentDoc?.id] || {};

  const handleAnswer = useCallback(
    (fieldName: string, value: any) => {
      setAllAnswers((prev) => ({
        ...prev,
        [currentDoc.id]: { ...prev[currentDoc.id], [fieldName]: value },
      }));
    },
    [currentDoc?.id]
  );

  const handleQuestionNavigate = useCallback(
    (newIndex: number) => {
      // Past last question → save and advance to next document
      if (newIndex >= fields.length) {
        if (currentDoc && Object.keys(docAnswers).length > 0) {
          saveResponse(projectId, currentDoc.id, docAnswers).catch((e) =>
            console.error("Failed to save:", e)
          );
        }
        if (docIndex < documents.length - 1) {
          setDocIndex(docIndex + 1);
          setQuestionIndex(0);
        }
        return;
      }
      setQuestionIndex(Math.max(0, newIndex));
    },
    [currentDoc, docAnswers, projectId, fields.length, docIndex, documents.length]
  );

  const handleDocNavigate = useCallback(
    (newIndex: number) => {
      if (currentDoc && Object.keys(docAnswers).length > 0) {
        saveResponse(projectId, currentDoc.id, docAnswers).catch((e) =>
          console.error("Failed to save:", e)
        );
      }
      setDocIndex(Math.max(0, Math.min(newIndex, documents.length - 1)));
      setQuestionIndex(0);
    },
    [currentDoc, docAnswers, projectId, documents.length]
  );

  // --- Browse mode handlers ---
  const handleBrowseSelect = useCallback(
    async (docId: string) => {
      try {
        const result = await getDocumentForCoding(projectId, docId);
        setSelectedBrowseDoc(result.document);
        setBrowseAnswers(
          (result.existingAnswers as Record<string, any>) ?? {}
        );
        setBrowseQuestionIndex(0);
      } catch (e) {
        console.error("Failed to load document:", e);
      }
    },
    [projectId]
  );

  const handleBrowseAnswer = useCallback(
    (fieldName: string, value: any) => {
      setBrowseAnswers((prev) => ({ ...prev, [fieldName]: value }));
    },
    []
  );

  const handleBrowseQuestionNavigate = useCallback(
    (newIndex: number) => {
      // Past last question → save and go back to picker
      if (newIndex >= fields.length && selectedBrowseDoc) {
        if (Object.keys(browseAnswers).length > 0) {
          saveResponse(projectId, selectedBrowseDoc.id, browseAnswers).catch((e) =>
            console.error("Failed to save:", e)
          );
        }
        // Update local browse doc list
        setBrowseDocuments((prev) =>
          prev?.map((d) =>
            d.id === selectedBrowseDoc.id
              ? {
                  ...d,
                  responseCount: d.userAlreadyResponded
                    ? d.responseCount
                    : d.responseCount + 1,
                  userAlreadyResponded: true,
                }
              : d
          ) ?? null
        );
        // Go back to picker
        setSelectedBrowseDoc(null);
        setBrowseAnswers({});
        setBrowseQuestionIndex(0);
        return;
      }

      setBrowseQuestionIndex(Math.max(0, newIndex));
    },
    [selectedBrowseDoc, browseAnswers, projectId, fields.length]
  );

  const handleBrowseBack = useCallback(() => {
    if (selectedBrowseDoc && Object.keys(browseAnswers).length > 0) {
      saveResponse(projectId, selectedBrowseDoc.id, browseAnswers)
        .then(() => {
          setBrowseDocuments((prev) =>
            prev?.map((d) =>
              d.id === selectedBrowseDoc.id
                ? { ...d, userAlreadyResponded: true }
                : d
            ) ?? null
          );
        })
        .catch((e) => console.error("Failed to save:", e));
    }
    setSelectedBrowseDoc(null);
    setBrowseAnswers({});
    setBrowseQuestionIndex(0);
  }, [selectedBrowseDoc, browseAnswers, projectId]);

  const handleBrowseRandom = useCallback(() => {
    if (!browseDocuments || browseDocuments.length === 0) return;
    const notResponded = browseDocuments.filter(
      (d) => !d.userAlreadyResponded && d.id !== selectedBrowseDoc?.id
    );
    const pool =
      notResponded.length > 0
        ? notResponded
        : browseDocuments.filter((d) => d.id !== selectedBrowseDoc?.id);
    if (pool.length === 0) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    handleBrowseSelect(pick.id);
  }, [browseDocuments, selectedBrowseDoc?.id, handleBrowseSelect]);

  // --- Empty states ---
  if (fields.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Schema não definido.
      </div>
    );
  }

  // Get browse doc info for nav
  const browseDocInfo = selectedBrowseDoc
    ? browseDocuments?.find((d) => d.id === selectedBrowseDoc.id)
    : null;

  const assignedTitle = currentDoc?.title || currentDoc?.external_id || "Documento";
  const browseTitle = selectedBrowseDoc?.title || selectedBrowseDoc?.external_id || "Documento";

  return (
    <div
      className={
        isFullscreen
          ? "fixed inset-0 z-50 flex flex-col bg-background"
          : "flex h-[calc(100vh-88px)] flex-col"
      }
    >
      {!isFullscreen && (
        <Tabs
          value={mode}
          onValueChange={(v) => setMode(v as "assigned" | "browse")}
          className="shrink-0"
        >
          <div className="border-b px-4">
            <TabsList className="h-9">
              <TabsTrigger value="assigned" className="text-xs">
                Atribuídos ({documents.length})
              </TabsTrigger>
              <TabsTrigger value="browse" className="text-xs">
                Explorar
              </TabsTrigger>
            </TabsList>
          </div>
        </Tabs>
      )}

      {mode === "assigned" && (
        <>
          {!currentDoc ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              Nenhum documento atribuído. Use a aba Explorar.
            </div>
          ) : (
            <>
              {isFullscreen ? (
                <FullscreenNav
                  title={assignedTitle}
                  currentIndex={docIndex}
                  total={documents.length}
                  onNavigate={handleDocNavigate}
                  onExit={toggleFullscreen}
                />
              ) : (
                <DocumentNav
                  title={assignedTitle}
                  currentIndex={docIndex}
                  total={documents.length}
                  onNavigate={handleDocNavigate}
                  onToggleFullscreen={toggleFullscreen}
                />
              )}
              <DocumentReader text={currentDoc.text} />
              <QuestionBanner
                fields={fields}
                currentIndex={questionIndex}
                answers={docAnswers}
                onAnswer={handleAnswer}
                onNavigate={handleQuestionNavigate}
                isFullscreen={isFullscreen}
              />
            </>
          )}
        </>
      )}

      {mode === "browse" && (
        <>
          {browseLoading ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              Carregando documentos...
            </div>
          ) : !selectedBrowseDoc ? (
            <DocumentPicker
              documents={browseDocuments ?? []}
              onSelect={handleBrowseSelect}
            />
          ) : (
            <>
              {isFullscreen ? (
                <FullscreenNav
                  title={browseTitle}
                  responseCount={browseDocInfo?.responseCount ?? 0}
                  onExit={toggleFullscreen}
                />
              ) : (
                <BrowseDocumentNav
                  title={browseTitle}
                  responseCount={browseDocInfo?.responseCount ?? 0}
                  onBack={handleBrowseBack}
                  onRandom={handleBrowseRandom}
                  onToggleFullscreen={toggleFullscreen}
                />
              )}
              <DocumentReader text={selectedBrowseDoc.text} />
              <QuestionBanner
                fields={fields}
                currentIndex={browseQuestionIndex}
                answers={browseAnswers}
                onAnswer={handleBrowseAnswer}
                onNavigate={handleBrowseQuestionNavigate}
                isFullscreen={isFullscreen}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
