// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import { pinnedIndex, usePinnedDocNavigation } from "../usePinnedDoc";

beforeEach(() => {
  sessionStorage.clear();
});
afterEach(cleanup);

const DOCS = [{ docId: "d1" }, { docId: "d2" }, { docId: "d3" }];

describe("usePinnedDocNavigation", () => {
  it("lê o valor do sessionStorage já no primeiro render", () => {
    sessionStorage.setItem("k", "d2");
    const { result } = renderHook(() => usePinnedDocNavigation("k", DOCS));
    // Sem effect de restore → valor disponível no render inicial.
    expect(result.current.docIndex).toBe(1);
  });

  it("navegação escreve no storage e atualiza o índice reativo", () => {
    const { result } = renderHook(() => usePinnedDocNavigation("k", DOCS));
    expect(result.current.docIndex).toBe(0);
    act(() => result.current.navigateToIndex(1));
    expect(sessionStorage.getItem("k")).toBe("d2");
    expect(result.current.docIndex).toBe(1);
  });

  it("limpa órfão quando o id fixado não está na fila", async () => {
    sessionStorage.setItem("k", "orphan");
    renderHook(() =>
      usePinnedDocNavigation("k", [{ docId: "d2" }, { docId: "d3" }]),
    );
    await waitFor(() => expect(sessionStorage.getItem("k")).toBeNull());
  });

  it("mantém o valor quando o id fixado está na fila", () => {
    sessionStorage.setItem("k", "d2");
    const { result } = renderHook(() =>
      usePinnedDocNavigation("k", [{ docId: "d2" }, { docId: "d3" }]),
    );
    expect(result.current.docIndex).toBe(0);
    expect(sessionStorage.getItem("k")).toBe("d2");
  });

  it("troca de storageKey re-lê o valor", () => {
    sessionStorage.setItem("a", "d2");
    sessionStorage.setItem("b", "d3");
    const { result, rerender } = renderHook(
      ({ k }) => usePinnedDocNavigation(k, DOCS),
      {
        initialProps: { k: "a" },
      },
    );
    expect(result.current.docIndex).toBe(1);
    rerender({ k: "b" });
    expect(result.current.docIndex).toBe(2);
  });

  it("propaga a mudança entre instâncias com a mesma chave", () => {
    const a = renderHook(() => usePinnedDocNavigation("shared", DOCS));
    const b = renderHook(() => usePinnedDocNavigation("shared", DOCS));
    act(() => a.result.current.navigateToIndex(2));
    expect(a.result.current.docIndex).toBe(2);
    expect(b.result.current.docIndex).toBe(2);
  });

  it("navega por índice e limita as pontas da fila", () => {
    const { result } = renderHook(() =>
      usePinnedDocNavigation("queue", [
        { docId: "a" },
        { docId: "b" },
        { docId: "c" },
      ]),
    );

    act(() => result.current.navigateToIndex(2));
    expect(result.current.docIndex).toBe(2);
    expect(sessionStorage.getItem("queue")).toBe("c");

    act(() => result.current.navigateToIndex(-1));
    expect(result.current.docIndex).toBe(0);
    expect(sessionStorage.getItem("queue")).toBe("a");
  });
});

describe("pinnedIndex", () => {
  it("retorna o índice do id fixado quando presente", () => {
    expect(pinnedIndex(["a", "b", "c"], "b")).toBe(1);
  });

  it("cai para 0 quando o id fixado não está na lista", () => {
    expect(pinnedIndex(["a", "b"], "x")).toBe(0);
  });

  it("cai para 0 com pin null", () => {
    expect(pinnedIndex(["a", "b"], null)).toBe(0);
  });

  it("cai para 0 com lista vazia", () => {
    expect(pinnedIndex([], "a")).toBe(0);
  });
});
