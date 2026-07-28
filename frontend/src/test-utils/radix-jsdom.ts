import { vi } from "vitest";

// Radix (Popover, Select, Tooltip…) usa APIs de Pointer Events e ResizeObserver
// que o jsdom não implementa: sem estes stubs, abrir um Popover num teste
// estoura em `hasPointerCapture is not a function`.
//
// Chamar de dentro de `beforeAll` do arquivo de teste — a mutação é no
// protótipo global, e fazê-la no topo do módulo a espalharia para arquivos que
// não a pediram.
//
// Deliberadamente NÃO está em `setupFiles`: um teste que renderiza Radix sem
// declarar isto denuncia a dependência no próprio arquivo, enquanto um stub
// global a tornaria invisível. Os arquivos anteriores a este helper mantêm a
// cópia local; consolidar todos é limpeza que não pertence a esta mudança.
export function stubRadixJsdomApis() {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.scrollIntoView = () => {};
  proto.hasPointerCapture = () => false;
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
}
