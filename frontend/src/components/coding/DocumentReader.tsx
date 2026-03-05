"use client";

interface DocumentReaderProps {
  text: string;
}

export function DocumentReader({ text }: DocumentReaderProps) {
  return (
    <div className="flex-1 overflow-y-auto px-4 py-6">
      <div className="mx-auto max-w-4xl whitespace-pre-wrap text-sm leading-relaxed">
        {text}
      </div>
    </div>
  );
}
