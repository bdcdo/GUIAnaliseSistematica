"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { createBrowserClient } from "@/lib/supabase/client";

interface DocumentPreviewProps {
  documentId: string | null;
  title: string;
  open: boolean;
  onClose: () => void;
}

export function DocumentPreview({ documentId, title, open, onClose }: DocumentPreviewProps) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!documentId || !open) {
      setText(null);
      return;
    }
    setLoading(true);
    const supabase = createBrowserClient();
    supabase
      .from("documents")
      .select("text")
      .eq("id", documentId)
      .single()
      .then(({ data }) => {
        setText(data?.text ?? null);
        setLoading(false);
      });
  }, [documentId, open]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="space-y-2">
            <div className="h-4 w-full animate-pulse rounded bg-muted" />
            <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
            <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
          </div>
        ) : (
          <div className="whitespace-pre-wrap text-sm leading-relaxed">
            {text}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
