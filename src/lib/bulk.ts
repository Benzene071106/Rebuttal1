// Bulk approval from the dispute queue: the seller ticks rows and sends the agent's
// recommended response for each in one click. The same guardrails as autopilot apply,
// checked here in code whatever the browser sent: only finished investigations, only
// refunds and evidence (an offer needs the seller to pick an amount), never above the
// seller's hard cap, and never when a PayPal lookup failed during the investigation.

import { approve } from "./actions";
import { addActivity, getCase } from "./cases";
import { getRules } from "./rules";
import type { AutopilotRules, CaseRecord } from "./types";

export const BULK_MAX = 25;

export function bulkBlocker(c: CaseRecord | undefined, rules: AutopilotRules): string | null {
  if (!c) return "Not found.";
  if (c.history) return "Closed past dispute.";
  if (c.submitted || c.outcome) return "Already answered.";
  if (c.status !== "READY" || !c.recommendation) return "Not investigated yet.";
  const amount = Number(c.dispute.dispute_amount.value);
  if (amount > rules.max_auto_amount) return `$${amount.toFixed(2)} is above your $${rules.max_auto_amount} cap.`;
  if (c.recommendation.decision === "OFFER") return "Partial-refund offers need you to pick the amount.";
  if (c.trace.some((s) => s.kind === "error")) return "A PayPal lookup failed during the investigation.";
  return null;
}

export type BulkResult = {
  approved: Array<{ id: string; decision: string; amount: number }>;
  skipped: Array<{ id: string; reason: string }>;
  failed: Array<{ id: string; error: string }>;
};

export async function bulkApprove(ids: string[]): Promise<BulkResult> {
  if (ids.length > BULK_MAX) throw new Error(`Approve at most ${BULK_MAX} disputes at a time.`);
  const rules = await getRules();
  const out: BulkResult = { approved: [], skipped: [], failed: [] };
  for (const id of [...new Set(ids)]) {
    const c = await getCase(id);
    const blocker = bulkBlocker(c, rules);
    if (blocker || !c?.recommendation) {
      out.skipped.push({ id, reason: blocker ?? "Not investigated yet." });
      continue;
    }
    const r = c.recommendation;
    try {
      // One at a time, so the self-healing layer handles each PayPal failure on its own.
      await approve(id, { decision: r.decision, response: r.response_to_paypal, by: "seller", autoRule: true });
      await addActivity(id, `You approved the agent's ${r.decision === "REFUND" ? "refund" : "evidence"} from the queue (bulk approve).`, "good");
      out.approved.push({ id, decision: r.decision, amount: Number(c.dispute.dispute_amount.value) });
    } catch (e) {
      out.failed.push({ id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
