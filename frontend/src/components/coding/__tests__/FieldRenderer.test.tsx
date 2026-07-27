// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FieldRenderer } from "@/components/coding/FieldRenderer";
import type { PydanticField } from "@/lib/types";

afterEach(cleanup);

const dateField: PydanticField = {
  name: "data_evento",
  type: "date",
  options: null,
  description: "Data do evento",
};

function lastOnChangeCall(onChange: ReturnType<typeof vi.fn>): unknown {
  const calls = onChange.mock.calls;
  return calls[calls.length - 1]?.[0];
}

describe("FieldRenderer (date) — race condition regression", () => {
  it("preserves both digits when typing '12' in the day field (PR #92)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    const { rerender } = render(
      <FieldRenderer field={dateField} value="" onChange={onChange} />,
    );

    const dayInput = screen.getByLabelText("Dia") as HTMLInputElement;
    const monthInput = screen.getByLabelText("Mês") as HTMLInputElement;

    // Simulate the controlled-input loop: each onChange call updates the value prop.
    onChange.mockImplementation((v: string) => {
      rerender(<FieldRenderer field={dateField} value={v} onChange={onChange} />);
    });

    await user.click(dayInput);
    await user.keyboard("12");

    // The bug produced "01" because handleBlur padded stale parts before
    // setParts({day: "12"}) committed. After the fix, the day must be "12".
    expect(dayInput.value).toBe("12");
    expect(lastOnChangeCall(onChange)).toBe("12/XX/XXXX");
    expect(document.activeElement).toBe(monthInput);
  });

  it("auto-pads single-digit day on blur (PR #90)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    const { rerender } = render(
      <FieldRenderer field={dateField} value="" onChange={onChange} />,
    );

    const dayInput = screen.getByLabelText("Dia") as HTMLInputElement;

    onChange.mockImplementation((v: string) => {
      rerender(<FieldRenderer field={dateField} value={v} onChange={onChange} />);
    });

    await user.click(dayInput);
    await user.keyboard("5");
    await user.tab();

    expect(dayInput.value).toBe("05");
    expect(lastOnChangeCall(onChange)).toBe("05/XX/XXXX");
  });

  it("selects pre-filled content on focus so typing overwrites (PR #91)", () => {
    const onChange = vi.fn();

    render(
      <FieldRenderer
        field={dateField}
        value="05/XX/XXXX"
        onChange={onChange}
      />,
    );

    const dayInput = screen.getByLabelText("Dia") as HTMLInputElement;
    expect(dayInput.value).toBe("05");

    // Focusing must trigger the onFocus={select()} handler so the next
    // keystroke replaces "05" instead of appending. We assert the selection
    // directly instead of relying on userEvent's keystroke-vs-selection
    // semantics in jsdom, which are not faithful to real browsers.
    dayInput.focus();
    expect(dayInput.selectionStart).toBe(0);
    expect(dayInput.selectionEnd).toBe(2);
  });
});

// Campo que era `text` simples, ganhou subcampos depois, e cujas respostas
// antigas continuam gravadas como string. 182 casos medidos em produção
// (#607). A régua de completude anistia esse valor de propósito
// (`coding-completeness.ts`, fronteira do #606), então a pergunta aparece com
// ✓ — e o renderizador precisa concordar com esse ✓ em vez de exibir vazio.
const LEGACY_TEXT = "18 anos e 6 meses";

const grupo: PydanticField = {
  name: "q7_idade_paciente",
  type: "text",
  options: null,
  description: "Idade do paciente",
  subfields: [
    { key: "anos", label: "Anos" },
    { key: "meses", label: "Meses" },
  ],
  subfield_rule: "at_least_one",
};

describe("FieldRenderer (grupo de subcampos) — valor legado em texto (#607)", () => {
  it("exibe na tela o valor coletado antes de o campo virar grupo", () => {
    render(
      <FieldRenderer field={grupo} value={LEGACY_TEXT} onChange={vi.fn()} />,
    );

    expect(screen.getByText(LEGACY_TEXT)).toBeTruthy();
  });

  // Asserção deliberadamente agnóstica ao mecanismo: não exige que o input
  // seja `readOnly`, só que nenhum valor emitido pela digitação tenha perdido
  // o texto legado. Amarrar o teste ao mecanismo o tornaria vácuo no dia em
  // que a via de escrita mudasse.
  it("digitar em um subcampo não descarta o valor legado", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <FieldRenderer field={grupo} value={LEGACY_TEXT} onChange={onChange} />,
    );

    await user.type(screen.getByRole("textbox", { name: /Meses/ }) as HTMLInputElement, "6");

    const perdeuOLegado = onChange.mock.calls.some(
      ([emitido]) => !JSON.stringify(emitido ?? null).includes(LEGACY_TEXT),
    );
    expect(perdeuOLegado).toBe(false);
    // Sem esta linha o caso passaria com ZERO chamadas — `[].some()` é `false`,
    // e "nenhuma emissão ruim" não distingue "nada se perdeu" de "nada
    // aconteceu". A sobrevivência é afirmada, não inferida da ausência.
    expect(screen.getByText(LEGACY_TEXT)).toBeTruthy();
  });

  it("mantém os subcampos inertes enquanto o valor for legado", () => {
    render(
      <FieldRenderer field={grupo} value={LEGACY_TEXT} onChange={vi.fn()} />,
    );

    const meses = screen.getByRole("textbox", { name: /Meses/ }) as HTMLInputElement;
    expect(meses.readOnly).toBe(true);
  });

  it("só converte por clique, e o destino é o subcampo escolhido", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <FieldRenderer field={grupo} value={LEGACY_TEXT} onChange={onChange} />,
    );

    await user.click(screen.getByRole("button", { name: /Mover para Anos/i }));

    expect(lastOnChangeCall(onChange)).toEqual({ anos: LEGACY_TEXT });
  });

  // O mesmo botão que antes trocava o texto legado pela sentinela em um clique
  // silencioso. Dentro do aviso, ele fica sob o mesmo enquadramento de ato
  // consciente que os botões de destino.
  it("põe o botão 'Não informada' dentro do aviso, junto das outras substituições", () => {
    render(
      <FieldRenderer field={grupo} value={LEGACY_TEXT} onChange={vi.fn()} />,
    );

    const aviso = screen.getByRole("note");
    const naoInformada = screen.getByRole("button", { name: "Não informada" });
    expect(aviso.contains(naoInformada)).toBe(true);
  });

  // A substituição pela sentinela é o único caminho irreversível que sobrou:
  // "Mover para" deixa o texto num input à vista, este apaga a resposta.
  // `pointerEventsCheck: 0` porque o overlay do Radix confunde o userEvent —
  // mesma razão do DocumentSelector.test.tsx.
  describe("substituir pela sentinela exige confirmação", () => {
    const abrirConfirmacao = async () => {
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      const onChange = vi.fn();
      render(
        <FieldRenderer field={grupo} value={LEGACY_TEXT} onChange={onChange} />,
      );
      await user.click(screen.getByRole("button", { name: "Não informada" }));
      return { user, onChange };
    };

    // Enquanto o diálogo está em cena o Radix marca o resto da página como
    // `aria-hidden`, então o aviso sai da árvore de acessibilidade e não dá
    // para consultá-lo por papel aqui — a sobrevivência do texto é afirmada no
    // caso do Cancelar, com o diálogo já fechado. O que este caso sustenta é o
    // essencial: o clique abriu uma pergunta em vez de gravar.
    it("o clique no botão não descarta o texto sozinho", async () => {
      const { onChange } = await abrirConfirmacao();

      expect(onChange).not.toHaveBeenCalled();
      expect(await screen.findByRole("alertdialog")).toBeTruthy();
    });

    it("a confirmação cita o texto que será perdido", async () => {
      await abrirConfirmacao();

      const dialogo = await screen.findByRole("alertdialog");
      expect(dialogo.textContent).toContain(LEGACY_TEXT);
    });

    it("só depois de confirmar a sentinela é gravada", async () => {
      const { user, onChange } = await abrirConfirmacao();

      await user.click(await screen.findByRole("button", { name: "Descartar" }));

      expect(lastOnChangeCall(onChange)).toBe("Não informada");
    });

    it("cancelar preserva a resposta anterior", async () => {
      const { user, onChange } = await abrirConfirmacao();

      await user.click(await screen.findByRole("button", { name: "Cancelar" }));

      expect(onChange).not.toHaveBeenCalled();
      expect(
        within(screen.getByRole("note")).getByText(LEGACY_TEXT),
      ).toBeTruthy();
    });
  });

  it("depois de mover, o subcampo seguinte se soma ao que já foi movido", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    const { rerender } = render(
      <FieldRenderer field={grupo} value={LEGACY_TEXT} onChange={onChange} />,
    );
    onChange.mockImplementation((v: unknown) => {
      rerender(<FieldRenderer field={grupo} value={v} onChange={onChange} />);
    });

    await user.click(screen.getByRole("button", { name: /Mover para Anos/i }));
    await user.type(screen.getByRole("textbox", { name: /Meses/ }), "6");

    expect(lastOnChangeCall(onChange)).toEqual({
      anos: LEGACY_TEXT,
      meses: "6",
    });
  });

  it("anuncia a pendência antes do clique quando a regra é 'all'", () => {
    const grupoAll: PydanticField = {
      ...grupo,
      subfield_rule: "all",
      subfields: [
        { key: "anos", label: "Anos", required: true },
        { key: "meses", label: "Meses", required: true },
      ],
    };

    render(
      <FieldRenderer field={grupoAll} value={LEGACY_TEXT} onChange={vi.fn()} />,
    );

    expect(screen.getByRole("note").textContent).toContain("Meses");
  });
});

// O aviso é para quem tem valor legado. Aparecer para os demais viraria ruído
// permanente na tela de codificação — e o guard do ramo de subcampos precisa
// continuar sendo o primeiro a decidir, senão um campo sem subcampos deixa de
// cair no textarea que hoje exibe o texto corretamente.
describe("FieldRenderer (grupo de subcampos) — quem não vê o aviso (#607)", () => {
  it("registro genuíno renderiza normalmente, sem aviso", () => {
    render(
      <FieldRenderer field={grupo} value={{ anos: "18" }} onChange={vi.fn()} />,
    );

    expect(screen.queryByRole("note")).toBeNull();
    const anos = screen.getByRole("textbox", { name: /Anos/ }) as HTMLInputElement;
    expect(anos.value).toBe("18");
    expect(anos.readOnly).toBe(false);
  });

  it("a sentinela continua sendo a sentinela, não um valor legado", () => {
    render(
      <FieldRenderer field={grupo} value="Não informada" onChange={vi.fn()} />,
    );

    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByRole("textbox", { name: /Anos/ })).toBeNull();
  });

  it("campo sem subcampos exibe a string no textarea, como sempre", () => {
    const semSubcampos: PydanticField = {
      name: "q7",
      type: "text",
      options: null,
      description: "Idade",
    };

    render(
      <FieldRenderer
        field={semSubcampos}
        value={LEGACY_TEXT}
        onChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole("note")).toBeNull();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      LEGACY_TEXT,
    );
  });

  // Valor fora da forma do grupo e sem texto a mostrar: a régua o anistia, mas
  // não há evidência para exibir verbatim. Comportamento de hoje preservado.
  it("valor sem texto legível não fabrica aviso", () => {
    render(<FieldRenderer field={grupo} value={42} onChange={vi.fn()} />);

    expect(screen.queryByRole("note")).toBeNull();
    const anos = screen.getByRole("textbox", { name: /Anos/ }) as HTMLInputElement;
    expect(anos.value).toBe("");
    expect(anos.readOnly).toBe(false);
  });
});
