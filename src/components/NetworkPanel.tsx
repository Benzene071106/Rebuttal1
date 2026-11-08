"use client";

import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { forPhone, usePhone } from "./phone";
import { useEffect, useMemo, useState } from "react";
import type { NetworkAccount } from "@/lib/network";
import { REASON_LABEL } from "./format";
import { gridTheme } from "./grid";
import { Badge, Card, Kpi } from "./ui";

type Account = NetworkAccount & { pending_order: string | null };
type Payload = { accounts: Account[]; shops: number; reports: number; shared: number };

// a.b.c@example.com -> a***@example.com
const mask = (email: string) => email.replace(/^(.)[^@]*/, "$1***");

function AccountCell({ data }: ICellRendererParams<Account>) {
  if (!data) return null;
  return (
    <div className="flex min-w-0 flex-col leading-tight">
      <span className="font-medium">{data.name ?? "Not one of your buyers"}</span>
      <span className="truncate text-xs text-muted" title="Shops share a one-way hash of the PayPal email, never the email itself.">
        {data.email ? mask(data.email) : `account #${data.buyer_hash.slice(0, 8)}`}
      </span>
    </div>
  );
}

function ShopsCell({ data }: ICellRendererParams<Account>) {
  if (!data) return null;
  return (
    <span className="flex items-center gap-2">
      <Badge tone={data.shops > 1 ? "bad" : "warn"}>{data.shops} shop{data.shops === 1 ? "" : "s"}</Badge>
      {data.yours ? <span className="text-xs text-muted">incl. you</span> : null}
    </span>
  );
}

function OrderCell({ data }: ICellRendererParams<Account>) {
  if (!data) return null;
  return data.pending_order ? (
    <Badge tone="bad" title="This account has a paid order with you that hasn't shipped. See the dispute shield below.">
      <span className="hidden sm:inline">Ordering from you: </span>
      {data.pending_order}
    </Badge>
  ) : (
    <span className="text-sm text-muted">No</span>
  );
}

const COLS: ColDef<Account>[] = [
  { colId: "account", headerName: "PayPal account", flex: 1.2, minWidth: 190, cellRenderer: AccountCell, valueGetter: (p) => p.data?.name ?? p.data?.buyer_hash, filter: "agTextColumnFilter" },
  { field: "shops", headerName: "Reported by", width: 150, cellRenderer: ShopsCell, sort: "desc", sortIndex: 1 },
  { colId: "claims", headerName: "Claims", flex: 1, minWidth: 150, valueGetter: (p) => p.data?.reasons.map((r) => REASON_LABEL[r]).join(", ") },
  { field: "evidence", headerName: "What the evidence showed", flex: 1.6, minWidth: 220, tooltipField: "evidence" },
  { colId: "order", headerName: "Ordering from you", width: 200, cellRenderer: OrderCell, valueGetter: (p) => (p.data?.pending_order ? 0 : 1), sort: "asc", sortIndex: 0 },
];

// The headline of Protect: repeat disputers reported across Rebuttal shops.
export default function NetworkPanel({ mode }: { mode?: "mock" | "sandbox" }) {
  const phone = usePhone();
  const phoneCols = useMemo(() => forPhone(COLS, phone, ["shops", "claims", "evidence"], ["order"]), [phone]);
  const [data, setData] = useState<Payload | null>(null);
  useEffect(() => {
    if (!mode) return;
    fetch("/api/network", { cache: "no-store" }).then((r) => r.json()).then(setData).catch(() => setData(null));
  }, [mode]);
  const flagged = data?.accounts.filter((a) => a.shops > 1).length ?? 0;
  const ordering = data?.accounts.filter((a) => a.pending_order).length ?? 0;

  return (
    <Card
      title="Repeat-scammer network"
      subtitle={
        <>
          One seller&apos;s proven dispute protects every other seller. When a Rebuttal shop wins a dispute because its evidence contradicted the buyer (a parcel signed for, then claimed &ldquo;never arrived&rdquo;), it shares a report. Shops share only a one-way hash of the buyer&apos;s PayPal email, the claim type and what the evidence showed: no names, addresses or amounts.
          {mode === "mock" ? " In this demo the other shops are simulated; your own reports come from your real case history." : ""}
        </>
      }
    >
      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Ordering from you now" value={data ? String(ordering) : "-"} tone={ordering ? "bad" : undefined} sub="Reported accounts with a paid order" />
        <Kpi label="Seen at 2+ shops" value={data ? String(flagged) : "-"} sub="Accounts reported more than once" />
        <Kpi label="Reports in the network" value={data ? String(data.reports) : "-"} sub={data ? `From ${data.shops} shops` : undefined} />
        <Kpi label="You shared" value={data ? String(data.shared) : "-"} tone="good" sub="Disputes you won with proof" />
      </div>
      <AgGridReact<Account>
        theme={gridTheme}
        rowData={data?.accounts ?? []}
        columnDefs={phoneCols}
        domLayout="autoHeight"
        rowHeight={52}
        pagination
        paginationPageSize={5}
        paginationPageSizeSelector={phone ? false : [5, 10, 25]}
        tooltipShowDelay={300}
        getRowId={(p) => p.data.buyer_hash}
        defaultColDef={{ cellStyle: { display: "flex", alignItems: "center" }, sortable: true }}
        overlayNoRowsTemplate="No reports yet."
        suppressCellFocus
      />
    </Card>
  );
}
