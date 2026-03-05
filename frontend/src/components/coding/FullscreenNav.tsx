"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { X, ChevronLeft, ChevronRight } from "lucide-react";

interface FullscreenNavProps {
  title: string;
  currentIndex?: number;
  total?: number;
  onNavigate?: (index: number) => void;
  responseCount?: number;
  onExit: () => void;
}

export function FullscreenNav({
  title,
  currentIndex,
  total,
  onNavigate,
  responseCount,
  onExit,
}: FullscreenNavProps) {
  const hasNavigation = currentIndex !== undefined && total !== undefined && onNavigate;

  return (
    <div className="flex h-10 items-center justify-between border-b px-4 text-sm shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={onExit}
        >
          <X className="h-4 w-4" />
        </Button>
        <span className="truncate font-medium">{title}</span>
        {responseCount !== undefined && (
          <Badge variant="secondary" className="shrink-0">
            {responseCount} {responseCount === 1 ? "resposta" : "respostas"}
          </Badge>
        )}
      </div>
      {hasNavigation && (
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => onNavigate(currentIndex - 1)}
            disabled={currentIndex === 0}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-muted-foreground">
            {currentIndex + 1}/{total}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => onNavigate(currentIndex + 1)}
            disabled={currentIndex === total - 1}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
