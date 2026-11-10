import { beforeEach, describe, expect, it } from "vitest";
import { approve } from "../src/lib/actions";
import { resetCases, syncCases } from "../src/lib/cases";
import { paypal } from "../src/lib/paypal";
import { armedFault, armFault, MAX_OPEN_SIM_DISPUTES, resetMock } from "../src/lib/paypal/mock";
import { resetIncidents } from "../src/lib/recovery";
import { DEFAULT_RULES, RulesSchema } from "../src/lib/rules";

import { ready } from "./ready";

process.env.PAYPAL_MODE = "mock";

describe("stress-test limits", () => {
  beforeEach(async () => {
    resetMock();
    await resetCases();
    await resetIncidents();
  });

  it("stops simulating disputes once the demo orders run out, instead of repeating an invoice", async () => {
    await syncCases();
    const gw = paypal();
    const filed: Array<{ disputed_transactions: Array<{ invoice_number?: string }> }> = [];
    await expect(async () => {
      for (let i = 0; i < MAX_OPEN_SIM_DISPUTES; i++) filed.push(await gw.fileTestDispute());
    }).rejects.toThrow("No more demo orders");
    // The $28 print, then one repeat of the signed-delivery order for the autopilot-fight walkthrough.
    expect(filed.map((d) => d.disputed_transactions[0].invoice_number)).toEqual(["JK-1063", "JK-1042"]);
  });

  it("rejects rules whose auto-refund limit is above the hard cap, whoever sends them", () => {
    expect(RulesSchema.safeParse({ ...DEFAULT_RULES, auto_refund_max: 5000, max_auto_amount: 10 }).success).toBe(false);
    expect(RulesSchema.safeParse(DEFAULT_RULES).success).toBe(true);
  });

  it("uses up an armed 'insufficient funds' fault on the next write, even when it isn't a refund", async () => {
    const [a] = await syncCases();
    await ready(a.id);
    armFault("INSUFFICIENT_FUNDS");
    await approve(a.id, { decision: "FIGHT", response: "Evidence attached." });
    expect(armedFault()).toBeNull();
  });
});
