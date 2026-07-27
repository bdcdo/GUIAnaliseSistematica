// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { ProjectTabs } from "@/components/shell/ProjectTabs";
import { registerUnsavedWorkGuard } from "@/lib/unsaved-work-guard";

const { push, searchParams } = vi.hoisted(() => ({
  push: vi.fn(),
  searchParams: { current: new URLSearchParams() },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/p1/analyze/code",
  useRouter: () => ({ push }),
  useSearchParams: () => searchParams.current,
}));

// `next/link` real chamaria o roteador do App Router; aqui só precisamos do
// <a> e do onClick, que é onde o guard entra.
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

vi.mock("@/components/llm/LlmRunningBadge", () => ({
  LlmRunningBadge: () => null,
}));

let unregister: (() => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  searchParams.current = new URLSearchParams();
});

afterEach(() => {
  unregister?.();
  unregister = null;
  cleanup();
});

function renderTabs() {
  render(<ProjectTabs projectId="p1" isCoordinator={false} />);
}

describe("ProjectTabs — guard de trabalho não enviado (#608)", () => {
  it("sem guard registrado, o clique na aba navega normalmente", async () => {
    renderTabs();
    // Sem guard, o <Link> segue o caminho nativo do Next: o teste prova que
    // nada foi bloqueado, não que `push` foi chamado.
    const link = screen.getByText("Revisar").closest("a")!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("com trabalho não enviado, o clique na aba é retido e entrega a navegação ao guard", async () => {
    let retained: (() => void) | null = null;
    unregister = registerUnsavedWorkGuard((proceed) => {
      retained = proceed;
      return false;
    });
    renderTabs();

    const link = screen.getByText("Revisar").closest("a")!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);

    // A navegação não acontece agora...
    expect(event.defaultPrevented).toBe(true);
    expect(push).not.toHaveBeenCalled();
    // ...mas fica disponível para quando a pesquisadora confirmar a saída.
    expect(retained).not.toBeNull();
    retained!();
    expect(push).toHaveBeenCalledWith("/projects/p1/reviews");
  });

  it("clique com Ctrl/Cmd não é retido: abrir em outra aba não tira ninguém da tela", async () => {
    unregister = registerUnsavedWorkGuard(() => false);
    renderTabs();

    const link = screen.getByText("Revisar").closest("a")!;
    for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"] as const) {
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        [modifier]: true,
      });
      link.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
  });

  it("a troca de impersonação também passa pelo guard", async () => {
    let retained: (() => void) | null = null;
    unregister = registerUnsavedWorkGuard((proceed) => {
      retained = proceed;
      return false;
    });
    searchParams.current = new URLSearchParams("viewAs=pesquisador");
    render(<ProjectTabs projectId="p1" isCoordinator />);

    await userEvent.click(screen.getByText("Visão Coordenador"));

    expect(push).not.toHaveBeenCalled();
    expect(retained).not.toBeNull();
  });
});
