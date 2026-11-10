// The negotiator: on a partial-refund case the agent haggles with the buyer itself,
// through PayPal's dispute offers, inside a ceiling the seller sets. The model chooses
// each move and writes each message; code enforces the money: never above the
// ceiling, never backwards, never more than the buyer asked for.

import { currentShop, describeShop, type Shop } from "./shop";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { outcomeFor } from "./actions";
import { addActivity, getCase, updateCase } from "./cases";
import { plainError } from "./errors";
import { defaultModel, type AgentModel } from "./model";
import type { ChatEntry } from "./model/types";
import { paypal } from "./paypal";
import type { ToolDef } from "./paypal/gateway";
import { RecoveryPausedError, withRecovery } from "./recovery";
import { getRules } from "./rules";
import type { CaseRecord, Dispute, Negotiation, NegotiationTurn } from "./types";
import { tenant } from "./visitor";

const MAX_AGENT_MOVES = 4;
const BUYER_WAIT_MS = 6_000;
const REPLAY_MS = 1_200;

type Move = { action: "OFFER" | "ACCEPT" | "STOP"; amount: number; message: string; reasoning: string };

const MOVE_TOOL: ToolDef = {
  name: "negotiation_move",
  description: "Make your next move in the negotiation. Call exactly once.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["action", "amount", "message", "reasoning"],
    properties: {
      action: { type: "string", enum: ["OFFER", "ACCEPT", "STOP"], description: "OFFER a refund amount, ACCEPT the buyer's current ask, or STOP and hand the case back to the seller." },
      amount: { type: "number", description: "OFFER: the refund you offer. ACCEPT: the buyer's ask. STOP: 0." },
      message: { type: "string", description: "What the buyer reads, in the seller's voice. Empty for STOP." },
      reasoning: { type: "string", description: "One or two sentences for the seller on why this move. Never sent to the buyer." },
    },
  },
};

const system = (shop: Shop) => `You negotiate a PayPal dispute for ${describeShop(shop)}, by trading partial-refund offers with the buyer through PayPal. The seller's goal is to settle fairly for as little refund as is reasonable, quickly, without the buyer escalating to PayPal.

How to negotiate:
- Ground every argument in the facts from the investigation (listing text, delivery records, what actually went wrong). Acknowledge what the seller got wrong.
- Concede in shrinking steps. Never offer less than your previous offer.
- You have a hard ceiling. Never offer above it and never mention it, or that one exists, to the buyer.
- ACCEPT when the buyer's ask is at or under the ceiling and haggling further would risk losing the deal for a few dollars.
- STOP when the buyer insists on more than the ceiling and further offers won't move them; the seller then decides whether to fight.
- Messages: warm, plain, under 450 characters, no legal threats, sign off as "${shop.name}".`;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const money = (n: number) => `$${n.toFixed(2)}`;
const round2 = (n: number) => Math.round(n * 100) / 100;
const running = new Set<string>();

// Starts a negotiation (maxRefund required) or continues one when the buyer has
// answered. Returns when the deal settles, is handed back, or the buyer hasn't answered
// yet (a webhook continues it then).
export async function negotiate(caseId: string, opts: { maxRefund?: number; onTurn?: (t: NegotiationTurn) => void; model?: AgentModel; waitMs?: number } = {}): Promise<CaseRecord> {
  let c = await getCase(caseId);
  if (!c) throw new Error(`Unknown case ${caseId}`);
  const r = c.recommendation;
  if (!r) throw new Error("Investigate the dispute before negotiating.");
  if (c.outcome) throw new Error("This dispute is already closed.");
  const amount = Number(c.dispute.dispute_amount.value);

  // A handed-back negotiation can be started again with a new ceiling (say after a
  // PayPal outage stopped it), as long as no offer is still waiting on the buyer.
  const restart = c.negotiation?.status === "HANDED_BACK" && opts.maxRefund !== undefined && !c.submitted;
  if (!c.negotiation || restart) {
    if (c.submitted) throw new Error("A response was already sent for this dispute.");
    const max = round2(Number(opts.maxRefund));
    if (!(max > 0 && max < amount)) throw new Error(`The negotiation ceiling must be between $0 and ${money(amount)}.`);
    // The seller's autopilot rule "Negotiator may refund at most N%" is a hard limit,
    // whoever sends the request.
    const pct = (await getRules()).negotiate_max_pct;
    const cap = round2(amount * pct);
    if (max > cap) throw new Error(`Your rules let the negotiator refund at most ${Math.round(pct * 100)}% (${money(cap)}) of this dispute. Lower the ceiling or change Autopilot rules.`);
    c = await updateCase(caseId, { negotiation: { status: "ACTIVE", max_refund: max, turns: [] } });
  } else if (c.negotiation.status === "SETTLED" || c.negotiation.status === "HANDED_BACK") {
    return c;
  }

  const lock = `${tenant()}:${caseId}`;
  if (running.has(lock)) throw new Error("The agent is already negotiating this dispute.");
  running.add(lock);
  const gw = paypal();
  const neg = async () => (await getCase(caseId))!.negotiation!;
  const save = async (patch: Partial<Negotiation>) => updateCase(caseId, { negotiation: { ...(await neg()), ...patch } });
  const push = async (t: NegotiationTurn) => {
    await save({ turns: [...(await neg()).turns, t] });
    opts.onTurn?.(t);
  };

  try {
    for (;;) {
      let d = await gw.getDispute(caseId);
      // The last move was ours: give the buyer a moment to answer.
      if ((await neg()).turns.at(-1)?.from === "AGENT") {
        const before = buyerMessages(d).length;
        const until = Date.now() + (opts.waitMs ?? BUYER_WAIT_MS);
        while (buyerMessages(d).length === before && !d.dispute_outcome && d.status !== "UNDER_REVIEW" && Date.now() < until) {
          await new Promise((res) => setTimeout(res, 400));
          d = await gw.getDispute(caseId);
        }
        const fresh = buyerMessages(d).slice(before);
        for (const [i, m] of fresh.entries()) await push({ at: new Date().toISOString(), from: "BUYER", text: m.content, amount: i === fresh.length - 1 && !d.dispute_outcome && d.status !== "UNDER_REVIEW" ? askOf(d) : undefined });
        if (!fresh.length && !d.dispute_outcome && d.status !== "UNDER_REVIEW") {
          await save({ status: "WAITING_FOR_BUYER" });
          return await updateCase(caseId, { dispute: d });
        }
      }

      if (d.dispute_outcome) {
        const o = outcomeFor(d, "OFFER");
        await save({ status: "SETTLED" });
        const agentMoves = (await neg()).turns.filter((t) => t.from === "AGENT").length;
        await addActivity(caseId, `The agent settled with the buyer at ${money(o?.amount_lost ?? 0)} after ${agentMoves} offer${agentMoves === 1 ? "" : "s"}. You keep ${money(o?.amount_kept ?? 0)}.`, "good");
        return await updateCase(caseId, { dispute: d, outcome: o, status: o?.result ?? "SETTLED" });
      }
      if (d.status === "UNDER_REVIEW") return await handBack(caseId, d, "The buyer stopped negotiating and asked PayPal to decide. You can still send evidence.");
      if ((await neg()).turns.filter((t) => t.from === "AGENT").length >= MAX_AGENT_MOVES) return await handBack(caseId, d, `No deal after ${MAX_AGENT_MOVES} offers, so the agent stopped. Decide whether to fight or offer more.`);

      const ask = askOf(d) ?? amount;
      const move = await decideMove((await getCase(caseId))!, d, ask, opts.model);
      if (move.action === "STOP") {
        await push({ at: new Date().toISOString(), from: "AGENT", text: "", reasoning: move.reasoning, by: move.by });
        return await handBack(caseId, d, `The agent stopped: ${move.reasoning}`);
      }
      const offer = move.action === "ACCEPT" ? ask : move.amount;
      // Same self-healing as a seller's own offer: outages and expired tokens are retried.
      await withRecovery((await getCase(caseId))!, "OFFER", offer, () => gw.makeOffer(caseId, { amount: offer.toFixed(2), currency: d.dispute_amount.currency_code, type: "REFUND", note: move.message, negotiating: true }));
      await push({ at: new Date().toISOString(), from: "AGENT", text: move.message, amount: offer, reasoning: move.reasoning, by: move.by });
      const first = !(await getCase(caseId))!.submitted;
      await updateCase(caseId, {
        status: "SUBMITTED",
        submitted: { decision: "OFFER", at: new Date().toISOString(), response: move.message, offer_amount: offer, by: "seller" },
      });
      if (first) await addActivity(caseId, `The agent opened a negotiation with the buyer: offered ${money(offer)}.`);
      await save({ status: "ACTIVE" });
    }
  } catch (e) {
    const d = await gw.getDispute(caseId).catch(async () => (await getCase(caseId))!.dispute);
    return await handBack(caseId, d, e instanceof RecoveryPausedError ? `PayPal refused the offer. ${e.message}` : `PayPal refused the offer: ${plainError(e)}`);
  } finally {
    running.delete(lock);
  }
}

async function handBack(caseId: string, d: Dispute, note: string): Promise<CaseRecord> {
  const c = (await getCase(caseId))!;
  await updateCase(caseId, { negotiation: { ...c.negotiation!, status: "HANDED_BACK", note }, dispute: d });
  await addActivity(caseId, `Negotiation handed back to you. ${note}`, "warn");
  // With no offer on the table the seller can choose again (fight, or offer more).
  return c.submitted && d.status !== "WAITING_FOR_BUYER_RESPONSE" ? await updateCase(caseId, { submitted: undefined, status: "READY" }) : (await getCase(caseId))!;
}

const buyerMessages = (d: Dispute) => (d.messages ?? []).filter((m) => m.posted_by === "BUYER");
const askOf = (d: Dispute) => (d.offer?.buyer_requested_amount ? Number(d.offer.buyer_requested_amount.value) : undefined);

// One move: a saved move for this exact conversation, else the model (validated, with
// one retry), else the rule-based fallback.
async function decideMove(c: CaseRecord, d: Dispute, ask: number, injected?: AgentModel): Promise<Move & { by: "model" | "rules" }> {
  const n = c.negotiation!;
  const lastOffer = [...n.turns].reverse().find((t) => t.from === "AGENT" && t.amount)?.amount ?? 0;
  const key = moveKey(c, ask);
  const saved = loadMove(key);
  if (saved && !validate(saved, n.max_refund, lastOffer, ask)) {
    await new Promise((res) => setTimeout(res, REPLAY_MS));
    return { ...saved, by: "model" };
  }

  let model: AgentModel | undefined = injected;
  try {
    model ??= defaultModel();
  } catch {
    model = undefined;
  }
  if (model) {
    const history: ChatEntry[] = [{ role: "user", text: brief(c, d, ask, lastOffer) }];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await model.next({ system: system(currentShop()), tools: [MOVE_TOOL], history });
        history.push({ role: "assistant", turn: res });
        const call = res.calls.find((x) => x.name === MOVE_TOOL.name);
        if (!call) {
          history.push({ role: "user", text: "Call negotiation_move now." });
          continue;
        }
        const move = call.input as Move;
        const problem = validate(move, n.max_refund, lastOffer, ask);
        if (!problem) {
          if (!injected) saveMove(key, move);
          return { ...move, amount: round2(move.amount), by: "model" };
        }
        history.push({ role: "tool", results: [{ id: call.id, name: call.name, content: `Invalid move: ${problem}`, isError: true }] });
      } catch (e) {
        console.warn("negotiation model call failed, using the rule-based move:", errorText(e));
        break;
      }
    }
  }
  return { ...ruleMove(c, ask, lastOffer), by: "rules" };
}

// The money rules, enforced whatever the model says. Returns the problem, or null.
export function validate(m: Move, max: number, lastOffer: number, ask: number): string | null {
  if (!m || !["OFFER", "ACCEPT", "STOP"].includes(m.action)) return "action must be OFFER, ACCEPT or STOP";
  if (m.action === "STOP") return null;
  if (!m.message?.trim() || m.message.length > 800) return "message must be 1 to 800 characters";
  if (m.action === "ACCEPT") return ask <= max ? null : `the buyer's ask $${ask} is above your ceiling; you can't accept it`;
  if (!(m.amount > 0)) return "amount must be above 0";
  if (m.amount > max) return `amount ${m.amount} is above your ceiling of ${max}`;
  if (m.amount < lastOffer) return `amount ${m.amount} is below your previous offer of ${lastOffer}; never go backwards`;
  if (m.amount >= ask) return `amount ${m.amount} is at or above the buyer's ask of ${ask}; use ACCEPT instead`;
  return null;
}

// Used when no model is available: open with the investigation's figure, then meet the
// buyer halfway inside the ceiling, accept an ask under it, and stop when stuck.
export function ruleMove(c: CaseRecord, ask: number, lastOffer: number): Move {
  const n = c.negotiation!;
  const amount = Number(c.dispute.dispute_amount.value);
  if (ask <= n.max_refund && lastOffer > 0) return { action: "ACCEPT", amount: ask, message: `Thanks for working this out with us. We'll refund ${money(ask)}. - ${currentShop().name}`, reasoning: "The buyer's ask is within your ceiling." };
  const target = lastOffer === 0 ? Math.min(n.max_refund, c.recommendation?.offer_amount || round2(amount * 0.25)) : Math.min(n.max_refund, round2((lastOffer + Math.min(ask, n.max_refund)) / 2));
  if (target <= lastOffer) return { action: "STOP", amount: 0, message: "", reasoning: "The buyer wants more than your ceiling allows." };
  return { action: "OFFER", amount: round2(target), message: `We're sorry this order wasn't right. We can refund ${money(target)} to resolve it. - ${currentShop().name}`, reasoning: lastOffer === 0 ? "Opening with the investigation's offer." : "Meeting the buyer partway, inside your ceiling." };
}

function brief(c: CaseRecord, d: Dispute, ask: number, lastOffer: number): string {
  const r = c.recommendation!;
  const n = c.negotiation!;
  const t = d.disputed_transactions[0];
  return JSON.stringify({
    dispute: { amount: Number(d.dispute_amount.value), item: t?.items?.[0]?.item_description, reason: d.reason, buyer_name: t?.buyer?.name },
    buyer_statements: buyerMessages(d).map((m) => m.content),
    investigation: { headline: r.headline, rationale: r.rationale, suggested_offer: r.offer_amount, facts: (r.factors ?? []).map((f) => `${f.favors === "SELLER" ? "for seller" : "for buyer"}: ${f.finding}`) },
    your_ceiling: n.max_refund,
    your_previous_offer: lastOffer || null,
    buyer_current_ask: ask,
    conversation_so_far: n.turns.map((x) => ({ from: x.from === "AGENT" ? "you" : "buyer", amount: x.amount ?? null, text: x.text })),
  }, null, 1);
}

// Saved moves, so the hosted demo replays real model runs without free-tier quota. A
// move is keyed by the whole conversation so far, so a different path asks the model.
const dir = () => path.join(process.env.REBUTTAL_CACHE_DIR ?? path.join(process.cwd(), "cache", "investigations"), "..", "negotiations");
function moveKey(c: CaseRecord, ask: number) {
  const t = c.dispute.disputed_transactions[0];
  const facts = { who: t?.invoice_number || c.id, amount: c.dispute.dispute_amount.value, max: c.negotiation!.max_refund, ask, turns: c.negotiation!.turns.map((x) => [x.from, x.amount ?? null, x.text]) };
  return `${String(facts.who).replace(/[^A-Za-z0-9_-]/g, "")}-${crypto.createHash("sha256").update(JSON.stringify(facts)).digest("hex").slice(0, 12)}`;
}
function loadMove(key: string): Move | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir(), `${key}.json`), "utf8")).move as Move;
  } catch {
    return null;
  }
}
function saveMove(key: string, move: Move) {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(path.join(dir(), `${key}.json`), JSON.stringify({ key, saved_at: new Date().toISOString(), move }, null, 2));
  } catch (e) {
    console.warn("Could not save negotiation move:", errorText(e));
  }
}
