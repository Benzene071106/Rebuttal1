// Regression tests for the Jira stress-test tickets (SMS-8 to SMS-21).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { approve, SIM_AUTO_RULING_MS, simulateRuling } from "../src/lib/actions";
import { getCase, resetCases, syncCases, updateCase } from "../src/lib/cases";
import { negotiate } from "../src/lib/negotiation";
import { resetMock } from "../src/lib/paypal/mock";
import { liveRunLimit, resetRateLimits, takeModelCall } from "../src/lib/rate-limit";
import { resetIncidents } from "../src/lib/recovery";
import { DEFAULT_RULES, getRules, resetRules, RulesSchema, setRules } from "../src/lib/rules";
import type { CaseRecord } from "../src/lib/types";
import { clientIp, runAs } from "../src/lib/visitor";
import { REC } from "./ready";

process.env.PAYPAL_MODE = "mock";
process.env.REBUTTAL_CACHE_DIR = "/nonexistent/investigations";

const byInvoice = async (inv: string) => (await syncCases()).find((c) => c.dispute.disputed_transactions[0].invoice_number === inv)!;
const ready = (c: CaseRecord, decision: "FIGHT" | "OFFER" | "REFUND" = "FIGHT") => updateCase(c.id, { status: "READY", recommendation: { ...REC, decision } });

describe("Jira fixes", () => {
  beforeEach(async () => {
    resetMock();
    await resetCases();
    await resetRules();
    await resetIncidents();
    resetRateLimits();
  });

  it("SMS-8: the negotiator ceiling can't go above the seller's max-refund rule", async () => {
    const mug = await ready(await byInvoice("JK-1057"), "OFFER");
    await expect(negotiate(mug.id, { maxRefund: 95.99 })).rejects.toThrow(/at most 40% \(\$38\.40\)/);
    expect((await getCase(mug.id))?.negotiation).toBeUndefined();
  });

  it("SMS-9: no ruling on a refunded or already-ruled dispute", async () => {
    const a = await ready(await byInvoice("JK-1042"));
    await approve(a.id, { decision: "REFUND", response: "refund" });
    await expect(simulateRuling(a.id, "SELLER_FAVOR")).rejects.toThrow(/closed|refunded/);
    expect((await getCase(a.id))?.outcome?.result).toBe("REFUNDED");

    const b = await ready(await byInvoice("JK-1071"));
    await approve(b.id, { decision: "FIGHT", response: "evidence" });
    expect((await simulateRuling(b.id, "SELLER_FAVOR")).outcome?.result).toBe("WON");
    await expect(simulateRuling(b.id, "BUYER_FAVOR")).rejects.toThrow(/already closed/);
    expect((await getCase(b.id))?.outcome?.result).toBe("WON");
  });

  it("SMS-10: no offer on a chargeback, no response before an investigation, no $1 deal", async () => {
    const cb = await byInvoice("JK-1071");
    await expect(approve(cb.id, { decision: "FIGHT", response: "x" })).rejects.toThrow(/Investigate/);
    await ready(cb);
    await expect(approve(cb.id, { decision: "OFFER", response: "x", offer_amount: 1 })).rejects.toThrow(/chargeback/);

    const mug = await ready(await byInvoice("JK-1057"), "OFFER");
    await approve(mug.id, { decision: "OFFER", response: "token offer", offer_amount: 1 });
    expect((await simulateRuling(mug.id, "SELLER_FAVOR")).outcome?.result).toBe("LOST");
  });

  it("SMS-10: the recommended $24 mug offer is still accepted by the simulated buyer", async () => {
    const mug = await ready(await byInvoice("JK-1057"), "OFFER");
    await approve(mug.id, { decision: "OFFER", response: "one mug", offer_amount: 24 });
    expect((await simulateRuling(mug.id, "SELLER_FAVOR")).outcome?.result).toBe("SETTLED");
  });

  it("SMS-14: rules API uses the panel's limits", () => {
    const bad = (patch: object) => RulesSchema.safeParse({ ...DEFAULT_RULES, ...patch }).success;
    expect(bad({ auto_fight_min_win: 0.01 })).toBe(false);
    expect(bad({ auto_fight_min_win: 0.49 })).toBe(false);
    expect(bad({ negotiate_max_pct: 0 })).toBe(false);
    expect(bad({ auto_refund_max: 29.999999 })).toBe(false);
    expect(bad({ auto_fight_min_win: 0 })).toBe(true);
    expect(bad({ auto_fight_min_win: 0.9, auto_refund_max: 29.5, negotiate_max_pct: 0.05 })).toBe(true);
  });

  it("SMS-15: Reset demo puts the rules back to the defaults", async () => {
    const { POST } = await import("../src/app/api/demo/reset/route");
    const cookie = "rebuttal_visitor=11111111-2222-3333-4444-555555555555; rebuttal_mode=mock";
    await runAs({ id: "11111111-2222-3333-4444-555555555555", mode: "mock" }, () => setRules({ ...DEFAULT_RULES, auto_fight_min_win: 0.9 }));
    const res = await POST(new Request("http://x/api/demo/reset", { method: "POST", headers: { cookie } }));
    expect(res.status).toBe(200);
    expect(await runAs({ id: "11111111-2222-3333-4444-555555555555", mode: "mock" }, getRules)).toEqual(DEFAULT_RULES);
  });

  it("SMS-17: a fight sent by autopilot or bulk approve gets a ruling in the simulator", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const c = await ready(await byInvoice("JK-1071"));
      await approve(c.id, { decision: "FIGHT", response: "evidence", by: "autopilot", autoRule: true });
      expect((await getCase(c.id))?.outcome).toBeUndefined();
      await vi.advanceTimersByTimeAsync(SIM_AUTO_RULING_MS + 100);
    } finally {
      vi.useRealTimers();
    }
    await new Promise((r) => setTimeout(r, 50));
    expect((await getCase((await byInvoice("JK-1071")).id))?.outcome?.result).toBe("WON");
  });

  it("SMS-11/18: client IP ignores a spoofed first x-forwarded-for value", () => {
    expect(clientIp(new Request("http://x", { headers: { "x-forwarded-for": "1.2.3.4, 9.9.9.9" } }))).toBe("9.9.9.9");
    expect(clientIp(new Request("http://x", { headers: { "x-forwarded-for": "1.2.3.4", "cf-connecting-ip": "8.8.8.8" } }))).toBe("8.8.8.8");
  });

  it("SMS-18: fresh AI runs are limited per visitor, and live model calls per day", () => {
    process.env.LIVE_MODEL_DAILY_CAP = "3";
    try {
      runAs({ id: "v1", mode: "mock" }, () => {
        const req = new Request("http://x", { headers: { "cf-connecting-ip": "5.5.5.5" } });
        const results = Array.from({ length: 11 }, () => liveRunLimit(req));
        expect(results.slice(0, 10).every((r) => r === null)).toBe(true);
        expect(results[10]?.status).toBe(429);
        for (let i = 0; i < 3; i++) takeModelCall();
        expect(() => takeModelCall()).toThrow(/too many/i);
      });
    } finally {
      delete process.env.LIVE_MODEL_DAILY_CAP;
    }
  });

  it("SMS-11: Ask AI refuses live turns from a caller with no visitor cookie", async () => {
    const { POST } = await import("../src/app/api/studio/turn/route");
    const res = await POST(new Request("http://x/api/studio/turn", { method: "POST", body: JSON.stringify({ input: [{ role: "user", content: "Reply PONG" }], instructions: "You are a general assistant." }) }));
    expect(res.status).toBe(401);
  });

  it("SMS-19: approve and ruling return one plain sentence for a bad body", async () => {
    const approveRoute = await import("../src/app/api/cases/[id]/approve/route");
    const res = await approveRoute.POST(new Request("http://x", { method: "POST", body: JSON.stringify({ decision: "FIGHT", response: "x".repeat(2001) }) }), { params: Promise.resolve({ id: "PP-D-27801" }) } as never);
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).not.toMatch(/^\[|"code"/);
  });
});
