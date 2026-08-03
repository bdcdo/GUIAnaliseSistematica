import { useState } from "react";
import type { LotteryPreview } from "@/actions/assignments";
import type {
  AssignmentFilter,
  LotteryBalancing,
  LotteryMode,
} from "@/lib/lottery-utils";
import type { CodingsFilterMode } from "./lottery-dialog-types";

// Toda a configuração do sorteio (tipo, distribuição, filtros, participantes,
// rótulo, prévia). Extraída para um hook para que o corpo do componente fique
// abaixo do limiar de useState do react-doctor; as derivações
// (useMemo/useCallback/buildParams) vivem em useLotteryRun, lendo estes valores.
export function useLotteryParams() {
  // Tipo do sorteio (codificação ou comparação)
  const [type, setType] = useState<"codificacao" | "comparacao">("codificacao");
  const [targetKind, setTargetKind] = useState<"current" | "new">("current");
  const [roundLabel, setRoundLabel] = useState("");
  const [confirmActiveWork, setConfirmActiveWork] = useState(false);
  const [confirmPendingScopeWork, setConfirmPendingScopeWork] = useState(false);

  // Distribuição
  const [researchersPerDoc, setResearchersPerDoc] = useState(2);
  const [docsPerResearcherEnabled, setDocsPerResearcherEnabled] =
    useState(false);
  const [docsPerResearcher, setDocsPerResearcher] = useState(10);
  const [docSubsetEnabled, setDocSubsetEnabled] = useState(false);
  const [docSubsetSize, setDocSubsetSize] = useState(50);
  const [balancing, setBalancing] = useState<LotteryBalancing>("round");

  // Atribuições pendentes (modo)
  const [mode, setMode] = useState<LotteryMode>("append");

  // Filtros de elegibilidade
  const [codingsFilterMode, setCodingsFilterMode] =
    useState<CodingsFilterMode>("all");
  const [maxCodingsValue, setMaxCodingsValue] = useState(1);
  const [assignmentFilter, setAssignmentFilter] =
    useState<AssignmentFilter>("any");
  const [batchFilterMode, setBatchFilterMode] = useState<
    "none" | "exclude" | "only"
  >("none");
  const [batchExclude, setBatchExclude] = useState<string[]>([]);
  const [batchOnly, setBatchOnly] = useState<string | null>(null);
  const [manualEnabled, setManualEnabled] = useState(false);
  const [manualDocIds, setManualDocIds] = useState<Set<string>>(new Set());

  // Participantes: default por role (pesquisador ON, coordenador OFF) +
  // overrides dos toggles — derivar do prop em vez de snapshot garante que
  // membro adicionado com o dialog montado entra com o default do role
  const [participantOverrides, setParticipantOverrides] = useState<
    Record<string, boolean>
  >({});

  // Peso/limite por participante, editados como string (inputs controlados).
  // Ausência da chave = usar o default persistido do membro (m.weight/m.cap).
  const [weightInputs, setWeightInputs] = useState<Record<string, string>>({});
  const [capInputs, setCapInputs] = useState<Record<string, string>>({});

  // Label
  const [label, setLabel] = useState("");

  const [previewState, setPreviewState] = useState<{
    key: string;
    preview: LotteryPreview;
  } | null>(null);

  return {
    type,
    setType,
    targetKind,
    setTargetKind,
    roundLabel,
    setRoundLabel,
    confirmActiveWork,
    setConfirmActiveWork,
    confirmPendingScopeWork,
    setConfirmPendingScopeWork,
    researchersPerDoc,
    setResearchersPerDoc,
    docsPerResearcherEnabled,
    setDocsPerResearcherEnabled,
    docsPerResearcher,
    setDocsPerResearcher,
    docSubsetEnabled,
    setDocSubsetEnabled,
    docSubsetSize,
    setDocSubsetSize,
    balancing,
    setBalancing,
    mode,
    setMode,
    codingsFilterMode,
    setCodingsFilterMode,
    maxCodingsValue,
    setMaxCodingsValue,
    assignmentFilter,
    setAssignmentFilter,
    batchFilterMode,
    setBatchFilterMode,
    batchExclude,
    setBatchExclude,
    batchOnly,
    setBatchOnly,
    manualEnabled,
    setManualEnabled,
    manualDocIds,
    setManualDocIds,
    participantOverrides,
    setParticipantOverrides,
    weightInputs,
    setWeightInputs,
    capInputs,
    setCapInputs,
    label,
    setLabel,
    previewState,
    setPreviewState,
  };
}

// Objeto coeso de estado do formulário do sorteio — é o que viaja para as
// seções extraídas do dialog em vez de dezenas de props soltas.
export type LotteryParamsState = ReturnType<typeof useLotteryParams>;
