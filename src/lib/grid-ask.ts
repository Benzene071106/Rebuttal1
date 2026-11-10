// "Ask the grid": a seller types a question in plain English and the model sets the AG
// Grid's filters, sort and grouping. The model only proposes a view through one strict
// tool; code keeps what is valid for the grid (known columns, AG Grid's own filter
// shapes, at most two sort and two group columns) and drops the rest. Answers are saved
// like investigations, so the example questions replay with no model quota.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { defaultModel, type AgentModel } from "./model";
import type { ChatEntry } from "./model/types";
import type { ToolDef } from "./paypal/gateway";

export type GridName = "disputes" | "outcomes";
type ColType = "text" | "number" | "date";
type Column = { id: string; type: ColType; label: string; values?: string[] };

export type TextFilter = { filterType: "text"; type: "contains" | "equals"; filter: string };
export type NumberFilter = { filterType: "number"; type: "greaterThan" | "lessThan" | "equals" | "inRange"; filter: number; filterTo?: number };
export type DateFilter = { filterType: "date"; type: "inRange" | "greaterThan" | "lessThan"; dateFrom: string; dateTo?: string };
export type GridFilter = TextFilter | NumberFilter | DateFilter;
export type GridView = {
  filterModel: Record<string, GridFilter>;
  sort: Array<{ colId: string; sort: "asc" | "desc" }>;
  rowGroup: string[];
  explanation: string;
};
export type GridAnswer = GridView & { replayed: boolean };

// The exact text the grids show (src/components/format.ts and Inbox.tsx / Insights.tsx),
// so the model filters on real values.
const CLAIMS = ["Not received", "Not as described", "Unauthorized", "Credit not processed", "Duplicate", "Incorrect amount", "Paid other way", "Canceled billing", "Remittance", "Other"];
const DECISIONS = ["Fight", "Partial refund", "Refund"];
const AGENT_STATUS = ["Not analyzed", "Analyzing", "Ready to review", "Evidence sent", "Offer sent", "Won", "Lost", "Settled", "Refunded", "Needs attention"];

export const GRID_COLUMNS: Record<GridName, Column[]> = {
  disputes: [
    { id: "buyer", type: "text", label: "Buyer name" },
    { id: "claim", type: "text", label: "Claim type", values: CLAIMS },
    { id: "stage", type: "text", label: "PayPal stage", values: ["Inquiry", "Chargeback", "Pre-arbitration", "Arbitration"] },
    { id: "amount", type: "number", label: "Disputed amount in USD" },
    { id: "priority", type: "text", label: "Priority: Urgent (3 days or less left), Soon (7 days or less) or blank", values: ["Urgent", "Soon"] },
    { id: "due", type: "number", label: "Days left to respond to PayPal (negative = overdue)" },
    { id: "agent", type: "text", label: "What the AI agent has done", values: AGENT_STATUS },
    { id: "decision", type: "text", label: "Decision recommended or sent", values: DECISIONS },
    { id: "status", type: "text", label: "Case status", values: AGENT_STATUS },
  ],
  outcomes: [
    { id: "buyer", type: "text", label: "Buyer name" },
    { id: "claim", type: "text", label: "Claim type", values: CLAIMS },
    { id: "amount", type: "number", label: "Disputed amount in USD" },
    { id: "decision", type: "text", label: "Decision sent", values: DECISIONS },
    { id: "by", type: "text", label: "Who answered PayPal", values: ["You", "Autopilot"] },
    { id: "result", type: "text", label: "How it ended", values: ["WON", "LOST", "REFUNDED", "SETTLED"] },
    { id: "kept", type: "number", label: "USD the seller kept" },
    { id: "refunded", type: "number", label: "USD refunded to the buyer" },
    { id: "closed", type: "date", label: "Date the dispute closed" },
  ],
};

export const NOTHING_VALID = "Ask about the disputes in this table.";
const MAX_SORT = 2;
const MAX_GROUP = 2;
const MAX_FILTERS = 6;

const TOOL_NAME = "set_grid_view";

function tool(grid: GridName): ToolDef {
  const ids = GRID_COLUMNS[grid].map((c) => c.id);
  return {
    name: TOOL_NAME,
    description: "Set the grid's filters, sort and row grouping to answer the seller's question. Call once.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["filters", "sort", "rowGroup", "explanation"],
      properties: {
        filters: {
          type: "array",
          description: "Column filters, all of which must match. Empty for none.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["colId", "type", "value", "valueTo"],
            properties: {
              colId: { type: "string", enum: ids },
              type: { type: "string", enum: ["contains", "equals", "greaterThan", "lessThan", "inRange"], description: "Text columns: contains or equals. Number and date columns: greaterThan, lessThan, equals or inRange." },
              value: { type: "string", description: "Text to match, a number (no $ sign), or a date as YYYY-MM-DD." },
              valueTo: { type: "string", description: "Upper bound for inRange, otherwise empty." },
            },
          },
        },
        sort: {
          type: "array",
          description: "At most two sort columns, most important first. Empty for the grid's default order.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["colId", "sort"],
            properties: { colId: { type: "string", enum: ids }, sort: { type: "string", enum: ["asc", "desc"] } },
          },
        },
        rowGroup: { type: "array", description: "At most two columns to group rows by, for questions like 'by claim type'. Empty for none.", items: { type: "string", enum: ids } },
        explanation: { type: "string", description: "One short sentence telling the seller what the grid now shows." },
      },
    },
  };
}

function system(grid: GridName): string {
  const cols = GRID_COLUMNS[grid]
    .map((c) => `- ${c.id} (${c.type}): ${c.label}${c.values ? `. Values: ${c.values.map((v) => `"${v}"`).join(", ")}` : ""}`)
    .join("\n");
  const what = grid === "disputes" ? "the seller's open and recent PayPal disputes" : "the seller's closed PayPal disputes and how each ended";
  return `You control an AG Grid table showing ${what}, for a small online shop. The seller asks a question in plain English. Answer it by calling ${TOOL_NAME} once with the filters, sort and grouping that make the table show the answer. Today is ${new Date().toISOString().slice(0, 10)}.

Columns (use these ids only):
${cols}

Rules:
- Filter text columns with one of the listed values exactly, using equals; use contains only for buyer names.
- Amounts are plain numbers in USD: "over $100" is amount greaterThan 100.
- "Biggest first" or "largest" sorts amount desc; "most urgent" or "due soonest" sorts due asc.
- "By <column>" or "per <column>" means group rows by that column.
- Use only the columns above. If the question is not about this table, call ${TOOL_NAME} with no filters, no sort, no grouping and say so in the explanation.
- The explanation is one plain sentence, under 25 words, describing what the table now shows.`;
}

// ---- Validation -----------------------------------------------------------------

type RawFilter = { colId?: unknown; type?: unknown; value?: unknown; valueTo?: unknown };

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v ?? "").replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
};

const day = (v: unknown): string | null => {
  const m = String(v ?? "").trim().match(/^(\d{4}-\d{2}-\d{2})/);
  if (!m || Number.isNaN(Date.parse(m[1]))) return null;
  return `${m[1]} 00:00:00`;
};

const nextDay = (d: string) => `${new Date(Date.parse(`${d.slice(0, 10)}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)} 00:00:00`;

// One filter in the AG Grid shape for its column type, or null when it can't be.
export function toFilter(col: Column, raw: RawFilter): GridFilter | null {
  const type = String(raw.type ?? "");
  if (col.type === "text") {
    let text = String(raw.value ?? "").trim().slice(0, 100);
    if (!text) return null;
    const known = col.values?.find((v) => v.toLowerCase() === text.toLowerCase());
    if (known) text = known;
    const t = type === "contains" ? "contains" : type === "equals" ? "equals" : null;
    if (!t) return null;
    return { filterType: "text", type: t, filter: text };
  }
  if (col.type === "number") {
    if (!["greaterThan", "lessThan", "equals", "inRange"].includes(type)) return null;
    const a = num(raw.value);
    if (a === null) return null;
    if (type === "inRange") {
      const b = num(raw.valueTo);
      if (b === null) return null;
      return { filterType: "number", type: "inRange", filter: Math.min(a, b), filterTo: Math.max(a, b) };
    }
    return { filterType: "number", type: type as NumberFilter["type"], filter: a };
  }
  const from = day(raw.value);
  if (!from) return null;
  if (type === "greaterThan" || type === "lessThan") return { filterType: "date", type, dateFrom: from };
  if (type === "equals") return { filterType: "date", type: "inRange", dateFrom: from, dateTo: nextDay(from) };
  if (type === "inRange") {
    const to = day(raw.valueTo);
    if (!to) return null;
    return from <= to ? { filterType: "date", type: "inRange", dateFrom: from, dateTo: to } : { filterType: "date", type: "inRange", dateFrom: to, dateTo: from };
  }
  return null;
}

// Keeps only what this grid can apply. Accepts either the tool's array of filters or a
// filterModel object (a saved answer), so both pass the same checks.
export function validateView(grid: GridName, input: unknown): GridView | null {
  const o = (input ?? {}) as Record<string, unknown>;
  const cols = new Map(GRID_COLUMNS[grid].map((c) => [c.id, c]));
  const filterModel: Record<string, GridFilter> = {};
  const raws: RawFilter[] = Array.isArray(o.filters)
    ? (o.filters as RawFilter[])
    : o.filterModel && typeof o.filterModel === "object"
      ? Object.entries(o.filterModel as Record<string, any>).map(([colId, f]) => ({ colId, type: f?.type, value: f?.filter ?? f?.dateFrom, valueTo: f?.filterTo ?? f?.dateTo }))
      : [];
  for (const raw of raws) {
    if (Object.keys(filterModel).length >= MAX_FILTERS) break;
    const col = cols.get(String(raw?.colId ?? ""));
    if (!col || filterModel[col.id]) continue;
    const f = toFilter(col, raw);
    if (f) filterModel[col.id] = f;
  }
  const sort: GridView["sort"] = [];
  for (const s of Array.isArray(o.sort) ? (o.sort as Array<Record<string, unknown>>) : []) {
    const id = String(s?.colId ?? "");
    if (!cols.has(id) || sort.some((x) => x.colId === id) || (s?.sort !== "asc" && s?.sort !== "desc")) continue;
    sort.push({ colId: id, sort: s.sort });
    if (sort.length >= MAX_SORT) break;
  }
  const rowGroup: string[] = [];
  for (const g of Array.isArray(o.rowGroup) ? o.rowGroup : []) {
    const id = String(g ?? "");
    if (!cols.has(id) || rowGroup.includes(id)) continue;
    rowGroup.push(id);
    if (rowGroup.length >= MAX_GROUP) break;
  }
  if (!Object.keys(filterModel).length && !sort.length && !rowGroup.length) return null;
  const explanation = String(o.explanation ?? "").replace(/\s+/g, " ").trim().slice(0, 240) || describe(filterModel, sort, rowGroup);
  return { filterModel, sort, rowGroup, explanation };
}

function describe(f: GridView["filterModel"], sort: GridView["sort"], group: string[]): string {
  const parts = [
    ...Object.entries(f).map(([id, x]) => `${id} ${"filter" in x ? `${x.type} ${x.filter}` : `${x.type} ${x.dateFrom.slice(0, 10)}`}`),
    ...sort.map((s) => `sorted by ${s.colId} ${s.sort === "desc" ? "high to low" : "low to high"}`),
    ...(group.length ? [`grouped by ${group.join(" and ")}`] : []),
  ];
  return `Showing disputes with ${parts.join(", ")}.`;
}

// ---- Saved answers --------------------------------------------------------------

export const normalizeQuestion = (q: string) => q.toLowerCase().trim().replace(/\s+/g, " ");

const dir = () => path.join(process.env.REBUTTAL_CACHE_DIR ?? path.join(process.cwd(), "cache", "investigations"), "..", "grid-ask");
export const answerKey = (grid: GridName, question: string) => crypto.createHash("sha256").update(`${grid}\n${normalizeQuestion(question)}`).digest("hex").slice(0, 16);

type SavedAnswer = { key: string; grid: GridName; question: string; saved_at: string; model: string; view: GridView };

export function savedAnswer(grid: GridName, question: string): GridAnswer | null {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(dir(), `${answerKey(grid, question)}.json`), "utf8")) as SavedAnswer;
    if (saved.grid !== grid) return null;
    // Saved answers pass the same checks as live ones.
    const view = validateView(grid, saved.view);
    return view ? { ...view, replayed: true } : null;
  } catch {
    return null;
  }
}

function saveAnswer(grid: GridName, question: string, model: string, view: GridView) {
  const entry: SavedAnswer = { key: answerKey(grid, question), grid, question: normalizeQuestion(question), saved_at: new Date().toISOString(), model, view };
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(path.join(dir(), `${entry.key}.json`), JSON.stringify(entry, null, 2));
  } catch (e) {
    console.warn("Could not save grid answer:", e instanceof Error ? e.message : e);
  }
}

// ---- The model turn -------------------------------------------------------------

export class GridAskError extends Error {
  constructor(message: string, readonly status: 400 | 502) {
    super(message);
  }
}

// Asks the model once (plus one nudge if it answers without the tool). Throws
// GridAskError(400) when nothing valid is left, GridAskError(502) when the model fails;
// a rate limit from defaultModel() is left to the caller (LiveLimitError, 429).
export async function askGrid(grid: GridName, question: string, opts: { model?: AgentModel; save?: boolean } = {}): Promise<GridAnswer> {
  const model = opts.model ?? defaultModel();
  const history: ChatEntry[] = [{ role: "user", text: question.trim() }];
  const def = tool(grid);
  for (let turn = 0; turn < 2; turn++) {
    const res = await model.next({ system: system(grid), tools: [def], history });
    const call = res.calls.find((c) => c.name === TOOL_NAME);
    if (call) {
      const view = validateView(grid, call.input);
      if (!view) throw new GridAskError(NOTHING_VALID, 400);
      if (opts.save ?? !opts.model) saveAnswer(grid, question, `${model.provider}:${model.model}`, view);
      return { ...view, replayed: false };
    }
    if (res.stop === "refusal") break;
    history.push({ role: "assistant", turn: res }, { role: "user", text: `Call ${TOOL_NAME} now.` });
  }
  throw new GridAskError("The AI couldn't turn that into a table view. Try rephrasing, or use one of the example questions.", 502);
}
