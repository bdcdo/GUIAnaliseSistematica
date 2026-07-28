import { describe, it, expect, vi } from "vitest";
import {
  registerUnsavedWorkGuard,
  requestNavigation,
} from "@/lib/unsaved-work-guard";

describe("unsaved-work-guard", () => {
  it("libera a navegação quando nenhuma tela registrou guard", () => {
    const proceed = vi.fn();
    // Fail-open: fora da codificação não há nada a proteger, e o resto do app
    // não pode ficar preso por causa deste módulo.
    expect(requestNavigation(proceed)).toBe(true);
    // Quem chamou é que executa; o módulo não navega por conta própria.
    expect(proceed).not.toHaveBeenCalled();
  });

  it("delega a decisão ao guard registrado e devolve o veredito dele", () => {
    const unregister = registerUnsavedWorkGuard(() => false);
    expect(requestNavigation(vi.fn())).toBe(false);
    unregister();
    expect(requestNavigation(vi.fn())).toBe(true);
  });

  it("entrega ao guard o `proceed` que quem navega quer executar", () => {
    const proceed = vi.fn();
    let retained: (() => void) | null = null;
    const unregister = registerUnsavedWorkGuard((p) => {
      retained = p;
      return false;
    });

    requestNavigation(proceed);
    expect(retained).toBe(proceed);
    // O guard só executa quando decide executar — reter não é navegar.
    expect(proceed).not.toHaveBeenCalled();
    retained!();
    expect(proceed).toHaveBeenCalledTimes(1);
    unregister();
  });

  it("o desregistro de um guard já substituído não desarma o substituto", () => {
    // O cenário do StrictMode e de qualquer remontagem rápida: o React monta o
    // substituto ANTES de rodar o cleanup do anterior. Um `currentGuard = null`
    // incondicional apagaria o guard vivo, e a tela ficaria desprotegida sem
    // nada indicar o problema.
    const unregisterFirst = registerUnsavedWorkGuard(() => false);
    const unregisterSecond = registerUnsavedWorkGuard(() => false);

    unregisterFirst(); // cleanup atrasado do primeiro mount

    expect(requestNavigation(vi.fn())).toBe(false);
    unregisterSecond();
    expect(requestNavigation(vi.fn())).toBe(true);
  });
});
