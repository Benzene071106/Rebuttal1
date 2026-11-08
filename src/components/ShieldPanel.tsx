"use client";

import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { forPhone, usePhone } from "./phone";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ShieldRow } from "@/lib/shield";
import { money } from "./format";
import { gridTheme } from "./grid";

const RISK_COLOR = { HIGH: "var(--danger)", MEDIUM: "var(--offer)", LOW: "var(--fight)" } as const;

type ShieldGridRow = ShieldRow & { detail?: true };
type Ctx = { open: string | null; recheck: (id: string) => void; viewOnly: boolean };

function BuyerCell({ data }: ICellRendererParams<ShieldGridRow>) {
  return (
    <div className="flex w-full min-w-0 flex-col leading-tight">
      <span className="font-medium">{data?.buyer}</span>
      <span className="block w-0 min-w-full truncate text-xs text-muted" title={data?.item}>{data?.item}</span>
    </div>
  );
}

function RiskCell({ data }: ICellRendererParams<ShieldGridRow>) {
  if (!data) return null;
  if (data.status === "CHECKING") return <span className="text-xs text-muted">Checking… {data.trace.at(-1)?.tool ? `(${data.trace.at(-1)!.tool})` : ""}</span>;
  if (data.status === "ERROR") return <span className="text-xs text-danger" title={data.error}>Check failed</span>;
  const v = data.verdict;
  if (!v) return null;
  return (
    <span className="flex items-center gap-2">
      <span className="rounded-full px-2 py-0.5 text-xs font-semibold" style={{ color: RISK_COLOR[v.risk], border: "1px solid currentColor" }}>{v.risk}</span>
      <span className="hidden h-1.5 w-14 overflow-hidden rounded-full bg-line sm:inline-block">
        <span className="block h-full rounded-full" style={{ width: `${Math.round(v.score)}%`, background: RISK_COLOR[v.risk] }} />
      </span>
      <span className="text-xs text-muted tabular">{Math.round(v.score)}</span>
    </span>
  );
}

function ExpandCell({ data, context }: ICellRendererParams<ShieldGridRow>) {
  if (!data?.verdict) return null;
  const open = (context as Ctx).open === data.order_id;
  return <span className="inline-block text-muted transition-transform" style={{ transform: open ? "rotate(90deg)" : undefined }} aria-hidden>▶</span>;
}

const COLS: ColDef<ShieldGridRow>[] = [
  { colId: "expand", headerName: "", width: 44, maxWidth: 44, sortable: false, resizable: false, cellRenderer: ExpandCell },
  { field: "invoice_id", headerName: "Order", width: 92, cellClass: "text-muted tabular" },
  { colId: "buyer", headerName: "Buyer", valueGetter: (p) => p.data?.buyer, cellRenderer: BuyerCell, flex: 1.1, minWidth: 160 },
  { field: "ship_to", headerName: "Ships to", flex: 1.2, minWidth: 160, tooltipField: "ship_to", cellRenderer: (p: ICellRendererParams<ShieldGridRow>) => <span className="truncate text-muted">{p.value}</span> },
  { colId: "amount", headerName: "Amount", width: 110, type: "rightAligned", valueGetter: (p) => Number(p.data?.amount ?? 0), valueFormatter: (p) => money(p.value), cellClass: "tabular font-medium justify-end" },
  { colId: "risk", headerName: "Dispute risk", width: 190, valueGetter: (p) => p.data?.verdict?.score ?? -1, cellRenderer: RiskCell, sort: "desc" },
  { colId: "headline", headerName: "Agent's read", valueGetter: (p) => p.data?.verdict?.headline ?? "", flex: 2, minWidth: 220, tooltipValueGetter: (p) => p.value, cellRenderer: (p: ICellRendererParams<ShieldGridRow>) => <span className="truncate">{p.value}</span> },
];

// What the agent found and what to do before shipping, under the order's row.
function ShieldDetail({ data, context }: ICellRendererParams<ShieldGridRow>) {
  const v = data?.verdict;
  if (!data || !v) return null;
  const { recheck, viewOnly } = context as Ctx;
  return (
    <div className="grid h-full gap-4 overflow-auto whitespace-normal border-l-4 bg-bg px-6 py-3 leading-normal md:grid-cols-2" style={{ borderColor: RISK_COLOR[v.risk] }}>
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">What decided it: {v.score}/100 from fixed rules</h3>
        <ul className="mt-1 space-y-1 text-sm">
          {v.signals.map((s, i) => (
            <li key={i} className="flex gap-2 leading-snug">
              <span className="font-semibold" style={{ color: s.effect === "RAISES" ? "var(--danger)" : "var(--fight)" }}>{s.effect === "RAISES" ? "▲" : "▼"}</span>
              <span>
                {s.finding} <span className="text-xs text-muted">({s.source}{s.weight ? `, ${s.weight > 0 ? "+" : ""}${s.weight} pts` : ""})</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Before you ship</h3>
        <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm leading-snug">
          {v.actions.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ol>
        {data.notice ? <p className="mt-2 text-xs" style={{ color: "var(--offer)" }}>{data.notice}</p> : null}
        <p className="mt-2 text-xs text-muted">
          {data.model === "rules" ? "Rule-based check" : `Explained by ${data.model}`} · {data.trace.filter((t) => t.kind === "tool").map((t) => t.tool).join(", ")}
          {viewOnly ? null : (
            <>
              {" · "}
              <button onClick={() => recheck(data.order_id)} className="underline hover:text-ink">Re-check</button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}

// Dispute shield: paid orders waiting to ship, each checked by the agent for dispute
// risk before the seller ships it, using the buyer's dispute history with the shop.
export default function ShieldPanel({ viewOnly }: { viewOnly: boolean }) {
  const phone = usePhone();
  const phoneCols = useMemo(() => forPhone(COLS, phone, ["invoice_id", "ship_to", "amount", "headline"], ["risk"]), [phone]);
  const [orders, setOrders] = useState<ShieldRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const grid = useRef<AgGridReact<ShieldGridRow>>(null);
  // The chevrons read `open` from the grid context, so redraw them when it changes.
  useEffect(() => {
    grid.current?.api?.refreshCells({ columns: ["expand"], force: true });
  }, [open]);

  const load = useCallback(async () => {
    const res = await fetch("/api/orders", { cache: "no-store" });
    const json = await res.json();
    if (!res.ok) return setError(json.error);
    setError(null);
    setOrders(json.orders);
  }, []);

  const checking = orders?.some((o) => o.status === "CHECKING") ?? true;
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!checking) return;
    const t = setInterval(load, 1200);
    return () => clearInterval(t);
  }, [checking, load]);

  async function recheck(id: string) {
    setOrders((os) => os?.map((o) => (o.order_id === id ? { ...o, status: "CHECKING", trace: [] } : o)) ?? null);
    const res = await fetch(`/api/orders/${id}/check`, { method: "POST" });
    if (!res.ok) setError((await res.json()).error);
    load();
  }

  if (!orders?.length) return null;
  const flagged = orders.filter((o) => o.verdict && o.verdict.risk !== "LOW");
  const held = flagged.reduce((n, o) => n + Number(o.amount), 0);
  const rows: ShieldGridRow[] = orders.flatMap((o) => (open === o.order_id && o.verdict ? [o, { ...o, detail: true as const }] : [o]));

  return (
    <section className="rounded-lg border border-line bg-panel p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Dispute shield: paid orders, not shipped yet</h2>
          <p className="text-xs text-muted">Before you ship, the agent checks each PayPal order for dispute risk, including every dispute this buyer has filed with you before.</p>
        </div>
        {flagged.length ? (
          <span className="rounded-full px-2.5 py-0.5 text-xs font-semibold" style={{ color: "var(--danger)", border: "1px solid currentColor" }}>
            {flagged.length} to review before shipping (${held.toFixed(0)})
          </span>
        ) : null}
      </div>
      {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}

      <div className="mt-3">
        <AgGridReact<ShieldGridRow>
          ref={grid}
          theme={gridTheme}
          rowData={rows}
          columnDefs={phoneCols}
          context={{ open, recheck, viewOnly }}
          domLayout="autoHeight"
          getRowId={(p) => `${p.data.order_id}${p.data.detail ? ":detail" : ""}`}
          isFullWidthRow={(p) => Boolean(p.rowNode.data?.detail)}
          fullWidthCellRenderer={ShieldDetail}
          getRowHeight={(p) => (p.data?.detail ? Math.max(216, 100 + 30 * (p.data.verdict?.signals.length ?? 0)) : 64)}
          // Highest risk first; a detail row sorts with its order and stays right under it.
          postSortRows={(p) => {
            const ordered = p.nodes.filter((n) => !n.data?.detail).flatMap((n) => {
              const d = p.nodes.find((x) => x.data?.detail && x.data.order_id === n.data?.order_id);
              return d ? [n, d] : [n];
            });
            p.nodes.splice(0, p.nodes.length, ...ordered);
          }}
          onRowClicked={(e) => e.data && !e.data.detail && e.data.verdict && setOpen(open === e.data.order_id ? null : e.data.order_id)}
          getRowClass={(p) => (p.data?.detail ? undefined : "cursor-pointer")}
          defaultColDef={{ cellStyle: { display: "flex", alignItems: "center" }, sortable: true }}
          suppressCellFocus
        />
      </div>
    </section>
  );
}
