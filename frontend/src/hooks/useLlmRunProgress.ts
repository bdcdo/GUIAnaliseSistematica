"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { toast } from "sonner";
import { fetchFastAPI, requireSupabaseToken } from "@/lib/api";
import { getScrollBehavior } from "@/lib/scroll";
import { cleanupStaleLlmRuns, getRunningLlmJob } from "@/actions/llm";
import type { LlmErrorInfo } from "@/components/llm/LlmErrorCard";

/**
 * Estado e ciclo de vida do polling de uma execução LLM, consolidando ~16
 * `useState` espalhados em `LlmConfigurePane` num único `useReducer`. Um único
 * dispatch por tick evita a cascata de renders que disparava `prefer-useReducer`.
 *
 * O polling vive num effect chaveado por `activeJobId`, com um `setTimeout`
 * auto-reagendado e cleanup lendo uma variável local (`timer`) — não um
 * `useRef` compartilhado. Isso elimina o `exhaustive-deps` que apontava que o
 * cleanup do `intervalRef.current` podia ler o valor errado.
 *
 * `start(jobId)` inicia (ou retoma) o polling; o effect de montagem retoma uma
 * run em andamento (`cleanupStaleLlmRuns` + `getRunningLlmJob`) — mesmo
 * comportamento de antes, agora encapsulado.
 */

interface StatusResponse {
  status: string;
  phase: string;
  progress: number;
  total: number;
  errors: string[];
  eta_seconds: number | null;
  current_batch: number;
  total_batches: number;
  error_traceback: string | null;
  error_type: string | null;
  error_line: number | null;
  error_column: number | null;
  pydantic_code: string | null;
  processed_complete: number;
  processed_partial: number;
  processed_empty: number;
}

interface LlmRunProgressState {
  activeJobId: string | null;
  progress: number;
  total: number;
  status: string;
  phase: string;
  etaSeconds: number | null;
  currentBatch: number;
  totalBatches: number;
  processedComplete: number;
  processedPartial: number;
  processedEmpty: number;
  errorInfo: LlmErrorInfo | null;
}

const INITIAL_STATE: LlmRunProgressState = {
  activeJobId: null,
  progress: 0,
  total: 0,
  status: "idle",
  phase: "idle",
  etaSeconds: null,
  currentBatch: 0,
  totalBatches: 0,
  processedComplete: 0,
  processedPartial: 0,
  processedEmpty: 0,
  errorInfo: null,
};

type Action =
  | { type: "START"; jobId: string }
  | { type: "TICK"; res: StatusResponse }
  | { type: "FAIL"; errorInfo: LlmErrorInfo }
  | { type: "DISMISS_ERROR" };

function reducer(
  state: LlmRunProgressState,
  action: Action,
): LlmRunProgressState {
  switch (action.type) {
    case "START":
      // Zera contadores antes de religar o polling: sem isso, valores residuais
      // de uma run anterior ficariam visíveis até o primeiro tick.
      return {
        ...INITIAL_STATE,
        activeJobId: action.jobId,
        status: "running",
        phase: "loading",
      };
    case "TICK": {
      const r = action.res;
      return {
        ...state,
        progress: r.progress,
        total: r.total,
        status: r.status,
        phase: r.phase,
        etaSeconds: r.eta_seconds,
        currentBatch: r.current_batch,
        totalBatches: r.total_batches,
        processedComplete: r.processed_complete ?? 0,
        processedPartial: r.processed_partial ?? 0,
        processedEmpty: r.processed_empty ?? 0,
      };
    }
    case "FAIL":
      return { ...state, status: "error", phase: "error", errorInfo: action.errorInfo };
    case "DISMISS_ERROR":
      return { ...state, errorInfo: null };
    default:
      return state;
  }
}

const POLL_INTERVAL_MS = 2000;
// Tolera falhas consecutivas de tick (token transitório, blip de rede) antes de
// declarar a run terminal: o job segue no backend e um erro isolado não deve
// derrubar o card com um erro falso.
const MAX_TICK_FAILURES = 3;

export function useLlmRunProgress(
  projectId: string,
  pydanticCode: string | null,
) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const { refresh } = useRouter();
  const { getToken } = useAuth();
  const { activeJobId } = state;

  // Lidos sempre atualizados dentro do loop de polling sem re-disparar o effect
  // (o effect só deve reiniciar quando `activeJobId` muda). Atualizados num
  // effect (após cada render), não durante o render — escrever em ref
  // no corpo do componente quebra o modelo concorrente do React e é erro de
  // `react-hooks/refs`.
  // `getToken` também via ref: cada tick busca um token fresco (o do template
  // expira em ~60s e o polling dura minutos) sem religar o effect.
  const refreshRef = useRef(refresh);
  const pydanticCodeRef = useRef(pydanticCode);
  const getTokenRef = useRef(getToken);
  useEffect(() => {
    refreshRef.current = refresh;
    pydanticCodeRef.current = pydanticCode;
    getTokenRef.current = getToken;
  });

  const start = useCallback((jobId: string) => {
    dispatch({ type: "START", jobId });
    // Refresca o layout do projeto para o badge "LLM rodando" aparecer na aba.
    refreshRef.current();
  }, []);

  const dismissError = useCallback(() => dispatch({ type: "DISMISS_ERROR" }), []);

  // Polling: um setTimeout auto-reagendado enquanto a run estiver "running".
  useEffect(() => {
    if (!activeJobId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;

    const tick = async () => {
      try {
        // Token fresco a cada tick: o do template expira em ~60s.
        const token = await requireSupabaseToken(getTokenRef.current);
        const res = await fetchFastAPI<StatusResponse>(
          `/api/llm/status/${activeJobId}`,
          undefined,
          token,
        );
        if (cancelled) return;
        failures = 0;
        dispatch({ type: "TICK", res });
        if (res.status === "running") {
          timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
          return;
        }
        // Terminal: refresca o layout para o badge de execução desaparecer.
        refreshRef.current();
        if (res.status === "completed") toast.success("LLM concluído!");
        if (res.status === "error") {
          const msg = res.errors[0] || "Erro na execução";
          dispatch({
            type: "FAIL",
            errorInfo: {
              message: msg,
              type: res.error_type,
              traceback: res.error_traceback,
              line: res.error_line,
              column: res.error_column,
              // Prefere o snapshot salvo com a run — o pydanticCode atual pode
              // ter sido editado entre o início da run e a falha.
              pydanticCode: res.pydantic_code ?? pydanticCodeRef.current,
            },
          });
          toast.error(msg, {
            duration: 10000,
            action: {
              label: "Ver detalhes",
              onClick: () =>
                document.getElementById("llm-error-card")?.scrollIntoView({
                  behavior: getScrollBehavior(),
                  block: "center",
                }),
            },
          });
        }
      } catch (e: unknown) {
        if (cancelled) return;
        // Falha isolada não é terminal: reagenda até MAX_TICK_FAILURES seguidas.
        failures += 1;
        if (failures < MAX_TICK_FAILURES) {
          timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
          return;
        }
        const msg =
          e instanceof Error
            ? e.message
            : "Não foi possível atualizar o progresso";
        dispatch({
          type: "FAIL",
          errorInfo: {
            message: msg,
            type: "NetworkError",
            traceback: null,
            line: null,
            column: null,
            pydanticCode: pydanticCodeRef.current,
          },
        });
        toast.error(msg);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeJobId]);

  // Retoma o polling se houver uma run em execução ao montar (ex.: o usuário
  // recarregou a página ou voltou para a aba). cleanupStaleLlmRuns roda
  // primeiro para evitar religar polling em runs cuja máquina morreu antes de
  // completar (scale-to-zero do Fly.io). Best-effort: se getRunningLlmJob
  // falhar (RLS, rede), apenas não religa — sem unhandled rejection.
  useEffect(() => {
    let cancelled = false;
    async function resume() {
      try {
        await cleanupStaleLlmRuns(projectId);
        if (cancelled) return;
        const running = await getRunningLlmJob(projectId);
        if (cancelled || !running) return;
        dispatch({ type: "START", jobId: running.job_id });
      } catch (e) {
        console.error("Falha ao retomar run em andamento:", e);
      }
    }
    void resume();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return { ...state, start, dismissError };
}
