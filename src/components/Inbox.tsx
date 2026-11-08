"use client";

import type { ColDef, ColumnState, DefaultMenuItem, GetContextMenuItemsParams, GridApi, ICellRendererParams, IRowNode, MenuItemDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { forPhone, usePhone } from "./phone";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AutopilotRules, CaseRecord } from "@/lib/types";
import { AlertsFeed } from "./AutopilotPanel";
import { useCases } from "./CasesProvider";
import { useGridEnterprise } from "./gridEnterprise";
import WelcomeTour from "./WelcomeTour";
import Link from "next/link";
import { chunk, daysLeft, DECISION_COLOR, DECISION_LABEL, money, priorityOf, REASON_LABEL, statusLabel } from "./format";
import { gridTheme } from "./grid";
import { Badge, BUTTON, Card, Empty, Kpi } from "./ui";


// The pinned bottom row carries totals for whatever rows the search and filters leave visible.
type Totals = { count: number; atRisk: number; kept: number; refunded: number };
// A detail row is a full-width copy of its case, placed right under it, that shows the
// agent's reasoning. It carries the case's own values so it passes the same filters.
type Row = CaseRecord & { totals?: Totals; detail?: true };
const isDetail = (n?: IRowNode<Row> | null) => Boolean(n?.data?.detail);
const COL_STATE_KEY = "rebuttal.inbox.columns.v1";

const STAGE_LABEL: Record<string, string> = { INQUIRY: "Inquiry", CHARGEBACK: "Chargeback", PRE_ARBITRATION: "Pre-arbitration", ARBITRATION: "Arbitration" };
const stageOf = (c?: CaseRecord) => (c?.dispute ? STAGE_LABEL[c.dispute.dispute_life_cycle_stage] ?? c.dispute.dispute_life_cycle_stage : undefined);

function totalsOf(rows: CaseRecord[]): Totals {
  const amt = (c: CaseRecord) => Number(c.dispute.dispute_amount.value);
  return {
    count: rows.length,
    atRisk: rows.filter((c) => !c.outcome).reduce((s, c) => s + amt(c), 0),
    kept: rows.reduce((s, c) => s + (c.outcome?.amount_kept ?? 0), 0),
    refunded: rows.reduce((s, c) => s + (c.outcome?.amount_lost ?? 0), 0),
  };
}

function TotalsLabel({ data }: ICellRendererParams<Row>) {
  return <span className="font-semibold">{data?.totals?.count ?? 0} shown</span>;
}
function TotalsAmount({ data }: ICellRendererParams<Row>) {
  return (
    <div className="flex h-full flex-col items-end justify-center leading-tight">
      <span className="tabular font-semibold">{money(data?.totals?.atRisk ?? 0)}</span>
      <span className="text-xs text-muted">at risk</span>
    </div>
  );
}
function TotalsOutcome({ data }: ICellRendererParams<Row>) {
  const t = data?.totals;
  return (
    <div className="flex h-full items-center gap-4 text-sm tabular">
      <span className="font-semibold" style={{ color: "var(--fight)" }}>{money(t?.kept ?? 0)} kept</span>
      <span className="text-muted">{money(t?.refunded ?? 0)} refunded</span>
    </div>
  );
}
const pinned = (component: (p: ICellRendererParams<Row>) => React.ReactNode) => (p: ICellRendererParams<Row>) =>
  p.node.rowPinned ? { component } : undefined;
const blank = () => null;

function BuyerCell({ data }: ICellRendererParams<Row>) {
  const t = data?.dispute.disputed_transactions[0];
  const shops = useCases().data?.network?.[data?.id ?? ""];
  return (
    <div className="flex h-full w-full min-w-0 flex-col justify-center leading-tight">
      <span className="font-medium">
        {t?.buyer?.name ?? "Unknown buyer"}
        {shops ? (
          <span title={`Reported by ${shops} other Rebuttal shop${shops === 1 ? "" : "s"}. See Protect.`} className="ml-1.5 inline-block whitespace-nowrap rounded-full px-1.5 align-middle text-[10px] font-semibold leading-4" style={{ color: "var(--danger)", border: "1px solid currentColor" }}>
            Network: {shops}
          </span>
        ) : null}
      </span>
      <span className="block w-0 min-w-full truncate text-xs text-muted">{t?.items?.[0]?.item_description ?? t?.invoice_number}</span>
      {/* Phones hide the Due in column, so the deadline rides along under the name. */}
      {data ? (
        <span className="text-xs sm:hidden">
          <DueCell {...({ data } as ICellRendererParams<Row>)} />
        </span>
      ) : null}
    </div>
  );
}

function ReasonCell({ data }: ICellRendererParams<Row>) {
  return data?.dispute ? <span>{REASON_LABEL[data.dispute.reason]}</span> : null;
}

function DueCell({ data }: ICellRendererParams<Row>) {
  if (!data) return null;
  if (data.outcome || data.submitted) return <span className="text-muted">Responded</span>;
  const d = daysLeft(data.dispute.seller_response_due_date);
  if (d === null) return <span className="text-muted">-</span>;
  return <span className="tabular font-medium" style={{ color: d <= 3 ? "var(--danger)" : undefined }}>{d <= 0 ? "Overdue" : `${d} day${d === 1 ? "" : "s"}`}</span>;
}

function PriorityCell({ data }: ICellRendererParams<Row>) {
  const p = data?.dispute ? priorityOf(data) : null;
  if (!p?.label) return null;
  return (
    <Badge tone={p.label === "Urgent" ? "bad" : "warn"}>{p.label}</Badge>
  );
}

function ExpandCell({ data, context }: ICellRendererParams<Row>) {
  if (!data || data.detail) return null;
  const open = (context as GridContext).expanded.has(data.id);
  return (
    <button
      aria-label={open ? "Hide the agent's reasoning" : "Show the agent's reasoning"}
      aria-expanded={open}
      onClick={(e) => {
        e.stopPropagation();
        (context as GridContext).toggle(data.id);
      }}
      className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-accent-soft hover:text-ink"
    >
      <span className="inline-block transition-transform" style={{ transform: open ? "rotate(90deg)" : undefined }}>▶</span>
    </button>
  );
}

type GridContext = { expanded: Set<string>; toggle: (id: string) => void };

// Full-width row under a case: what the agent found, without opening the case.
function DetailRow({ data }: ICellRendererParams<Row>) {
  if (!data) return null;
  const r = data.recommendation;
  const factors = r?.factors ?? [];
  return (
    <div className="flex h-full gap-6 overflow-auto whitespace-normal border-l-4 bg-bg px-6 py-3 text-sm leading-normal" style={{ borderColor: r ? DECISION_COLOR[data.submitted?.decision ?? r.decision] : "var(--line)" }}>
      {r ? (
        <>
          <div className="w-96 min-w-0 shrink-0 space-y-1">
            <p className="font-medium leading-snug">{r.headline}</p>
            <p className="text-xs text-muted">
              {DECISION_LABEL[r.decision]}
              {r.decision === "OFFER" ? ` of ${money(r.offer_amount)}` : ""} · {Math.round(r.win_probability * 100)}% win estimate · {r.evidence.length} evidence item{r.evidence.length === 1 ? "" : "s"}
            </p>
            {data.autopilot ? <p className="text-xs text-muted">Autopilot: {data.autopilot.reason}</p> : null}
            {data.negotiation ? (
              <p className="text-xs text-muted">
                Negotiation: {data.negotiation.status.replaceAll("_", " ").toLowerCase()}, {data.negotiation.turns.length} messages, ceiling {money(data.negotiation.max_refund)}
              </p>
            ) : null}
          </div>
          <ul className="min-w-0 flex-1 space-y-1">
            {factors.slice(0, 4).map((f, i) => (
              <li key={i} className="flex gap-2 leading-snug">
                <span className="shrink-0 font-semibold" style={{ color: f.favors === "SELLER" ? "var(--fight)" : "var(--danger)" }}>{f.favors === "SELLER" ? "For you" : "For buyer"}</span>
                <span className="truncate" title={f.finding}>{f.finding}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="self-center text-muted">{data.status === "ANALYZING" ? "The agent is investigating this dispute now." : "Not investigated yet. Open the dispute and the agent starts right away."}</p>
      )}
      <Link href={`/cases/${data.id}`} className="shrink-0 self-center rounded-md border border-line px-3 py-1.5 text-sm hover:border-accent">
        Open dispute
      </Link>
    </div>
  );
}

// The one thing the seller should do next on this dispute.
function NextStepCell({ data }: ICellRendererParams<Row>) {
  if (!data) return null;
  const go = (label: string, primary = false) => (
    <Link href={`/cases/${data.id}`} className={primary ? BUTTON.primary : BUTTON.secondary}>
      {label}
    </Link>
  );
  if (data.outcome) return go("View");
  if (data.status === "ANALYZING") return <span className="text-xs text-muted">Agent working...</span>;
  if (data.submitted) return go("Track");
  if (data.status === "READY") return go("Review", true);
  if (data.status === "ERROR") return go("Retry", true);
  return go("Investigate", true);
}

function AgentCell({ data }: ICellRendererParams<Row>) {
  if (!data) return null;
  const r = data.recommendation;
  const decided = data.submitted?.decision ?? r?.decision;
  return (
    <div className="flex h-full items-center gap-3">
      {data.submitted?.by === "autopilot" ? (
        <Badge tone="info" title={data.autopilot?.reason}>Autopilot</Badge>
      ) : null}
      {decided ? (
        <span className="rounded-full px-2.5 py-0.5 text-xs font-semibold" style={{ color: DECISION_COLOR[decided], border: `1px solid ${DECISION_COLOR[decided]}` }}>
          {DECISION_LABEL[decided]}
        </span>
      ) : null}
      <span className="text-sm text-muted">{statusLabel(data)}</span>
      {r && !data.outcome ? (
        <span className="ml-auto flex items-center gap-1.5 text-xs text-muted tabular" title="Estimated chance PayPal rules for the seller">
          <span className="inline-block h-1.5 w-14 overflow-hidden rounded-full bg-line">
            <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.round(r.win_probability * 100)}%` }} />
          </span>
          {Math.round(r.win_probability * 100)}%
        </span>
      ) : null}
      {data.outcome ? (
        <span className="ml-auto text-xs font-semibold tabular" style={{ color: data.outcome.amount_kept > 0 ? "var(--fight)" : "var(--refund)" }}>
          {data.outcome.amount_kept > 0 ? `+${money(data.outcome.amount_kept)} kept` : `${money(data.outcome.amount_lost)} refunded`}
        </span>
      ) : null}
    </div>
  );
}

// Mirrors bulkBlocker in lib/bulk.ts, so the bar only offers what the server will accept.
// The server checks again; this only decides what the button says.
function bulkBlocker(c: CaseRecord, rules: AutopilotRules | null): string | null {
  if (c.submitted || c.outcome) return "already answered";
  if (c.status !== "READY" || !c.recommendation) return "not investigated";
  if (rules && Number(c.dispute.dispute_amount.value) > rules.max_auto_amount) return `over your $${rules.max_auto_amount} cap`;
  if (c.recommendation.decision === "OFFER") return "offers need an amount";
  if (c.trace.some((s) => s.kind === "error")) return "a lookup failed";
  return null;
}

// Shown above the queue while rows are ticked: investigate the new ones, or approve the
// agent's recommended refunds and evidence in one go.
function BulkBar({ selected, rules, viewOnly, onDone, clear }: { selected: CaseRecord[]; rules: AutopilotRules | null; viewOnly: boolean; onDone: (msg: string) => void; clear: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  // `selected` is rebuilt on every poll; only reset the confirm step when the ticked
  // disputes actually change, or a poll between the two clicks undoes the first one.
  const selectedKey = selected.map((c) => c.id).join(",");
  useEffect(() => setConfirm(false), [selectedKey]);
  const fresh = selected.filter((c) => c.status === "NEW" || c.status === "ERROR");
  const ready = selected.filter((c) => !bulkBlocker(c, rules));
  const blocked = selected.filter((c) => bulkBlocker(c, rules) && !fresh.includes(c));
  const sum = (xs: CaseRecord[]) => xs.reduce((t, c) => t + Number(c.dispute.dispute_amount.value), 0);
  const refunds = ready.filter((c) => c.recommendation?.decision === "REFUND");

  async function investigate() {
    setBusy("investigate");
    // Saved investigations replay in a few seconds each; run them side by side.
    await Promise.all(fresh.map((c) => fetch(`/api/cases/${c.id}/analyze`, { method: "POST" }).then((r) => r.text()).catch(() => null)));
    setBusy(null);
    onDone(`Investigated ${fresh.length} dispute${fresh.length === 1 ? "" : "s"}.`);
  }
  async function approveAll() {
    if (!confirm) return setConfirm(true);
    setBusy("approve");
    // The server takes at most 25 per request (BULK_MAX), so send larger selections in batches.
    const j = { approved: [] as unknown[], skipped: [] as unknown[], failed: [] as unknown[] };
    let error: string | null = null;
    for (const ids of chunk(ready.map((c) => c.id), 25)) {
      const res = await fetch("/api/cases/bulk-approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
      const part = await res.json().catch(() => ({}));
      if (!res.ok) {
        error = part.error ?? "Bulk approve failed.";
        break;
      }
      j.approved.push(...part.approved);
      j.skipped.push(...part.skipped);
      j.failed.push(...part.failed);
    }
    setBusy(null);
    setConfirm(false);
    if (error && !j.approved.length) return onDone(error);
    const parts = [`Sent ${j.approved.length} response${j.approved.length === 1 ? "" : "s"} to PayPal`];
    if (j.skipped.length) parts.push(`${j.skipped.length} skipped`);
    if (j.failed.length) parts.push(`${j.failed.length} paused: open them to see why`);
    if (error) parts.push(`the rest stopped: ${error}`);
    clear();
    onDone(parts.join(", ") + ".");
  }

  return (
    <div role="region" aria-label="Bulk actions" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--accent)", background: "var(--accent-soft)" }}>
      <span className="font-semibold">{selected.length} selected · {money(sum(selected))}</span>
      {fresh.length ? (
        <button onClick={investigate} disabled={busy !== null || viewOnly} className={BUTTON.secondary}>
          {busy === "investigate" ? "Investigating..." : `Investigate ${fresh.length}`}
        </button>
      ) : null}
      <button onClick={approveAll} disabled={!ready.length || busy !== null || viewOnly} className={BUTTON.primary}>
        {busy === "approve"
          ? "Sending..."
          : confirm
            ? `Confirm: send ${ready.length} to PayPal (${money(sum(ready))})`
            : `Approve ${ready.length} recommended response${ready.length === 1 ? "" : "s"}`}
      </button>
      <span className="text-xs text-muted">
        {ready.length ? `${refunds.length} refund${refunds.length === 1 ? "" : "s"}, ${ready.length - refunds.length} with evidence. ` : ""}
        {blocked.length ? `${blocked.length} need${blocked.length === 1 ? "s" : ""} you: ${[...new Set(blocked.map((c) => bulkBlocker(c, rules)))].join(", ")}.` : `Never above your $${rules?.max_auto_amount ?? 250} cap, never offers.`}
      </span>
      <button onClick={clear} className={`${BUTTON.ghost} ml-auto`}>Clear</button>
    </div>
  );
}

export default function Inbox() {
  const router = useRouter();
  const { data, error, rules, reload, switchMode } = useCases();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Read the ticked disputes from the latest data, so the bar follows autopilot and PayPal.
  const selected = useMemo(() => (data?.cases ?? []).filter((c) => selectedIds.includes(c.id) && !c.submitted && !c.outcome), [data, selectedIds]);
  const [flash, setFlash] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [totals, setTotals] = useState<Totals | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const grid = useRef<AgGridReact<Row>>(null);

  const toggle = useCallback((id: string) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const context = useMemo<GridContext>(() => ({ expanded, toggle }), [expanded, toggle]);
  // The chevrons read `expanded` from the grid context, so redraw them when it changes.
  useEffect(() => {
    grid.current?.api?.refreshCells({ columns: ["expand"], force: true });
  }, [expanded]);

  const rows = useMemo<Row[]>(
    () => (data?.cases ?? []).filter((c) => !c.history).flatMap((c) => (expanded.has(c.id) ? [c, { ...c, id: `${c.id}:detail`, detail: true as const }] : [c])),
    [data, expanded],
  );

  const refreshTotals = useCallback((api: GridApi<Row>) => {
    const visible: CaseRecord[] = [];
    api.forEachNodeAfterFilter((n) => n.data && !n.data.detail && visible.push(n.data));
    const next = totalsOf(visible);
    // Only update on a real change, so setting the pinned row can't loop back here.
    setTotals((cur) => (cur && JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
  }, []);


  const phone = usePhone();
  const cols = useMemo<ColDef<Row>[]>(
    () => [
      {
        colId: "expand",
        headerName: "",
        width: 52,
        minWidth: 52,
        maxWidth: 52,
        resizable: false,
        sortable: false,
        suppressMovable: true,
        lockPosition: "left",
        cellRenderer: ExpandCell,
        cellRendererSelector: pinned(blank),
      },
      { colId: "id", headerName: "Dispute ID", hide: true, valueGetter: (p) => p.data?.id },
      {
        colId: "buyer",
        headerName: "Buyer",
        cellRenderer: BuyerCell,
        cellRendererSelector: pinned(TotalsLabel),
        flex: 1.6,
        minWidth: 170,
        valueGetter: (p) => p.data?.dispute?.disputed_transactions[0]?.buyer?.name,
        getQuickFilterText: (p) => {
          const t = p.data?.dispute?.disputed_transactions[0];
          return [t?.buyer?.name, t?.items?.[0]?.item_description, t?.invoice_number, p.data?.id].filter(Boolean).join(" ");
        },
      },
      {
        colId: "claim",
        headerName: "Claim",
        cellRenderer: ReasonCell,
        cellRendererSelector: pinned(blank),
        flex: 0.9,
        minWidth: 120,
        valueGetter: (p) => p.data?.dispute && REASON_LABEL[p.data.dispute.reason],
        filter: "agTextColumnFilter",
        floatingFilter: true,
      },
      {
        colId: "stage",
        headerName: "Stage",
        flex: 0.7,
        minWidth: 92,
        valueGetter: (p) => stageOf(p.data),
        cellRendererSelector: pinned(blank),
        filter: "agTextColumnFilter",
        floatingFilter: true,
        cellClass: "text-muted",
      },
      {
        colId: "amount",
        headerName: "Amount",
        flex: 0.8,
        minWidth: 100,
        type: "rightAligned",
        valueGetter: (p) => (p.data?.dispute ? Number(p.data.dispute.dispute_amount.value) : undefined),
        valueFormatter: (p) => (p.value == null ? "" : money(p.value)),
        cellRendererSelector: pinned(TotalsAmount),
        cellClass: "tabular font-medium justify-end",
        filter: "agNumberColumnFilter",
        floatingFilter: true,
      },
      {
        colId: "priority",
        headerName: "Priority",
        headerTooltip: "Open disputes ranked by money at risk and days left to respond",
        cellRenderer: PriorityCell,
        cellRendererSelector: pinned(blank),
        flex: 0.6,
        minWidth: 96,
        valueGetter: (p) => (p.data?.dispute ? priorityOf(p.data).score : undefined),
        sort: "desc",
      },
      {
        colId: "due",
        headerName: "Due in",
        cellRenderer: DueCell,
        cellRendererSelector: pinned(blank),
        flex: 0.8,
        minWidth: 96,
        valueGetter: (p) => (p.data?.submitted ? 999 : daysLeft(p.data?.dispute?.seller_response_due_date)),
      },
      {
        colId: "agent",
        headerName: "Agent",
        cellRenderer: AgentCell,
        cellRendererSelector: pinned(TotalsOutcome),
        // Autopilot and PayPal change these on their own; flash the cell so the seller notices.
        enableCellChangeFlash: true,
        flex: 1.8,
        minWidth: 220,
        valueGetter: (p) => (p.data?.dispute ? statusLabel(p.data) : undefined),
      },
      {
        colId: "next",
        headerName: "Next step",
        width: 120,
        minWidth: 120,
        sortable: false,
        cellRenderer: NextStepCell,
        cellRendererSelector: pinned(blank),
      },
      // Export-only columns for the outcomes CSV (Insights exports the same data).
      { colId: "decision", headerName: "Decision", hide: true, valueGetter: (p) => { const d = p.data?.submitted?.decision ?? p.data?.recommendation?.decision; return d ? DECISION_LABEL[d] : ""; } },
      { colId: "status", headerName: "Status", hide: true, valueGetter: (p) => (p.data?.dispute ? statusLabel(p.data) : "") },
      // Export-only columns: plain numbers so the CSV adds up in a spreadsheet. Open cases count as 0 kept and 0 refunded.
      { colId: "amountUsd", headerName: "Amount (USD)", hide: true, valueGetter: (p) => (p.data?.dispute ? Number(p.data.dispute.dispute_amount.value) : "") },
      { colId: "kept", headerName: "Kept (USD)", hide: true, valueGetter: (p) => p.data?.outcome?.amount_kept ?? 0 },
      { colId: "refunded", headerName: "Refunded (USD)", hide: true, valueGetter: (p) => p.data?.outcome?.amount_lost ?? 0 },
      {
        colId: "win",
        headerName: "AI win estimate",
        hide: true,
        // A refund isn't a bet on PayPal's ruling, so it has no win estimate.
        valueGetter: (p) => {
          const r = p.data?.recommendation;
          if (!r || (p.data?.submitted?.decision ?? r.decision) === "REFUND") return "";
          return `${Math.round(r.win_probability * 100)}%`;
        },
      },
    ],
    [],
  );
  // Phones keep Buyer (with the days left under the name), Amount and Next step; the rest
  // are on the dispute page.
  const phoneCols = useMemo(() => forPhone(cols, phone, ["expand", "claim", "stage", "priority", "agent", "due"], ["next"]), [cols, phone]);


  // Keep the seller's column layout (order, widths, sort) between visits.
  const saveColumns = useCallback((api: GridApi<Row>) => {
    try {
      localStorage.setItem(COL_STATE_KEY, JSON.stringify(api.getColumnState()));
    } catch {}
  }, []);
  const restoreColumns = useCallback((api: GridApi<Row>) => {
    try {
      const raw = localStorage.getItem(COL_STATE_KEY);
      if (raw) api.applyColumnState({ state: JSON.parse(raw) as ColumnState[], applyOrder: true });
    } catch {}
  }, []);

  const s = data?.stats;
  const auto = rules?.enabled;

  // Enterprise only (with AG_GRID_LICENSE_KEY): right-click a dispute to open it,
  // investigate it or tick it for bulk approve, and a status bar with row counts.
  const enterprise = useGridEnterprise();
  const viewOnly = Boolean(data?.viewOnly);
  const enterpriseProps = enterprise
    ? {
        statusBar: {
          statusPanels: [
            { statusPanel: "agTotalAndFilteredRowCountComponent", align: "left" as const },
            { statusPanel: "agSelectedRowCountComponent", align: "right" as const },
          ],
        },
        getContextMenuItems: (p: GetContextMenuItemsParams<Row>) => {
          const c = p.node?.data;
          if (!c || c.detail || c.totals) return ["copy", "separator", "excelExport", "csvExport"] as DefaultMenuItem[];
          const open = !c.submitted && !c.outcome;
          const items: (DefaultMenuItem | MenuItemDef<Row>)[] = [
            { name: "Open this dispute", action: () => router.push(`/cases/${c.id}`) },
            {
              name: c.status === "NEW" || c.status === "ERROR" ? "Investigate now" : "Re-investigate",
              disabled: viewOnly || !open || c.status === "ANALYZING",
              action: () => {
                setFlash(`Investigating ${c.dispute.disputed_transactions[0]?.buyer?.name ?? c.id}...`);
                fetch(`/api/cases/${c.id}/analyze`, { method: "POST" })
                  .then((r) => r.text())
                  .catch(() => null)
                  .finally(() => {
                    setFlash("Investigation finished.");
                    reload();
                  });
              },
            },
            {
              name: "Tick for bulk approve",
              disabled: viewOnly || !p.node?.selectable || p.node?.isSelected(),
              action: () => p.node?.setSelected(true),
            },
            "separator",
            "copy",
            "excelExport",
            "csvExport",
          ];
          return items;
        },
      }
    : {};

  return (
    <div className="space-y-5">
      <WelcomeTour />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Disputes</h1>
        <p className="text-sm text-muted">The agent investigates each dispute as PayPal reports it and ranks them by money and deadline. Nothing goes to PayPal without your approval, except what your autopilot rules allow.</p>
      </div>
      {data ? (
        <p className="text-xs text-muted">
          {data.mode === "mock"
            ? "Simulator: your own private copy of the shop. It answers like PayPal's Disputes, Orders and Tracking APIs, with the same dispute states and payloads. AI investigations are real Gemini runs, replayed to stay within the free tier."
            : `Live PayPal sandbox: real disputes from api-m.sandbox.paypal.com, read and answered through the PayPal Agent Toolkit and Disputes API.${data.viewOnly ? " View-only on the hosted demo." : ""}`}
        </p>
      ) : null}
      {data?.mode === "sandbox" && data.stats && data.stats.open === 0 ? (
        <Empty
          title={data.cases.length ? "No open disputes in the PayPal sandbox right now" : "The PayPal sandbox has no disputes yet"}
          action={{ label: "Try the full flow in the Simulator", onClick: () => switchMode("mock") }}
        >
          {data.cases.length ? "The rows below are real sandbox disputes that PayPal has already closed. " : ""}
          A new one appears here when a sandbox buyer files a dispute: PayPal sends the webhook, the agent investigates it and autopilot acts within your rules.
          Sandbox disputes can take a few minutes to show up.
        </Empty>
      ) : null}
      {error ? <p className="rounded-md border border-danger px-3 py-2 text-sm text-danger">{error}</p> : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-tour="kpis">
        <Kpi label="Money at risk" value={s ? money(s.at_risk) : "-"} sub={s ? `${s.open} open dispute${s.open === 1 ? "" : "s"}` : undefined} />
        <Kpi label="Due within 3 days" value={s ? String(s.due_soon) : "-"} sub={s?.due_soon ? `${money(s.due_soon_amount)} at stake` : "Nothing urgent"} tone={s?.due_soon ? "bad" : undefined} />
        <Kpi label="Money protected" value={s ? money(s.kept) : "-"} tone="good" sub={s?.rulings ? `Won ${s.won} of ${s.rulings} PayPal ruling${s.rulings === 1 ? "" : "s"}` : "No PayPal rulings yet"} />
        <Kpi label="Autopilot" value={rules ? (auto ? "On" : "Off") : "-"} tone={auto ? "good" : "neutral"} sub={s ? `Handled ${s.autopilot} of ${s.answered} responses` : undefined} />
      </div>

      <Card title="Latest alerts" subtitle="PayPal webhooks and what autopilot did with them." right={<Link href="/insights" className="text-xs text-accent underline">Full history</Link>}>
        <AlertsFeed cases={data?.cases ?? []} mode={data?.mode} limit={3} />
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search buyer, item, claim or status"
          aria-label="Search disputes"
          className="w-full max-w-sm rounded-md border border-line bg-panel px-3 py-2 text-sm"
        />
        <span className="text-xs text-muted">Tick rows to act on several at once. Click ▶ for the agent&apos;s reasoning, or a row to open it.</span>
      </div>

      {flash ? <p role="status" className="text-sm" style={{ color: "var(--fight)" }}>{flash}</p> : null}
      {selected.length ? (
        <BulkBar
          selected={selected}
          rules={rules}
          viewOnly={Boolean(data?.viewOnly)}
          clear={() => grid.current?.api.deselectAll()}
          onDone={(msg) => {
            setFlash(msg);
            reload();
          }}
        />
      ) : null}

      <div data-tour="grid">
        <AgGridReact<Row>
          // Remount when Enterprise switches on: the status bar is set when the grid starts.
          key={enterprise ? "enterprise" : "community"}
          {...enterpriseProps}
          ref={grid}
          theme={gridTheme}
          rowHeight={64}
          domLayout="autoHeight"
          rowData={rows}
          context={context}
          isFullWidthRow={(p) => isDetail(p.rowNode)}
          fullWidthCellRenderer={DetailRow}
          getRowHeight={(p) => (isDetail(p.node) ? 132 : undefined)}
          // Keep each detail row right under its case, whatever the sort.
          postSortRows={(p) => {
            const details = new Map<string, IRowNode<Row>>();
            for (const n of p.nodes) if (n.data?.detail) details.set(n.data.id, n);
            if (!details.size) return;
            const ordered = p.nodes.filter((n) => !n.data?.detail).flatMap((n) => {
              const d = n.data && details.get(`${n.data.id}:detail`);
              return d ? [n, d] : [n];
            });
            p.nodes.splice(0, p.nodes.length, ...ordered);
          }}
          onGridReady={(e) => restoreColumns(e.api)}
          onColumnMoved={(e) => e.finished && saveColumns(e.api)}
          onColumnResized={(e) => e.finished && saveColumns(e.api)}
          onSortChanged={(e) => saveColumns(e.api)}
          columnDefs={phoneCols}
          quickFilterText={search}
          // The id changes with the numbers so AG Grid redraws the pinned row.
          pinnedBottomRowData={totals ? [{ id: `totals-${JSON.stringify(totals)}`, totals } as Row] : []}
          getRowId={(p) => p.data.id}
          // The chevron and the detail row's own link handle their clicks; AG Grid still reports them as row clicks.
          // Community row selection: checkboxes only on open disputes the seller can act on.
          rowSelection={{
            mode: "multiRow",
            checkboxes: true,
            headerCheckbox: true,
            selectAll: "filtered",
            hideDisabledCheckboxes: true,
            enableClickSelection: false,
            isRowSelectable: (n) => Boolean(n.data && !n.data.detail && !n.data.totals && !n.data.submitted && !n.data.outcome && n.data.status !== "ANALYZING"),
          }}
          selectionColumnDef={{ width: 48, minWidth: 48, maxWidth: 48, pinned: "left", resizable: false, suppressMovable: true }}
          onSelectionChanged={(e) => {
            const picked = e.api.getSelectedRows().filter((r) => !r.detail).map((r) => r.id);
            setSelectedIds((cur) => (cur.join() === picked.join() ? cur : picked));
          }}
          onRowClicked={(e) => {
            const fromControl = (e.event?.target as HTMLElement | null)?.closest("button, a, input, .ag-selection-checkbox");
            if (e.data && !e.node.rowPinned && !e.data.detail && !fromControl) router.push(`/cases/${e.data.id}`);
          }}
          getRowClass={(p) => (p.node.rowPinned ? "font-medium" : isDetail(p.node) ? undefined : "cursor-pointer")}
          defaultColDef={{ cellStyle: { display: "flex", alignItems: "center" } }}
          onRowDataUpdated={(e) => refreshTotals(e.api)}
          onFilterChanged={(e) => refreshTotals(e.api)}
          overlayNoRowsTemplate={data?.mode === "sandbox" ? "No disputes in the PayPal sandbox yet." : "No disputes yet. Open Simulator tools to file a test dispute."}
          suppressCellFocus
        />
      </div>
    </div>
  );
}

