"use client";

import type { ColDef, DefaultMenuItem, GetContextMenuItemsParams, GridApi, ICellRendererParams, MenuItemDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { forPhone, usePhone } from "./phone";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import type { CaseRecord } from "@/lib/types";
import { AlertsFeed } from "./AutopilotPanel";
import { useCases } from "./CasesProvider";
import { DECISION_LABEL, money, REASON_LABEL, statusLabel } from "./format";
import { gridTheme } from "./grid";
import { useGridEnterprise } from "./gridEnterprise";
import IncidentsPanel from "./IncidentsPanel";
import InboxCharts from "./InboxCharts";
import ScaleTest from "./ScaleTest";
import { Badge, BUTTON, Card, Kpi } from "./ui";

const decisionOf = (c?: CaseRecord) => {
  const d = c?.submitted?.decision ?? c?.recommendation?.decision;
  return d ? DECISION_LABEL[d] : "";
};

function ResultCell({ data }: ICellRendererParams<CaseRecord>) {
  if (!data) return null;
  const o = data.outcome;
  if (!o) return <span className="text-sm text-muted">{statusLabel(data)}</span>;
  return <Badge tone={o.amount_kept > 0 ? "good" : "bad"}>{o.result === "WON" ? "Won" : o.result === "SETTLED" ? "Settled" : o.result === "REFUNDED" ? "Refunded" : "Lost"}</Badge>;
}

const COLS: ColDef<CaseRecord>[] = [
  { colId: "id", headerName: "Dispute ID", hide: true, valueGetter: (p) => p.data?.id },
  { colId: "buyer", headerName: "Buyer", flex: 1.2, minWidth: 140, valueGetter: (p) => p.data?.dispute.disputed_transactions[0]?.buyer?.name, tooltipValueGetter: (p) => p.data?.dispute.disputed_transactions[0]?.items?.[0]?.item_description, filter: "agTextColumnFilter" },
  { colId: "claim", headerName: "Claim", flex: 1, minWidth: 120, valueGetter: (p) => p.data && REASON_LABEL[p.data.dispute.reason], filter: "agTextColumnFilter", floatingFilter: true },
  { colId: "amount", headerName: "Amount", width: 100, type: "rightAligned", valueGetter: (p) => Number(p.data?.dispute.dispute_amount.value ?? 0), valueFormatter: (p) => money(p.value), cellClass: "tabular", filter: "agNumberColumnFilter" },
  { colId: "decision", headerName: "Decision", width: 120, valueGetter: (p) => decisionOf(p.data), filter: "agTextColumnFilter", floatingFilter: true },
  { colId: "by", headerName: "Answered by", width: 120, valueGetter: (p) => (p.data?.submitted ? (p.data.submitted.by === "autopilot" ? "Autopilot" : "You") : "") },
  { colId: "result", headerName: "Result", width: 120, valueGetter: (p) => p.data?.outcome?.result ?? (p.data ? statusLabel(p.data) : ""), cellRenderer: ResultCell },
  { colId: "kept", headerName: "Kept", width: 100, type: "rightAligned", valueGetter: (p) => p.data?.outcome?.amount_kept ?? 0, valueFormatter: (p) => money(p.value), cellClass: "tabular" },
  {
    colId: "closed",
    headerName: "Closed",
    width: 110,
    valueGetter: (p) => (p.data?.outcome ? new Date(p.data.outcome.at) : null),
    valueFormatter: (p) => (p.node?.group || p.node?.footer ? "" : p.value ? (p.value as Date).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "Open"),
    filter: "agDateColumnFilter",
    // Compare calendar days, not timestamps.
    filterParams: { comparator: (day: Date, v: Date | null) => (!v ? -1 : new Date(v.getFullYear(), v.getMonth(), v.getDate()).getTime() - day.getTime()) },
    comparator: (a: Date | null, b: Date | null) => (a?.getTime() ?? Infinity) - (b?.getTime() ?? Infinity),
    sort: "desc",
  },
  { colId: "refunded", headerName: "Refunded", width: 110, flex: 0.5, type: "rightAligned", valueGetter: (p) => p.data?.outcome?.amount_lost ?? 0, valueFormatter: (p) => money(p.value), cellClass: "tabular" },
];

type Factor = NonNullable<NonNullable<CaseRecord["recommendation"]>["factors"]>[number];
const FACTOR_COLS: ColDef<Factor>[] = [
  { field: "finding", headerName: "What the agent found", flex: 2, minWidth: 220, wrapText: true, autoHeight: true },
  { field: "favors", headerName: "Favors", width: 110, valueFormatter: (p) => (p.value === "SELLER" ? "You" : "Buyer") },
  { field: "weight", headerName: "Weight", width: 100, valueFormatter: (p) => String(p.value ?? "").toLowerCase() },
  { field: "source", headerName: "PayPal source", width: 190 },
];

// Enterprise only (with AG_GRID_LICENSE_KEY): the ledger groups by claim type with
// totals per group, every category can be grouped, pivoted and set-filtered, the money
// columns aggregate and chart, and each dispute expands into its evidence and timeline.
const CATEGORIES = ["claim", "decision", "by", "result"];
const MONEY = ["amount", "kept", "refunded"];
function enterpriseCols(cols: ColDef<CaseRecord>[]): ColDef<CaseRecord>[] {
  return cols.map((c) => {
    const id = c.colId ?? "";
    if (CATEGORIES.includes(id))
      return {
        ...c,
        // Initial, not stateful: the "Chart in grid" button ungroups the ledger at run time.
        ...(id === "claim" ? { initialRowGroup: true, initialHide: true, hide: undefined } : {}),
        enableRowGroup: true,
        enablePivot: true,
        chartDataType: "category" as const,
        filter: "agSetColumnFilter",
        floatingFilter: false,
        // Result shows a badge; the set filter lists the plain words.
        ...(id === "result" ? { filterValueGetter: (p: { data?: CaseRecord }) => p.data?.outcome?.result ?? (p.data ? statusLabel(p.data) : "") } : {}),
      };
    if (MONEY.includes(id)) return { ...c, aggFunc: "sum", enableValue: true, allowedAggFuncs: ["sum", "avg", "count", "max"], chartDataType: "series" as const };
    if (id === "buyer") return { ...c, chartDataType: "category" as const };
    return { ...c, chartDataType: "excluded" as const };
  });
}

const cssVar = (name: string, fallback: string) => (typeof window === "undefined" ? fallback : getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback);

// Master-detail: what the agent found on one dispute, next to everything that happened to it.
function DisputeDetail({ data }: ICellRendererParams<CaseRecord>) {
  if (!data) return null;
  const factors = data.recommendation?.factors ?? [];
  const timeline: Array<{ at: string; text: string }> = [
    { at: data.dispute.create_time, text: `Buyer opened a ${money(data.dispute.dispute_amount.value)} "${REASON_LABEL[data.dispute.reason] ?? data.dispute.reason}" dispute` },
    ...(data.activity ?? []).map((a) => ({ at: a.at, text: a.text })),
    ...(data.submitted ? [{ at: data.submitted.at, text: `${DECISION_LABEL[data.submitted.decision]} sent to PayPal by ${data.submitted.by === "autopilot" ? "autopilot" : "the seller"}` }] : []),
    ...(data.outcome ? [{ at: data.outcome.at, text: `PayPal closed it: ${data.outcome.result.toLowerCase()}, ${money(data.outcome.amount_kept)} kept` }] : []),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return (
    <div className="grid gap-4 p-4 md:grid-cols-[3fr_2fr]" style={{ background: "var(--bg)" }}>
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Evidence the agent weighed</p>
        {factors.length ? (
          <AgGridReact<Factor> theme={gridTheme} rowData={factors} columnDefs={FACTOR_COLS} domLayout="autoHeight" defaultColDef={{ cellStyle: { display: "flex", alignItems: "center" } }} suppressCellFocus />
        ) : (
          <p className="text-sm text-muted">Not investigated by the agent.</p>
        )}
      </div>
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Timeline</p>
        <ol className="space-y-1.5 text-sm">
          {timeline.map((t, i) => (
            <li key={i} className="flex gap-3">
              <span className="w-14 shrink-0 tabular text-muted">{new Date(t.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
              <span>{t.text}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

// What the agent did: savings, linked charts over an outcomes ledger, the autopilot
// history and the self-healing incident log.
export default function Insights() {
  const router = useRouter();
  const { data } = useCases();
  const grid = useRef<AgGridReact<CaseRecord>>(null);
  const [shown, setShown] = useState<CaseRecord[]>([]);
  const [claim, setClaim] = useState<string | null>(null);
  const [chartOpen, setChartOpen] = useState(false);
  const chartBox = useRef<HTMLDivElement>(null);
  const s = data?.stats;
  const enterprise = useGridEnterprise();
  const phone = usePhone();
  const columnDefs = useMemo(() => {
    const cols = forPhone(COLS, phone, ["claim", "decision", "by", "closed", "kept", "refunded"], ["result"]);
    return enterprise ? enterpriseCols(cols) : cols;
  }, [enterprise, phone]);
  const enterpriseProps = useMemo(() => enterprise
    ? {
        rowGroupPanelShow: "always" as const,
        pivotPanelShow: "onlyWhenPivoting" as const,
        groupDefaultExpanded: 0,
        autoGroupColumnDef: { headerName: "Claim type", minWidth: 220 },
        grandTotalRow: "bottom" as const,
        suppressAggFuncInHeader: true,
        masterDetail: true,
        isRowMaster: (c: CaseRecord) => Boolean(c),
        detailRowAutoHeight: true,
        detailCellRenderer: DisputeDetail,
        // Columns (group, pivot, values) and Filters tool panels, closed until opened.
        sideBar: { toolPanels: ["columns", "filters"] },
        // Integrated charts use the app's colors: kept in green, refunded in red.
        customChartThemes: {
          rebuttal: {
            baseTheme: "ag-default" as const,
            // Cross-filter charts take every other color (the in-between one shades the
            // filtered-out part), so each color is listed twice.
            palette: { fills: [cssVar("--fight", "#0f5c4d"), cssVar("--fight", "#0f5c4d"), cssVar("--refund", "#8a3b2e"), cssVar("--refund", "#8a3b2e"), cssVar("--offer", "#b7791f")], strokes: [cssVar("--fight", "#0f5c4d"), cssVar("--fight", "#0f5c4d"), cssVar("--refund", "#8a3b2e"), cssVar("--refund", "#8a3b2e"), cssVar("--offer", "#b7791f")] },
            overrides: { common: { background: { fill: cssVar("--panel", "#ffffff") } } },
          },
        },
        chartThemes: ["rebuttal", "ag-default", "ag-default-dark"],
        statusBar: {
          statusPanels: [
            { statusPanel: "agTotalAndFilteredRowCountComponent", align: "left" as const },
            { statusPanel: "agAggregationComponent", statusPanelParams: { aggFuncs: ["sum", "avg", "count"] } },
          ],
        },
        // Drag across money cells for live sums in the status bar, or right-click to chart them.
        cellSelection: true,
        enableCharts: true,
        getContextMenuItems: (p: GetContextMenuItemsParams<CaseRecord>) => {
          const open: MenuItemDef<CaseRecord>[] = p.node?.data ? [{ name: "Open this dispute", action: () => router.push(`/cases/${p.node!.data!.id}`) }] : [];
          const items: DefaultMenuItem[] = ["copy", "copyWithHeaders", "separator", "chartRange", "pivotChart", "separator", "excelExport", "csvExport"];
          return [...open, ...(open.length ? (["separator"] as DefaultMenuItem[]) : []), ...items];
        },
      }
    : {}, [enterprise, router]);

  const refresh = useCallback((api: GridApi<CaseRecord>) => {
    const visible: CaseRecord[] = [];
    api.forEachNodeAfterFilter((n) => n.data && visible.push(n.data));
    setShown((cur) => (cur.length === visible.length && cur.every((c, i) => c === visible[i]) ? cur : visible));
    const m = api.getColumnFilterModel("claim") as { type?: string; filter?: string; values?: string[] } | null;
    setClaim(m?.type === "equals" ? m.filter ?? null : m?.values?.length === 1 ? m.values[0] : null);
  }, []);

  // Clicking a bar in the chart filters the ledger's Claim column; clicking it again clears it.
  const filterClaim = useCallback(
    async (value: string | null) => {
      const api = grid.current?.api;
      if (!api) return;
      await api.setColumnFilterModel("claim", value ? (enterprise ? { filterType: "set", values: [value] } : { filterType: "text", type: "equals", filter: value }) : null);
      api.onFilterChanged();
    },
    [enterprise],
  );

  // Enterprise: an AG Grid cross-filter chart of money kept per claim type, drawn by the
  // grid itself; clicking a bar filters the ledger.
  function toggleGridChart() {
    const api = grid.current?.api;
    if (!api) return;
    if (chartOpen) {
      api.getChartModels()?.forEach((m) => api.getChartRef(m.chartId)?.destroyChart());
      // Back to the grouped ledger.
      api.setRowGroupColumns(["claim"]);
      api.setColumnsVisible(["claim"], false);
      api.setGridOption("grandTotalRow", "bottom");
      return setChartOpen(false);
    }
    setChartOpen(true);
    // The cross-filter chart counts every row it sees, group rows included, so the ledger
    // goes flat while the chart is open: one row per dispute, each counted once.
    api.setRowGroupColumns([]);
    api.setColumnsVisible(["claim"], true);
    api.setGridOption("grandTotalRow", undefined);
    requestAnimationFrame(() =>
      api.createCrossFilterChart({
        chartType: "column",
        cellRange: { columns: ["claim", "kept", "refunded"] },
        aggFunc: "sum",
        chartContainer: chartBox.current ?? undefined,
        chartThemeOverrides: {
          common: { title: { enabled: true, text: "Kept vs refunded by claim type (click a bar to filter)" } },
          bar: { series: { fillOpacity: 0.9 } },
        },
        chartThemeName: "rebuttal",
      }),
    );
  }

  function exportExcel() {
    grid.current?.api.exportDataAsExcel({ fileName: `rebuttal-outcomes-${new Date().toISOString().slice(0, 10)}.xlsx`, sheetName: "Outcomes" });
  }

  function exportCsv() {
    grid.current?.api.exportDataAsCsv({ fileName: `rebuttal-outcomes-${new Date().toISOString().slice(0, 10)}.csv`, columnKeys: ["id", "buyer", "claim", "amount", "decision", "by", "result", "closed", "kept", "refunded"], processCellCallback: (p) => (p.value instanceof Date ? p.value.toISOString().slice(0, 10) : p.value) });
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Insights</h1>
        <p className="text-sm text-muted">What the agent did for you: money kept, time saved, every autopilot action and every PayPal failure it handled.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Money protected" value={s ? money(s.kept) : "-"} tone="good" sub={s?.rulings ? `Won ${s.won} of ${s.rulings} PayPal ruling${s.rulings === 1 ? "" : "s"}` : "No PayPal rulings yet"} />
        <Kpi label="Hours saved" value={s ? `${s.hours_saved}h` : "-"} sub="Est. 45 min of manual work per dispute" />
        <Kpi label="Handled by autopilot" value={s ? `${s.autopilot} of ${s.answered}` : "-"} sub="Responses sent without you" />
        <Kpi label="Disputes" value={s ? String(data?.cases.length ?? 0) : "-"} sub={s ? `${s.open} still open` : undefined} />
      </div>

      <InboxCharts shown={shown} activeClaim={claim} onClaim={filterClaim} />

      <Card
        title="Outcomes ledger"
        subtitle={`${enterprise ? "Grouped by claim type: drag columns into the bar to regroup, open the side bar to pivot or filter, expand a dispute for its evidence and timeline, drag across amounts for a sum, right-click to chart. " : ""}The charts above follow this grid's filters (try the Closed date filter). Click a row to open it.${data?.cases.some((c) => c.history) ? ` Includes ${data.cases.filter((c) => c.history).length} simulated past disputes from the demo shop.` : ""}`}
        right={
          <div className="flex flex-wrap gap-2">
            {enterprise ? (
              <>
                <button onClick={toggleGridChart} disabled={!data?.cases.length} className={BUTTON.secondary}>{chartOpen ? "Hide grid chart" : "Chart in grid"}</button>
                <button onClick={exportExcel} disabled={!data?.cases.length} className={BUTTON.secondary}>Export to Excel</button>
              </>
            ) : null}
            <button onClick={exportCsv} disabled={!data?.cases.length} className={BUTTON.secondary}>Export outcomes (CSV)</button>
          </div>
        }
      >
        {enterprise ? <div ref={chartBox} className={chartOpen ? "mb-3 h-80 overflow-hidden rounded-md border border-line" : "hidden"} /> : null}
        <AgGridReact<CaseRecord>
          ref={grid}
          // Remount when Enterprise switches on, so grouping and master-detail apply cleanly.
          key={enterprise ? "enterprise" : "community"}
          {...enterpriseProps}
          theme={gridTheme}
          rowData={data?.cases ?? []}
          columnDefs={columnDefs}
          domLayout="autoHeight"
          rowHeight={48}
          pagination
          paginationPageSize={10}
          paginationPageSizeSelector={phone ? false : [10, 25, 50, 100]}
          tooltipShowDelay={400}
          getRowId={(p) => p.data.id}
          onRowClicked={(e) => {
            // The master-detail chevron is a control, not a request to open the dispute.
            const fromControl = (e.event?.target as HTMLElement | null)?.closest(".ag-group-contracted, .ag-group-expanded, .ag-details-row");
            if (e.data && !fromControl) router.push(`/cases/${e.data.id}`);
          }}
          getRowClass={() => "cursor-pointer"}
          defaultColDef={{ cellStyle: { display: "flex", alignItems: "center" }, sortable: true }}
          onRowDataUpdated={(e) => refresh(e.api)}
          onFilterChanged={(e) => refresh(e.api)}
          overlayNoRowsTemplate="No disputes yet."
          suppressCellFocus
        />
      </Card>

      <ScaleTest />

      <IncidentsPanel mode={data?.mode} refreshKey={(data?.cases ?? []).map((c) => c.updated_at).join("|")} />

      <Card title="Autopilot history" subtitle="PayPal webhooks and what the agent did, newest first.">
        <AlertsFeed cases={data?.cases ?? []} mode={data?.mode} limit={20} />
      </Card>
    </div>
  );
}
