// Live PayPal sandbox gateway. Everything the PayPal Agent Toolkit covers goes through
// it: the agent's read tools, listing and reading disputes, accepting a claim and
// adding shipment tracking. The Disputes REST API is called directly only for what the
// toolkit (v1.11) lacks: provide-evidence, make-offer, the sandbox adjudicate
// simulation and webhook signature checks.

import fs from "node:fs";
import path from "node:path";
import type { Dispute, PayPalReceipt } from "../types";
import { cachedDisputeList, type ListItem } from "./dispute-list-cache";
import type { EvidenceSubmission, PayPalGateway } from "./gateway";
import { evidencePdf } from "./evidence-pdf";
import { makeToolkit, toolkitDefs, type PayPalEnv } from "./toolkit";
import { recordCall, toolEndpoint, traced, type TrailMethod } from "../trail";

const ORDER_MAP = path.join(process.cwd(), "data", "sandbox-orders.json");

// `env` picks PayPal's sandbox or live API; `webhookId` is the webhook PayPal signs
// deliveries for (a seller's own, or PAYPAL_WEBHOOK_ID for the shared demo sandbox).
export function sandboxGateway(clientId: string, clientSecret: string, opts: { env?: PayPalEnv; webhookId?: string | null } = {}): PayPalGateway {
  const env = opts.env ?? "sandbox";
  const tk = makeToolkit(clientId, clientSecret, env);
  const defs = toolkitDefs(tk);
  traceTokenCalls(tk);

  async function call(method: string, urlPath: string, body?: unknown | FormData) {
    return (await callWithReceipt(method, urlPath, body)).json;
  }

  // Same call, plus what PayPal answered (status and PayPal-Debug-Id), kept as the
  // seller's proof that a write landed. Every call, failed or not, goes on the API trail.
  async function callWithReceipt(method: string, urlPath: string, body?: unknown | FormData): Promise<{ json: any; receipt: PayPalReceipt }> {
    const system = /^\/v1\/notifications\//.test(urlPath);
    const trail = (status: number, debug: string | null) => recordCall({ method: method as TrailMethod, endpoint: urlPath, status, debug_id: debug, via: "rest", ...(system ? { by: "system" as const } : {}) });
    const headers = await tk.client.getHeaders();
    const isForm = body instanceof FormData;
    if (isForm) delete headers["Content-Type"];
    let res: Response;
    try {
      res = await fetch(`${tk.client.getBaseUrl()}${urlPath}`, {
        method,
        headers: isForm ? headers : { ...headers, "Content-Type": "application/json" },
        body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      });
    } catch (e) {
      trail(0, null);
      throw e;
    }
    const text = await res.text();
    const debugId = res.headers.get("paypal-debug-id");
    trail(res.status, debugId);
    if (!res.ok) throw new Error(`PayPal ${method} ${urlPath} failed (${res.status}): ${text.slice(0, 500)}`);
    const receipt: PayPalReceipt = { method: "POST", endpoint: urlPath, via: "rest", http_status: res.status, debug_id: debugId ?? undefined, at: new Date().toISOString() };
    return { json: text ? JSON.parse(text) : {}, receipt };
  }

  // Runs one Agent Toolkit tool. The toolkit reports PayPal errors as an `error` object
  // in its result rather than throwing, so turn those back into exceptions.
  async function toolkit(name: string, input: Record<string, unknown>): Promise<any> {
    return traced({ ...toolEndpoint(name, input), via: "agent_toolkit" }, () => runToolkit(name, input));
  }

  async function runToolkit(name: string, input: Record<string, unknown>): Promise<any> {
    const msg = await tk.handleToolCall({ id: `call_${Date.now()}`, type: "function", function: { name, arguments: JSON.stringify(input) } });
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    let out: any = content;
    try {
      out = JSON.parse(content);
    } catch {
      // plain text
    }
    if (out && typeof out === "object" && "error" in out && out.error) {
      const err = out.error as { message?: string };
      throw new Error(`PayPal ${name} failed: ${err.message ?? JSON.stringify(err).slice(0, 500)}`);
    }
    // Toolkit v1.11 reports HTTP errors as {ok:false,status,code,message} instead of
    // `error`. Missing this once marked a refused accept-claim as refunded.
    if (out && typeof out === "object" && out.ok === false) {
      throw new Error(`PayPal ${name} failed (${out.status ?? "?"}): ${String(out.message ?? JSON.stringify(out)).slice(0, 500)}`);
    }
    return out;
  }

  // PayPal lists what the seller may do next as links on the dispute; check before a
  // write so the seller gets a plain explanation instead of a 422.
  async function requireAction(id: string, rel: string, message: string) {
    const d = (await toolkit("get_dispute", { dispute_id: id })) as { status?: string; links?: Array<{ rel: string }> };
    if (!(d.links ?? []).some((l) => l.rel === rel)) throw new Error(`${message} (status ${d.status ?? "unknown"})`);
  }

  return {
    mode: "sandbox",

    agentTools: () => defs,

    runTool: (name, input) => toolkit(name, input),

    async orderIdForInvoice(invoiceId) {
      // The seeded order map belongs to the shared demo sandbox only.
      if (opts.webhookId !== undefined) return null;
      try {
        const map = JSON.parse(fs.readFileSync(ORDER_MAP, "utf8")) as Record<string, string>;
        return map[invoiceId] ?? null;
      } catch {
        return null;
      }
    },

    // The shield runs on the simulator's orders. A live install would collect these from
    // PAYMENT.CAPTURE.COMPLETED webhooks and the shop's fulfillment system.
    async ordersAwaitingShipment() {
      return [];
    },

    listDisputes() {
      return cachedDisputeList(
        async () => ((await toolkit("list_disputes", { page_size: 50 })).items ?? []) as ListItem[],
        (id) => toolkit("get_dispute", { dispute_id: id }) as Promise<Dispute>,
      );
    },

    getDispute: (id) => toolkit("get_dispute", { dispute_id: id }),

    async provideEvidence(id, ev: EvidenceSubmission) {
      // PayPal only accepts what the dispute's links allow. A chargeback that is
      // UNDER_REVIEW (what the sandbox creates for an item-not-received claim paid by
      // card) takes provide-supporting-info, not provide-evidence.
      const d = (await toolkit("get_dispute", { dispute_id: id })) as Dispute & { links?: Array<{ rel: string }>; evidences?: Array<{ evidence_type: string; source?: string; dispute_life_cycle_stage?: string }> };
      const rels = new Set((d.links ?? []).map((l) => l.rel));
      if (!rels.has("provide_evidence") && rels.has("provide_supporting_info")) {
        const t = ev.tracking ? `\n\nTracking: ${ev.tracking.carrier} ${ev.tracking.tracking_number}` : "";
        const form = new FormData();
        form.append("input", new Blob([JSON.stringify({ notes: `${ev.notes}${t}`.slice(0, 2000) })], { type: "application/json" }));
        return (await callWithReceipt("POST", `/v1/customer/disputes/${id}/provide-supporting-info`, form)).receipt;
      }
      if (!rels.has("provide_evidence")) {
        throw new Error(`PayPal isn't accepting evidence on this dispute right now (status ${d.status}; allowed: ${[...rels].filter((r) => r !== "self").join(", ") || "none"}).`);
      }

      // Learned on a live sandbox chargeback (2026-10-07): several evidences in one call
      // fail (400 without item_id, 500 with it); PROOF_OF_FULFILLMENT was refused with
      // EVIDENCE_TYPE_IS_NOT_ALLOWED even though PayPal had requested it; a single
      // PROOF_OF_DELIVERY_SIGNATURE with a PDF attached went through and closed the
      // response. So send one evidence, strongest type first, falling through types
      // PayPal refuses, with the response attached as a PDF.
      const requested = (d.evidences ?? [])
        .filter((e: { source?: string; dispute_life_cycle_stage?: string }) => e.source === "REQUESTED_FROM_SELLER" && e.dispute_life_cycle_stage === d.dispute_life_cycle_stage)
        .map((e: { evidence_type: string }) => e.evidence_type)
        .filter((t: string) => t !== "PROOF_OF_REFUND");
      const order = ["PROOF_OF_DELIVERY_SIGNATURE", "PROOF_OF_FULFILLMENT", "ITEM_DESCRIPTION", "PROOF_OF_RECEIPT_COPY", "RETURN_POLICY", "OTHER"];
      const types = [...new Set<string>([...ev.evidence_types, ...requested])].sort((a, b) => rank(a) - rank(b));
      function rank(t: string) {
        const i = order.indexOf(t);
        return i < 0 ? order.length : i;
      }
      const t = ev.tracking ? `\nTracking: ${ev.tracking.carrier} ${ev.tracking.tracking_number}` : "";
      const notes = `${ev.notes}${t}`.slice(0, 2000);
      let lastError: unknown;
      for (const type of types) {
        const evidence = {
          evidence_type: type,
          notes,
          documents: [{ name: "seller-response.pdf" }],
          ...(type === "PROOF_OF_FULFILLMENT" && ev.tracking
            ? { evidence_info: { tracking_info: [{ carrier_name: ev.tracking.carrier, tracking_number: ev.tracking.tracking_number }] } }
            : {}),
        };
        const form = new FormData();
        form.append("input", new Blob([JSON.stringify({ evidences: [evidence] })], { type: "application/json" }));
        form.append("file1", evidencePdf(`Seller response to PayPal dispute ${id}`, notes), "seller-response.pdf");
        try {
          return (await callWithReceipt("POST", `/v1/customer/disputes/${id}/provide-evidence`, form)).receipt;
        } catch (e) {
          lastError = e;
          if (!/EVIDENCE_TYPE_IS_NOT_ALLOWED/.test(e instanceof Error ? e.message : "")) throw e;
        }
      }
      throw lastError ?? new Error("No evidence type to send.");
    },

    async makeOffer(id, offer) {
      await requireAction(id, "make_offer", "PayPal doesn't take offers on this dispute right now. Offers are only possible before a dispute becomes a chargeback or claim under PayPal review.");
      return (await callWithReceipt("POST", `/v1/customer/disputes/${id}/make-offer`, {
        note: offer.note,
        offer_amount: { currency_code: offer.currency, value: offer.amount },
        offer_type: offer.type,
      })).receipt;
    },

    async sendMessage(id, message) {
      await requireAction(id, "send_message", "PayPal doesn't allow messages to the buyer on this dispute right now (chargebacks and cases under PayPal review have no buyer conversation).");
      await call("POST", `/v1/customer/disputes/${id}/send-message`, { message });
    },

    async acceptClaim(id, note) {
      await requireAction(id, "accept_claim", "PayPal isn't letting the seller accept this claim right now (it is under PayPal review). Try again once PayPal asks the seller to respond.");
      try {
        await toolkit("accept_dispute_claim", { dispute_id: id, note });
        return { method: "POST", endpoint: `/v1/customer/disputes/${id}/accept-claim`, via: "agent_toolkit", at: new Date().toISOString() };
      } catch (e) {
        // The toolkit's tool also sends its arguments as query parameters; if PayPal
        // rejects that, make the same call directly.
        console.warn("accept_dispute_claim via Agent Toolkit failed, retrying over REST:", e instanceof Error ? e.message : e);
        try {
          return (await callWithReceipt("POST", `/v1/customer/disputes/${id}/accept-claim`, { note, accept_claim_type: "REFUND" })).receipt;
        } catch (rest) {
          if (/INSUFFICIENT_FUNDS/.test(rest instanceof Error ? rest.message : "")) {
            // Keep PayPal's own error (name, debug_id) so the recovery agent can read it.
            throw new Error(`PayPal refused the refund: the seller's PayPal balance is too low to cover it (INSUFFICIENT_FUNDS). ${rest instanceof Error ? rest.message : ""}`);
          }
          throw rest;
        }
      }
    },

    async refundCapture(captureId, amount) {
      const body = amount ? { amount: { value: amount.value, currency_code: amount.currency_code } } : {};
      return (await callWithReceipt("POST", `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, body)).receipt;
    },

    async addTracking(transactionId, t, orderId) {
      const existing = await toolkit("get_shipment_tracking", { transaction_id: transactionId }).catch(() => null);
      const trackers: Array<{ tracking_number?: string }> = existing?.trackers ?? [];
      if (trackers.some((x) => x.tracking_number === t.tracking_number)) return "exists";
      try {
        await toolkit("create_shipment_tracking", { transaction_id: transactionId, tracking_number: t.tracking_number, carrier: t.carrier, status: "SHIPPED" });
      } catch (e) {
        // The toolkit uses the older trackers API, which apps without the "Add tracking"
        // feature get a 403 from. Orders v2 /track works for any app that took the payment.
        if (!orderId) throw e;
        await call("POST", `/v2/checkout/orders/${orderId}/track`, { capture_id: transactionId, tracking_number: t.tracking_number, carrier: t.carrier, notify_payer: false });
      }
      return "added";
    },

    async verifyWebhook(headers, event) {
      // A seller gateway passes its own webhook id (or null); only the demo sandbox uses the env var.
      const webhookId = opts.webhookId === undefined ? process.env.PAYPAL_WEBHOOK_ID : opts.webhookId;
      if (!webhookId) throw new Error("No PayPal webhook is registered for this account (set PAYPAL_WEBHOOK_ID for the demo sandbox).");
      const h = (k: string) => headers.get(k) ?? "";
      const res = await call("POST", "/v1/notifications/verify-webhook-signature", {
        auth_algo: h("paypal-auth-algo"),
        cert_url: h("paypal-cert-url"),
        transmission_id: h("paypal-transmission-id"),
        transmission_sig: h("paypal-transmission-sig"),
        transmission_time: h("paypal-transmission-time"),
        webhook_id: webhookId,
        webhook_event: event,
      });
      return res.verification_status === "SUCCESS";
    },

    async simulateRuling(id, outcome) {
      if (env === "live") throw new Error("PayPal decides real disputes itself; a ruling can only be simulated in the sandbox.");
      await call("POST", `/v1/customer/disputes/${id}/adjudicate`, { adjudication_outcome: outcome });
    },

    async fileTestDispute() {
      // Disputes are filed by the buyer, which needs the sandbox buyer account.
      // `npm run seed:sandbox` walks through it; see README.
      throw new Error("In sandbox mode, file test disputes from the sandbox buyer account (see README, 'Seeding the sandbox').");
    },
  };
}

// The toolkit signs in with its own HTTP client; record each access-token request on the
// trail too, as the server's own call.
function traceTokenCalls(tk: ReturnType<typeof makeToolkit>) {
  const client = (tk as unknown as { client?: { getAccessToken?: () => Promise<string> } }).client;
  const original = client?.getAccessToken?.bind(client);
  if (!client || !original) return;
  client.getAccessToken = () => traced({ method: "POST", endpoint: "/v1/oauth2/token", via: "rest", by: "system", case_id: null }, original);
}
