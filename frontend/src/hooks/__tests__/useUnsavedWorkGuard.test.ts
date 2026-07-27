// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useUnsavedWorkGuard } from "@/hooks/useUnsavedWorkGuard";
import { requestNavigation } from "@/lib/unsaved-work-guard";

afterEach(() => {
  cleanup();
});

describe("useUnsavedWorkGuard", () => {
  it("deixa passar quando não há trabalho não enviado", () => {
    renderHook(() => useUnsavedWorkGuard(false));
    const proceed = vi.fn();

    expect(requestNavigation(proceed)).toBe(true);
    expect(proceed).not.toHaveBeenCalled();
  });

  it("retém a navegação e abre o aviso quando há trabalho não enviado", () => {
    const { result } = renderHook(() => useUnsavedWorkGuard(true));
    const proceed = vi.fn();

    let allowed = true;
    act(() => {
      allowed = requestNavigation(proceed);
    });

    expect(allowed).toBe(false);
    expect(result.current.isPrompting).toBe(true);
    // Retida, não cancelada: nada navegou ainda.
    expect(proceed).not.toHaveBeenCalled();
  });

  it("confirmar executa a navegação retida uma única vez e fecha o aviso", () => {
    const { result } = renderHook(() => useUnsavedWorkGuard(true));
    const proceed = vi.fn();
    act(() => {
      requestNavigation(proceed);
    });

    act(() => result.current.confirmLeave());

    // "Uma única vez" é a asserção que importa: o `proceed()` fica fora do
    // updater de `setState` justamente porque updaters são reexecutados sob
    // StrictMode, e navegar de dentro de um dispararia a saída em dobro.
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(result.current.isPrompting).toBe(false);
  });

  it("ficar descarta a navegação retida sem executá-la", () => {
    const { result } = renderHook(() => useUnsavedWorkGuard(true));
    const proceed = vi.fn();
    act(() => {
      requestNavigation(proceed);
    });

    act(() => result.current.cancelLeave());

    expect(proceed).not.toHaveBeenCalled();
    expect(result.current.isPrompting).toBe(false);
  });

  it("acompanha a mudança de sujeira sem reassinar o registro", () => {
    const { result, rerender } = renderHook(
      ({ dirty }) => useUnsavedWorkGuard(dirty),
      { initialProps: { dirty: false } },
    );

    expect(requestNavigation(vi.fn())).toBe(true);

    rerender({ dirty: true });
    act(() => {
      requestNavigation(vi.fn());
    });
    expect(result.current.isPrompting).toBe(true);

    // De volta a limpo: o mesmo registro passa a liberar. Se o effect
    // dependesse da sujeira, cada tecla digitada desregistraria e registraria de
    // novo, e uma navegação que caísse nessa fresta passaria sem aviso.
    act(() => result.current.cancelLeave());
    rerender({ dirty: false });
    expect(requestNavigation(vi.fn())).toBe(true);
  });

  it("desmontar libera a navegação de novo", () => {
    const { unmount } = renderHook(() => useUnsavedWorkGuard(true));
    expect(requestNavigation(vi.fn())).toBe(false);

    unmount();

    expect(requestNavigation(vi.fn())).toBe(true);
  });

  it("previne o fechamento da janela só quando há trabalho não enviado", () => {
    const { rerender } = renderHook(
      ({ dirty }) => useUnsavedWorkGuard(dirty),
      { initialProps: { dirty: false } },
    );

    const fire = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };

    expect(fire()).toBe(false);
    rerender({ dirty: true });
    expect(fire()).toBe(true);
  });
});
