// @vitest-environment jsdom
//
// A fiação entre o rascunho local e os dois modos (#608). O que se fixa aqui é a
// regra mais perigosa da feature: um rascunho retomado só pode ser aplicado ao
// documento de onde veio. Aplicar o conteúdo de A sobre o formulário de B não é
// um bug de UI — é fabricar dado de pesquisa, porque o próximo "Enviar" gravaria
// as respostas de A no documento B, sem que nada na tela denunciasse a troca.
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useCodingDraftWiring } from "../useCodingDraftWiring";
import { useDirtyDocs } from "@/hooks/useDirtyDocs";
import type { CodingDraftsApi } from "@/hooks/useCodingDrafts";
import type { CodingDocument } from "@/hooks/useDocumentForCoding";
import type { CodingSnapshot } from "@/lib/coding-draft";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const DRAFT_DE_A: CodingSnapshot = { answers: { q1: "resposta-do-doc-A" }, notes: "nota-A" };

function browseDoc(id: string, answers: Record<string, unknown> = {}): CodingDocument {
  return {
    document: {
      id,
      external_id: `ext-${id}`,
      title: `Doc ${id}`,
      text: `texto-${id}`,
      exclusionPending: null,
    },
    initialAnswers: answers,
    initialNotes: `nota-do-servidor-${id}`,
  };
}

function draftsApi(over: Partial<CodingDraftsApi> = {}): CodingDraftsApi {
  return {
    openDocument: vi.fn(),
    recordDraft: vi.fn(),
    restoreDraft: vi.fn(() => DRAFT_DE_A),
    discardDraft: vi.fn(),
    submitConfirmed: vi.fn(),
    recovery: { kind: "none" },
    storageAvailable: true,
    staleDiscardedCount: 0,
    ...over,
  } as CodingDraftsApi;
}

// Roda a fiação em modo Explorar, com o doc de browse podendo trocar entre
// renders — que é exatamente o que a seleção no picker faz.
function renderWiring(initialDoc: CodingDocument) {
  const drafts = draftsApi();
  const view = renderHook(
    ({ doc }: { doc: CodingDocument }) => {
      const dirtyDocs = useDirtyDocs();
      return useCodingDraftWiring({
        mode: "browse",
        activeDocId: doc.document.id,
        drafts,
        dirtyDocs,
        markDirty: dirtyDocs.markDirty,
        restoreAssignedDraft: vi.fn(),
        browseDocId: doc.document.id,
        browseDoc: doc,
        existingAnswers: {},
        existingJustifications: {},
      });
    },
    { initialProps: { doc: initialDoc } },
  );
  return { ...view, drafts };
}

describe("useCodingDraftWiring — o rascunho retomado pertence a um documento só", () => {
  it("aplica o rascunho retomado ao documento de onde ele veio", () => {
    const { result } = renderWiring(browseDoc("A"));

    act(() => result.current.handleRestoreDraft());

    expect(result.current.browseDocForCoder?.initialAnswers).toEqual(
      DRAFT_DE_A.answers,
    );
  });

  // ESTE é o caso que fabrica dado. Cenário: retomar em A, escolher B no picker.
  // O `BrowseDocCoder` é keyed por `docId:nonce`, então remonta semeado pelo que
  // a fiação entregar — e entregava o rascunho de A, sem marcar sujeira e sem
  // nenhum sinal na tela. Um clique em "Enviar" gravaria as respostas de A no
  // documento B.
  it("NÃO vaza o rascunho de um documento para o próximo selecionado", () => {
    const docB = browseDoc("B", { q1: "resposta-do-servidor-de-B" });
    const { result, rerender } = renderWiring(browseDoc("A"));

    act(() => result.current.handleRestoreDraft());
    rerender({ doc: docB });

    expect(result.current.browseDocForCoder?.initialAnswers).toEqual({
      q1: "resposta-do-servidor-de-B",
    });
    expect(result.current.browseDocForCoder?.initialNotes).toBe(
      "nota-do-servidor-B",
    );
    // E o conteúdo de A não aparece em lugar nenhum do que B vai semear.
    expect(
      JSON.stringify(result.current.browseDocForCoder?.initialAnswers),
    ).not.toContain("resposta-do-doc-A");
  });

  it("voltar ao documento de origem ainda mostra o rascunho retomado", () => {
    const docA = browseDoc("A");
    const { result, rerender } = renderWiring(docA);

    act(() => result.current.handleRestoreDraft());
    rerender({ doc: browseDoc("B") });
    rerender({ doc: docA });

    // A retomada não é desfeita pela ida e volta: o snapshot continua sendo de A,
    // e é A quem o recebe.
    expect(result.current.browseDocForCoder?.initialAnswers).toEqual(
      DRAFT_DE_A.answers,
    );
  });
});
