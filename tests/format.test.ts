import { describe, expect, it } from "vitest";
import { chunk } from "../src/components/format";
import { BULK_MAX } from "../src/lib/bulk";
import { plainError } from "../src/lib/errors";

describe("bulk approve batching", () => {
  it("splits 39 selected disputes into requests the server accepts", () => {
    const batches = chunk(Array.from({ length: 39 }, (_, i) => `D-${i}`), BULK_MAX);
    expect(batches.map((b) => b.length)).toEqual([25, 14]);
    expect(batches.flat()).toHaveLength(39);
  });
});

describe("plainError", () => {
  it("turns PayPal and Gemini JSON into one sentence", () => {
    expect(plainError(new Error('PayPal POST /v1/x failed (503): {"name":"SERVICE_UNAVAILABLE","message":"Service Unavailable.","debug_id":"abc"}'))).toBe("PayPal returned 503 SERVICE_UNAVAILABLE: Service Unavailable.");
    expect(plainError(new Error('{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}'))).toBe("The AI model refused the request (400): API key not valid. Please pass a valid API key.");
    expect(plainError(new Error("Plain words stay."))).toBe("Plain words stay.");
  });
});

describe("phone columns", () => {
  it("hides low-value columns on a phone, fits the rest to the screen, and pins the action column on wider screens", async () => {
    const { forPhone } = await import("../src/components/phone");
    const cols = [{ colId: "buyer" }, { colId: "claim" }, { field: "amount" }, { colId: "next" }] as any[];
    const phone = forPhone(cols, true, ["claim"], ["next"]);
    expect(phone.map((c) => [c.colId ?? c.field, !!c.hide, c.pinned ?? null])).toEqual([["buyer", false, null], ["claim", true, null], ["amount", false, null], ["next", false, null]]);
    expect(phone.find((c) => c.colId === "buyer")?.wrapText).toBeUndefined();
    expect(phone.every((c) => !c.floatingFilter)).toBe(true);
    const desk = forPhone(cols, false, ["claim"], ["next"]);
    expect(desk.find((c) => c.colId === "claim")?.hide).toBe(false);
    expect(desk.find((c) => c.colId === "next")?.pinned).toBe("right");
  });
});
