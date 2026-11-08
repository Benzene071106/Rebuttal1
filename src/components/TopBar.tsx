"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { RulesForm } from "./AutopilotPanel";
import { useCases } from "./CasesProvider";
import { BUTTON, OPEN_SIMULATOR_EVENT } from "./ui";

const TABS = [
  { href: "/", label: "Disputes" },
  { href: "/protect", label: "Protect" },
  { href: "/insights", label: "Insights" },
  { href: "/ask", label: "Ask AI" },
] as const;

type Fault = "OUTAGE" | "TOKEN_EXPIRED" | "INSUFFICIENT_FUNDS";
export const FAULTS: Array<[Fault, string]> = [
  ["OUTAGE", "PayPal outage (503, twice)"],
  ["TOKEN_EXPIRED", "Expired PayPal token (401)"],
  ["INSUFFICIENT_FUNDS", "Refund refused: insufficient funds (422)"],
];

// Opens the welcome tour on the home page (see WelcomeTour).
export const TOUR_EVENT = "rebuttal:tour";

export default function TopBar() {
  const path = usePathname();
  const { data, reload, setError, switchMode } = useCases();
  const [settings, setSettings] = useState(false);
  // Coming back from a dispute page, show what changed there right away.
  useEffect(() => {
    reload();
  }, [path, reload]);
  const active = (href: string) => (href === "/" ? path === "/" || path.startsWith("/cases") : path.startsWith(href));

  return (
    <header className="border-b border-line bg-panel">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 sm:px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span aria-hidden className="grid h-7 w-7 place-items-center rounded-md bg-accent text-sm font-bold text-panel">R</span>
          Rebuttal
        </Link>
        <nav aria-label="Main" className="-mx-1 flex gap-1 overflow-x-auto sm:mx-0">
          {TABS.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active(t.href) ? "page" : undefined}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${active(t.href) ? "bg-accent-soft text-accent" : "text-muted hover:text-ink"}`}
            >
              {t.label}
            </Link>
          ))}
        </nav>
        <div className="flex w-full flex-wrap items-center justify-between gap-2 sm:ml-auto sm:w-auto sm:justify-end">
          {data?.sandboxAvailable ? (
            <div className="flex rounded-md border border-line p-0.5 text-xs" role="group" aria-label="PayPal mode">
              {(["mock", "sandbox"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => switchMode(m)}
                  aria-pressed={data.mode === m}
                  className={`rounded px-2.5 py-1 ${data.mode === m ? "bg-accent text-panel" : m === "sandbox" ? "font-medium text-accent hover:bg-accent-soft" : "text-muted hover:text-ink"}`}
                >
                  {m === "mock" ? "Simulator" : data.account ? `My PayPal${data.account.paypal_env === "sandbox" ? " (sandbox)" : ""}` : <><span className="hidden sm:inline">Live PayPal </span><span className="sm:hidden">Live </span>sandbox</>}
                </button>
              ))}
            </div>
          ) : null}
          {data?.mode === "mock" ? <SimulatorMenu onDone={reload} onError={setError} /> : null}
          <button onClick={() => setSettings(true)} className={BUTTON.secondary} aria-label="Autopilot rules"><span className="sm:hidden">Rules</span><span className="hidden sm:inline">Autopilot rules</span></button>
          {data?.accounts ? (
            <Link href="/account" aria-current={path === "/account" ? "page" : undefined} className={BUTTON.secondary} title={data.account?.email}>
              {data.account ? "Account" : "Sign in"}
            </Link>
          ) : null}
        </div>
      </div>
      {data?.mode === "mock" && data.sandboxAvailable ? (
        <div role="note" className="border-t border-line bg-accent-soft">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm sm:px-4">
            <span>
              <strong>Simulator: mirrors the real PayPal Disputes API</strong>
              <span className="hidden sm:inline"> (same endpoints, payloads and dispute states), so you can try every action safely.
              The Gemini investigations are real.</span>
            </span>
            <button onClick={() => switchMode("sandbox")} className="font-medium text-accent underline">
              <span className="sm:hidden">See the live sandbox</span>
              <span className="hidden sm:inline">Switch to Live PayPal sandbox to see real API calls</span>
            </button>
          </div>
        </div>
      ) : null}
      {data?.mode === "sandbox" && data.viewOnly ? (
        <div role="note" className="border-t border-line" style={{ background: "color-mix(in srgb, var(--offer) 10%, transparent)" }}>
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm sm:px-4">
            <span>
              <strong>Live PayPal sandbox, view-only for safety.</strong> Every visitor shares one real sandbox account, so approvals, refunds and offers are turned off here.
              The demo video shows them running live.
            </span>
            <button onClick={() => switchMode("mock")} className="font-medium text-accent underline">Try every action in the Simulator</button>
          </div>
        </div>
      ) : null}
      {settings ? <SettingsDrawer onClose={() => setSettings(false)} /> : null}
    </header>
  );
}

// Demo controls, kept out of the way: file a test dispute, break PayPal's next call, reset.
function SimulatorMenu({ onDone, onError }: { onDone: () => void; onError: (e: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fault, setFault] = useState<Fault>("INSUFFICIENT_FUNDS");
  const [armed, setArmed] = useState<Fault | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Empty states elsewhere can open this menu.
  useEffect(() => {
    const show = () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
      setOpen(true);
    };
    window.addEventListener(OPEN_SIMULATOR_EVENT, show);
    return () => window.removeEventListener(OPEN_SIMULATOR_EVENT, show);
  }, []);
  useEffect(() => {
    if (!open) return;
    fetch("/api/incidents", { cache: "no-store" }).then((r) => r.json()).then((j) => setArmed(j.armed)).catch(() => {});
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  async function run(fn: () => Promise<Response>) {
    setBusy(true);
    const res = await fn();
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return onError(json.error ?? "Something went wrong.");
    onError(null);
    onDone();
    return json;
  }

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className={BUTTON.primary}>
        {busy ? "Working..." : <><span className="sm:hidden">Tools</span><span className="hidden sm:inline">Simulator tools</span></>}
      </button>
      {open ? (
        <div className="absolute right-0 z-30 mt-2 w-[min(20rem,calc(100vw-2rem))] space-y-3 rounded-lg border border-line bg-panel p-3 shadow-lg">
          <div>
            <button
              onClick={() => run(() => fetch("/api/demo/dispute", { method: "POST" })).then(() => setOpen(false))}
              disabled={busy}
              className={`${BUTTON.primary} w-full`}
            >
              Simulate a new dispute
            </button>
            <p className="mt-1 text-xs text-muted">A buyer files a dispute and PayPal&apos;s webhook reaches the agent. Watch the alerts on Disputes.</p>
          </div>
          <div className="border-t border-line pt-3">
            <p className="text-xs font-medium">Test self-healing</p>
            <select value={fault} onChange={(e) => setFault(e.target.value as Fault)} aria-label="PayPal fault to inject" className="mt-1 w-full rounded-md border border-line bg-panel px-2 py-1.5 text-sm">
              {FAULTS.map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
            <button
              onClick={() => run(() => fetch("/api/demo/fault", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: fault }) })).then((j) => j && setArmed(j.armed))}
              disabled={busy}
              className={`${BUTTON.secondary} mt-2 w-full`}
            >
              Break PayPal&apos;s next call
            </button>
            {armed ? (
              <p className="mt-1 text-xs" style={{ color: "var(--offer)" }}>
                Armed: {FAULTS.find(([k]) => k === armed)?.[1]}. Approve a response or simulate a dispute.{" "}
                <button
                  onClick={() => run(() => fetch("/api/demo/fault", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: null }) })).then(() => setArmed(null))}
                  className="underline"
                >
                  Cancel
                </button>
              </p>
            ) : (
              <p className="mt-1 text-xs text-muted">The incident shows up in Insights.</p>
            )}
          </div>
          <div className="flex items-center justify-between border-t border-line pt-3">
            <button onClick={() => (window.dispatchEvent(new Event(TOUR_EVENT)), setOpen(false))} className={BUTTON.ghost}>Show the tour</button>
            <button onClick={() => run(() => fetch("/api/demo/reset", { method: "POST" })).then(() => (setArmed(null), setOpen(false)))} disabled={busy} className={BUTTON.ghost}>
              Reset demo
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SettingsDrawer({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <aside role="dialog" aria-label="Autopilot rules" className="h-full w-full max-w-xl overflow-y-auto bg-panel p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">Autopilot rules</h2>
          <button onClick={onClose} className={BUTTON.ghost} aria-label="Close">Close</button>
        </div>
        <RulesForm />
      </aside>
    </div>
  );
}
