import { beforeEach, describe, expect, it, vi } from "vitest";
import { approve } from "../src/lib/actions";
import { analyzeDispute } from "../src/lib/agent";
import { getCase, resetCases, syncCases } from "../src/lib/cases";
import { scriptedModel } from "../src/lib/dev/scripted-model";
import { claudeModel } from "../src/lib/model";
import { paypal } from "../src/lib/paypal";
import { armFault, resetMock } from "../src/lib/paypal/mock";
import { resetIncidents } from "../src/lib/recovery";
import { listCalls, recordCall, resetTrail } from "../src/lib/trail";
import { runAs, type Visitor } from "../src/lib/visitor";
import { GET } from "../src/app/api/trail/route";
import { ready } from "./ready";

// Route handlers call connection() to opt out of prerendering; outside Next it has no request scope.
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), connection: async () => {} }));

process.env.PAYPAL_MODE = "mock";
process.env.REBUTTAL_BACKOFF_MS = "1";

const ID = "7a7a7a7a-1111-2222-3333-444444444444";
const V: Visitor = { id: ID, mode: "mock" };
const as = <T>(fn: () => Promise<T>) => runAs({ ...V }, fn);

describe("PayPal API trail", () => {
  beforeEach(() =>
    as(async () => {
      resetMock();
      await resetCases();
      await resetIncidents();
      resetTrail();
    }),
  );

  it("records the four read tools an investigation calls, as the agent's", () =>
    as(async () => {
      await syncCases();
      const d = await paypal().getDispute("PP-D-27800");
      resetTrail();
      await analyzeDispute(d, { model: claudeModel({ client: scriptedModel() as any }) });
      const calls = listCalls("PP-D-27800");
      const reads = calls.filter((c) => c.by === "agent").map((c) => c.endpoint.split("?")[0]);
      expect(reads).toEqual(expect.arrayContaining(["/v1/customer/disputes/PP-D-27800", expect.stringMatching(/^\/v2\/checkout\/orders\//), "/v1/shipping/trackers", "/v1/reporting/transactions"]));
      for (const c of calls) expect(c).toMatchObject({ method: "GET", status: 200, via: "simulator", case_id: "PP-D-27800" });
      expect(calls[0].debug_id).toMatch(/^[a-f0-9]{13}$/);
      expect(calls.map((c) => c.summary)).toContain("Searched the buyer's PayPal transactions");
    }),
  20_000);

  it("records the seller's approval as a POST with status 200", () =>
    as(async () => {
      await syncCases();
      await ready("PP-D-27800");
      await approve("PP-D-27800", { decision: "FIGHT", response: "Signed for on delivery." });
      const write = listCalls("PP-D-27800").find((c) => c.endpoint.endsWith("/provide-evidence"))!;
      expect(write).toMatchObject({ method: "POST", status: 200, by: "seller", via: "simulator", summary: "Sent evidence for the fight" });
    }),
  );

  it("records an injected outage's 503s, then the retry that went through", () =>
    as(async () => {
      await syncCases();
      await ready("PP-D-27800");
      armFault("OUTAGE");
      await approve("PP-D-27800", { decision: "REFUND", response: "Refunding." });
      const writes = listCalls("PP-D-27800").filter((c) => c.endpoint.endsWith("/accept-claim"));
      // Newest first: the successful retry, then the two failures.
      expect(writes.map((c) => c.status)).toEqual([200, 503, 503]);
      expect(writes[1].debug_id).toMatch(/^[a-f0-9]{13}$/);
      expect(writes[1].summary).toMatch(/PayPal returned 503/);
      expect((await getCase("PP-D-27800"))?.status).toBe("REFUNDED");
    }),
  20_000);

  it("GET /api/trail lists this visitor's calls newest first, and ?case= filters", async () => {
    await as(async () => {
      await syncCases();
      recordCall({ method: "GET", endpoint: "/v1/customer/disputes/PP-D-27801", status: 200, via: "simulator", by: "agent" });
      recordCall({ method: "POST", endpoint: "/v1/customer/disputes/PP-D-27800/provide-evidence", status: 200, via: "simulator", by: "seller" });
    });
    const headers = { cookie: `rebuttal_visitor=${ID}; rebuttal_mode=mock` };
    const all = (await (await GET(new Request("http://x/api/trail", { headers }))).json()).calls;
    expect(all[0].endpoint).toBe("/v1/customer/disputes/PP-D-27800/provide-evidence");
    expect(all.length).toBeGreaterThanOrEqual(2);
    const one = (await (await GET(new Request("http://x/api/trail?case=PP-D-27801", { headers }))).json()).calls;
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ method: "GET", case_id: "PP-D-27801", by: "agent", summary: "Read the dispute" });
    expect(Object.keys(one[0]).sort()).toEqual(["at", "by", "case_id", "debug_id", "endpoint", "method", "status", "summary", "via"]);
    // Another visitor sees none of it.
    const other = (await (await GET(new Request("http://x/api/trail", { headers: { cookie: "rebuttal_mode=mock" } }))).json()).calls;
    expect(other).toEqual([]);
  });

  it("shows a repeated background read once", () =>
    as(async () => {
      await paypal().listDisputes();
      await paypal().listDisputes();
      expect(listCalls().filter((c) => c.endpoint === "/v1/customer/disputes")).toHaveLength(1);
    }),
  );
});
