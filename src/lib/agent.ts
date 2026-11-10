// The dispute analyst: an AI model (Gemini by default, Claude optional) investigates a
// dispute with read-only PayPal Agent Toolkit tools and the shop's own records, then
// returns a recommendation the seller approves or edits.

import { currentShop, describeShop, type Shop } from "./shop";
import { z } from "zod";
import { defaultModel, type AgentModel } from "./model";
import type { ChatEntry, ToolResult } from "./model/types";
import { paypal } from "./paypal";
import type { ToolDef } from "./paypal/gateway";
import { getStoreRecords, STORE_RECORDS_TOOL } from "./store-records";
import type { Dispute, Recommendation, TraceStep } from "./types";

const MAX_TURNS = 14;

const system = (shop: Shop) => `You review PayPal disputes for ${describeShop(shop)}, and recommend how the seller should respond. The seller reads your recommendation and approves or edits it before anything is sent to PayPal.

Investigate before you decide. Read the dispute, the PayPal order, the PayPal shipment tracker, the buyer's PayPal transaction history with the shop, and the shop's own records (listing text, customer messages, carrier scans). Compare the carrier's delivery address with the shipping address on the PayPal order. Then call submit_recommendation exactly once.

Choose one decision:
- FIGHT: send evidence to PayPal. Choose it when the evidence directly answers the buyer's claim. For item-not-received, PayPal generally needs online tracking showing delivery to the order's shipping address, and a signature for high-value orders. For not-as-described, the listing text and photos matter. For unauthorised, a confirmed delivery to the account holder's address and prior purchase history matter.
- OFFER: a partial refund, when the seller is partly at fault or a quick settlement is worth more than the likely outcome. Set offer_amount to a specific figure and explain how you got it. When only part of the order is affected (one damaged piece of a set), an offer in proportion to that part usually beats refunding the whole order.
- REFUND: accept the claim, when the seller cannot realistically win or the amount is too small to be worth fighting. Say so plainly; a good refund recommendation saves the seller time.

Rules:
- Every fact in evidence and response_to_paypal must come from a tool result. Name the tool in each evidence item's source. Never invent documents, photos or tracking numbers.
- response_to_paypal is read by a PayPal dispute specialist (or the card issuer, for a chargeback). Write it in the seller's voice, factual and chronological, under 1500 characters. For OFFER or REFUND, it is the short note sent with the offer or refund.
- win_probability is your honest estimate between 0 and 1 that PayPal rules for the seller if they fight. Give it for every decision.
- factors lists the 3 to 6 facts that decided it, each marked as favoring the SELLER or the BUYER, with a weight and the tool that returned it. Include the facts against your decision too, so the seller sees both sides.
- Leave tracking_carrier and tracking_number empty unless a carrier and tracking number appear in the tool results. Set offer_amount to 0 and offer_type to NONE unless the decision is OFFER.`;

const SUBMIT_TOOL: ToolDef = {
  name: "submit_recommendation",
  description: "Submit the final recommendation to the seller. Call once, after investigating.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "decision", "win_probability", "headline", "rationale", "evidence", "response_to_paypal",
      "tracking_carrier", "tracking_number", "offer_amount", "offer_type", "risks", "factors",
    ],
    properties: {
      decision: { type: "string", enum: ["FIGHT", "OFFER", "REFUND"] },
      win_probability: { type: "number", description: "0 to 1" },
      headline: { type: "string", description: "One sentence the seller reads first." },
      rationale: { type: "string", description: "Why this decision, in 2-4 sentences." },
      evidence: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["type", "summary", "source"],
          properties: {
            type: { type: "string", enum: ["PROOF_OF_FULFILLMENT", "PROOF_OF_DELIVERY_SIGNATURE", "ITEM_DESCRIPTION", "RETURN_POLICY", "PROOF_OF_RECEIPT_COPY", "OTHER"] },
            summary: { type: "string" },
            source: { type: "string", description: "Tool that returned this fact." },
          },
        },
      },
      response_to_paypal: { type: "string" },
      tracking_carrier: { type: "string" },
      tracking_number: { type: "string" },
      offer_amount: { type: "number" },
      offer_type: { type: "string", enum: ["REFUND", "REFUND_WITH_RETURN", "NONE"] },
      risks: { type: "array", items: { type: "string" }, description: "What could still go wrong." },
      factors: {
        type: "array",
        description: "The 3 to 6 facts that decided it, for and against the seller.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["finding", "favors", "weight", "source"],
          properties: {
            finding: { type: "string", description: "One fact, in plain words." },
            favors: { type: "string", enum: ["SELLER", "BUYER"] },
            weight: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
            source: { type: "string", description: "Tool that returned this fact." },
          },
        },
      },
    },
  },
};

const RecommendationSchema = z.object({
  decision: z.enum(["FIGHT", "OFFER", "REFUND"]),
  win_probability: z.number().min(0).max(1),
  headline: z.string().min(1),
  rationale: z.string().min(1),
  evidence: z.array(z.object({
    type: z.enum(["PROOF_OF_FULFILLMENT", "PROOF_OF_DELIVERY_SIGNATURE", "ITEM_DESCRIPTION", "RETURN_POLICY", "PROOF_OF_RECEIPT_COPY", "OTHER"]),
    summary: z.string(),
    source: z.string(),
  })),
  response_to_paypal: z.string().min(1).max(2000),
  tracking_carrier: z.string(),
  tracking_number: z.string(),
  offer_amount: z.number().min(0),
  offer_type: z.enum(["REFUND", "REFUND_WITH_RETURN", "NONE"]),
  risks: z.array(z.string()),
  factors: z.array(z.object({
    finding: z.string(),
    favors: z.enum(["SELLER", "BUYER"]),
    weight: z.enum(["HIGH", "MEDIUM", "LOW"]),
    source: z.string(),
  })).default([]),
}).superRefine((r, ctx) => {
  // Seen live with Gemini flash-lite: OFFER with offer_amount 0 / offer_type NONE, which
  // would send PayPal an empty offer. Send it back to the model instead.
  if (r.decision === "OFFER" && (r.offer_amount <= 0 || r.offer_type === "NONE")) {
    ctx.addIssue({ code: "custom", path: ["offer_amount"], message: "decision OFFER needs offer_amount above 0 and offer_type REFUND or REFUND_WITH_RETURN" });
  }
});

export type AnalyzeOptions = {
  model?: AgentModel;
  onStep?: (step: TraceStep) => void;
};

export async function analyzeDispute(dispute: Dispute, opts: AnalyzeOptions = {}): Promise<{ recommendation: Recommendation; trace: TraceStep[]; model: string }> {
  const model = opts.model ?? defaultModel();
  const gw = paypal();
  const trace: TraceStep[] = [];
  const step = (s: Omit<TraceStep, "at">) => {
    const full = { ...s, at: new Date().toISOString() };
    trace.push(full);
    opts.onStep?.(full);
  };

  const tools: ToolDef[] = [...gw.agentTools(), STORE_RECORDS_TOOL, SUBMIT_TOOL];
  const txn = dispute.disputed_transactions[0];
  const history: ChatEntry[] = [
    {
      role: "user",
      text: `New dispute ${dispute.dispute_id} on invoice ${txn?.invoice_number ?? "unknown"} (PayPal transaction ${txn?.seller_transaction_id ?? "unknown"}).${dueNote(dispute)} Investigate and submit your recommendation.`,
    },
  ];

  let nudged = false;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await model.next({ system: system(currentShop()), tools, history });

    if (res.stop === "refusal") throw new Error("The model declined to analyze this dispute.");
    if (res.stop === "max_tokens") throw new Error("The analysis ran out of output space.");

    history.push({ role: "assistant", turn: res });

    if (res.calls.length === 0) {
      if (nudged) throw new Error("The model finished without a recommendation.");
      nudged = true;
      history.push({ role: "user", text: "Call submit_recommendation now with your decision." });
      continue;
    }

    const results: ToolResult[] = [];
    for (const use of res.calls) {
      const input = use.input;
      const reply = (content: string, isError?: boolean) => results.push({ id: use.id, name: use.name, content, ...(isError ? { isError } : {}) });
      if (use.name === SUBMIT_TOOL.name) {
        const parsed = RecommendationSchema.safeParse(input);
        const disputed = Number(dispute.dispute_amount?.value ?? Infinity);
        if (parsed.success && parsed.data.decision === "OFFER" && parsed.data.offer_amount >= disputed) {
          reply(`Invalid recommendation: offer_amount ${parsed.data.offer_amount} must be below the disputed amount ${disputed}. For a full refund choose REFUND.`, true);
          continue;
        }
        if (parsed.success) {
          step({ kind: "note", summary: `Recommendation: ${parsed.data.decision}` });
          return { recommendation: parsed.data, trace, model: `${model.provider}:${model.model}` };
        }
        reply(`Invalid recommendation: ${parsed.error.message}`, true);
        continue;
      }
      try {
        const out = use.name === STORE_RECORDS_TOOL.name ? await getStoreRecords(String(input.invoice_id)) : await gw.runTool(use.name, input);
        step({ kind: "tool", tool: use.name, input, summary: summarize(use.name, out) });
        reply(JSON.stringify(out));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        step({ kind: "error", tool: use.name, input, summary: msg });
        reply(msg, true);
      }
    }
    history.push({ role: "tool", results });
  }
  throw new Error("The analysis did not finish within its step limit.");
}

// PayPal closes the case for the buyer if the seller misses the response deadline, so the
// agent hears how much time is left (a REFUND can beat a FIGHT that can't be ready in time).
function dueNote(d: Dispute): string {
  if (!d.seller_response_due_date) return "";
  const days = Math.ceil((Date.parse(d.seller_response_due_date) - Date.now()) / 86_400_000);
  return ` The seller must respond by ${d.seller_response_due_date.slice(0, 10)} (${days <= 0 ? "overdue" : `${days} day${days === 1 ? "" : "s"} left`}).`;
}

// One-line, human-readable description of what a tool returned, for the live trace.
export function summarize(tool: string, out: unknown): string {
  const o = (out ?? {}) as Record<string, any>;
  if (o.error) return typeof o.error === "object" ? String(o.error.message ?? JSON.stringify(o.error)) : String(o.error);
  switch (tool) {
    case "get_dispute":
      return `Dispute ${o.dispute_id}: ${String(o.reason ?? "").replaceAll("_", " ").toLowerCase()}, $${o.dispute_amount?.value}, ${String(o.dispute_life_cycle_stage ?? "").toLowerCase()}`;
    case "get_order": {
      const pu = o.purchase_units?.[0];
      const a = pu?.shipping?.address;
      return `Order ${o.id}: ${pu?.items?.map((i: any) => i.name).join(", ") ?? "items"}, ships to ${a?.admin_area_2 ?? "?"}, ${a?.admin_area_1 ?? ""}`;
    }
    case "get_shipment_tracking": {
      const t = o.trackers?.[0];
      return t ? `PayPal tracker: ${t.carrier} ${t.tracking_number}, status ${t.status}` : "No tracking on file with PayPal";
    }
    case "list_transactions": {
      const n = o.transaction_details?.length ?? 0;
      return `${n} transaction${n === 1 ? "" : "s"} from this buyer`;
    }
    case "get_store_records": {
      const f = o.fulfillment;
      const last = f?.carrier_events?.at(-1)?.status;
      return `Shop records: ${o.customer_messages?.length ?? 0} customer messages; ${last ? `last scan "${last}"` : "no carrier scans"}`;
    }
    default:
      return "Done";
  }
}
