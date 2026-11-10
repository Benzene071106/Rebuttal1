// Pre-ship actions: the dispute shield flags a risky paid order, and the seller takes one
// clear action before anything ships.
// - REFUND: give the money back through PayPal (Payments v2 capture refund), the
//   cheapest way out of an order that looks like fraud. Self-healing like other writes.
// - SIGNATURE / PAYPAL_ADDRESS: shop-side shipping rules (require a signature, ship
//   only to the address on the PayPal transaction). No PayPal write; saved on the order.
// One action per order. Every action goes on the API trail as the seller's.

import { withCaseLock, CaseBusyError } from "./locks";
import { paypal } from "./paypal";
import { RecoveryPausedError, withRecovery } from "./recovery";
import { listShield, saveDecision, shieldDecision, type OrderDecision, type ShieldRow } from "./shield";
import { asActor, recordCall } from "./trail";
import type { CaseRecord } from "./types";

export type PreshipAction = OrderDecision["action"];

export class PreshipError extends Error {
  constructor(message: string, readonly status: 404 | 409 | 422) {
    super(message);
  }
}

export const NO_CAPTURE = "This order has no PayPal capture to refund yet.";

// The order as the shape withRecovery reads (PayPal's error, the amount, who the buyer
// is), so a failed refund is retried, logged and explained like a failed dispute write.
function orderAsCase(invoiceId: string, order: any, captureId: string): CaseRecord {
  const pu = order?.purchase_units?.[0] ?? {};
  const amount = { currency_code: String(pu.amount?.currency_code ?? "USD"), value: String(pu.amount?.value ?? "0") };
  const now = new Date().toISOString();
  return {
    id: invoiceId,
    status: "READY",
    trace: [],
    updated_at: now,
    dispute: {
      dispute_id: invoiceId,
      create_time: String(order?.create_time ?? now),
      update_time: now,
      reason: "OTHER",
      status: "OPEN",
      dispute_amount: amount,
      dispute_life_cycle_stage: "INQUIRY",
      disputed_transactions: [
        {
          seller_transaction_id: captureId,
          invoice_number: invoiceId,
          gross_amount: amount,
          buyer: { name: [order?.payer?.name?.given_name, order?.payer?.name?.surname].filter(Boolean).join(" "), email: order?.payer?.email_address },
        },
      ],
    },
  };
}

// Runs one action on a paid order awaiting shipment, found by its invoice id (or PayPal
// order id). Returns the order's row as GET /api/orders shows it, with the decision.
export function actOnOrder(id: string, action: PreshipAction): Promise<ShieldRow> {
  return asActor("seller", async () => {
    const meta = (await paypal().ordersAwaitingShipment()).find((o) => o.invoice_id === id || o.order_id === id);
    if (!meta) throw new PreshipError(`There is no paid order ${id} waiting to ship.`, 404);
    try {
      // The lock is taken before any PayPal call, so a double click can't refund twice.
      return await withCaseLock(`order:${meta.order_id}`, "An action", () => act(meta, action));
    } catch (e) {
      if (e instanceof CaseBusyError) throw new PreshipError("An action is already being taken on this order.", 409);
      throw e;
    }
  }, null);
}

async function act(meta: { order_id: string; invoice_id: string }, action: PreshipAction): Promise<ShieldRow> {
  if (shieldDecision(meta.order_id)) throw new PreshipError("You already chose what to do with this order.", 409);
  let receipt: OrderDecision["receipt"] = null;
  if (action === "REFUND") {
    const gw = paypal();
    const order = (await gw.runTool("get_order", { id: meta.order_id })) as any;
    const capture = order?.purchase_units?.[0]?.payments?.captures?.find((c: any) => c?.id && c.status !== "REFUNDED");
    if (!capture?.id) throw new PreshipError(NO_CAPTURE, 422);
    const pseudo = orderAsCase(meta.invoice_id, order, capture.id);
    try {
      await withRecovery(pseudo, "REFUND", Number(pseudo.dispute.dispute_amount.value), async () => {
        receipt = await gw.refundCapture(capture.id);
      });
    } catch (e) {
      if (e instanceof RecoveryPausedError) throw new PreshipError(e.message, 422);
      throw e;
    }
  } else {
    // A shipping rule lives in the shop, not in PayPal; it still goes on the trail so the
    // seller sees every action in one place.
    recordCall({ method: "POST", endpoint: `shop/orders/${meta.invoice_id}/shipping-rule`, status: 200, via: "simulator", debug_id: null, case_id: null });
  }
  saveDecision(meta, { action, at: new Date().toISOString(), receipt });
  // Reading the order back for the reply is the server's own read, not the seller's action.
  const row = (await asActor("system", () => listShield())).find((r) => r.order_id === meta.order_id);
  if (!row) throw new PreshipError(`There is no paid order ${meta.invoice_id} waiting to ship.`, 404);
  return row;
}
