"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { PydanticField } from "@/lib/types";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Check, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { OTHER_PREFIX, isOtherValue } from "@/lib/other-option";
import { NOT_INFORMED } from "@/lib/sentinels";
import { isSubfieldRecord, readLegacyGroupText } from "@/lib/subfield-value";
import {
  arePartsValid,
  buildDateValue,
  type DateParts,
  type DatePartName,
  isPartOutOfRange,
  padDatePart,
  parseDatePartsForUI,
} from "@/lib/date-parts";
import {
  resolveSubfieldRequired,
  resolveSubfieldRule,
} from "@/lib/pydantic-field";

interface FieldRendererProps {
  field: PydanticField;
  value: unknown;
  onChange: (value: unknown) => void;
}

const otherText = (v: string) => v.slice(OTHER_PREFIX.length);

// Pure handler: backspace on an empty date part jumps focus to the previous
// input. Depends only on its arguments (no closure over props/state), so it
// lives at module scope instead of being rebuilt every render.
const handleBackspaceJump = (
  e: React.KeyboardEvent<HTMLInputElement>,
  previousRef: React.RefObject<HTMLInputElement | null>,
) => {
  if (e.key === "Backspace" && e.currentTarget.value === "") {
    e.preventDefault();
    previousRef.current?.focus();
  }
};

function DateFieldRenderer({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options?: string[] | null;
}) {
  const sentinels = (options ?? []).filter((o) => o !== NOT_INFORMED);
  const activeSentinel = sentinels.find((o) => value === o);
  const isNotInformed = value === NOT_INFORMED;
  const isSentinelActive = Boolean(activeSentinel) || isNotInformed;

  const externalForUI = isSentinelActive ? "" : value;
  const [parts, setParts] = useState<DateParts>(() =>
    parseDatePartsForUI(externalForUI),
  );
  // `lastExternal` É lido no render (na comparação `externalForUI !== lastExternal`
  // abaixo) — é o padrão oficial React de "previous render", não state só-de-handler.
  // A regra classifica errado; useRef quebraria o padrão (set-durante-render
  // precisa de useState para reagendar o render).
  // react-doctor-disable-next-line react-doctor/rerender-state-only-in-handlers
  const [lastExternal, setLastExternal] = useState(externalForUI);

  // React's official "Storing information from previous renders" pattern
  // (https://react.dev/reference/react/useState#storing-information-from-previous-renders).
  // We need local state for `parts` so the user's typed digits don't get
  // clobbered before the parent's value prop catches up. But when the prop
  // changes for an external reason (switching response, sentinel toggled,
  // parent reset), we must resync. Two cases when `externalForUI` differs
  // from the value we last saw:
  //   (a) external change: parts no longer match externalForUI → reparse.
  //   (b) echo of our own edit: parts already match externalForUI via
  //       buildDateValue → only update lastExternal, leave parts alone
  //       (otherwise we'd reparse "1/XX/XXXX" → ["1","",""] mid-typing
  //       and lose any in-progress empty slot semantics).
  if (externalForUI !== lastExternal) {
    setLastExternal(externalForUI);
    if (externalForUI !== buildDateValue(...parts)) {
      setParts(parseDatePartsForUI(externalForUI));
    }
  }

  const [day, month, year] = parts;
  const dayRef = useRef<HTMLInputElement>(null);
  const monthRef = useRef<HTMLInputElement>(null);
  const yearRef = useRef<HTMLInputElement>(null);
  // Defer focus() to a post-commit effect. If we focus()ed synchronously inside
  // handlePart, the resulting onBlur would fire before our setParts had been
  // applied — handleBlur would then read stale parts ("1" instead of "12"),
  // pad to "01", and queue a setParts that overwrites our just-typed value.
  const pendingFocusRef = useRef<"month" | "year" | null>(null);

  const handlePart = (part: DatePartName, raw: string) => {
    const maxLen = part === "year" ? 4 : 2;
    const v = raw.replace(/\D/g, "").slice(0, maxLen);

    const next: DateParts = [
      part === "day" ? v : day,
      part === "month" ? v : month,
      part === "year" ? v : year,
    ];
    setParts(next);

    // Don't persist invalid values (e.g. day=32). User sees aria-invalid red
    // border and can correct; once back in range, onChange resumes.
    if (arePartsValid(next)) {
      onChange(buildDateValue(...next));
      if (part === "day" && v.length === 2) pendingFocusRef.current = "month";
      else if (part === "month" && v.length === 2) pendingFocusRef.current = "year";
    }
  };

  useEffect(() => {
    const target = pendingFocusRef.current;
    if (!target) return;
    pendingFocusRef.current = null;
    if (target === "month") monthRef.current?.focus();
    else if (target === "year") yearRef.current?.focus();
  }, [parts]);

  const handleBlur = (part: "day" | "month") => {
    const idx = part === "day" ? 0 : 1;
    const padded = padDatePart(parts[idx], part);
    if (padded === parts[idx]) return;
    const next: DateParts = [parts[0], parts[1], parts[2]];
    next[idx] = padded;
    setParts(next);
    if (arePartsValid(next)) onChange(buildDateValue(...next));
  };

  const handleClear = () => {
    setParts(["", "", ""]);
    onChange("");
  };

  const hasContent = Boolean(day || month || year);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 flex-wrap">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(
            "h-7 text-xs",
            isNotInformed && "bg-brand-muted text-brand border-brand",
          )}
          onClick={() => onChange(isNotInformed ? "" : NOT_INFORMED)}
        >
          {isNotInformed && <Check className="mr-1 size-3" />}
          Não informada
        </Button>
        {sentinels.map((opt) => {
          const active = value === opt;
          return (
            <Button
              key={opt}
              type="button"
              variant="outline"
              size="sm"
              className={cn(
                "h-7 text-xs",
                active && "bg-brand-muted text-brand border-brand",
              )}
              onClick={() => onChange(active ? "" : opt)}
            >
              {active && <Check className="mr-1 size-3" />}
              {opt}
            </Button>
          );
        })}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="size-3.5 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs text-xs">
              <p>
                Formato <strong>DD/MM/AAAA</strong>. Se o documento não informa
                parte da data (ex: só o ano), deixe os campos correspondentes
                em branco.
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      {!isSentinelActive && (
        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <Input
              ref={dayRef}
              className="w-14 text-center text-sm font-mono"
              placeholder="DD"
              value={day}
              onChange={(e) => handlePart("day", e.target.value)}
              onBlur={() => handleBlur("day")}
              onFocus={(e) => e.currentTarget.select()}
              maxLength={2}
              inputMode="numeric"
              aria-label="Dia"
              aria-invalid={isPartOutOfRange(day, "day")}
            />
            <span className="text-muted-foreground">/</span>
            <Input
              ref={monthRef}
              className="w-14 text-center text-sm font-mono"
              placeholder="MM"
              value={month}
              onChange={(e) => handlePart("month", e.target.value)}
              onBlur={() => handleBlur("month")}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => handleBackspaceJump(e, dayRef)}
              maxLength={2}
              inputMode="numeric"
              aria-label="Mês"
              aria-invalid={isPartOutOfRange(month, "month")}
            />
            <span className="text-muted-foreground">/</span>
            <Input
              ref={yearRef}
              className="w-20 text-center text-sm font-mono"
              placeholder="AAAA"
              value={year}
              onChange={(e) => handlePart("year", e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => handleBackspaceJump(e, monthRef)}
              maxLength={4}
              inputMode="numeric"
              aria-label="Ano"
              aria-invalid={isPartOutOfRange(year, "year")}
            />
            {hasContent && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 text-muted-foreground hover:text-foreground"
                      onClick={handleClear}
                      aria-label="Limpar data"
                    >
                      <X className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    Limpar data
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
          <p className="text-[11px] leading-tight text-muted-foreground">
            Deixe em branco partes que o documento não informa.
          </p>
        </div>
      )}
    </div>
  );
}

export function FieldRenderer({ field, value, onChange }: FieldRendererProps) {
  // Prefixo dos ids que ligam cada `label` de subcampo ao seu `Input`. Vem de
  // `useId` e não de `field.name` porque o mesmo campo pode ser renderizado
  // mais de uma vez na página (comparação lado a lado), e id duplicado faz o
  // clique no rótulo focar o input errado.
  const subfieldIdPrefix = useId();

  if (field.type === "single" && field.options) {
    const otherChecked = isOtherValue(value);
    const otherValue = otherChecked ? otherText(value as string) : "";
    return (
      <div className="flex flex-col gap-0.5">
        {field.options.map((option) => (
          <label key={option} className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-1 hover:bg-muted">
            <input
              type="radio"
              name={field.name}
              value={option}
              checked={value === option}
              onChange={() => onChange(option)}
              className="accent-brand"
            />
            <span className="text-sm">{option}</span>
          </label>
        ))}
        {field.allow_other && (
          <div className="space-y-1.5">
            <label className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-1 hover:bg-muted">
              <input
                type="radio"
                name={field.name}
                checked={otherChecked}
                onChange={() => {
                  if (!otherChecked) onChange(OTHER_PREFIX);
                }}
                className="accent-brand"
              />
              <span className="text-sm">Outro:</span>
            </label>
            {otherChecked && (
              <Input
                value={otherValue}
                onChange={(e) => onChange(OTHER_PREFIX + e.target.value)}
                placeholder="Digite o valor..."
                className="ml-8 h-8 text-sm"
              />
            )}
          </div>
        )}
      </div>
    );
  }

  if (field.type === "multi" && field.options) {
    const selected = Array.isArray(value) ? (value as unknown[]) : [];
    const fixedOptions = field.options;
    // Os dois conjuntos são consultados uma vez por item da outra lista.
    const fixedOptionSet = new Set(fixedOptions);
    const selectedFixed = selected.filter(
      (s): s is string => typeof s === "string" && fixedOptionSet.has(s),
    );
    const selectedFixedSet = new Set(selectedFixed);
    const otherItem = selected.find(isOtherValue) as string | undefined;
    const otherChecked = otherItem !== undefined;
    const otherValue = otherChecked ? otherText(otherItem as string) : "";

    const withOther = (next: string | undefined): string[] =>
      next !== undefined ? [...selectedFixed, next] : [...selectedFixed];

    return (
      <div className="flex flex-col gap-0.5">
        {field.options.map((option) => (
          <label key={option} className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-1 hover:bg-muted">
            <input
              type="checkbox"
              value={option}
              checked={selectedFixedSet.has(option)}
              onChange={(e) => {
                const nextFixed = e.target.checked
                  ? [...selectedFixed, option]
                  : selectedFixed.filter((s) => s !== option);
                onChange(
                  otherChecked ? [...nextFixed, otherItem as string] : nextFixed,
                );
              }}
              className="accent-brand"
            />
            <span className="text-sm">{option}</span>
          </label>
        ))}
        {field.allow_other && (
          <div className="space-y-1.5">
            <label className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-1 hover:bg-muted">
              <input
                type="checkbox"
                checked={otherChecked}
                onChange={(e) => {
                  onChange(withOther(e.target.checked ? OTHER_PREFIX : undefined));
                }}
                className="accent-brand"
              />
              <span className="text-sm">Outro:</span>
            </label>
            {otherChecked && (
              <Input
                value={otherValue}
                onChange={(e) => onChange(withOther(OTHER_PREFIX + e.target.value))}
                placeholder="Digite o valor..."
                className="ml-8 h-8 text-sm"
              />
            )}
          </div>
        )}
      </div>
    );
  }

  if (field.type === "date") {
    return (
      <DateFieldRenderer
        value={(value as string) || ""}
        onChange={(v) => onChange(v)}
        options={field.options}
      />
    );
  }

  // text with subfields
  if (field.type === "text" && field.subfields && field.subfields.length > 0) {
    // Sem cast: o guard devolve `Record<string, unknown>` e é essa a verdade —
    // o jsonb pode guardar `{anos: 42}`. A conversão para texto acontece na
    // leitura do input, uma vez, em vez de ser prometida pelo tipo aqui.
    const objValue = isSubfieldRecord(value) ? value : {};
    const isNotInformed = value === NOT_INFORMED;
    // Resposta coletada quando o campo ainda era texto simples. A régua de
    // completude a conta como respondida (`coding-completeness.ts`), então ela
    // precisa estar VISÍVEL — e nenhuma tecla pode descartá-la. Enquanto o
    // valor está nesta forma os subcampos ficam inertes, e a única transição
    // para a forma do grupo é o clique num destino nomeado (#607).
    const legacyText = readLegacyGroupText(value);
    // O id fica no bloco de texto, não na região inteira: `role="note"` inclui
    // os botões, e um leitor de tela que a usasse como descrição de cada input
    // anunciaria "Mover para Anos Meses Substituir por..." depois de cada
    // rótulo. O `aria-describedby` aponta só para a explicação + o valor.
    const legacyDescriptionId = `${subfieldIdPrefix}-legado-descricao`;
    const subfields = field.subfields;
    // Sob `all`, mover o texto para um subcampo deixa os outros obrigatórios
    // em branco e rebaixa a codificação. É o comportamento correto — a anistia
    // descrevia um valor que ninguém tinha tocado —, mas tem que ser
    // anunciado antes do clique, não descoberto depois.
    const requiredSubfields =
      resolveSubfieldRule(field.subfield_rule) === "at_least_one"
        ? []
        : subfields.filter((sf) => resolveSubfieldRequired(sf.required));

    // Só entra em cena quando NÃO há texto legado (abaixo), então o ramo que
    // desmarca (`{}`) é alcançável: quem já está em "Não informada" não tem
    // texto legado a proteger. A substituição destrutiva mora no aviso.
    const notInformedButton = (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={cn(
          "h-7 text-xs",
          isNotInformed && "bg-brand-muted text-brand border-brand",
        )}
        onClick={() => onChange(isNotInformed ? {} : NOT_INFORMED)}
      >
        {isNotInformed && <Check className="mr-1 size-3" />}
        Não informada
      </Button>
    );

    return (
      <div className="space-y-2">
        {legacyText !== null && (
          <div
            role="note"
            className="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2.5"
          >
            <div className="flex items-start gap-2">
              <Info className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
              <div id={legacyDescriptionId} className="min-w-0 space-y-1.5">
                <p className="text-xs text-amber-800 dark:text-amber-300">
                  Resposta registrada antes de esta pergunta ganhar subcampos.
                  Ela continua valendo — nada se perde enquanto você não
                  substituir.
                </p>
                <p className="text-sm font-medium break-words">{legacyText}</p>
                {requiredSubfields.length > 0 && (
                  <p className="text-xs text-amber-800 dark:text-amber-300">
                    Esta pergunta exige preencher{" "}
                    {requiredSubfields.map((sf) => sf.label).join(", ")}. Ao
                    mover o texto para um deles, os outros seguirão pendentes.
                  </p>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Mover para:</span>
              {subfields.map((sf) => (
                <Button
                  key={sf.key}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  aria-label={`Mover para ${sf.label}`}
                  onClick={() => onChange({ [sf.key]: legacyText })}
                >
                  {sf.label}
                </Button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">
                Substituir por:
              </span>
              {/* O único caminho que ainda descarta o texto legado, e o único
                  irreversível: "Mover para" deixa o texto num input à vista,
                  daí bastar o clique; aqui a resposta anterior some da tela e
                  do banco. A confirmação é o que impede que um clique errado
                  faça sozinho o que a tecla deixou de fazer (#607).

                  AlertDialog cru, e não `ConfirmActionDialog`: aquele é
                  controlado (`open`/`isPending`), desenhado para server
                  action, e exigiria `useState` AQUI. O `FieldRenderer` não
                  remonta ao trocar de documento no modo Atribuídos, então
                  estado próprio vazaria entre documentos; sem `open`, o
                  diálogo se desmonta junto do aviso quando o valor deixa de
                  ser legado, e o reset é por construção. */}
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                  >
                    Não informada
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      Descartar a resposta anterior?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      A resposta registrada antes de esta pergunta ganhar
                      subcampos —{" "}
                      <span className="font-medium text-foreground">
                        {legacyText}
                      </span>{" "}
                      — será substituída por &ldquo;Não informada&rdquo;. Não há
                      como recuperá-la depois. Para preservar o texto, use
                      &ldquo;Mover para&rdquo;.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancelar</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      onClick={() => onChange(NOT_INFORMED)}
                    >
                      Descartar
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          {legacyText === null && notInformedButton}
          {resolveSubfieldRule(field.subfield_rule) === "at_least_one" && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Info className="size-3.5" />
                    Preencha pelo menos um
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs text-xs">
                  Basta preencher pelo menos um dos campos abaixo.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
        {!isNotInformed && (
          <div className="space-y-2">
            {subfields.map((sf) => (
              <div key={sf.key} className="flex items-center gap-2">
                <label
                  htmlFor={`${subfieldIdPrefix}-${sf.key}`}
                  className="w-32 shrink-0 text-right text-xs text-muted-foreground"
                >
                  {sf.label}
                  {resolveSubfieldRequired(sf.required) &&
                    resolveSubfieldRule(field.subfield_rule) !==
                      "at_least_one" && (
                      <span className="text-destructive ml-0.5">*</span>
                    )}
                </label>
                <Input
                  id={`${subfieldIdPrefix}-${sf.key}`}
                  className={cn("text-sm", legacyText !== null && "opacity-60")}
                  value={
                    legacyText !== null ? "" : String(objValue[sf.key] ?? "")
                  }
                  // `readOnly` é o que impede a perda: sem caminho de tecla,
                  // não há como a digitação emitir um objeto que já perdeu o
                  // texto legado. Mesmo mecanismo que o ramo de texto usa
                  // quando um preset está ativo.
                  readOnly={legacyText !== null}
                  aria-describedby={
                    legacyText !== null ? legacyDescriptionId : undefined
                  }
                  onChange={(e) =>
                    onChange({ ...objValue, [sf.key]: e.target.value })
                  }
                  placeholder={sf.label}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // text
  const textValue = (value as string) || "";
  const presets = field.options ?? [];
  const isPresetActive = presets.includes(textValue);

  return (
    <div className="space-y-2">
      {presets.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {presets.map((preset) => {
            const active = textValue === preset;
            return (
              <Button
                key={preset}
                type="button"
                variant="outline"
                size="sm"
                className={cn(
                  "h-7 text-xs",
                  active && "bg-brand-muted text-brand border-brand",
                )}
                onClick={() => onChange(active ? "" : preset)}
              >
                {active && <Check className="mr-1 size-3" />}
                {preset}
              </Button>
            );
          })}
        </div>
      )}
      <Textarea
        rows={2}
        value={textValue}
        onChange={(e) => onChange(e.target.value)}
        readOnly={isPresetActive}
        placeholder="Digite sua resposta..."
        className={cn("resize-y", isPresetActive && "opacity-60")}
      />
    </div>
  );
}
