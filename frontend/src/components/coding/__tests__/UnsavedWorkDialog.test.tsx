// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UnsavedWorkDialog } from "@/components/coding/UnsavedWorkDialog";

afterEach(() => {
  cleanup();
});

function renderDialog(
  props: Partial<React.ComponentProps<typeof UnsavedWorkDialog>> = {},
) {
  const onLeave = vi.fn();
  const onStay = vi.fn();
  render(
    <UnsavedWorkDialog
      open
      unsentDocsCount={1}
      allHaveLocalCopy
      onLeave={onLeave}
      onStay={onStay}
      {...props}
    />,
  );
  return { onLeave, onStay };
}

// O que este arquivo protege é a VERACIDADE da frase, não a existência dela. A
// promessa "ficam salvas neste navegador" é o que separa o aviso de um alarme
// falso; dita quando não há cópia, ela é a mesma mentira que a #608 existe para
// eliminar — só que agora saindo da tela encarregada de corrigi-la.
describe("UnsavedWorkDialog", () => {
  it("com cópia local, afirma que as alterações ficam no navegador", () => {
    renderDialog();
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Elas ficam salvas neste navegador.");
    expect(dialog.textContent).not.toContain("se perdem");
  });

  it("sem cópia local, avisa que sair perde o trabalho", () => {
    renderDialog({ allHaveLocalCopy: false });
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain(
      "Não foi possível guardar uma cópia neste navegador",
    );
    expect(dialog.textContent).toContain("se perdem");
    // A promessa NÃO pode aparecer junto do desmentido.
    expect(dialog.textContent).not.toContain("ficam salvas neste navegador");
  });

  it("nomeia quantos documentos estão pendentes quando é mais de um", () => {
    renderDialog({ unsentDocsCount: 3 });
    expect(screen.getByRole("alertdialog").textContent).toContain(
      "Você editou 3 documentos",
    );
  });

  it("com um documento só, não pluraliza nem inventa contagem", () => {
    renderDialog({ unsentDocsCount: 1 });
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Você editou respostas");
    expect(dialog.textContent).not.toContain("1 documentos");
  });

  it("a contagem e o destino são independentes: 2 documentos sem cópia dizem as duas coisas", () => {
    renderDialog({ unsentDocsCount: 2, allHaveLocalCopy: false });
    const text = screen.getByRole("alertdialog").textContent ?? "";
    expect(text).toContain("Você editou 2 documentos");
    expect(text).toContain("se perdem");
  });

  it("sair é uma escolha, nunca um veto: os dois botões existem e chamam o dono", async () => {
    const { onLeave, onStay } = renderDialog();
    // Buscas dentro do diálogo: o Radix marca o resto da árvore com
    // `aria-hidden` enquanto o modal está aberto, e consultas por role no
    // `screen` não veem o que está escondido.
    const dialog = within(screen.getByRole("alertdialog"));

    await userEvent.click(dialog.getByRole("button", { name: "Sair sem enviar" }));
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(onStay).not.toHaveBeenCalled();

    await userEvent.click(dialog.getByRole("button", { name: "Ficar" }));
    expect(onStay).toHaveBeenCalledTimes(1);
  });
});
