"use client";

import type { ColDef } from "ag-grid-community";
import { useEffect, useState } from "react";

// True on phone-width screens. False during server render and the first paint.
export function usePhone(maxWidth = 640): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const m = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const update = () => setPhone(m.matches);
    update();
    m.addEventListener("change", update);
    return () => m.removeEventListener("change", update);
  }, [maxWidth]);
  return phone;
}

// On a phone the grids keep only the columns a seller needs at a glance; the rest are
// hidden (still in the CSV export and the row detail). What is left is sized to fit the
// screen with no sideways scrolling: columns shrink to a small minimum, the column that
// was pinned right (the action or verdict) sits at the right edge without pinning, and
// the first flexible column (usually the buyer) wraps onto two lines instead of being
// cut off. On wider screens every column shows and the action column is pinned right.
const PHONE_MIN = 84;

export function forPhone<T>(cols: ColDef<T>[], phone: boolean, hide: string[], pinRight: string[] = []): ColDef<T>[] {
  if (!phone)
    return cols.map((c) => {
      const id = c.colId ?? String(c.field ?? "");
      if (hide.includes(id)) return { ...c, hide: false };
      // Pinned so the action stays on screen when a laptop or tablet is too narrow for
      // every column, instead of hiding past the grid's right edge.
      return pinRight.includes(id) ? { ...c, pinned: "right" } : c;
    });
  const visible = (c: ColDef<T>) => !c.hide && !hide.includes(c.colId ?? String(c.field ?? ""));
  const wrapId = cols.find((c) => visible(c) && c.flex && !pinRight.includes(c.colId ?? String(c.field ?? "")));
  return cols.map((c) => {
    const id = c.colId ?? String(c.field ?? "");
    if (hide.includes(id)) return { ...c, hide: true, floatingFilter: false };
    if (c.hide) return { ...c, floatingFilter: false };
    // The action/verdict column keeps room for its badge, but no more than a third of the screen.
    if (pinRight.includes(id)) return { ...c, pinned: null, floatingFilter: false, width: undefined, flex: 1.2, minWidth: Math.min(c.minWidth ?? c.width ?? 150, 150) };
    const fixed = c.maxWidth !== undefined && c.maxWidth === c.minWidth; // e.g. a chevron column
    // Floating filter inputs take a whole row; on a phone the search box does that job.
    const next: ColDef<T> = fixed ? { ...c, floatingFilter: false } : { ...c, width: undefined, flex: c.flex ?? 1, minWidth: Math.min(c.minWidth ?? PHONE_MIN, PHONE_MIN), floatingFilter: false };
    return c === wrapId
      ? { ...next, wrapText: true, autoHeight: true, cellStyle: { display: "flex", alignItems: "center", lineHeight: "1.3", paddingTop: 8, paddingBottom: 8, overflow: "hidden", minWidth: 0 } }
      : next;
  });
}
