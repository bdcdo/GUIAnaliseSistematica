"use client";

import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";

interface RunProgressProps {
  phase: string;
  progress: number;
  total: number;
  etaSeconds: number | null;
  currentBatch: number;
  totalBatches: number;
  processedComplete: number;
  processedPartial: number;
  processedEmpty: number;
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins < 60) return secs > 0 ? `${mins}min ${secs}s` : `${mins}min`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hours}h ${remainMins}min`;
}

export function RunProgress({
  phase,
  progress,
  total,
  etaSeconds,
  currentBatch,
  totalBatches,
  processedComplete,
  processedPartial,
  processedEmpty,
}: RunProgressProps) {
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge
            variant={
              phase === "processing"
                ? "default"
                : phase === "saving"
                  ? "outline"
                  : "secondary"
            }
            className={
              phase === "processing" ? "bg-brand text-brand-foreground" : ""
            }
          >
            {phase === "loading" && "Carregando"}
            {phase === "processing" && "Processando"}
            {phase === "saving" && "Salvando"}
          </Badge>
          {phase === "processing" && totalBatches > 0 && (
            <span className="text-xs text-muted-foreground">
              Lote {currentBatch}/{totalBatches}
            </span>
          )}
        </div>
        {etaSeconds != null && etaSeconds > 0 && phase === "processing" && (
          <span className="text-xs text-muted-foreground">
            ~{formatEta(etaSeconds)} restantes
          </span>
        )}
      </div>
      <Progress
        value={total > 0 ? (progress / total) * 100 : 0}
        className={phase === "loading" ? "animate-pulse" : ""}
      />
      <p className="text-sm text-muted-foreground">
        {phase === "loading" && "Carregando documentos..."}
        {phase === "processing" && `${progress}/${total} documentos processados`}
        {phase === "saving" && "Salvando resultados..."}
      </p>
      {/* Counters ao vivo: completas / parciais / vazias. Aparecem durante a
          fase de saving (quando o backend comeca a inserir em responses) e ate
          o fim da run para que o usuario tenha feedback imediato de como esta
          saindo.

          Granularidade DIFERE de `progress` (na Progress acima):
            - progress = iter no result_df (incrementa antes do INSERT)
            - processed_* = linha classificada pelo LLM, ANTES da publicacao
          Durante a fase de saving as duas medidas podem divergir
          transitoriamente (ate ~2s, throttle do _persist_run_progress).

          Estes contadores nao medem gravacao. _record_processed_row_outcome
          incrementa antes da RPC publish_latest_llm_response, entao uma linha
          que o banco recusa ja contou aqui, e a diferenca NAO se fecha ao
          final: desde que a run passou a sobreviver a falha de linha, o
          caminho de erro persiste esses contadores inflados em llm_runs. Quais
          documentos ficaram sem resposta se le na mensagem de erro da run, nao
          daqui; a contagem real gravada e a de getLlmRunStats, que conta em
          responses e por isso pode ser menor que a soma destes badges. Ver o
          comentario em _record_processed_row_outcome (llm_runner.py). */}
      {(processedComplete > 0 ||
        processedPartial > 0 ||
        processedEmpty > 0) && (
        <div className="flex flex-wrap gap-2 pt-1">
          <Badge className="bg-emerald-600 hover:bg-emerald-600 text-white">
            {processedComplete} completa{processedComplete !== 1 ? "s" : ""}
          </Badge>
          <Badge className="bg-amber-600 hover:bg-amber-600 text-white">
            {processedPartial} parcia{processedPartial !== 1 ? "is" : "l"}
          </Badge>
          <Badge variant="destructive">
            {processedEmpty} vazia{processedEmpty !== 1 ? "s" : ""}
          </Badge>
        </div>
      )}
    </div>
  );
}
