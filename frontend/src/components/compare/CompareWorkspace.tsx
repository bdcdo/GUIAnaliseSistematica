"use client";

import { useDefaultLayout } from "react-resizable-panels";
import { DocumentReader } from "../coding/DocumentReader";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { ComparisonPanel } from "./ComparisonPanel";
import { CompareDocList, type DocListEntry } from "./CompareDocList";

// Identificam cada painel DENTRO do layout persistido, que é um mapa
// `{ [panelId]: tamanho }`. Sem `id` explícito a lib cai em `useId()`, cuja
// saída muda entre execuções: a gravação funciona, a restauração não acha a
// chave, e a falha é silenciosa — o pior modo possível para uma preferência.
const READER_PANEL_ID = "compare-reader";
const REVIEW_PANEL_ID = "compare-review";

// `useDefaultLayout` lê o storage via `useSyncExternalStore` COM
// `getServerSnapshot`, e seu default é `localStorage` — que não existe no
// render de servidor deste componente. O guard mora aqui, numa constante de
// módulo, porque o objeto entra nas dependências do hook: recriá-lo a cada
// render o faria reassinar sem parar.
const layoutStorage = {
  getItem: (key: string) =>
    typeof window === "undefined" ? null : window.localStorage.getItem(key),
  setItem: (key: string, value: string) => {
    if (typeof window !== "undefined") window.localStorage.setItem(key, value);
  },
};

interface CompareWorkspaceProps {
  docs: DocListEntry[];
  docIndex: number;
  onDocNavigate: (index: number) => void;
  listCollapsed: boolean;
  onToggleList: () => void;
  documentText: string;
  comparisonPanel: React.ComponentProps<typeof ComparisonPanel>;
}

/**
 * Corpo presentacional da Comparação: lista de documentos + leitor do texto e
 * o painel de comparação, lado a lado e redimensionáveis. Extraído de
 * `ComparePage` para reduzir o tamanho do container (`no-giant-component`).
 */
export function CompareWorkspace({
  docs,
  docIndex,
  onDocNavigate,
  listCollapsed,
  onToggleList,
  documentText,
  comparisonPanel,
}: CompareWorkspaceProps) {
  // Quem revisa muito ajusta a divisão uma vez e a mantém; sem isto, toda
  // sessão recomeçava em 50/50 (#610).
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "compare:split",
    storage: layoutStorage,
    panelIds: [READER_PANEL_ID, REVIEW_PANEL_ID],
  });

  return (
    <div className="flex flex-1 overflow-hidden">
      <CompareDocList
        docs={docs}
        currentIndex={docIndex}
        onSelect={onDocNavigate}
        collapsed={listCollapsed}
        onToggle={onToggleList}
      />

      <ResizablePanelGroup
        className="flex-1"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
      >
        <ResizablePanel id={READER_PANEL_ID} defaultSize={50} minSize={25}>
          <DocumentReader text={documentText} />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel id={REVIEW_PANEL_ID} defaultSize={50} minSize={25}>
          <ComparisonPanel {...comparisonPanel} />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
