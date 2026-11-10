// Executes the seller-approved decision against PayPal and records the outcome.

import { getCase, updateCase } from "./cases";
import { withCaseLock } from "./locks";
import { paypal } from "./paypal";
import { withRecovery } from "./recovery";
import { runAs, visitor } from "./visitor";
import { asActor } from "./trail";
import type { CaseRecord, Decision, Dispute, EvidenceType, PayPalReceipt } from "./types";

export type Approval = {
  decision: Decision;
  response: string;
  offer_amount?: number;
  offer_type?: "REFUND" | "REFUND_WITH_RETURN";
  by?: "seller" | "autopilot";
  // Simulator only: play PayPal's ruling on the server a little later, for fights sent
  // where no case page is open to run the countdown (autopilot, bulk approve).
  autoRule?: boolean;
};

// Seconds before the simulator rules on a fight that autopilot or bulk approve sent.
// Longer than the case page's own countdown, so an open page still rules first.
export const SIM_AUTO_RULING_MS = 8_000;

export function approve(caseId: string, a: Approval): Promise<CaseRecord> {
  // The lock is taken before the first await, so a second approve for the same
  // dispute is refused instead of reaching PayPal while the first is in flight.
  // Calls go on the API trail as the seller's, or autopilot's when it acted on its own.
  return withCaseLock(caseId, "Sending the response", () => asActor(a.by ?? "seller", () => send(caseId, a), caseId));
}

async function send(caseId: string, a: Approval): Promise<CaseRecord> {
  const c = await getCase(caseId);
  if (!c) throw new Error(`Unknown case ${caseId}`);
  if (c.submitted) throw new Error("A response was already sent for this dispute.");
  if (c.outcome) throw new Error("This dispute is already closed.");
  if (c.status === "ANALYZING") throw new Error("Wait for the investigation to finish before sending a response.");
  if (!c.recommendation) throw new Error("Investigate the dispute before sending a response.");
  // PayPal takes no partial-refund offers once a dispute is a card chargeback.
  if (a.decision === "OFFER" && c.dispute.dispute_life_cycle_stage === "CHARGEBACK") throw new Error("PayPal doesn't allow offers on a chargeback. Send evidence or refund instead.");
  const gw = paypal();
  const r = c.recommendation;
  const currency = c.dispute.dispute_amount.currency_code;
  const response = a.response.trim().slice(0, 2000);
  if (!response) throw new Error("The response to PayPal is empty.");
  let offerAmount: number | undefined;
  let receipt: PayPalReceipt | undefined;

  if (a.decision === "FIGHT") {
    const types = [...new Set<EvidenceType>(r?.evidence.map((e) => e.type) ?? ["OTHER"])];
    const tracking = r?.tracking_number ? { carrier: r.tracking_carrier, tracking_number: r.tracking_number } : undefined;
    if (tracking && !types.includes("PROOF_OF_FULFILLMENT")) types.unshift("PROOF_OF_FULFILLMENT");
    const txnId = c.dispute.disputed_transactions[0]?.seller_transaction_id;
    if (tracking && txnId) {
      // Best effort: the evidence below carries the tracking too, so a failure here
      // shouldn't block the response.
      try {
        const invoice = c.dispute.disputed_transactions[0]?.invoice_number;
        const res = await gw.addTracking(txnId, tracking, invoice ? await gw.orderIdForInvoice(invoice) : null);
        if (res === "added") await note(caseId, `Added ${tracking.carrier} tracking ${tracking.tracking_number} to the PayPal transaction.`);
      } catch (e) {
        await note(caseId, `Could not add tracking to the PayPal transaction: ${e instanceof Error ? e.message : e}`, "error");
      }
    }
    await withRecovery(c, "FIGHT", Number(c.dispute.dispute_amount.value), async () => {
      receipt = await gw.provideEvidence(caseId, { notes: response, evidence_types: types, tracking });
    });
  } else if (a.decision === "OFFER") {
    // Round to cents first: PayPal gets what we validated, and 0.001 can't become "0.00".
    offerAmount = Math.round(Number(a.offer_amount) * 100) / 100;
    const amount = offerAmount;
    const max = Number(c.dispute.dispute_amount.value);
    if (!(amount >= 0.01 && amount < max)) throw new Error(`Offer must be at least $0.01 and below $${max.toFixed(2)}.`);
    await withRecovery(c, "OFFER", amount, async () => {
      receipt = await gw.makeOffer(caseId, { amount: amount.toFixed(2), currency, type: a.offer_type ?? "REFUND", note: response });
    });
  } else {
    await withRecovery(c, "REFUND", Number(c.dispute.dispute_amount.value), async () => {
      receipt = await gw.acceptClaim(caseId, response);
    });
  }

  const dispute = await gw.getDispute(caseId);
  if (a.decision === "FIGHT" && a.autoRule && gw.mode === "mock") scheduleSimRuling(caseId);
  if (receipt) receipt = { ...receipt, status_after: dispute.status, stage_after: dispute.dispute_life_cycle_stage };
  return await updateCase(caseId, {
    dispute,
    status: a.decision === "REFUND" ? "REFUNDED" : "SUBMITTED",
    submitted: { decision: a.decision, at: new Date().toISOString(), response, offer_amount: offerAmount, by: a.by ?? "seller", receipt },
    outcome: a.decision === "REFUND" ? outcomeFor(dispute, "REFUND") : undefined,
  });
}

async function note(caseId: string, summary: string, kind: "note" | "error" = "note") {
  const c = await getCase(caseId);
  if (c) await updateCase(caseId, { trace: [...c.trace, { at: new Date().toISOString(), kind, summary }] });
}

function scheduleSimRuling(caseId: string) {
  const v = { ...visitor() };
  setTimeout(() => {
    // A case page that was open may have ruled already; that refusal is expected.
    runAs(v, () => simulateRuling(caseId, "SELLER_FAVOR")).catch(() => {});
  }, SIM_AUTO_RULING_MS).unref?.();
}

// Sandbox only: ask PayPal to rule on the dispute so the full lifecycle can be shown.
// A ruling happens once, on a fight or an offer that is still waiting.
export function simulateRuling(caseId: string, outcome: "SELLER_FAVOR" | "BUYER_FAVOR"): Promise<CaseRecord> {
  return asActor("system", () => rule(caseId, outcome), caseId);
}

async function rule(caseId: string, outcome: "SELLER_FAVOR" | "BUYER_FAVOR"): Promise<CaseRecord> {
  const c = await getCase(caseId);
  if (!c?.submitted) throw new Error("Send a response before simulating PayPal's ruling.");
  if (c.outcome) throw new Error("This dispute is already closed, so there is nothing left for PayPal to rule on.");
  if (c.submitted.decision === "REFUND") throw new Error("This dispute was refunded, so there is nothing left for PayPal to rule on.");
  await paypal().simulateRuling(caseId, outcome);
  const dispute = await paypal().getDispute(caseId);
  const o = outcomeFor(dispute, c.submitted.decision);
  return await updateCase(caseId, { dispute, outcome: o, status: o?.result ?? c.status });
}

export function outcomeFor(d: Dispute, decision?: Decision): CaseRecord["outcome"] {
  const code = d.dispute_outcome?.outcome_code;
  if (!code) return undefined;
  const total = Number(d.dispute_amount.value);
  const refunded = Number(d.dispute_outcome?.amount_refunded?.value ?? 0);
  const at = new Date().toISOString();
  if (code === "RESOLVED_SELLER_FAVOUR") return { result: "WON", amount_kept: total, amount_lost: 0, at };
  if (code === "RESOLVED_WITH_PAYOUT") return { result: "SETTLED", amount_kept: total - refunded, amount_lost: refunded, at };
  if (decision === "REFUND") return { result: "REFUNDED", amount_kept: total - (refunded || total), amount_lost: refunded || total, at };
  return { result: "LOST", amount_kept: total - refunded, amount_lost: refunded || total, at };
}
