import { beforeEach, describe, expect, it } from "vitest";
import { approve } from "../src/lib/actions";
import { runAnalysis } from "../src/lib/analysis";
import { getCase, resetCases, syncCases, updateCase } from "../src/lib/cases";
import { loadInvestigation } from "../src/lib/investigation-cache";
import { armFault, resetMock } from "../src/lib/paypal/mock";
import { resetIncidents } from "../src/lib/recovery";
import { resetRules } from "../src/lib/rules";

import { ready } from "./ready";

process.env.PAYPAL_MODE = "mock";

describe("one action per dispute at a time", () => {
  beforeEach(async () => {
    resetMock();
    await resetCases();
    await resetRules();
    await resetIncidents();
  });

  it("sends only one response when approve is clicked five times during a PayPal outage", async () => {
    const [c] = await syncCases();
    await ready(c.id);
    armFault("OUTAGE"); // slows the first call down with retries, widening the race window
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => approve(c.id, { decision: "FIGHT", response: "Tracking shows delivery." })));
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(4);
    for (const r of refused) expect((r.reason as { status?: number }).status).toBe(409);
    // A later approve sees the sent response.
    await expect(approve(c.id, { decision: "REFUND", response: "x" })).rejects.toThrow("already sent");
  }, 30_000);

  it("refuses to send a response while the investigation runs, and the case keeps its final state", async () => {
    const cases = await syncCases();
    const c = cases.find((x) => loadInvestigation(x.dispute));
    expect(c, "a demo dispute with a saved investigation").toBeDefined();
    const analysis = runAnalysis(c!.id); // replays the saved trace slowly
    await new Promise((r) => setTimeout(r, 700));
    expect((await getCase(c!.id))?.status).toBe("ANALYZING");
    await expect(approve(c!.id, { decision: "REFUND", response: "Refunding." })).rejects.toThrow(/investigation|analysis/i);
    const done = await analysis;
    expect(done.status).toBe("READY");
    const sent = await approve(c!.id, { decision: "REFUND", response: "Refunding." });
    expect(sent.status).toBe("REFUNDED");
    expect((await getCase(c!.id))?.status).toBe("REFUNDED");
  }, 30_000);

  it("rounds offers to cents and refuses one that rounds to $0.00", async () => {
    // The $96 mug inquiry: offers aren't allowed once a dispute is a chargeback.
    const c = (await syncCases()).find((x) => x.dispute.dispute_life_cycle_stage !== "CHARGEBACK")!;
    await ready(c.id);
    await expect(approve(c.id, { decision: "OFFER", response: "Partial refund.", offer_amount: 0.001 })).rejects.toThrow("$0.01");
    expect((await getCase(c.id))?.submitted).toBeUndefined();
    const sent = await approve(c.id, { decision: "OFFER", response: "Partial refund.", offer_amount: 10.006 });
    expect(sent.submitted?.offer_amount).toBe(10.01);
  });
});
