// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import { Header } from "@/components/shell/Header";
import { registerUnsavedWorkGuard } from "@/lib/unsaved-work-guard";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

// `next/link` real chamaria o roteador do App Router; aqui só precisamos do <a>
// e do onClick, que é onde o guard entra.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children?: ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/shell/UserMenu", () => ({
  UserMenu: () => null,
}));

let unregister: (() => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  unregister?.();
  unregister = null;
  cleanup();
});

function logo() {
  return screen.getByText("AC").closest("a")!;
}

function clickWith(node: Element, init: MouseEventInit = {}) {
  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  node.dispatchEvent(event);
  return event;
}

// O logo é o terceiro canal de saída da codificação (#608), junto das abas do
// projeto e do fechamento da janela. Antes de ser guardado, era o furo mais fácil
// de achar por acidente: o clique saía da tela sem nenhum aviso, e o aviso das
// abas passava a impressão de cobertura que não existia.
describe("Header — guard de trabalho não enviado (#608)", () => {
  it("sem guard registrado, o clique no logo navega normalmente", () => {
    render(<Header />);
    const event = clickWith(logo());
    // Sem guard, o <Link> segue o caminho nativo do Next: prova que nada foi
    // bloqueado, não que `push` foi chamado.
    expect(event.defaultPrevented).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });

  it("com trabalho não enviado, o clique no logo é retido e entrega a navegação ao guard", () => {
    let retained: (() => void) | null = null;
    unregister = registerUnsavedWorkGuard((proceed) => {
      retained = proceed;
      return false;
    });
    render(<Header />);

    const event = clickWith(logo());

    expect(event.defaultPrevented).toBe(true);
    expect(push).not.toHaveBeenCalled();
    expect(retained).not.toBeNull();
    retained!();
    expect(push).toHaveBeenCalledWith("/dashboard");
  });

  it("clique modificado não é retido: abrir em outra aba não tira ninguém da tela", () => {
    unregister = registerUnsavedWorkGuard(() => false);
    render(<Header />);

    for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"] as const) {
      const event = clickWith(logo(), { [modifier]: true });
      expect(event.defaultPrevented).toBe(false);
    }
  });
});
