"use client";

import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { forPhone, usePhone } from "./phone";
import { useEffect, useMemo, useState } from "react";
import type { ShieldRow } from "@/lib/shield";
import { useCases } from "./CasesProvider";
import { money, REASON_LABEL } from "./format";
import { gridTheme } from "./grid";
import NetworkPanel from "./NetworkPanel";
import ShieldPanel from "./ShieldPanel";
import { Badge, Card, Empty } from "./ui";

type Buyer = { email: string; name: string; disputes: number; disputed: number; open: number; claims: string; lastOutcome: string; pendingOrder: string | null };

function OrderCell({ data }: ICellRendererParams<Buyer>) {
  return data?.pendingOrder ? <Badge tone="bad" title="This buyer has a paid order waiting to ship. See the dispute shield above.">Ordered again: {data.pendingOrder}</Badge> : <span className="text-sm text-muted">None</span>;
}

const COLS: ColDef<Buyer>[] = [
  { field: "name", headerName: "Buyer", flex: 1, minWidth: 150 },
  { field: "email", headerName: "PayPal email", flex: 1.1, minWidth: 180, cellClass: "text-muted" },
  { field: "disputes", headerName: "Disputes", width: 130, type: "rightAligned", sort: "desc", sortIndex: 1, filter: "agNumberColumnFilter" },
  { field: "disputed", headerName: "Disputed", width: 120, type: "rightAligned", valueFormatter: (p) => money(p.value), cellClass: "tabular" },
  { field: "claims", headerName: "Claims", flex: 1, minWidth: 140 },
  { field: "lastOutcome", headerName: "Latest result", width: 140 },
  { field: "pendingOrder", headerName: "Open orders", flex: 1.2, minWidth: 220, cellRenderer: OrderCell, sort: "asc", sortIndex: 0, comparator: (a, b) => (a ? 0 : 1) - (b ? 0 : 1) },
];

// Before you ship: the dispute shield, and the buyers Rebuttal remembers from past disputes.
export default function Protect() {
  const phone = usePhone();
  const phoneCols = useMemo(() => forPhone(COLS, phone, ["email", "disputes", "disputed", "claims", "lastOutcome"], ["pendingOrder"]), [phone]);
  const { data } = useCases();
  const [orders, setOrders] = useState<ShieldRow[]>([]);

  useEffect(() => {
    if (data?.mode !== "mock") return;
    fetch("/api/orders", { cache: "no-store" }).then((r) => r.json()).then((j) => setOrders(j.orders ?? [])).catch(() => {});
  }, [data?.mode]);

  // Dispute memory: every buyer who has disputed with the shop, and whether they're ordering again.
  const buyers = useMemo<Buyer[]>(() => {
    const map = new Map<string, Buyer>();
    for (const c of data?.cases ?? []) {
      const b = c.dispute.disputed_transactions[0]?.buyer;
      const email = b?.email?.toLowerCase();
      if (!email) continue;
      const row = map.get(email) ?? { email, name: b?.name ?? email, disputes: 0, disputed: 0, open: 0, claims: "", lastOutcome: "Open", pendingOrder: null };
      row.disputes++;
      row.disputed += Number(c.dispute.dispute_amount.value);
      if (!c.outcome) row.open++;
      row.claims = [...new Set([...row.claims.split(", ").filter(Boolean), REASON_LABEL[c.dispute.reason]])].join(", ");
      row.lastOutcome = c.outcome ? c.outcome.result.charAt(0) + c.outcome.result.slice(1).toLowerCase() : "Open";
      row.pendingOrder = orders.find((o) => o.buyer === row.name)?.invoice_id ?? null;
      map.set(email, row);
    }
    return [...map.values()];
  }, [data, orders]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Protect</h1>
        <p className="text-sm text-muted">Stop disputes before they start: see buyers other sellers caught, check every paid order before you ship it, and remember every buyer who has disputed with you.</p>
      </div>

      <NetworkPanel mode={data?.mode} />

      {data?.mode === "mock" ? (
        <ShieldPanel key={data.cases.length ? "on" : "reset"} viewOnly={Boolean(data.viewOnly)} />
      ) : (
        <Card title="Dispute shield" subtitle="Checks paid orders for dispute risk before you ship.">
          <Empty title="No paid orders to check here">The shield runs on the Simulator&apos;s paid orders. A live install would check each order as PayPal&apos;s PAYMENT.CAPTURE.COMPLETED webhook arrives.</Empty>
        </Card>
      )}

      <Card title="Dispute memory" subtitle="Buyers who have disputed with you. The shield and the investigator both read this history.">
        {buyers.length ? (
          <AgGridReact<Buyer>
            theme={gridTheme}
            rowData={buyers}
            columnDefs={phoneCols}
            domLayout="autoHeight"
            rowHeight={48}
            pagination
            paginationPageSize={10}
            paginationPageSizeSelector={phone ? false : [10, 25, 50]}
            getRowId={(p) => p.data.email}
            defaultColDef={{ cellStyle: { display: "flex", alignItems: "center" }, sortable: true }}
            suppressCellFocus
          />
        ) : (
          <Empty title="No buyers to remember yet">Every buyer who disputes with you will be listed here, so the shield and the investigator can read their history.</Empty>
        )}
      </Card>
    </div>
  );
}
