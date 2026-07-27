// @vitest-environment jsdom
//
// O conjunto de documentos não enviados virou um external store no #608, porque
// a tela passou a EXIBIR "há alterações não enviadas". O que se fixa aqui é que
// a leitura reativa funciona sem que a API imperativa (lida em tempo de evento
// por guards e handlers) mude de comportamento.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useDirtyDocs, useDirtyDocsCount, useIsDocDirty } from "../useDirtyDocs";

afterEach(cleanup);

describe("API imperativa — inalterada", () => {
  it("marca, consulta e limpa", () => {
    const { result } = renderHook(() => useDirtyDocs());
    expect(result.current.isDirty("doc-1")).toBe(false);
    act(() => result.current.markDirty("doc-1"));
    expect(result.current.isDirty("doc-1")).toBe(true);
    act(() => result.current.markClean("doc-1"));
    expect(result.current.isDirty("doc-1")).toBe(false);
  });

  it("id nulo nunca é sujo", () => {
    const { result } = renderHook(() => useDirtyDocs());
    expect(result.current.isDirty(null)).toBe(false);
    expect(result.current.isDirty(undefined)).toBe(false);
  });

  it("a identidade do store é estável entre renders", () => {
    const { result, rerender } = renderHook(() => useDirtyDocs());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});

describe("leitura reativa — o indicador de não enviado", () => {
  // Mutação vermelha: manter `useDirtyDocs` só-ref (sem `emit`/`subscribe`). O
  // componente nunca re-renderizaria e o indicador ficaria preso no estado do
  // primeiro render — o critério "a tela diz, a qualquer momento, se há
  // alterações não enviadas" seria falso.
  it("`useIsDocDirty` re-renderiza quando o documento fica sujo e quando limpa", () => {
    const { result } = renderHook(() => {
      const store = useDirtyDocs();
      return { store, dirty: useIsDocDirty(store, "doc-1") };
    });

    expect(result.current.dirty).toBe(false);
    act(() => result.current.store.markDirty("doc-1"));
    expect(result.current.dirty).toBe(true);
    act(() => result.current.store.markClean("doc-1"));
    expect(result.current.dirty).toBe(false);
  });

  it("não reage à sujeira de outro documento", () => {
    const { result } = renderHook(() => {
      const store = useDirtyDocs();
      return { store, dirty: useIsDocDirty(store, "doc-1") };
    });
    act(() => result.current.store.markDirty("doc-2"));
    expect(result.current.dirty).toBe(false);
  });

  // O aviso de saída vale para a fila inteira: navegar para longe com outro
  // documento pendente também perde trabalho.
  it("`useDirtyDocsCount` acompanha o total", () => {
    const { result } = renderHook(() => {
      const store = useDirtyDocs();
      return { store, count: useDirtyDocsCount(store) };
    });

    expect(result.current.count).toBe(0);
    act(() => result.current.store.markDirty("doc-1"));
    act(() => result.current.store.markDirty("doc-2"));
    expect(result.current.count).toBe(2);
    act(() => result.current.store.markClean("doc-1"));
    expect(result.current.count).toBe(1);
  });

  // Mutação vermelha: notificar incondicionalmente em `markDirty`/`markClean`.
  // Cada tecla chama `markDirty` no documento já sujo; sem a guarda, toda tecla
  // vira um re-render da tela de codificação inteira.
  it("marcar de novo o que já está sujo não notifica", () => {
    const { result } = renderHook(() => useDirtyDocs());
    act(() => result.current.markDirty("doc-1"));
    const afterFirst = result.current.getVersion();
    act(() => result.current.markDirty("doc-1"));
    expect(result.current.getVersion()).toBe(afterFirst);
  });

  it("limpar o que já está limpo não notifica", () => {
    const { result } = renderHook(() => useDirtyDocs());
    const initial = result.current.getVersion();
    act(() => result.current.markClean("doc-inexistente"));
    expect(result.current.getVersion()).toBe(initial);
  });

  it("desinscrever para de notificar", () => {
    const { result } = renderHook(() => useDirtyDocs());
    let calls = 0;
    const unsubscribe = result.current.subscribe(() => {
      calls += 1;
    });
    act(() => result.current.markDirty("doc-1"));
    expect(calls).toBe(1);
    unsubscribe();
    act(() => result.current.markDirty("doc-2"));
    expect(calls).toBe(1);
  });
});
