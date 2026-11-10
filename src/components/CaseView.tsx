"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CaseRecord, Decision, NegotiationTurn, PayPalReceipt, TraceStep } from "@/lib/types";
import EvidenceGrid from "./EvidenceGrid";
import NegotiationPanel from "./NegotiationPanel";
import NetworkBanner from "./NetworkBanner";
import WhyPanel from "./WhyPanel";
import { useCases } from "./CasesProvider";
import { BUTTON } from "./ui";
import { daysLeft, DECISION_COLOR, DECISION_LABEL, money, REASON_LABEL, statusLabel } from "./format";

const TOOL_LABEL: Record<string, string> = {
  get_dispute: "PayPal Disputes API",
  get_order: "PayPal Orders API",
  get_shipment_tracking: "PayPal Shipment Tracking",
  list_transactions: "PayPal Transaction Search",
  get_store_records: "Shop records",
};

export default function CaseView({ id }: { id: string }) {
  const [c, setC] = useState<CaseRecord | null>(null);
  const [live, setLive] = useState<TraceStep[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision>("FIGHT");
  const [response, setResponse] = useState("");
  const [offer, setOffer] = useState("");
  const [ceilingPct, setCeilingPct] = useState(0.4);
  const [ceiling, setCeiling] = useState("");
  const [negLive, setNegLive] = useState<NegotiationTurn[] | null>(null);
  const negPanel = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const [simulator, setSimulator] = useState(false);
  const [viewOnly, setViewOnly] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const sentPanel = useRef<HTMLDivElement>(null);
  const banner = useRef<HTMLDivElement>(null);
  const wasAwaiting = useRef(false);
  const [missing, setMissing] = useState(false);
  const [lookup, setLookup] = useState(0);

  const adopt = useCallback((rec: CaseRecord) => {
    setC(rec);
    if (rec.recommendation && !rec.submitted) {
      setDecision(rec.recommendation.decision);
      setResponse(rec.recommendation.response_to_paypal);
      setOffer(rec.recommendation.offer_amount ? String(rec.recommendation.offer_amount) : "");
    }
  }, []);

  const analyze = useCallback(async (fresh = false) => {
    setBusy("analyze");
    setError(null);
    setLive([]);
    setC((cur) => (cur ? { ...cur, status: "ANALYZING", recommendation: undefined } : cur));
    const res = await fetch(`/api/cases/${id}/analyze${fresh ? "?fresh=1" : ""}`, { method: "POST" });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const line of lines.filter(Boolean)) {
        const msg = JSON.parse(line);
        if (msg.type === "step") setLive((s) => [...s, msg.step]);
        if (msg.type === "done") adopt(msg.case);
        if (msg.type === "error") setError(msg.error);
      }
    }
    setBusy(null);
  }, [id, adopt]);

  useEffect(() => {
    // A superseded load (the page re-mounting, or a newer id) must not touch the page.
    let cancelled = false;
    (async () => {
      let rec: CaseRecord | null = null;
      // The server can be missing the case for a moment: a freshly filed dispute, or a
      // server that just woke up or redeployed with empty memory. Syncing the inbox
      // reloads it, so retry a few times before calling the dispute missing.
      for (let attempt = 0; attempt < 4 && !rec && !cancelled; attempt++) {
        if (attempt > 0) {
          await fetch("/api/cases", { cache: "no-store" }).catch(() => null);
          await new Promise((r) => setTimeout(r, 400 * attempt));
        }
        const res = await fetch(`/api/cases/${id}`, { cache: "no-store" }).catch(() => null);
        if (res?.ok) rec = await res.json();
      }
      if (cancelled) return;
      if (!rec) return setMissing(true);
      setMissing(false);
      setError(null);
      adopt(rec);
      if (rec.status === "NEW" && !started.current) {
        started.current = true;
        analyze();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, adopt, analyze, lookup]);

  // Hands the partial refund to the agent, which haggles with the buyer up to the
  // ceiling; the conversation streams in as it happens.
  async function startNegotiation(max: number) {
    setBusy("negotiate");
    setError(null);
    setNegLive(c?.negotiation?.turns ?? []);
    setTimeout(() => negPanel.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
    const res = await fetch(`/api/cases/${id}/negotiate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ max_refund: max }) });
    if (!res.ok || !res.body) {
      const json = await res.json().catch(() => ({ error: "Negotiation failed." }));
      setBusy(null);
      setNegLive(null);
      return setError(json.error);
    }
    setC((cur) => (cur && !cur.negotiation ? { ...cur, negotiation: { status: "ACTIVE", max_refund: max, turns: [] } } : cur));
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const line of lines.filter(Boolean)) {
        const msg = JSON.parse(line);
        if (msg.type === "turn") setNegLive((t) => [...(t ?? []), msg.turn]);
        if (msg.type === "done") adopt(msg.case);
        if (msg.type === "error") setError(msg.error);
      }
    }
    setNegLive(null);
    setBusy(null);
  }

  async function post(path: string, body: unknown, label: string) {
    setBusy(label);
    setError(null);
    const res = await fetch(`/api/cases/${id}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json();
    setBusy(null);
    if (!res.ok) return setError(json.error);
    adopt(json);
  }

  useEffect(() => {
    fetch("/api/mode", { cache: "no-store" })
      .then((r) => r.json())
      .then((m) => {
        setSimulator(m.mode === "mock");
        setViewOnly(Boolean(m.viewOnly));
      })
      .catch(() => {});
    fetch("/api/rules", { cache: "no-store" })
      .then((r) => r.json())
      .then((rules) => typeof rules.negotiate_max_pct === "number" && setCeilingPct(rules.negotiate_max_pct))
      .catch(() => {});
  }, []);

  // Autopilot may be investigating this dispute in the background (it arrived by webhook):
  // follow its trace until it finishes.
  const background = c?.status === "ANALYZING" && busy === null;
  useEffect(() => {
    if (!background) return;
    const t = setInterval(async () => {
      const res = await fetch(`/api/cases/${id}`, { cache: "no-store" }).catch(() => null);
      if (res?.ok) adopt(await res.json());
    }, 1000);
    return () => clearInterval(t);
  }, [background, id, adopt]);

  // In the simulator, PayPal's side plays itself: a few seconds after the seller approves,
  // the buyer accepts the offer or PayPal rules, so every run reaches an end state.
  // A negotiation plays out on its own, so it gets no countdown.
  const awaiting = Boolean(c?.submitted && !c.outcome && !c.negotiation);
  useEffect(() => {
    const ended = wasAwaiting.current && !awaiting;
    wasAwaiting.current = awaiting;
    if (!awaiting) {
      setCountdown(null);
      // Bring the result into view; the seller is usually scrolled down at the approve button.
      if (ended || c?.submitted) banner.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    sentPanel.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (!simulator) return;
    setCountdown(SIMULATED_REVIEW_SECONDS);
  }, [awaiting, simulator]);
  useEffect(() => {
    if (countdown === null || busy) return;
    if (countdown <= 0) {
      setCountdown(null);
      post("ruling", { outcome: "SELLER_FAVOR" }, "ruling");
      return;
    }
    const t = setTimeout(() => setCountdown((n) => (n === null ? null : n - 1)), 1000);
    return () => clearTimeout(t);
  }, [countdown, busy]);

  if (!c && missing) return <MissingDispute id={id} onRetry={() => { setMissing(false); setLookup((n) => n + 1); }} />;
  if (!c) return <p className="text-muted">{error ?? "Loading..."}</p>;

  const d = c.dispute;
  const t = d.disputed_transactions[0];
  const r = c.recommendation;
  const trace = busy === "analyze" ? live : c.trace;
  const due = daysLeft(d.seller_response_due_date);

  return (
    <div className="space-y-6">
      <Link href="/" className="text-sm text-muted hover:text-ink">&larr; All disputes</Link>

      <section className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-sm text-muted">{d.dispute_id} &middot; invoice {t?.invoice_number}</div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t?.buyer?.name}: {REASON_LABEL[d.reason].toLowerCase()}
          </h1>
          <div className="text-muted">{t?.items?.[0]?.item_description}</div>
        </div>
        <div className="text-right">
          <div className="text-3xl font-semibold tabular">{money(d.dispute_amount.value, d.dispute_amount.currency_code)}</div>
          <div className="text-sm" style={{ color: due !== null && due <= 3 && !c.submitted ? "var(--danger)" : "var(--muted)" }}>
            {c.submitted ? statusLabel(c) : due === null ? "" : `Respond within ${due} day${due === 1 ? "" : "s"}`}
            {" "}&middot; {d.dispute_life_cycle_stage === "CHARGEBACK" ? "Chargeback" : "Inquiry"}
          </div>
        </div>
      </section>

      {error ? <p className="rounded-md border border-danger px-3 py-2 text-sm text-danger">{error}</p> : null}

      {c.outcome ? <div ref={banner}><OutcomeBanner c={c} /></div> : null}

      {c.history ? null : <NetworkBanner caseId={c.id} />}

      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <div className="space-y-6">
          {c.activity?.length ? (
            <Panel title="Alerts">
              <ol className="space-y-1.5">
                {c.activity.map((a, i) => (
                  <li key={i} className="text-sm">
                    <span className="text-muted tabular">{new Date(a.at).toLocaleTimeString()}</span> {a.text}
                  </li>
                ))}
              </ol>
            </Panel>
          ) : null}

          <Panel title="What the buyer said">
            {(d.messages ?? []).filter((m) => m.posted_by === "BUYER").map((m, i) => (
              <blockquote key={i} className="border-l-2 border-line pl-3 text-sm">&ldquo;{m.content}&rdquo;</blockquote>
            ))}
          </Panel>

          <Panel
            title="Agent investigation"
            action={
              !c.submitted && !(viewOnly && c.status !== "NEW") ? (
                <button onClick={() => analyze(c.status !== "NEW")} disabled={busy !== null} className="text-sm text-accent disabled:opacity-50">
                  {busy === "analyze" ? "Investigating..." : c.status === "NEW" ? "Investigate" : "Re-run"}
                </button>
              ) : null
            }
          >
            {trace.length === 0 && busy !== "analyze" ? <p className="text-sm text-muted">Not investigated yet.</p> : null}
            <ol className="space-y-3">
              {trace.map((s, i) => (
                <li key={i} className="flex gap-3 text-sm">
                  <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: s.kind === "error" ? "var(--danger)" : "var(--accent)" }} />
                  <div>
                    <div className="text-xs font-medium uppercase tracking-wide text-muted">{s.tool ? TOOL_LABEL[s.tool] ?? s.tool : "Agent"}</div>
                    <div>{s.summary}</div>
                  </div>
                </li>
              ))}
              {busy === "analyze" || background ? (
                <li className="flex gap-3 text-sm text-muted">
                  <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-muted" />
                  Thinking...
                </li>
              ) : null}
            </ol>
          </Panel>
        </div>

        <div className="space-y-6">
          {c.notice && r ? (
            <p role="status" className="rounded-md border px-3 py-2 text-sm" style={{ borderColor: "var(--offer)", color: "var(--offer)" }}>
              Using saved analysis. {c.notice}
            </p>
          ) : null}
          {c.status === "ERROR" && !r && busy !== "analyze" ? (
            <Panel title="Recommendation">
              <p className="text-sm">The agent couldn&apos;t finish this investigation, and there&apos;s no saved one for this dispute yet. Nothing was sent to PayPal.</p>
              <p className="text-xs text-muted">{c.error}</p>
              {!viewOnly ? <button onClick={() => analyze(true)} className="text-sm text-accent">Try again</button> : null}
            </Panel>
          ) : null}
          {r ? (
            <Panel title="Recommendation">
              <div className="flex flex-wrap items-center gap-3">
                <span className="rounded-full px-3 py-1 text-sm font-semibold text-panel" style={{ background: DECISION_COLOR[r.decision] }}>
                  {DECISION_LABEL[r.decision]}
                </span>
                <span className="text-sm text-muted tabular">{Math.round(r.win_probability * 100)}% chance PayPal rules for you if you fight</span>
              </div>
              <p className="text-lg font-medium leading-snug">{r.headline}</p>
              <p className="text-sm text-muted">{r.rationale}</p>
              {r.evidence.length ? (
                <div>
                  <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Evidence trail</h3>
                  <EvidenceGrid evidence={r.evidence} toolLabel={TOOL_LABEL} />
                </div>
              ) : null}
              {r.risks.length ? (
                <div>
                  <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Risks</h3>
                  <ul className="list-disc space-y-1 pl-5 text-sm text-muted">{r.risks.map((x, i) => <li key={i}>{x}</li>)}</ul>
                </div>
              ) : null}
            </Panel>
          ) : null}

          {r ? <WhyPanel c={c} toolLabel={TOOL_LABEL} /> : null}

          {r && !c.submitted && !c.outcome && viewOnly ? (
            <Panel title="Your response">
              <p className="text-sm text-muted">
                The live PayPal sandbox is view-only on the hosted demo, so visitors can&apos;t change it for each other. Switch to the Simulator from the inbox to approve, send offers and see PayPal&apos;s ruling.
              </p>
            </Panel>
          ) : null}

          {r && !c.submitted && !c.outcome && !viewOnly ? (
            <Panel title="Your response">
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Decision">
                {(["FIGHT", "OFFER", "REFUND"] as Decision[]).map((x) => (
                  <button
                    key={x}
                    role="radio"
                    aria-checked={decision === x}
                    onClick={() => setDecision(x)}
                    className="rounded-md border px-3 py-1.5 text-sm"
                    style={decision === x ? { borderColor: DECISION_COLOR[x], color: DECISION_COLOR[x], fontWeight: 600 } : { borderColor: "var(--line)" }}
                  >
                    {DECISION_LABEL[x]}
                    {x === r.decision ? " (recommended)" : ""}
                  </button>
                ))}
              </div>
              {decision === "OFFER" ? (
                <label className="flex items-center gap-2 text-sm">
                  Refund amount
                  <input value={offer} onChange={(e) => setOffer(e.target.value)} inputMode="decimal" className="w-28 rounded-md border border-line bg-bg px-2 py-1 tabular" />
                  <span className="text-muted">of {money(d.dispute_amount.value)}</span>
                </label>
              ) : null}
              <label className="block text-sm">
                <span className="text-muted">{decision === "FIGHT" ? "Statement sent to PayPal with the evidence" : "Note sent to PayPal"}</span>
                <textarea value={response} onChange={(e) => setResponse(e.target.value)} rows={9} maxLength={2000} className="mt-1 w-full rounded-md border border-line bg-bg p-3 text-sm leading-relaxed" />
              </label>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted tabular">{response.length}/2000</span>
                <button
                  onClick={() => post("approve", { decision, response, offer_amount: decision === "OFFER" ? Number(offer) : undefined, offer_type: r.offer_type !== "NONE" ? r.offer_type : undefined }, "approve")}
                  disabled={busy !== null || !response.trim()}
                  className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-panel disabled:opacity-60"
                >
                  {busy === "approve" ? "Sending..." : decision === "FIGHT" ? "Approve and send evidence" : decision === "OFFER" ? "Approve and send offer" : "Approve refund"}
                </button>
              </div>
              {decision === "OFFER" ? (
                <div className="space-y-2 rounded-md border border-accent bg-accent-soft p-3">
                  <p className="text-sm font-medium">Or let the agent negotiate with the buyer</p>
                  <p className="text-xs text-muted">It opens low, answers the buyer&apos;s counters with the evidence, and settles. It can never refund more than your ceiling, and the buyer never sees it.</p>
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2 text-sm">
                      Ceiling $
                      <input
                        aria-label="Negotiation ceiling"
                        value={ceiling || (Number(d.dispute_amount.value) * ceilingPct).toFixed(2)}
                        onChange={(e) => setCeiling(e.target.value)}
                        inputMode="decimal"
                        className="w-24 rounded-md border border-line bg-bg px-2 py-1 tabular"
                      />
                    </label>
                    <button
                      onClick={() => startNegotiation(Number(ceiling || (Number(d.dispute_amount.value) * ceilingPct).toFixed(2)))}
                      disabled={busy !== null}
                      className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-panel disabled:opacity-60"
                    >
                      Let the agent negotiate
                    </button>
                  </div>
                </div>
              ) : null}
            </Panel>
          ) : null}

          {c.negotiation || negLive ? (
            <div ref={negPanel}>
              <NegotiationPanel c={c.negotiation ? c : { ...c, negotiation: { status: "ACTIVE", max_refund: Number(ceiling || (Number(d.dispute_amount.value) * ceilingPct).toFixed(2)), turns: [] } }} live={negLive} busy={busy === "negotiate"} />
            </div>
          ) : null}

          {c.submitted && !c.negotiation ? (
            <div ref={sentPanel}>
            <Panel title="Sent to PayPal">
              <p className="text-sm">
                {DECISION_LABEL[c.submitted.decision]}
                {c.submitted.offer_amount ? ` of ${money(c.submitted.offer_amount)}` : ""} &middot; {c.submitted.by === "autopilot" ? "sent by autopilot" : "approved by you"} &middot; {new Date(c.submitted.at).toLocaleString()}
              </p>
              <p className="whitespace-pre-wrap rounded-md bg-bg p-3 text-sm text-muted">{c.submitted.response}</p>
              {c.submitted.receipt ? <PayPalReceiptCard id={c.id} r={c.submitted.receipt} /> : null}
              {!c.outcome && !viewOnly ? (
                <div className="space-y-2 rounded-md border border-accent bg-accent-soft p-3">
                  <p className="text-sm font-medium">
                    {busy === "ruling"
                      ? "Getting PayPal's decision..."
                      : countdown !== null
                        ? `Simulating PayPal's side: ${c.submitted.decision === "OFFER" ? "the buyer answers your offer" : "PayPal rules"} in ${countdown}s.`
                        : "Next: PayPal's review takes days in real life. Simulate the ruling to see the outcome."}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button onClick={() => { setCountdown(null); post("ruling", { outcome: "SELLER_FAVOR" }, "ruling"); }} disabled={busy !== null} className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-panel disabled:opacity-60">
                      {c.submitted.decision === "OFFER" ? "Buyer accepts offer" : "PayPal rules for seller"}
                    </button>
                    {c.submitted.decision === "FIGHT" ? (
                      <button onClick={() => { setCountdown(null); post("ruling", { outcome: "BUYER_FAVOR" }, "ruling"); }} disabled={busy !== null} className="rounded-md border border-line bg-panel px-3 py-1.5 text-sm">
                        PayPal rules for buyer
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </Panel>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const SIMULATED_REVIEW_SECONDS = 4;

function OutcomeBanner({ c }: { c: CaseRecord }) {
  const o = c.outcome!;
  const good = o.amount_kept > 0;
  const text =
    o.result === "WON" ? `PayPal ruled for you. You keep ${money(o.amount_kept)}.`
    : o.result === "SETTLED" ? `Buyer accepted your offer. You keep ${money(o.amount_kept)} of ${money(c.dispute.dispute_amount.value)}.`
    : o.result === "REFUNDED" ? `Refunded ${money(o.amount_lost)}. Case closed without a fight.`
    : `PayPal ruled for the buyer. ${money(o.amount_lost)} refunded.`;
  return (
    <div className="rounded-lg px-4 py-3 font-medium" style={{ background: good ? "var(--accent-soft)" : "var(--bg)", color: good ? "var(--accent)" : "var(--refund)", border: "1px solid var(--line)" }}>
      {text}
    </div>
  );
}

function Panel({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border border-line bg-panel p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const MONO = new Set(["Call", "PayPal-Debug-Id", "Dispute ID"]);

// Proof the response landed: what PayPal answered to the write call.
function PayPalReceiptCard({ id, r }: { id: string; r: PayPalReceipt }) {
  const sim = r.via === "simulator";
  const rows: Array<[string, string | undefined]> = [
    ["Call", `${r.method} ${r.endpoint}`],
    ["Sent through", r.via === "agent_toolkit" ? "PayPal Agent Toolkit (accept_dispute_claim)" : r.via === "rest" ? "PayPal Disputes REST API" : "Simulator (same endpoint and payload as the live sandbox)"],
    ["PayPal answered", r.http_status ? `HTTP ${r.http_status} ${r.http_status < 300 ? "accepted" : ""}`.trim() : "Accepted (no error from PayPal)"],
    ["PayPal-Debug-Id", r.debug_id],
    ["Dispute after the call", r.status_after ? `${r.status_after.replaceAll("_", " ").toLowerCase()}${r.stage_after ? `, ${r.stage_after.replaceAll("_", " ").toLowerCase()} stage` : ""}` : undefined],
    ["Dispute ID", id],
    ["At", new Date(r.at).toLocaleString()],
  ];
  return (
    <div className="rounded-md border p-3 text-sm" style={{ borderColor: sim ? "var(--line)" : "var(--accent)" }} data-testid="paypal-receipt">
      <p className="mb-2 flex flex-wrap items-center gap-2 font-medium">
        <span aria-hidden style={{ color: "var(--fight)" }}>✓</span>
        {sim ? "Simulated PayPal response" : "PayPal accepted it"}
        <span className="rounded px-1.5 py-0.5 text-xs" style={{ background: sim ? "var(--bg)" : "var(--accent-soft)", color: sim ? "var(--muted)" : "var(--accent)" }}>
          {sim ? "Simulator" : "Live PayPal sandbox"}
        </span>
      </p>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[11rem_1fr]">
        {rows.filter(([, v]) => v).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className={MONO.has(k) ? "break-all font-mono text-xs leading-5" : ""}>{v}</dd>
          </div>
        ))}
      </dl>
      {sim ? (
        <p className="mt-2 text-xs text-muted">Switch to Live PayPal sandbox to see the real response from api-m.sandbox.paypal.com.</p>
      ) : (
        <p className="mt-2 text-xs text-muted">
          Check it on PayPal&apos;s side:{" "}
          <a href="https://www.sandbox.paypal.com/resolutioncenter" target="_blank" rel="noreferrer" className="text-accent underline">sandbox Resolution Center</a>{" "}
          (sign in as the sandbox seller, open dispute {id}).
        </p>
      )}
    </div>
  );
}

// A dispute link that doesn't open: an old or shared link, the other mode, or a demo server
// that restarted and re-seeded. Say why and give a way out instead of a bare error.
function MissingDispute({ id, onRetry }: { id: string; onRetry: () => void }) {
  const { data, switchMode } = useCases();
  const other = data?.mode === "sandbox" ? "mock" : data?.sandboxAvailable ? "sandbox" : null;
  return (
    <div className="space-y-4">
      <Link href="/" className="text-sm text-muted hover:text-ink">&larr; All disputes</Link>
      <section className="rounded-lg border border-line bg-panel p-4 sm:p-6">
        <h1 className="text-lg font-semibold">Dispute {id} isn&apos;t in this inbox</h1>
        <p className="mt-2 max-w-prose text-sm text-muted">
          {data?.mode === "sandbox" ? "You're looking at the live PayPal sandbox." : "You're in the Simulator, which is a private copy of the shop for each browser."}{" "}
          A link copied from someone else&apos;s Simulator, a dispute from the other mode, or a demo server that has just restarted all land here. Your own disputes are one click away.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/" className={BUTTON.primary}>Open all disputes</Link>
          {other ? (
            <button className={BUTTON.secondary} onClick={async () => { await switchMode(other); onRetry(); }}>
              Look in the {other === "sandbox" ? "live PayPal sandbox" : "Simulator"}
            </button>
          ) : null}
          <button className={BUTTON.ghost} onClick={onRetry}>Try again</button>
        </div>
      </section>
    </div>
  );
}
