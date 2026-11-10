import type { Dispute, PayPalReceipt } from "../types";

// JSON-schema tool definition, as exposed by the PayPal Agent Toolkit.
export type ToolDef = { name: string; description: string; input_schema: { type: "object"; [k: string]: unknown }; strict?: boolean };

export type EvidenceSubmission = {
  notes: string;
  evidence_types: string[];
  tracking?: { carrier: string; tracking_number: string };
};

export interface PayPalGateway {
  mode: "sandbox" | "mock";

  // Read side: the agent calls these through `runTool`.
  agentTools(): ToolDef[];
  runTool(name: string, input: Record<string, unknown>): Promise<unknown>;

  // The shop's own order system remembers which PayPal order paid each invoice.
  orderIdForInvoice(invoiceId: string): Promise<string | null>;
  // Paid orders not shipped yet, for the dispute shield: { PayPal order id, invoice }.
  ordersAwaitingShipment(): Promise<Array<{ order_id: string; invoice_id: string }>>;

  listDisputes(): Promise<Dispute[]>;
  getDispute(id: string): Promise<Dispute>;

  // Write side: only ever called after the seller approves.
  provideEvidence(id: string, ev: EvidenceSubmission): Promise<PayPalReceipt>;
  // `negotiating` marks an offer made by the negotiator, which expects the buyer to
  // answer in the dispute conversation (the simulator's buyer then haggles).
  makeOffer(id: string, offer: { amount: string; currency: string; type: "REFUND" | "REFUND_WITH_RETURN"; note: string; negotiating?: boolean }): Promise<PayPalReceipt>;
  acceptClaim(id: string, note: string): Promise<PayPalReceipt>;
  // Refunds a captured payment (Payments v2), for a paid order the seller decides not to
  // ship. Without `amount` PayPal refunds the whole capture.
  refundCapture(captureId: string, amount?: { value: string; currency_code: string }): Promise<PayPalReceipt>;
  // Posts a message to the buyer in the dispute conversation.
  sendMessage(id: string, message: string): Promise<void>;
  // Makes sure PayPal has the carrier tracking on the disputed transaction before we
  // fight: PayPal's item-not-received decisions lean heavily on it.
  addTracking(transactionId: string, t: { carrier: string; tracking_number: string }, orderId?: string | null): Promise<"added" | "exists">;

  // Checks a webhook delivery really came from PayPal.
  verifyWebhook(headers: Headers, event: unknown): Promise<boolean>;

  // Sandbox-only simulation of PayPal's side of the dispute.
  simulateRuling(id: string, outcome: "SELLER_FAVOR" | "BUYER_FAVOR"): Promise<void>;
  fileTestDispute(scenarioKey?: string): Promise<Dispute>;
}

// Tools the agent may call. Read-only by design: every money-moving call is made
// by the server after the seller clicks Approve, never by the model.
export const AGENT_TOOL_NAMES = ["get_dispute", "get_order", "get_shipment_tracking", "list_transactions"] as const;
