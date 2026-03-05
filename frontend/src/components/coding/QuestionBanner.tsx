"use client";

import { useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { ProgressDots } from "./ProgressDots";
import { FieldRenderer } from "./FieldRenderer";
import type { PydanticField } from "@/lib/types";

interface QuestionBannerProps {
  fields: PydanticField[];
  currentIndex: number;
  answers: Record<string, any>;
  onAnswer: (fieldName: string, value: any) => void;
  onNavigate: (index: number) => void;
  isFullscreen?: boolean;
}

export function QuestionBanner({ fields, currentIndex, answers, onAnswer, onNavigate, isFullscreen }: QuestionBannerProps) {
  const field = fields[currentIndex];
  const answered = fields.map((f) => answers[f.name] !== undefined && answers[f.name] !== null && answers[f.name] !== "");

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "ArrowLeft" && currentIndex > 0) onNavigate(currentIndex - 1);
    if (e.key === "ArrowRight" && currentIndex < fields.length - 1) onNavigate(currentIndex + 1);
  }, [currentIndex, fields.length, onNavigate]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  if (!field) return null;

  return (
    <div className="border-t bg-card">
      <ProgressDots total={fields.length} currentIndex={currentIndex} answered={answered} onNavigate={onNavigate} />
      <div className={`overflow-y-auto px-4 pb-4 ${isFullscreen ? "max-h-[30vh]" : "max-h-[40vh]"}`}>
        <AnimatePresence mode="wait">
          <motion.div
            key={field.name}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.15 }}
          >
            <p className="mb-3 text-sm font-medium">
              <span className="text-muted-foreground">{currentIndex + 1}/{fields.length}:</span>{" "}
              {field.description}
            </p>
            <FieldRenderer field={field} value={answers[field.name] ?? null} onChange={(val) => onAnswer(field.name, val)} />
          </motion.div>
        </AnimatePresence>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onNavigate(currentIndex - 1)} disabled={currentIndex === 0}>
            ← Anterior
          </Button>
          <Button size="sm" onClick={() => onNavigate(currentIndex + 1)} disabled={currentIndex === fields.length - 1} className="bg-brand hover:bg-brand/90 text-brand-foreground">
            Próximo →
          </Button>
        </div>
      </div>
    </div>
  );
}
