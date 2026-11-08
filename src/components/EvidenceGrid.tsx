"use client";

import type { CellStyle, ColDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useMemo } from "react";
import type { Recommendation } from "@/lib/types";
import { gridTheme } from "./grid";
import { usePhone } from "./phone";

type Evidence = Recommendation["evidence"][number];

// Wrapped text needs a normal line height (the theme uses the row height) and its own
// padding, or AG Grid's auto row height clips multi-line facts.
const WRAP: CellStyle = { lineHeight: "1.4", paddingTop: "10px", paddingBottom: "10px", wordBreak: "normal" };

// The agent's evidence trail: each fact it relies on, what kind of PayPal evidence it is,
// and which tool returned it, so the seller can check every claim before approving.
export default function EvidenceGrid({ evidence, toolLabel }: { evidence: Evidence[]; toolLabel: Record<string, string> }) {
  // On a phone the fact and its source fill the width; the evidence type is left out.
  const phone = usePhone();
  const cols = useMemo<ColDef<Evidence>[]>(
    () => [
      { headerName: "Fact", field: "summary", flex: 3, minWidth: phone ? 160 : 260, autoHeight: true, wrapText: true, cellStyle: WRAP },
      {
        headerName: "Evidence type",
        field: "type",
        flex: 1.2,
        minWidth: 150,
        hide: phone,
        valueFormatter: (p) => String(p.value ?? "").replaceAll("_", " ").toLowerCase(),
        cellClass: "text-muted",
        wrapText: true,
        autoHeight: true,
        cellStyle: WRAP,
        filter: "agTextColumnFilter",
      },
      {
        headerName: "Source",
        field: "source",
        flex: 1.2,
        minWidth: phone ? 100 : 150,
        valueFormatter: (p) => toolLabel[p.value] ?? p.value,
        cellClass: "text-muted",
        wrapText: phone,
        autoHeight: phone,
        cellStyle: phone ? WRAP : undefined,
        filter: "agTextColumnFilter",
      },
    ],
    [toolLabel, phone],
  );
  return (
    <div>
      <AgGridReact<Evidence>
        theme={gridTheme}
        rowData={evidence}
        columnDefs={cols}
        domLayout="autoHeight"
        defaultColDef={{ sortable: true }}
        suppressCellFocus
        // Column widths settle after the first paint; re-measure so wrapped rows aren't cut off.
        onGridSizeChanged={(e) => e.api.resetRowHeights()}
        onFirstDataRendered={(e) => e.api.resetRowHeights()}
      />
    </div>
  );
}
