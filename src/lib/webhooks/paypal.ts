// Handles a PayPal dispute webhook for one account: the shared demo sandbox, or one
// seller (each seller's PayPal app delivers to /api/webhooks/paypal/<seller id>).
//
// PayPal retries a delivery until it gets a 2xx and may deliver an event twice, so each
// event id is handled once per account (store.claimEvent).

import { after } from "next/server";
import { ingestDisputeEvent, runAutopilot } from "../autopilot";
import { getCase } from "../cases";
import { negotiate } from "../negotiation";
import { paypal } from "../paypal";
import { storeFor } from "../store";
import { runAs, tenant, type Visitor } from "../visitor";

export async function handlePayPalWebhook(req: Request, as: Visitor): Promise<Response> {
  return runAs(as, () => handle(req, as));
}

async function handle(req: Request, as: Visitor): Promise<Response> {
  const event = await req.json().catch(() => null);
  if (!event?.event_type) return Response.json({ error: "Bad payload" }, { status: 400 });
  // Ignore other event types before verifying, so an app subscribed to more events
  // (or a missing PAYPAL_WEBHOOK_ID) never makes PayPal retry events we don't use.
  if (!String(event.event_type).startsWith("CUSTOMER.DISPUTE.")) return Response.json({ ignored: true });
  const gw = paypal();
  try {
    if (!(await gw.verifyWebhook(req.headers, event))) return Response.json({ error: "Signature check failed" }, { status: 401 });
  } catch (e) {
    // The reason (say, PAYPAL_WEBHOOK_ID not set) goes to the server log, not to the caller.
    console.error("webhook signature check could not run:", e instanceof Error ? e.message : e);
    return Response.json({ error: "Could not verify the event" }, { status: 500 });
  }
  if (!event.resource?.dispute_id) return Response.json({ error: "No dispute_id" }, { status: 400 });

  const store = storeFor(tenant());
  const eventId = typeof event.id === "string" ? event.id : null;
  if (eventId && !(await store.claimEvent(eventId))) return Response.json({ duplicate: true });

  let ingested;
  try {
    ingested = await ingestDisputeEvent(event);
  } catch (e) {
    // PayPal's "simulate event" sends a sample dispute that doesn't exist in the sandbox.
    // The signature already checked out, so accept it without investigating anything.
    console.warn(`Webhook ${eventId ?? ""} for ${event.resource.dispute_id}: dispute not readable (${e instanceof Error ? e.message : e}).`);
    return Response.json({ received: true, investigated: false }, { status: 202 });
  }
  try {
    const { case: rec, investigate } = ingested;
    if (investigate) after(() => runAs(as, () => runAutopilot(rec.id)));
    // The buyer answered an offer from the negotiator: let the agent make its next move.
    else if ((await getCase(rec.id))?.negotiation?.status === "WAITING_FOR_BUYER") {
      after(() => runAs(as, () => negotiate(rec.id).catch((e) => console.error(`negotiation ${rec.id} failed:`, e))));
    }
    return Response.json({ received: true });
  } catch (e) {
    // Let PayPal's retry try again.
    if (eventId) await store.releaseEvent(eventId).catch(() => {});
    console.error("webhook handling failed:", e);
    return Response.json({ error: "Could not process the event" }, { status: 500 });
  }
}
