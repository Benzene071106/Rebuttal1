import { beforeEach, describe, expect, it } from "vitest";
import { approve } from "../src/lib/actions";
import { resetCases, syncCases } from "../src/lib/cases";
import { resetMock } from "../src/lib/paypal/mock";
import { resetIncidents } from "../src/lib/recovery";
import { resetRules } from "../src/lib/rules";

import { ready } from "./ready";

process.env.PAYPAL_MODE = "mock";

describe("proof that PayPal accepted the response", () => {
  beforeEach(async () => {
    resetMock();
    await resetCases();
    await resetRules();
    await resetIncidents();
  });

  it("records the endpoint, PayPal's answer and the dispute status after the call", async () => {
    const [c] = await syncCases();
    await ready(c.id);
    const sent = await approve(c.id, { decision: "FIGHT", response: "Tracking shows delivery." });
    const r = sent.submitted?.receipt;
    expect(r?.endpoint).toBe(`/v1/customer/disputes/${c.id}/provide-evidence`);
    expect(r?.http_status).toBe(200);
    expect(r?.via).toBe("simulator");
    expect(r?.status_after).toBe(sent.dispute.status);
  });

  it("records the accept-claim call for a refund", async () => {
    const [c] = await syncCases();
    await ready(c.id);
    const sent = await approve(c.id, { decision: "REFUND", response: "Refunding." });
    expect(sent.submitted?.receipt?.endpoint).toMatch(/accept-claim$/);
    expect(sent.submitted?.receipt?.status_after).toBe("RESOLVED");
  });
});
