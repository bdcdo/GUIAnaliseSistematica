"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { saveLlmConfig } from "@/actions/schema";
import { fetchFastAPI } from "@/lib/api";
import { toast } from "sonner";

interface LlmControlProps {
  projectId: string;
  config: {
    llm_provider: string;
    llm_model: string;
    llm_kwargs: Record<string, any>;
  };
}

export function LlmControl({ projectId, config: initialConfig }: LlmControlProps) {
  const [config, setConfig] = useState(initialConfig);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<string>("idle");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const handleSave = async () => {
    try {
      await saveLlmConfig(projectId, config);
      toast.success("Configuração salva!");
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleRun = async (mode: "all" | "pending") => {
    try {
      const res = await fetchFastAPI<{ job_id: string }>("/api/llm/run", {
        method: "POST",
        body: JSON.stringify({ project_id: projectId }),
      });
      setJobId(res.job_id);
      setStatus("running");
      pollProgress(res.job_id);
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const pollProgress = (id: string) => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(async () => {
      try {
        const res = await fetchFastAPI<{ status: string; progress: number; total: number; errors: string[] }>(`/api/llm/status/${id}`);
        setProgress(res.progress);
        setTotal(res.total);
        setStatus(res.status);
        if (res.status !== "running") {
          if (intervalRef.current) clearInterval(intervalRef.current);
          intervalRef.current = null;
          if (res.status === "completed") toast.success("LLM concluído!");
          if (res.status === "error") toast.error(res.errors[0] || "Erro na execução");
        }
      } catch {
        if (intervalRef.current) clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }, 2000);
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-sm font-medium">Provider</label>
          <select
            value={config.llm_provider}
            onChange={(e) => setConfig((c) => ({ ...c, llm_provider: e.target.value }))}
            className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          >
            <option value="google_genai">Google GenAI</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </div>
        <div>
          <label className="text-sm font-medium">Modelo</label>
          <Input
            value={config.llm_model}
            onChange={(e) => setConfig((c) => ({ ...c, llm_model: e.target.value }))}
          />
        </div>
        <div>
          <label className="text-sm font-medium">Temperature</label>
          <Input
            type="number"
            step={0.1}
            min={0}
            max={2}
            value={config.llm_kwargs.temperature || 1.0}
            onChange={(e) => setConfig((c) => ({ ...c, llm_kwargs: { ...c.llm_kwargs, temperature: parseFloat(e.target.value) } }))}
          />
        </div>
        <div>
          <label className="text-sm font-medium">Thinking Level</label>
          <select
            value={config.llm_kwargs.thinking_level || "medium"}
            onChange={(e) => setConfig((c) => ({ ...c, llm_kwargs: { ...c.llm_kwargs, thinking_level: e.target.value } }))}
            className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>
      </div>

      <div className="flex gap-2">
        <Button variant="outline" onClick={handleSave}>Salvar Config</Button>
        <Button onClick={() => handleRun("all")} className="bg-brand hover:bg-brand/90 text-brand-foreground" disabled={status === "running"}>
          Rodar em todos
        </Button>
        <Button variant="outline" onClick={() => handleRun("pending")} disabled={status === "running"}>
          Rodar pendentes
        </Button>
      </div>

      {status === "running" && (
        <div className="space-y-2">
          <Progress value={total > 0 ? (progress / total) * 100 : 0} />
          <p className="text-sm text-muted-foreground">{progress}/{total}</p>
        </div>
      )}
    </div>
  );
}
