// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LlmErrorCard } from "@/components/stats/LlmErrorCard";
import type { LlmError, LlmErrorSource } from "@/lib/llm-error-metrics";

function llmError(source: LlmErrorSource): LlmError {
  return {
    documentId: "doc1",
    documentTitle: "Documento 1",
    fieldName: "x",
    fieldDescription: "Pergunta x",
    llmAnswer: "NI",
    llmJustification: null,
    chosenVerdict: "N/A",
    reviewerComment: null,
    resolvedAt: null,
    reviewedAt: "2026-02-01T00:00:00Z",
    schemaVersion: "1.0.0",
    llmResponseId: "rllm",
    chosenResponseId: "rh",
    source,
  };
}

function renderCard(source: LlmErrorSource) {
  render(
    <LlmErrorCard
      error={llmError(source)}
      projectId="proj1"
      isPending={false}
      onResolve={vi.fn()}
      onReopen={vi.fn()}
      onMarkEquivalent={vi.fn()}
    />,
  );
}

afterEach(cleanup);

describe("LlmErrorCard — affordance de equivalência", () => {
  it("oferece 'marcar como equivalente' em erro vindo da Comparação", () => {
    renderCard("comparacao");

    expect(screen.getByTitle("Marcar respostas como equivalentes")).toBeTruthy();
  });

  // `markLlmEquivalent` grava em `response_equivalences`, e a classificação da
  // auto-revisão lê só `provenance`/`final_verdict` de `field_reviews`: ali o
  // botão daria toast de sucesso e devolveria o mesmo erro intacto (#705).
  it("esconde o botão em erro vindo da auto-revisão", () => {
    renderCard("auto_revisao");

    expect(screen.queryByTitle("Marcar respostas como equivalentes")).toBeNull();
  });
});
