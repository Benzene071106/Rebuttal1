// Autopilot: a PayPal dispute webhook arrives, the AI investigates on its own, and the
// seller's rules decide whether Rebuttal answers PayPal by itself or alerts the seller
// to approve. The live sandbox webhook and the simulator's "File a test dispute" both
// come through here, so the demo runs the same code path as a real PayPal event.

import { approve } from "./actions";
import { runAnalysis } from "./analysis";
import { plainError } from "./errors";
import { CaseBusyError, caseIdle } from "./locks";
import { addActivity, getCase, updateCase, upsertFromDispute } from "./cases";
import { paypal } from "./paypal";
import { RecoveryPausedError } from "./recovery";
import { evaluateRules, getRules } from "./rules";
import type { CaseRecord, Dispute } from "./types";
import { asActor } from "./trail";

export type DisputeEvent = { id?: string; event_type: string; resource?: { dispute_id?: string } & Partial<Dispute> };

const money = (v: number | string) => `$${Number(v).toFixed(2)}`;
const reasonText = (d: Dispute) => d.reason.replaceAll("_", " ").toLowerCase().replace("merchandise or service ", "item ");
const daysLeft = (d: Dispute) => (d.seller_response_due_date ? Math.ceil((Date.parse(d.seller_response_due_date) - Date.now()) / 86_400_000) : null);

// Records a webhook against its case. Returns the case and whether autopilot should
// investigate it (a newly created dispute nobody has looked at yet).
export async function ingestDisputeEvent(event: DisputeEvent): Promise<{ case: CaseRecord; investigate: boolean }> {
  const id = event.resource?.dispute_id;
  if (!id) throw new Error("No dispute_id");
  const known = await getCase(id);
  const rec = await upsertFromDispute(await paypal().getDispute(id));
  const d = rec.dispute;
  const buyer = d.disputed_transactions[0]?.buyer?.name ?? "A buyer";

  if (event.event_type === "CUSTOMER.DISPUTE.CREATED" && rec.status === "NEW" && !rec.source) {
    const left = daysLeft(d);
    await updateCase(id, { source: "webhook", status: "ANALYZING" });
    await addActivity(id, `PayPal webhook: ${buyer} opened a ${money(d.dispute_amount.value)} "${reasonText(d)}" dispute${left === null ? "" : `, ${left} day${left === 1 ? "" : "s"} to respond`}. Agent is investigating.`);
    return { case: (await getCase(id))!, investigate: true };
  }
  if (event.event_type === "CUSTOMER.DISPUTE.RESOLVED" && rec.outcome) {
    await addActivity(id, `PayPal closed the dispute: ${rec.outcome.result.toLowerCase()}, ${money(rec.outcome.amount_kept)} kept.`, rec.outcome.amount_kept > 0 ? "good" : "bad");
  } else if (event.event_type === "CUSTOMER.DISPUTE.UPDATED" && known && known.dispute.status !== d.status) {
    await addActivity(id, `PayPal moved the dispute to ${d.status.replaceAll("_", " ").toLowerCase()}.`);
  }
  return { case: (await getCase(id))!, investigate: false };
}

// Investigates a dispute and applies the seller's rules. Never throws: every result,
// including a failure, ends up as an alert on the case.
// PayPal calls autopilot makes go on the API trail as autopilot's (its investigation is
// still the agent's).
export function runAutopilot(id: string): Promise<CaseRecord | undefined> {
  return asActor("autopilot", () => autopilot(id), id);
}

async function autopilot(id: string): Promise<CaseRecord | undefined> {
  const at = () => new Date().toISOString();
  try {
    await runAnalysis(id);
  } catch (e) {
    // The seller pressed Investigate (or approved) first: let that finish, then apply
    // the rules to its result instead of reporting a failure.
    if (!(e instanceof CaseBusyError)) return await failed(id, e);
    await caseIdle(id);
    const now = await getCase(id);
    if (now?.submitted || now?.outcome) return now;
    if (now?.status !== "READY" || !now.recommendation) return await failed(id, new Error(now?.error ?? "The investigation did not finish."));
  }
  const c = (await getCase(id))!;
  if (c.submitted || c.outcome) return c;
  const r = c.recommendation!;
  const verdict = evaluateRules(c, await getRules());
  const pct = Math.round(r.win_probability * 100);
  const left = daysLeft(c.dispute);

  if (!verdict.act) {
    await updateCase(id, { autopilot: { action: "NEEDS_APPROVAL", reason: verdict.reason, at: at() } });
    const what = r.decision === "FIGHT" ? `fight (${pct}% win chance)` : r.decision === "OFFER" ? `offer a ${money(r.offer_amount)} partial refund` : "refund";
    const urgent = left !== null && left <= 3;
    await addActivity(id, `Needs your approval: the AI recommends you ${what}.${left === null ? "" : ` ${left <= 0 ? "Response is overdue." : `${left} day${left === 1 ? "" : "s"} left.`}`}`, urgent ? "warn" : "info");
    return await getCase(id);
  }

  try {
    await approve(id, { decision: verdict.act, response: r.response_to_paypal, by: "autopilot", autoRule: true });
    await updateCase(id, { autopilot: { action: verdict.act === "REFUND" ? "AUTO_REFUNDED" : "AUTO_FOUGHT", reason: verdict.reason, at: at() } });
    await addActivity(
      id,
      verdict.act === "REFUND"
        ? `Autopilot refunded ${money(c.dispute.dispute_amount.value)} through PayPal. ${verdict.reason}`
        : `Autopilot sent the evidence to PayPal. ${verdict.reason}`,
      "good",
    );
  } catch (e) {
    // The seller answered this dispute themselves while autopilot was deciding.
    if (e instanceof CaseBusyError || (await getCase(id))?.submitted) return await getCase(id);
    // The recovery agent already logged the incident, alerted the seller and set the case up.
    if (e instanceof RecoveryPausedError) {
      await updateCase(id, { autopilot: { action: "FAILED", reason: e.message, at: at() } });
      return await getCase(id);
    }
    await updateCase(id, { autopilot: { action: "FAILED", reason: `${verdict.reason} PayPal refused: ${errorText(e)}`, at: at() } });
    await addActivity(id, `Autopilot tried to ${verdict.act === "REFUND" ? "refund" : "send evidence"}, but PayPal refused: ${errorText(e)} It needs you now.`, "bad");
  }
  return await getCase(id);
}

async function failed(id: string, e: unknown) {
  await updateCase(id, { autopilot: { action: "FAILED", reason: errorText(e), at: new Date().toISOString() } });
  await addActivity(id, `Investigation failed: ${errorText(e)} Open the dispute to retry.`, "bad");
  return await getCase(id);
}

function errorText(e: unknown) {
  const m = plainError(e);
  return /[.!?]$/.test(m) ? m : `${m}.`;
}
