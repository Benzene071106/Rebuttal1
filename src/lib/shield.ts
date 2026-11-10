// Dispute shield: before the seller ships a paid order, the AI checks how likely it is to
// come back as a dispute and what to do about it now, while the seller still can (ask
// for a signature, confirm the address, hold the parcel). It reads the PayPal order with
// the Agent Toolkit's get_order and the buyer's history, including every dispute
// Rebuttal has handled for that buyer ("dispute memory").

import { currentShop, describeShop, type Shop } from "./shop";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { listCases, syncCases } from "./cases";
import { networkFor } from "./network";
import { PENDING_ORDERS } from "./demo/orders";
import { defaultModel, type AgentModel } from "./model";
import type { ChatEntry, ToolResult } from "./model/types";
import { paypal } from "./paypal";
import type { ToolDef } from "./paypal/gateway";
import { getStoreRecords } from "./store-records";
import type { PayPalReceipt, TraceStep } from "./types";
import { lruGet, visitor } from "./visitor";
import { asActor } from "./trail";

export type RiskSignal = { finding: string; effect: "RAISES" | "LOWERS"; source: string; weight?: number };
export type RiskVerdict = { risk: "LOW" | "MEDIUM" | "HIGH"; score: number; headline: string; signals: RiskSignal[]; actions: string[] };
// What the seller chose to do before shipping (see preship.ts). One per order.
export type OrderDecision = { action: "REFUND" | "SIGNATURE" | "PAYPAL_ADDRESS"; at: string; receipt: PayPalReceipt | null };

export type ShieldCheck = {
  order_id: string;
  invoice_id: string;
  status: "CHECKING" | "READY" | "ERROR";
  verdict?: RiskVerdict;
  trace: TraceStep[];
  model?: string;
  error?: string;
  // Set when the AI couldn't explain the check and the seller sees the rule-based one.
  notice?: string;
  decision?: OrderDecision;
  at: string;
};

const MAX_TURNS = 8;
const REPLAY_STEP_MS = 350;

const system = (shop: Shop) => `You protect ${describeShop(shop)} paid through PayPal, from disputes before they happen. A buyer has just paid and the order has not shipped yet. Decide how likely this order is to end in a PayPal dispute or chargeback, and what the seller should do before shipping.

A fixed rule-based check has already scored the order; you are told its score, band and the signals behind it. You do not change the score or the band. Read the PayPal order with get_order and the buyer's history with get_buyer_history, then call submit_risk exactly once with a headline that explains the result and the steps to take.

What matters:
- Shipping somewhere other than the buyer's PayPal address, especially a package forwarder or a different recipient name. PayPal Seller Protection generally only covers items shipped to the address on the transaction.
- A first-time buyer, an unverified PayPal account, an expensive order, and paid overnight shipping together, which is the usual pattern of stolen-account fraud.
- Past disputes the buyer filed with this shop, and whether the shop's evidence contradicted them (for example a "not received" claim on a parcel signed for by the buyer). Say this plainly; it is the strongest signal.
- Reports from other Rebuttal shops (network) on the same PayPal account, where their evidence contradicted the buyer's claim. Name it as the Rebuttal network.
- A repeat buyer with completed orders and no disputes lowers the risk.

Rules:
- Use only facts from tool results. Never invent facts.
- The headline must agree with the band you were given.
- actions are 1 to 3 short, imperative steps the seller can take before shipping, cheapest first: for example message the buyer through PayPal to confirm the order, ship only to the address on the PayPal transaction, require signature confirmation, keep a packing photo, hold the parcel, or refund before shipping. For LOW risk, say to ship as normal.
- Be fair to the buyer: a single weak signal is not fraud. Explain it in the headline, in one sentence a busy seller reads first.`;

const SUBMIT_TOOL: ToolDef = {
  name: "submit_risk",
  description: "Submit the dispute-risk check for this order. Call once, after reading the order and the buyer's history.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["headline", "actions"],
    properties: {
      headline: { type: "string", description: "One sentence the seller reads first, explaining the given risk band." },
      actions: { type: "array", items: { type: "string" }, description: "1 to 3 steps before shipping." },
    },
  },
};

const HISTORY_TOOL: ToolDef = {
  name: "get_buyer_history",
  description:
    "Look up a buyer's history with the shop by their PayPal email: completed orders, and every dispute they have filed that Rebuttal handled, with what the shop's evidence showed (carrier delivery, signature) and how it ended, plus reports on the same PayPal account from other shops in the Rebuttal network.",
  input_schema: {
    type: "object",
    properties: { email: { type: "string", description: "The buyer's PayPal email address, from the order's payer." } },
    required: ["email"],
    additionalProperties: false,
  },
};

const ExplainSchema = z.object({
  headline: z.string().min(1),
  actions: z.array(z.string().min(1)).min(1).max(4),
});

// ---- Rule-based risk score -------------------------------------------------------
// The score and band come from fixed weights, so the same order and the same buyer
// history always give the same level. The model only explains the result.

export const RISK_WEIGHTS = {
  base: 10,
  addressMismatch: 15,
  recipientMismatch: 10,
  forwarder: 15,
  unverified: 10,
  firstTime: 10,
  overnight: 10,
  highValue: 5, // $200 and over
  pastDispute: 45, // first dispute this buyer filed with the shop
  morePastDisputes: 15, // each further one
  contradicted: 15, // the shop's evidence contradicted a past claim (signed for, delivered)
  cleanRepeat: -5, // completed orders and no disputes
  networkFirst: 20, // another Rebuttal shop reported this account
  networkMore: 5, // each further shop
} as const;

export type RuleCheck = { score: number; risk: RiskVerdict["risk"]; signals: RiskSignal[] };
type BuyerHistory = Awaited<ReturnType<typeof getBuyerHistory>>;

const FORWARDER = /forward|c\/o\b|#fwd|reship|freight|parcel ?bridge|shipito|myus/i;
const norm = (x: unknown) => String(x ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

export function scoreOrder(order: any, history: Pick<BuyerHistory, "completed_orders" | "disputes"> & { network?: BuyerHistory["network"] }): RuleCheck {
  const W = RISK_WEIGHTS;
  const signals: RiskSignal[] = [];
  let score: number = W.base;
  const add = (weight: number, finding: string, source: string) => {
    score += weight;
    signals.push({ finding, effect: weight >= 0 ? "RAISES" : "LOWERS", source, weight });
  };
  const pu = order?.purchase_units?.[0] ?? {};
  const ship = pu.shipping ?? {};
  const payer = order?.payer ?? {};
  const payerAddr = payer.address ?? order?.payment_source?.paypal?.address;
  const shipAddr = ship.address;
  const payerName = [payer.name?.given_name, payer.name?.surname].filter(Boolean).join(" ");
  const shipName = String(ship.name?.full_name ?? "");
  const amount = Number(pu.amount?.value ?? 0);
  const option = (ship.options ?? []).find((o: any) => o.selected) ?? {};

  if (payerAddr && shipAddr && (norm(payerAddr.address_line_1) !== norm(shipAddr.address_line_1) || norm(payerAddr.postal_code) !== norm(shipAddr.postal_code)))
    add(W.addressMismatch, `Ships to ${[shipAddr.address_line_1, shipAddr.admin_area_2].filter(Boolean).join(", ")}, not the buyer's PayPal address. Seller Protection generally covers only the address on the transaction.`, "get_order");
  const surname = norm(payer.name?.surname);
  if (shipName && surname && !norm(shipName).includes(surname)) add(W.recipientMismatch, `The parcel is addressed to ${shipName}, not the PayPal payer ${payerName}.`, "get_order");
  if (FORWARDER.test(`${shipName} ${shipAddr?.address_line_1 ?? ""}`)) add(W.forwarder, "The shipping address looks like a package forwarder.", "get_order");
  const status = order?.payment_source?.paypal?.account_status;
  if (status === "UNVERIFIED") add(W.unverified, "The buyer's PayPal account is unverified.", "get_order");
  if (/overnight|express|next.?day/i.test(`${option.id ?? ""} ${option.label ?? ""}`)) add(W.overnight, `The buyer paid for ${option.label ?? "overnight shipping"}.`, "get_order");
  if (amount >= 200) add(W.highValue, `A high-value order ($${amount.toFixed(2)}).`, "get_order");

  const disputes = history.disputes ?? [];
  if (!disputes.length && history.completed_orders === 0) add(W.firstTime, "First order from this buyer.", "get_buyer_history");
  disputes.forEach((d, i) => {
    const label = String(d.reason ?? "").toLowerCase().replaceAll("_", " ");
    add(i === 0 ? W.pastDispute : W.morePastDisputes, `Filed a "${label}" dispute on ${d.invoice_id} (${String(d.outcome).toLowerCase()}).`, "get_buyer_history");
    const ev = d.shop_evidence;
    if (ev?.signed_by && /NOT_RECEIVED/.test(String(d.reason))) add(W.contradicted, `That parcel was signed for by ${ev.signed_by}, which contradicts the claim.`, "get_buyer_history");
  });
  const net = history.network;
  if (net?.other_shops) {
    const claims = [...new Set(net.reports.map((x) => String(x.claim).toLowerCase().replaceAll("_", " ").replace("merchandise or service ", "item ")))].join(", ");
    add(W.networkFirst + W.networkMore * (net.other_shops - 1), `Rebuttal network: ${net.other_shops} other shop${net.other_shops === 1 ? "" : "s"} reported this PayPal account (${claims}) after their evidence contradicted the claim.`, "rebuttal_network");
  }
  if (!disputes.length && !net?.other_shops && history.completed_orders > 0) {
    const n = history.completed_orders;
    add(W.cleanRepeat, `Repeat buyer: ${n} completed order${n === 1 ? "" : "s"} and no disputes.`, "get_buyer_history");
  }
  if (status === "VERIFIED" && !signals.some((x) => x.source === "get_order" && x.effect === "RAISES"))
    signals.push({ finding: "Verified PayPal account, shipping to the address on the payment.", effect: "LOWERS", source: "get_order", weight: 0 });

  score = Math.max(0, Math.min(100, score));
  return { score, risk: bandOf(score), signals };
}

// What the seller sees if the model can't explain the check: the same score, in plain steps.
export function ruleVerdict(rule: RuleCheck): RiskVerdict {
  const top = rule.signals.filter((x) => x.effect === "RAISES").sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0];
  const headline =
    rule.risk === "LOW" ? "Low dispute risk: ship as normal." : `${rule.risk === "HIGH" ? "High" : "Medium"} dispute risk: ${top ? top.finding.charAt(0).toLowerCase() + top.finding.slice(1) : "check before shipping."}`;
  const actions =
    rule.risk === "LOW"
      ? ["Ship as normal with tracking."]
      : rule.risk === "MEDIUM"
        ? ["Message the buyer through PayPal to confirm the order.", "Ship only to the address on the PayPal transaction, with tracking."]
        : ["Message the buyer through PayPal to confirm the order before shipping.", "Ship only to the address on the PayPal transaction, with signature confirmation.", "If the buyer can't confirm, refund before shipping."];
  return { ...rule, headline, actions };
}

// The buyer's history with the shop: completed orders, plus Rebuttal's memory of every
// dispute they filed, with the evidence the shop had and how it ended.
export async function getBuyerHistory(email: string) {
  const key = email.trim().toLowerCase();
  const order = PENDING_ORDERS.find((o) => o.buyer.email === key);
  const disputes = await Promise.all(
    (await listCases())
      .filter((c) => c.dispute.disputed_transactions[0]?.buyer?.email?.toLowerCase() === key)
      .map(async (c) => {
        const t = c.dispute.disputed_transactions[0];
        const store = await getStoreRecords(t.invoice_number ?? "");
        const f = "fulfillment" in store ? store.fulfillment : undefined;
        return {
          invoice_id: t.invoice_number,
          dispute_id: c.id,
          reason: c.dispute.reason,
          amount: c.dispute.dispute_amount,
          opened: c.dispute.create_time.slice(0, 10),
          paypal_status: c.dispute.status,
          shop_evidence: f
            ? { carrier: f.carrier, last_scan: f.carrier_events.at(-1)?.status ?? null, signature_required: f.signature_required, signed_by: f.signed_by }
            : null,
          rebuttal_assessment: c.recommendation ? { decision: c.recommendation.decision, headline: c.recommendation.headline } : null,
          outcome: c.outcome ? c.outcome.result : "OPEN",
        };
      }),
  );
  const net = await networkFor(key);
  return {
    email: key,
    completed_orders: order?.prior_purchases ?? 0,
    disputes_filed: disputes.length,
    disputes,
    // Other Rebuttal shops' reports on this PayPal account (hashed; no other shop's data).
    network: {
      other_shops: net.other_shops,
      reports: net.reports.map((r) => ({ claim: r.reason, evidence: r.evidence, outcome: r.outcome, reported: r.at.slice(0, 10) })),
    },
  };
}

type AssessOptions = { model?: AgentModel; onStep?: (s: TraceStep) => void; rule?: RuleCheck };

// The agent's order reads go on the API trail as the agent's.
export function assessOrder(orderId: string, opts: AssessOptions = {}): Promise<{ verdict: RiskVerdict; trace: TraceStep[]; model: string }> {
  return asActor("agent", () => checkOrder(orderId, opts), null);
}

async function checkOrder(orderId: string, opts: AssessOptions): Promise<{ verdict: RiskVerdict; trace: TraceStep[]; model: string }> {
  const model = opts.model ?? defaultModel();
  const gw = paypal();
  const rule = opts.rule ?? (await ruleFor(orderId));
  const trace: TraceStep[] = [];
  const step = (s: Omit<TraceStep, "at">) => {
    const full = { ...s, at: new Date().toISOString() };
    trace.push(full);
    opts.onStep?.(full);
  };
  const tools: ToolDef[] = [...gw.agentTools().filter((t) => t.name === "get_order"), HISTORY_TOOL, SUBMIT_TOOL];
  const history: ChatEntry[] = [
    {
      role: "user",
      text: `PayPal order ${orderId} was just paid and has not shipped. The rule-based check scored it ${rule.score}/100, ${rule.risk} risk, from these signals:\n${rule.signals.map((x) => `- ${x.effect === "RAISES" ? "+" : ""}${x.weight ?? 0}: ${x.finding}`).join("\n")}\nRead the order and the buyer's history, then submit a headline explaining this ${rule.risk} result and the steps to take before shipping.`,
    },
  ];

  let nudged = false;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await model.next({ system: system(currentShop()), tools, history });
    if (res.stop === "refusal") throw new Error("The model declined to check this order.");
    if (res.stop === "max_tokens") throw new Error("The check ran out of output space.");
    history.push({ role: "assistant", turn: res });
    if (res.calls.length === 0) {
      if (nudged) throw new Error("The model finished without a risk check.");
      nudged = true;
      history.push({ role: "user", text: "Call submit_risk now." });
      continue;
    }
    const results: ToolResult[] = [];
    for (const use of res.calls) {
      const reply = (content: string, isError?: boolean) => results.push({ id: use.id, name: use.name, content, ...(isError ? { isError } : {}) });
      if (use.name === SUBMIT_TOOL.name) {
        const parsed = ExplainSchema.safeParse(use.input);
        if (parsed.success) {
          const v: RiskVerdict = { ...rule, ...parsed.data };
          step({ kind: "note", summary: `Risk: ${v.risk} (${Math.round(v.score)}/100)` });
          return { verdict: v, trace, model: `${model.provider}:${model.model}` };
        }
        reply(`Invalid risk check: ${parsed.error.message}`, true);
        continue;
      }
      try {
        const out = use.name === HISTORY_TOOL.name ? await getBuyerHistory(String(use.input.email ?? "")) : await gw.runTool(use.name, use.input);
        step({ kind: "tool", tool: use.name, input: use.input, summary: summarizeShield(use.name, out) });
        reply(JSON.stringify(out));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        step({ kind: "error", tool: use.name, input: use.input, summary: msg });
        reply(msg, true);
      }
    }
    history.push({ role: "tool", results });
  }
  throw new Error("The check did not finish within its step limit.");
}

async function ruleFor(orderId: string) {
  const order = (await paypal().runTool("get_order", { id: orderId })) as any;
  return scoreOrder(order, await getBuyerHistory(order?.payer?.email_address ?? ""));
}

const bandOf = (score: number): RiskVerdict["risk"] => (score >= 65 ? "HIGH" : score >= 30 ? "MEDIUM" : "LOW");

function summarizeShield(tool: string, out: unknown): string {
  const o = (out ?? {}) as Record<string, any>;
  if (tool === "get_order") {
    const pu = o.purchase_units?.[0];
    const a = pu?.shipping?.address;
    return `Order ${o.id}: $${pu?.amount?.value}, ${pu?.shipping?.options?.find((x: any) => x.selected)?.label ?? "shipping"}, ships to ${pu?.shipping?.name?.full_name ?? "?"} in ${a?.admin_area_2 ?? "?"}, ${a?.admin_area_1 ?? ""}`;
  }
  if (tool === "get_buyer_history") {
    const n = o.disputes_filed ?? 0;
    const net = o.network?.other_shops ?? 0;
    return `${o.completed_orders ?? 0} completed order${o.completed_orders === 1 ? "" : "s"}, ${n} past dispute${n === 1 ? "" : "s"}${n ? ` (${o.disputes.map((d: any) => d.invoice_id).join(", ")})` : ""}${net ? `; reported by ${net} other Rebuttal shop${net === 1 ? "" : "s"}` : ""}`;
  }
  return "Done";
}

// Per-visitor results in the simulator, like cases; the live sandbox has no orders yet.
const g = globalThis as unknown as { __rebuttalShield?: Map<string, Map<string, ShieldCheck>> };
function store(): Map<string, ShieldCheck> {
  g.__rebuttalShield ??= new Map();
  return lruGet(g.__rebuttalShield, `${visitor().mode}:${visitor().id}`, () => new Map());
}

export function resetShield() {
  g.__rebuttalShield?.delete(`${visitor().mode}:${visitor().id}`);
}

// to_review: flagged MEDIUM or HIGH and the seller hasn't acted on it yet.
export type ShieldRow = ShieldCheck & { buyer: string; item: string; amount: string; ship_to: string; to_review: boolean };

export async function listShield(): Promise<ShieldRow[]> {
  const gw = paypal();
  const s = store();
  return Promise.all(
    (await gw.ordersAwaitingShipment()).map(async (o) => {
      const order = (await gw.runTool("get_order", { id: o.order_id })) as any;
      const pu = order.purchase_units?.[0];
      const a = pu?.shipping?.address;
      const check: ShieldCheck = s.get(o.order_id) ?? { ...o, status: "CHECKING" as const, trace: [], at: new Date().toISOString() };
      return {
        ...check,
        to_review: Boolean(check.verdict && check.verdict.risk !== "LOW" && !check.decision),
        buyer: [order.payer?.name?.given_name, order.payer?.name?.surname].filter(Boolean).join(" "),
        item: pu?.items?.[0]?.name ?? "",
        amount: pu?.amount?.value ?? "0",
        ship_to: `${pu?.shipping?.name?.full_name ?? ""}, ${a?.admin_area_2 ?? ""}, ${a?.admin_area_1 ?? ""}`,
      };
    }),
  );
}

// Marks the orders nobody has checked yet and returns their ids, so the caller can
// check them in the background.
export async function claimUnchecked(): Promise<string[]> {
  const s = store();
  const todo: string[] = [];
  for (const o of await paypal().ordersAwaitingShipment()) {
    if (s.has(o.order_id)) continue;
    s.set(o.order_id, { ...o, status: "CHECKING", trace: [], at: new Date().toISOString() });
    todo.push(o.order_id);
  }
  return todo;
}

// Runs (or replays) the check for one order and stores the result.
export async function runShield(orderId: string, opts: { fresh?: boolean; model?: AgentModel } = {}): Promise<ShieldCheck> {
  const s = store();
  const meta = (await paypal().ordersAwaitingShipment()).find((o) => o.order_id === orderId);
  if (!meta) throw new Error(`No order ${orderId} awaiting shipment.`);
  const decision = s.get(orderId)?.decision;
  const base: ShieldCheck = { ...meta, status: "CHECKING", trace: [], at: new Date().toISOString(), ...(decision ? { decision } : {}) };
  s.set(orderId, base);
  const onStep = (st: TraceStep) => s.set(orderId, { ...s.get(orderId)!, trace: [...(s.get(orderId)?.trace ?? []), st] });
  try {
    await syncCases(); // dispute memory needs the current cases
    const order = (await paypal().runTool("get_order", { id: orderId })) as any;
    const memory = await getBuyerHistory(order?.payer?.email_address ?? "");
    const rule = scoreOrder(order, memory);
    const key = shieldKey(meta.invoice_id, memory);
    const saved = loadCheck(key);
    const replay = async (from: SavedCheck, why: string) => {
      onStep({ at: new Date().toISOString(), kind: "note", summary: why });
      for (const st of from.trace.filter((t) => t.kind !== "note")) {
        await new Promise((r) => setTimeout(r, REPLAY_STEP_MS));
        onStep({ ...st, at: new Date().toISOString() });
      }
      onStep({ at: new Date().toISOString(), kind: "note", summary: `Risk: ${rule.risk} (${rule.score}/100)` });
      // The saved run only supplies the wording; the score is always today's rule score.
      return done(orderId, { status: "READY", verdict: { ...rule, headline: from.verdict.headline, actions: from.verdict.actions }, model: from.model });
    };
    if (saved && !opts.fresh) return await replay(saved, `Saved check from ${saved.saved_at.slice(0, 10)} (${saved.model}). Re-check for a fresh one.`);
    try {
      const out = await assessOrder(orderId, { model: opts.model, onStep, rule });
      if (!opts.model) saveCheck(key, out);
      return done(orderId, { status: "READY", verdict: out.verdict, model: out.model });
    } catch (e) {
      // The AI is down or out of quota: the score never depended on it, so show it anyway.
      const why = e instanceof Error ? e.message : String(e);
      console.warn("Shield explanation failed, using the rule-based check:", why);
      if (saved) return await replay(saved, "The AI model is busy right now, so this uses the saved explanation. The risk score is calculated fresh.");
      onStep({ at: new Date().toISOString(), kind: "note", summary: `Risk: ${rule.risk} (${rule.score}/100)` });
      return done(orderId, { status: "READY", verdict: ruleVerdict(rule), model: "rules", notice: "The AI model is busy right now, so this is the rule-based check without the AI's explanation." });
    }
  } catch (e) {
    return done(orderId, { status: "ERROR", error: e instanceof Error ? e.message : String(e) });
  }
}

export function shieldDecision(orderId: string): OrderDecision | undefined {
  return store().get(orderId)?.decision;
}

export function saveDecision(meta: { order_id: string; invoice_id: string }, decision: OrderDecision) {
  const s = store();
  s.set(meta.order_id, { ...(s.get(meta.order_id) ?? { ...meta, status: "CHECKING" as const, trace: [], at: new Date().toISOString() }), decision });
}

function done(orderId: string, patch: Partial<ShieldCheck>): ShieldCheck {
  const s = store();
  const next = { ...s.get(orderId)!, ...patch, at: new Date().toISOString() };
  s.set(orderId, next);
  return next;
}

// Saved checks, like saved investigations: keyed by the order and the buyer's dispute
// memory, so a new dispute from the same buyer asks the model again.
const dir = () => path.join(process.env.REBUTTAL_CACHE_DIR ?? path.join(process.cwd(), "cache", "investigations"), "..", "shield");
function shieldKey(invoice: string, memory: Awaited<ReturnType<typeof getBuyerHistory>>) {
  const facts = { invoice, disputes: memory.disputes.map((d) => [d.invoice_id, d.reason, d.outcome]) };
  return `${invoice.replace(/[^A-Za-z0-9_-]/g, "")}-${crypto.createHash("sha256").update(JSON.stringify(facts)).digest("hex").slice(0, 12)}`;
}
type SavedCheck = { key: string; saved_at: string; model: string; verdict: RiskVerdict; trace: TraceStep[] };
function loadCheck(key: string): SavedCheck | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir(), `${key}.json`), "utf8")) as SavedCheck;
  } catch {
    return null;
  }
}
function saveCheck(key: string, out: { verdict: RiskVerdict; trace: TraceStep[]; model: string }) {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(path.join(dir(), `${key}.json`), JSON.stringify({ key, saved_at: new Date().toISOString(), ...out }, null, 2));
  } catch (e) {
    console.warn("Could not save shield check:", e instanceof Error ? e.message : e);
  }
}
