import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../src/app/api/orders/[id]/action/route";
import { paypal } from "../src/lib/paypal";
import { armFault, resetMock } from "../src/lib/paypal/mock";
import { actOnOrder } from "../src/lib/preship";
import { listIncidents, resetIncidents } from "../src/lib/recovery";
import { listShield, resetShield, runShield } from "../src/lib/shield";
import { listCalls, resetTrail } from "../src/lib/trail";
import { runAs, type Visitor } from "../src/lib/visitor";

vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), connection: async () => {} }));

process.env.PAYPAL_MODE = "mock";
process.env.REBUTTAL_BACKOFF_MS = "1";
// A fresh, empty cache: no saved checks or plans, and nothing this test writes leaks into others.
process.env.REBUTTAL_CACHE_DIR = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "preship-")), "investigations");
delete process.env.GEMINI_API_KEY; // order checks fall back to the rule-based score, offline
delete process.env.AI_PROVIDER;

const ID = "5e5e5e5e-1111-2222-3333-444444444444";
const V: Visitor = { id: ID, mode: "mock" };
const as = <T>(fn: () => Promise<T>) => runAs({ ...V }, fn);
const cookie = `rebuttal_visitor=${ID}; rebuttal_mode=mock`;
const act = (invoice: string, action: unknown, c = cookie) =>
  POST(new Request(`http://x/api/orders/${invoice}/action`, { method: "POST", headers: { cookie: c }, body: JSON.stringify({ action }) }), { params: Promise.resolve({ id: invoice }) } as any);

const firstOrder = () => as(async () => (await paypal().ordersAwaitingShipment())[0]);

describe("pre-ship order actions", () => {
  beforeEach(() =>
    as(async () => {
      resetMock();
      resetShield();
      resetTrail();
      await resetIncidents();
    }),
  );

  it("refunds the PayPal capture, keeps the receipt on the order and puts it on the trail", async () => {
    const o = await firstOrder();
    const res = await act(o.invoice_id, "REFUND");
    expect(res.status).toBe(200);
    const { order } = await res.json();
    expect(order).toMatchObject({ order_id: o.order_id, invoice_id: o.invoice_id, to_review: false, decision: { action: "REFUND", receipt: { via: "simulator", http_status: 201 } } });
    expect(order.decision.receipt.endpoint).toMatch(/^\/v2\/payments\/captures\/[A-Z0-9]+\/refund$/);
    await as(async () => {
      const call = listCalls().find((c) => c.endpoint.endsWith("/refund"))!;
      expect(call).toMatchObject({ method: "POST", status: 201, via: "simulator", by: "seller", case_id: null, summary: "Refunded the payment before shipping" });
      // GET /api/orders shows the decision too.
      expect((await listShield()).find((r) => r.order_id === o.order_id)?.decision?.action).toBe("REFUND");
    });
  });

  it("saves a shipping rule without a PayPal write, and refuses a second action with 409", async () => {
    const o = await firstOrder();
    const res = await act(o.invoice_id, "SIGNATURE");
    expect(res.status).toBe(200);
    expect((await res.json()).order.decision).toMatchObject({ action: "SIGNATURE", receipt: null });
    await as(async () => {
      const call = listCalls().find((c) => c.by === "seller");
      expect(call).toMatchObject({ method: "POST", endpoint: `shop/orders/${o.invoice_id}/shipping-rule`, status: 200, via: "simulator", by: "seller" });
      expect(listCalls().some((c) => c.endpoint.includes("/refund"))).toBe(false);
    });
    const again = await act(o.invoice_id, "REFUND");
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("You already chose what to do with this order.");
  });

  it("returns 404 for an unknown order and 400 for an unknown action", async () => {
    expect((await act("JK-0000", "REFUND")).status).toBe(404);
    const o = await firstOrder();
    const bad = await act(o.invoice_id, "SHIP_IT");
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/REFUND, SIGNATURE or PAYPAL_ADDRESS/);
  });

  it("self-heals an injected PayPal 503 during the refund", async () => {
    const o = await firstOrder();
    await as(async () => {
      armFault("OUTAGE");
      const row = await actOnOrder(o.invoice_id, "REFUND");
      expect(row.decision?.action).toBe("REFUND");
      expect(listCalls().filter((c) => c.endpoint.endsWith("/refund")).map((c) => c.status)).toEqual([201, 503, 503]);
      const [inc] = await listIncidents();
      expect(inc).toMatchObject({ result: "HEALED", plan: "RETRIED", invoice: o.invoice_id, paypal: { status: 503 } });
    });
  }, 20_000);

  it("a flagged order stops counting as to review once the seller acts", async () => {
    const orders = await firstOrder().then(() => as(() => paypal().ordersAwaitingShipment()));
    await as(async () => {
      for (const o of orders) await runShield(o.order_id);
      const flagged = (await listShield()).find((r) => r.to_review)!;
      expect(flagged).toBeTruthy();
      await actOnOrder(flagged.invoice_id, "PAYPAL_ADDRESS");
      const after = (await listShield()).find((r) => r.order_id === flagged.order_id)!;
      expect(after).toMatchObject({ to_review: false, decision: { action: "PAYPAL_ADDRESS" } });
      // A re-check keeps the decision.
      expect((await runShield(flagged.order_id)).decision?.action).toBe("PAYPAL_ADDRESS");
    });
  }, 30_000);

  it("keeps the live sandbox view-only for anonymous visitors", async () => {
    const env = { NODE_ENV: process.env.NODE_ENV, id: process.env.PAYPAL_CLIENT_ID, secret: process.env.PAYPAL_CLIENT_SECRET };
    vi.stubEnv("NODE_ENV", "production");
    process.env.PAYPAL_CLIENT_ID = "test-id";
    process.env.PAYPAL_CLIENT_SECRET = "test-secret";
    try {
      const res = await act("JK-1093", "REFUND", `rebuttal_visitor=${ID}; rebuttal_mode=sandbox`);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/view-only/);
    } finally {
      vi.unstubAllEnvs();
      if (env.id === undefined) delete process.env.PAYPAL_CLIENT_ID; else process.env.PAYPAL_CLIENT_ID = env.id;
      if (env.secret === undefined) delete process.env.PAYPAL_CLIENT_SECRET; else process.env.PAYPAL_CLIENT_SECRET = env.secret;
    }
  });
});
