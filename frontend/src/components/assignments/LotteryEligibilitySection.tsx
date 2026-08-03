"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { DocumentPickerList } from "@/components/assignments/DocumentPickerList";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AssignmentFilter } from "@/lib/lottery-utils";
import { formatDate } from "@/lib/date-format";
import type {
  CodingsFilterMode,
  LotteryStats,
} from "./lottery-dialog-types";
import type { LotteryParamsState } from "./useLotteryParams";

// Seção "Documentos elegíveis" do LotteryDialog (US1): filtros de
// codificações humanas, status de atribuição, lotes anteriores e seleção
// manual de documentos.
export function LotteryEligibilitySection({
  params,
  stats,
}: {
  params: Pick<
    LotteryParamsState,
    | "type"
    | "codingsFilterMode"
    | "setCodingsFilterMode"
    | "maxCodingsValue"
    | "setMaxCodingsValue"
    | "assignmentFilter"
    | "setAssignmentFilter"
    | "batchFilterMode"
    | "setBatchFilterMode"
    | "batchExclude"
    | "setBatchExclude"
    | "batchOnly"
    | "setBatchOnly"
    | "manualEnabled"
    | "setManualEnabled"
    | "manualDocIds"
    | "setManualDocIds"
  >;
  stats: LotteryStats | null;
}) {
  const {
    type,
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
  } = params;
  const isComparacao = type === "comparacao";
  // Uma varredura por lote renderizado viraria O(lotes × excluídos).
  const batchExcludeSet = new Set(batchExclude);

  return (
    <div className="space-y-4">
      <h4 className="text-sm font-semibold">Documentos elegíveis</h4>

      <div>
        <Label>Codificações humanas</Label>
        <RadioGroup
          value={codingsFilterMode}
          onValueChange={(v) =>
            setCodingsFilterMode(v as CodingsFilterMode)
          }
          className="mt-2 space-y-1"
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem value="all" id="cod-all" />
            <Label htmlFor="cod-all" className="font-normal">
              Todos os documentos
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="none" id="cod-none" />
            <Label htmlFor="cod-none" className="font-normal">
              Sem nenhuma codificação
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="atMost" id="cod-atmost" />
            <Label htmlFor="cod-atmost" className="font-normal">
              No máximo
            </Label>
            <Input
              type="number"
              min={1}
              value={maxCodingsValue}
              onChange={(e) =>
                setMaxCodingsValue(parseInt(e.target.value) || 1)
              }
              onFocus={() => setCodingsFilterMode("atMost")}
              className="h-7 w-16"
              aria-label="Número máximo de codificações"
            />
            <span className="text-sm font-normal">codificações</span>
          </div>
        </RadioGroup>
      </div>

      <div>
        <Label htmlFor="assignment-filter">Status de atribuição</Label>
        <Select
          value={assignmentFilter}
          onValueChange={(v) =>
            setAssignmentFilter(v as AssignmentFilter)
          }
        >
          <SelectTrigger id="assignment-filter" className="mt-1 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Qualquer</SelectItem>
            <SelectItem value="noActiveOfType">
              Sem atribuição ativa de{" "}
              {isComparacao ? "comparação" : "codificação"}
            </SelectItem>
            <SelectItem value="neverAssigned">
              Ainda não atribuído nesta rodada
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {stats !== null && stats.batches.length > 0 && (
        <div>
          <Label htmlFor="batch-filter-mode">Lotes anteriores</Label>
          <Select
            value={batchFilterMode}
            onValueChange={(v) =>
              setBatchFilterMode(v as "none" | "exclude" | "only")
            }
          >
            <SelectTrigger id="batch-filter-mode" className="mt-1 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Todos os lotes</SelectItem>
              <SelectItem value="exclude">Excluir lotes</SelectItem>
              <SelectItem value="only">Somente de um lote</SelectItem>
            </SelectContent>
          </Select>

          {batchFilterMode === "exclude" && (
            <div className="mt-2 max-h-32 space-y-2 overflow-y-auto rounded-md border p-2">
              {stats.batches.map((b) => (
                <div key={b.id} className="flex items-center gap-2">
                  <Checkbox
                    id={`batch-ex-${b.id}`}
                    checked={batchExcludeSet.has(b.id)}
                    onCheckedChange={(checked) =>
                      setBatchExclude((prev) =>
                        checked
                          ? [...prev, b.id]
                          : prev.filter((id) => id !== b.id)
                      )
                    }
                  />
                  <Label
                    htmlFor={`batch-ex-${b.id}`}
                    className="font-normal"
                  >
                    {b.label || "Sem rótulo"}
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      {formatDate(b.createdAt)}
                    </span>
                  </Label>
                </div>
              ))}
            </div>
          )}

          {batchFilterMode === "only" && (
            <RadioGroup
              value={batchOnly ?? ""}
              onValueChange={setBatchOnly}
              className="mt-2 max-h-32 space-y-1 overflow-y-auto rounded-md border p-2"
            >
              {stats.batches.map((b) => (
                <div key={b.id} className="flex items-center gap-2">
                  <RadioGroupItem value={b.id} id={`batch-only-${b.id}`} />
                  <Label
                    htmlFor={`batch-only-${b.id}`}
                    className="font-normal"
                  >
                    {b.label || "Sem rótulo"}
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      {formatDate(b.createdAt)}
                    </span>
                  </Label>
                </div>
              ))}
            </RadioGroup>
          )}

          <p className="mt-1 text-xs text-muted-foreground">
            O vínculo com o lote vem das atribuições existentes dos
            documentos.
          </p>
        </div>
      )}

      <div className="flex items-center justify-between">
        <Label htmlFor="manual-switch">
          Selecionar documentos manualmente
        </Label>
        <Switch
          id="manual-switch"
          checked={manualEnabled}
          onCheckedChange={setManualEnabled}
        />
      </div>
      {manualEnabled && stats !== null && (
        <DocumentPickerList
          docs={stats.docs}
          selected={manualDocIds}
          onChange={setManualDocIds}
        />
      )}
    </div>
  );
}
