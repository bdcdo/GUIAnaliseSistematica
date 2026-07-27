// Pure helpers for the partial-date format used by `date` fields.
// Storage shape: `DD/MM/AAAA` with `XX`/`XXXX` in slots the document doesn't
// inform (e.g. `XX/03/2024` when only month+year are known). UI exposes
// these as empty inputs; storage round-trip is preserved by buildDateValue.

import { NOT_INFORMED } from "@/lib/sentinels";

export type DateParts = [day: string, month: string, year: string];
export type DatePartName = "day" | "month" | "year";

const PART_NAMES: readonly DatePartName[] = ["day", "month", "year"] as const;

export function parseDatePartsForUI(val: string): DateParts {
  if (!val || val === NOT_INFORMED) return ["", "", ""];
  const parts = val.split("/");
  if (parts.length !== 3) return ["", "", ""];
  const normalize = (p: string) => (/^X+$/i.test(p) ? "" : p);
  return [normalize(parts[0]), normalize(parts[1]), normalize(parts[2])];
}

export function buildDateValue(day: string, month: string, year: string): string {
  if (!day && !month && !year) return "";
  return `${day || "XX"}/${month || "XX"}/${year || "XXXX"}`;
}

// True only when the part is COMPLETE (length matches the slot) AND out of range.
// Partial inputs ("3" while typing "30") are NOT flagged — the user is mid-type.
export function isPartOutOfRange(v: string, part: DatePartName): boolean {
  if (!v) return false;
  const expectedLen = part === "year" ? 4 : 2;
  if (v.length !== expectedLen) return false;
  const n = Number.parseInt(v, 10);
  if (part === "day") return n < 1 || n > 31;
  if (part === "month") return n < 1 || n > 12;
  return n < 1000 || n > 9999;
}

export function arePartsValid(parts: DateParts): boolean {
  return parts.every((p, i) => !isPartOutOfRange(p, PART_NAMES[i]));
}

// Pads day/month from 1 digit to 2 ("5" -> "05"). Year is left as-is — auto-padding
// "5" -> "0005" would invent an unintended year.
export function padDatePart(v: string, part: DatePartName): string {
  if (part === "year") return v;
  if (v.length === 1 && /^[1-9]$/.test(v)) return `0${v}`;
  return v;
}

// "XX/03/2024" -> "—/03/2024". Used only for display in compare cards.
// Strings that don't match the date shape pass through unchanged.
const PARTIAL_DATE_RE = /^[\dX]+\/[\dX]+\/[\dX]+$/i;
export function formatPartialDate(s: string): string {
  if (!PARTIAL_DATE_RE.test(s)) return s;
  if (!/X/i.test(s)) return s;
  return s.replace(/X+/gi, "—");
}
