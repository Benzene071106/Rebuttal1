import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "../src/app/api/grid-ask/route";
import { askGrid, GridAskError, NOTHING_VALID, savedAnswer, validateView } from "../src/lib/grid-ask";
import { claudeModel } from "../src/lib/model";
import { resetRateLimits } from "../src/lib/rate-limit";

// Scripted model: answers set_grid_view with the given input, and counts its calls.
function answering(input: Record<string, unknown>) {
  const seen = { calls: 0, tools: [] as string[] };
  const client = {
    create: async (params: any) => {
      seen.calls++;
      seen.tools = params.tools.map((t: any) => t.name);
      return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_1", name: "set_grid_view", input }] } as any;
    },
  };
  return { model: claudeModel({ client: client as any }), seen };
}

const post = (body: unknown, cookie = "rebuttal_visitor=99999999-8888-7777-6666-555555555555; rebuttal_mode=mock") =>
  POST(new Request("http://x/api/grid-ask", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grid-ask-"));
  process.env.REBUTTAL_CACHE_DIR = path.join(tmp, "investigations");
  resetRateLimits();
});
afterEach(() => {
  delete process.env.REBUTTAL_CACHE_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("ask the grid", () => {
  it("turns a valid tool call into an AG Grid filter model, sort and grouping", async () => {
    const { model, seen } = answering({
      filters: [
        { colId: "claim", type: "equals", value: "unauthorized", valueTo: "" },
        { colId: "amount", type: "greaterThan", value: "$100", valueTo: "" },
      ],
      sort: [{ colId: "amount", sort: "desc" }],
      rowGroup: [],
      explanation: "Unauthorized claims over $100, biggest first.",
    });
    const out = await askGrid("disputes", "unauthorized claims over $100, biggest first", { model });
    expect(seen.tools).toEqual(["set_grid_view"]);
    expect(out).toEqual({
      filterModel: {
        claim: { filterType: "text", type: "equals", filter: "Unauthorized" },
        amount: { filterType: "number", type: "greaterThan", filter: 100 },
      },
      sort: [{ colId: "amount", sort: "desc" }],
      rowGroup: [],
      explanation: "Unauthorized claims over $100, biggest first.",
      replayed: false,
    });
  });

  it("drops unknown columns and filters in the wrong shape, and caps sort and grouping at two", () => {
    const v = validateView("outcomes", {
      filters: [
        { colId: "password", type: "equals", value: "x", valueTo: "" },
        { colId: "due", type: "lessThan", value: "3", valueTo: "" }, // a disputes column, not outcomes
        { colId: "claim", type: "greaterThan", value: "Duplicate", valueTo: "" }, // text can't be greaterThan
        { colId: "kept", type: "equals", value: "lots", valueTo: "" }, // not a number
        { colId: "refunded", type: "inRange", value: "10", valueTo: "" }, // inRange needs an upper bound
        { colId: "amount", type: "inRange", value: "200", valueTo: "50", },
        { colId: "closed", type: "equals", value: "2026-10-03", valueTo: "" },
      ],
      sort: [{ colId: "kept", sort: "desc" }, { colId: "nope", sort: "asc" }, { colId: "amount", sort: "sideways" }, { colId: "closed", sort: "asc" }, { colId: "buyer", sort: "asc" }],
      rowGroup: ["claim", "result", "by", "secret"],
      explanation: "",
    })!;
    expect(v.filterModel).toEqual({
      amount: { filterType: "number", type: "inRange", filter: 50, filterTo: 200 },
      closed: { filterType: "date", type: "inRange", dateFrom: "2026-10-03 00:00:00", dateTo: "2026-10-04 00:00:00" },
    });
    expect(v.sort).toEqual([{ colId: "kept", sort: "desc" }, { colId: "closed", sort: "asc" }]);
    expect(v.rowGroup).toEqual(["claim", "result"]);
    expect(v.explanation).toMatch(/^Showing disputes with/);
  });

  it("refuses an answer with nothing valid left", async () => {
    const { model } = answering({ filters: [{ colId: "weather", type: "equals", value: "sunny", valueTo: "" }], sort: [], rowGroup: [], explanation: "Not about this table." });
    await expect(askGrid("disputes", "what's the weather", { model })).rejects.toMatchObject({ message: NOTHING_VALID, status: 400 });
    await expect(askGrid("disputes", "what's the weather", { model })).rejects.toBeInstanceOf(GridAskError);
  });

  it("replays a saved answer for the same question without calling the model", async () => {
    const { model, seen } = answering({ filters: [{ colId: "result", type: "equals", value: "LOST", valueTo: "" }], sort: [], rowGroup: [], explanation: "Disputes you lost." });
    await askGrid("outcomes", "Disputes we lost", { model, save: true });
    expect(seen.calls).toBe(1);
    // The route checks saved answers first: no model is configured here, so a live call would fail.
    const res = await post({ grid: "outcomes", question: "  disputes   WE lost " });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ filterModel: { result: { filterType: "text", type: "equals", filter: "LOST" } }, replayed: true });
    expect(seen.calls).toBe(1);
    expect(savedAnswer("disputes", "Disputes we lost")).toBeNull(); // saved per grid
  });

  it("ships saved answers for the six example questions", () => {
    delete process.env.REBUTTAL_CACHE_DIR;
    const examples: Array<["disputes" | "outcomes", string]> = [
      ["disputes", "Urgent chargebacks first"], ["disputes", "Unauthorized claims over $100"], ["disputes", "Not investigated yet"],
      ["outcomes", "Disputes we lost"], ["outcomes", "Refunds by claim type"], ["outcomes", "Biggest wins first"],
    ];
    for (const [grid, q] of examples) expect(savedAnswer(grid, q), q).toMatchObject({ replayed: true, explanation: expect.any(String) });
  });

  it("validates the body, and rate-limits new questions with a 429", async () => {
    const key = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.AI_PROVIDER;
    try {
      expect((await post({ grid: "disputes", question: "hi" })).status).toBe(400);
      expect((await post({ grid: "orders", question: "big ones" })).status).toBe(400);
      const bad = await post({ grid: "disputes" });
      expect((await bad.json()).error).toMatch(/question/i);
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) statuses.push((await post({ grid: "disputes", question: `fresh question number ${i}` })).status);
      expect(statuses.slice(0, 10).every((s) => s === 502)).toBe(true); // no model configured
      expect(statuses[10]).toBe(429);
      const res = await post({ grid: "disputes", question: "fresh question number 99" });
      expect((await res.json()).error).toMatch(/^Too many grid questions/);
    } finally {
      if (key) process.env.GEMINI_API_KEY = key;
    }
  });
});
