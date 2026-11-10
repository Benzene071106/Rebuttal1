// Seller rules for autopilot, kept per tenant like cases: each simulator visitor and
// each seller has their own.

import { z } from "zod";
import type { AutopilotRules, CaseRecord } from "./types";
import { storeFor } from "./store";
import { tenant, visitor } from "./visitor";

export const DEFAULT_RULES: AutopilotRules = { enabled: true, auto_refund_max: 30, auto_fight_min_win: 0, max_auto_amount: 250, negotiate_max_pct: 0.4 };

// Same limits as the rules panel, enforced for any client.
const cents = (n: number) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6;
const money = z.number().min(0).max(10_000).refine(cents, { message: "Money limits take whole cents only." });

export const RulesSchema = z.object({
  enabled: z.boolean(),
  auto_refund_max: money,
  auto_fight_min_win: z.number().min(0).max(1).refine((n) => n === 0 || n >= 0.5, { message: "Send evidence on its own at: 0 (never) or 50 to 100%." }),
  max_auto_amount: money,
  negotiate_max_pct: z.number().min(0.05, { message: "The negotiator limit must be 5 to 95%." }).max(0.95, { message: "The negotiator limit must be 5 to 95%." }).default(DEFAULT_RULES.negotiate_max_pct),
}).refine((r) => r.auto_refund_max <= r.max_auto_amount, {
  // Same cross-field check as the rules grid, enforced for any client.
  message: "The auto-refund limit can't be above the hard cap.",
  path: ["auto_refund_max"],
});

export async function getRules(): Promise<AutopilotRules> {
  const saved = await storeFor(tenant()).getRules();
  // Rules saved before a field existed get its default.
  // Rules saved before the limits were tightened fall back to the defaults.
  const ok = saved ? RulesSchema.safeParse({ ...DEFAULT_RULES, ...saved }) : null;
  return ok?.success ? ok.data : { ...DEFAULT_RULES };
}

export async function setRules(next: AutopilotRules): Promise<AutopilotRules> {
  const rules = RulesSchema.parse(next);
  await storeFor(tenant()).setRules(rules);
  return rules;
}

export async function resetRules() {
  if (visitor().mode === "mock") await storeFor(tenant()).clearRules();
}

export type RuleVerdict =
  | { act: "REFUND" | "FIGHT"; reason: string }
  | { act: null; reason: string };

// Decides what autopilot may do with a finished investigation. Guardrails come first:
// anything over the hard cap, an investigation that hit tool errors, or a partial-refund
// offer always goes to the seller.
export function evaluateRules(c: CaseRecord, rules: AutopilotRules): RuleVerdict {
  const r = c.recommendation;
  const amount = Number(c.dispute.dispute_amount.value);
  const fmt = (n: number) => `$${n.toFixed(2).replace(/\.00$/, "")}`;
  if (!rules.enabled) return { act: null, reason: "Autopilot is off, so every dispute waits for your approval." };
  if (!r) return { act: null, reason: "No recommendation yet." };
  if (c.submitted || c.outcome) return { act: null, reason: "This dispute already has a response." };
  if (amount > rules.max_auto_amount) return { act: null, reason: `${fmt(amount)} is above your ${fmt(rules.max_auto_amount)} autopilot limit, so you decide.` };
  if (c.trace.some((s) => s.kind === "error")) return { act: null, reason: "Some PayPal lookups failed during the investigation, so a person should check it." };
  if (r.decision === "REFUND") {
    if (amount <= rules.auto_refund_max) return { act: "REFUND", reason: `The AI recommends a refund and ${fmt(amount)} is within your auto-refund limit of ${fmt(rules.auto_refund_max)}.` };
    return { act: null, reason: `The AI recommends a refund, but ${fmt(amount)} is above your auto-refund limit of ${fmt(rules.auto_refund_max)}.` };
  }
  if (r.decision === "FIGHT") {
    if (rules.auto_fight_min_win <= 0) return { act: null, reason: "Auto-fight is off, so evidence is only sent after you approve it." };
    const pct = Math.round(r.win_probability * 100);
    const need = Math.round(rules.auto_fight_min_win * 100);
    if (r.win_probability >= rules.auto_fight_min_win) return { act: "FIGHT", reason: `The AI puts the win chance at ${pct}%, at or above your auto-fight threshold of ${need}%.` };
    return { act: null, reason: `The AI puts the win chance at ${pct}%, below your auto-fight threshold of ${need}%.` };
  }
  return { act: null, reason: "Partial-refund offers always need your approval, because you choose the amount." };
}
