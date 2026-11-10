// PayPal API trail: every PayPal call the agent, autopilot, the seller's approvals and
// the server itself made, so a judge (or a seller) can see exactly what reached PayPal.
// Kept in memory per tenant (a simulator visitor, a signed-in seller, or the shared
// sandbox), newest first. Both gateways record here: the live sandbox with PayPal's own
// status and PayPal-Debug-Id, the simulator with the same shape and a stable fake id.

import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { lruGet, tenant } from "./visitor";

export type TrailVia = "simulator" | "rest" | "agent_toolkit";
export type TrailBy = "agent" | "seller" | "autopilot" | "system";
export type TrailMethod = "GET" | "POST" | "PATCH";

export type TrailCall = {
  at: string;
  method: TrailMethod;
  endpoint: string;
  status: number;
  debug_id: string | null;
  via: TrailVia;
  by: TrailBy;
  case_id: string | null;
  summary: string;
};

export type TrailEntry = Omit<TrailCall, "at" | "by" | "case_id" | "summary" | "debug_id"> & Partial<Pick<TrailCall, "at" | "by" | "case_id" | "summary" | "debug_id">>;

const MAX_CALLS = 500;
const MAX_TENANTS = 500;
// The inbox and the shield poll every few seconds; the same background read repeated
// within this window is shown once, so the trail stays readable. Calls made by the
// agent, autopilot or the seller are always recorded.
const REPEAT_MS = 30_000;

type TenantTrail = { calls: TrailCall[]; seen: Map<string, number> };
const g = globalThis as unknown as { __rebuttalTrail?: Map<string, TenantTrail> };

function trail(t = tenant()): TenantTrail {
  g.__rebuttalTrail ??= new Map();
  return lruGet(g.__rebuttalTrail, t, () => ({ calls: [], seen: new Map() }), MAX_TENANTS);
}

// Who is acting, for the calls made inside: the agent (investigation, negotiation, order
// check), autopilot, the seller (approvals, order actions) or the server ("system").
// The innermost actor wins, so an investigation autopilot starts is still the agent's.
type Actor = { by: TrailBy; caseId?: string | null };
const actor = new AsyncLocalStorage<Actor>();

export function asActor<T>(by: TrailBy, fn: () => T, caseId?: string | null): T {
  const parent = actor.getStore();
  return actor.run({ by, caseId: caseId === undefined ? parent?.caseId : caseId }, fn);
}

export function currentActor(): Actor {
  return actor.getStore() ?? { by: "system" };
}

const SUMMARIES: Array<[RegExp, string]> = [
  [/^POST \/v1\/oauth2\/token/, "Signed in to PayPal for an access token"],
  [/^POST \/v1\/notifications\/verify-webhook-signature/, "Checked that a webhook really came from PayPal"],
  [/^GET \/v1\/customer\/disputes\/?(\?.*)?$/, "Listed the seller's disputes"],
  [/^GET \/v1\/customer\/disputes\/[^/]+$/, "Read the dispute"],
  [/^POST \/v1\/customer\/disputes\/[^/]+\/provide-evidence$/, "Sent evidence for the fight"],
  [/^POST \/v1\/customer\/disputes\/[^/]+\/provide-supporting-info$/, "Sent supporting information for the chargeback"],
  [/^POST \/v1\/customer\/disputes\/[^/]+\/make-offer$/, "Offered the buyer a partial refund"],
  [/^POST \/v1\/customer\/disputes\/[^/]+\/accept-claim$/, "Accepted the claim and refunded the buyer"],
  [/^POST \/v1\/customer\/disputes\/[^/]+\/send-message$/, "Messaged the buyer in the dispute"],
  [/^POST \/v1\/customer\/disputes\/[^/]+\/adjudicate$/, "Asked the sandbox to rule on the dispute"],
  [/^GET \/v2\/checkout\/orders\/[^/]+$/, "Read the PayPal order"],
  [/^POST \/v2\/checkout\/orders\/[^/]+\/track$/, "Added tracking to the PayPal order"],
  [/^GET \/v1\/shipping\/trackers/, "Read the shipment tracking"],
  [/^POST \/v1\/shipping\/trackers/, "Added shipment tracking to the transaction"],
  [/^GET \/v1\/reporting\/transactions/, "Searched the buyer's PayPal transactions"],
  [/^POST \/v2\/payments\/captures\/[^/]+\/refund$/, "Refunded the payment before shipping"],
  [/^POST shop\/orders\/[^/]+\/shipping-rule$/, "Saved a shipping rule for the order"],
];

export function summarize(method: string, endpoint: string, status: number): string {
  const key = `${method} ${endpoint}`;
  const base = SUMMARIES.find(([re]) => re.test(key))?.[1] ?? `${method} ${endpoint.split("?")[0]}`;
  if (status === 0) return `${base}: PayPal could not be reached`;
  return status >= 400 ? `${base}: PayPal returned ${status}` : base;
}

const caseFrom = (endpoint: string) => endpoint.match(/^\/v1\/customer\/disputes\/([^/?]+)/)?.[1] ?? null;

// A simulator call's debug id: stable for the same request, like one real PayPal request.
export function fakeDebugId(method: string, endpoint: string): string {
  return crypto.createHash("sha256").update(`${method} ${endpoint}`).digest("hex").slice(0, 13);
}

export function recordCall(entry: TrailEntry): TrailCall | null {
  const who = currentActor();
  const call: TrailCall = {
    at: entry.at ?? new Date().toISOString(),
    method: entry.method,
    endpoint: entry.endpoint,
    status: entry.status,
    debug_id: entry.debug_id ?? null,
    via: entry.via,
    by: entry.by ?? who.by,
    case_id: entry.case_id !== undefined ? entry.case_id : caseFrom(entry.endpoint) ?? who.caseId ?? null,
    summary: entry.summary ?? summarize(entry.method, entry.endpoint, entry.status),
  };
  const t = trail();
  if (call.method === "GET" && call.by === "system") {
    const key = `${call.via} ${call.endpoint} ${call.status}`;
    const now = Date.parse(call.at);
    const last = t.seen.get(key);
    if (last !== undefined && now - last < REPEAT_MS) return null;
    t.seen.set(key, now);
    if (t.seen.size > 1000) t.seen.delete(t.seen.keys().next().value as string);
  }
  t.calls.unshift(call);
  if (t.calls.length > MAX_CALLS) t.calls.length = MAX_CALLS;
  return call;
}

export function listCalls(caseId?: string | null): TrailCall[] {
  const calls = trail().calls;
  return caseId ? calls.filter((c) => c.case_id === caseId) : [...calls];
}

export function resetTrail() {
  g.__rebuttalTrail?.delete(tenant());
}

// The HTTP status and debug id in a gateway error: "PayPal POST /path failed (503): {..debug_id..}".
export function failureOf(e: unknown): { status: number; debug_id: string | null } {
  const msg = e instanceof Error ? e.message : String(e);
  const code = Number(msg.match(/\((\d{3})\)/)?.[1] ?? NaN);
  const status = Number.isFinite(code)
    ? code
    : /RESOURCE_NOT_FOUND|not found/i.test(msg)
      ? 404
      : /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|timed? ?out/i.test(msg)
        ? 0
        : 422;
  const debug = msg.match(/debug_id"?\s*:\s*"?([A-Za-z0-9]+)/)?.[1] ?? null;
  return { status, debug_id: debug };
}

// Runs one PayPal call and records it, success or failure. `meta.status` / `debugId`
// read PayPal's answer when the call returns one.
export async function traced<T>(
  meta: { method: TrailMethod; endpoint: string; via: TrailVia; by?: TrailBy; case_id?: string | null; status?: (out: T) => number; debugId?: (out: T) => string | null | undefined },
  run: () => Promise<T>,
): Promise<T> {
  const fake = meta.via === "simulator" ? fakeDebugId(meta.method, meta.endpoint) : null;
  try {
    const out = await run();
    recordCall({ method: meta.method, endpoint: meta.endpoint, via: meta.via, by: meta.by, case_id: meta.case_id, status: meta.status?.(out) ?? 200, debug_id: meta.debugId?.(out) ?? fake });
    return out;
  } catch (e) {
    const f = failureOf(e);
    recordCall({ method: meta.method, endpoint: meta.endpoint, via: meta.via, by: meta.by, case_id: meta.case_id, status: f.status, debug_id: f.debug_id ?? fake });
    throw e;
  }
}

// Where each Agent Toolkit tool lands in PayPal's REST API, for the trail.
export function toolEndpoint(name: string, input: Record<string, unknown>): { method: TrailMethod; endpoint: string } {
  const s = (k: string) => encodeURIComponent(String(input[k] ?? ""));
  switch (name) {
    case "get_dispute":
      return { method: "GET", endpoint: `/v1/customer/disputes/${s("dispute_id")}` };
    case "list_disputes":
      return { method: "GET", endpoint: "/v1/customer/disputes" };
    case "accept_dispute_claim":
      return { method: "POST", endpoint: `/v1/customer/disputes/${s("dispute_id")}/accept-claim` };
    case "get_order":
      return { method: "GET", endpoint: `/v2/checkout/orders/${s("id")}` };
    case "get_shipment_tracking":
      return { method: "GET", endpoint: input.transaction_id ? `/v1/shipping/trackers?transaction_id=${s("transaction_id")}` : "/v1/shipping/trackers" };
    case "create_shipment_tracking":
      return { method: "POST", endpoint: "/v1/shipping/trackers-batch" };
    case "list_transactions":
      return { method: "GET", endpoint: input.transaction_id ? `/v1/reporting/transactions?transaction_id=${s("transaction_id")}` : "/v1/reporting/transactions" };
    default:
      return { method: "GET", endpoint: `agent_toolkit/${name}` };
  }
}
