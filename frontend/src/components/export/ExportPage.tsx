"use client";

import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const ReactMarkdown = dynamic(() => import("react-markdown"), {
  ssr: false,
  loading: () => <div className="h-32 animate-pulse rounded bg-muted" />,
});

interface ExportPageProps {
  projectId: string;
  csvData: string;
  markdownReport: string;
}

export function ExportPage({
  projectId,
  csvData,
  markdownReport,
}: ExportPageProps) {
  const downloadCSV = () => {
    const blob = new Blob([csvData], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `export-${projectId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadMarkdown = () => {
    const blob = new Blob([markdownReport], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `relatorio-${projectId}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex gap-3">
        <Button
          onClick={downloadCSV}
          className="bg-brand text-brand-foreground hover:bg-brand/90"
        >
          Download CSV
        </Button>
        <Button variant="outline" onClick={downloadMarkdown}>
          Download Markdown
        </Button>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Preview do Relatório</CardTitle>
        </CardHeader>
        <CardContent className="prose prose-sm dark:prose-invert max-w-none">
          <ReactMarkdown>{markdownReport}</ReactMarkdown>
        </CardContent>
      </Card>
    </div>
  );
}
