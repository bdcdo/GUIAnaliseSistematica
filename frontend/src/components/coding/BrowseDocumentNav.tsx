"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Shuffle, Maximize2 } from "lucide-react";

interface BrowseDocumentNavProps {
  title: string;
  responseCount: number;
  onBack: () => void;
  onRandom: () => void;
  onToggleFullscreen?: () => void;
}

export function BrowseDocumentNav({
  title,
  responseCount,
  onBack,
  onRandom,
  onToggleFullscreen,
}: BrowseDocumentNavProps) {
  return (
    <div className="flex h-8 items-center justify-between border-b px-4 text-sm">
      <div className="flex items-center gap-2 min-w-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          onClick={onBack}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <span className="truncate font-medium">{title}</span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Badge variant="secondary">
          {responseCount} {responseCount === 1 ? "resposta" : "respostas"}
        </Badge>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onRandom}
        >
          <Shuffle className="h-4 w-4" />
        </Button>
        {onToggleFullscreen && (
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onToggleFullscreen}>
            <Maximize2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}
