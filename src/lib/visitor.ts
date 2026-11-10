// Per-visitor demo state. On the hosted demo several judges can be clicking at once,
// so each browser gets its own simulator (disputes, cases, Reset demo) and its own
// Simulator / Live sandbox choice, keyed by a cookie. The live sandbox is one real
// PayPal account, so its cases stay shared.

import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { SESSION_COOKIE, sellerForSession, type PayPalConnection } from "./auth/sellers";

export type Mode = "mock" | "sandbox";
// A signed-in seller. Their "sandbox" mode is their own connected PayPal account
// (PayPal's sandbox or live API, whichever they connected).
export type SellerRef = { id: string; email: string; paypal: PayPalConnection | null; shop_name?: string };
// ip: the caller's address, for rate limits on live AI calls.
export type Visitor = { id: string; mode: Mode; seller?: SellerRef; ip?: string };

const VISITOR_COOKIE = "rebuttal_visitor";
const MODE_COOKIE = "rebuttal_mode";
const YEAR = 60 * 60 * 24 * 365;

const als = new AsyncLocalStorage<Visitor>();

// Whether this visitor has a real PayPal account to switch to: a signed-in seller's own,
// otherwise the shared demo sandbox configured on the server.
export function sandboxAvailable(seller?: SellerRef): boolean {
  if (seller) return Boolean(seller.paypal);
  return Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

// The starting mode for a new visitor. A seller with PayPal connected opens on their
// account; otherwise PAYPAL_MODE=mock opens on the simulator and sandbox credentials win.
export function defaultMode(seller?: SellerRef): Mode {
  if (seller) return seller.paypal ? "sandbox" : "mock";
  return process.env.PAYPAL_MODE === "mock" || !sandboxAvailable() ? "mock" : "sandbox";
}

// Code running outside a request (a PayPal webhook, a script) acts as the server
// itself: the shared state in the default mode. Decided on first use, not at import,
// so the environment (PAYPAL_MODE in tests and scripts) is read when it is final.
let server: Visitor | undefined;

export function visitor(): Visitor {
  return als.getStore() ?? (server ??= { id: "server", mode: defaultMode() });
}

// Whose records this request reads and writes: a simulator visitor, a signed-in
// seller, or the shared demo sandbox.
export function tenant(v: Visitor = visitor()): string {
  if (v.mode === "mock") return `mock:${v.id}`;
  if (v.seller) return `seller:${v.seller.id}`;
  return "sandbox";
}

export function runAs<T>(v: Visitor, fn: () => T): T {
  return als.run(v, fn);
}

export function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

// Wraps a route handler so everything it calls sees this browser's visitor id and
// mode, and the browser gets a visitor cookie on its first request.
export function withVisitor<A extends unknown[]>(handler: (req: Request, ...rest: A) => Promise<Response>) {
  return async (req: Request, ...rest: A): Promise<Response> => {
    const existing = readCookie(req, VISITOR_COOKIE);
    const id = existing && /^[a-f0-9-]{36}$/.test(existing) ? existing : crypto.randomUUID();
    const found = await sellerForSession(readCookie(req, SESSION_COOKIE)).catch((e) => {
      console.error("session lookup failed:", e instanceof Error ? e.message : e);
      return null;
    });
    const seller: SellerRef | undefined = found ? { id: found.id, email: found.email, paypal: found.paypal, shop_name: found.shop_name } : undefined;
    const wanted = readCookie(req, MODE_COOKIE);
    const mode: Mode = wanted === "sandbox" && sandboxAvailable(seller) ? "sandbox" : wanted === "mock" ? "mock" : defaultMode(seller);
    const v: Visitor = { id, mode, seller, ip: clientIp(req) };
    const res = await als.run(v, () => handler(req, ...rest));
    if (id !== existing) res.headers.append("Set-Cookie", cookie(VISITOR_COOKIE, id));
    if (v.mode !== wanted) res.headers.append("Set-Cookie", cookie(MODE_COOKIE, v.mode));
    return res;
  };
}

// The caller's address. Render sits behind Cloudflare, which sets cf-connecting-ip /
// true-client-ip itself; x-forwarded-for's first value is whatever the caller sent, so
// only its last hop (added by the proxy in front of us) is used.
export function clientIp(req: Request): string {
  const direct = req.headers.get("cf-connecting-ip") ?? req.headers.get("true-client-ip");
  if (direct?.trim()) return direct.trim();
  const hops = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return hops.at(-1) || "local";
}

export function cookie(name: string, value: string, maxAge = YEAR) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; SameSite=Lax; HttpOnly${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

// Switches this visitor's mode for the rest of the request; withVisitor writes the cookie.
export function setVisitorMode(mode: Mode) {
  const seller = visitor().seller;
  if (mode === "sandbox" && !sandboxAvailable(seller)) throw new Error(seller ? "Connect your PayPal account first (Account page)." : "PayPal sandbox credentials are not configured on this server.");
  visitor().mode = mode;
}

// Keeps at most `max` entries, dropping the least recently used, so the per-visitor
// simulators of past judges don't pile up in memory.
export function lruGet<V>(map: Map<string, V>, key: string, make: () => V, max = 500): V {
  let v = map.get(key);
  if (v !== undefined) map.delete(key);
  else v = make();
  map.set(key, v);
  while (map.size > max) map.delete(map.keys().next().value as string);
  return v;
}

// The live sandbox is one shared PayPal account. On the hosted demo it is view-only
// (cases, saved investigations, outcomes), so one visitor can't change it for others;
// set LIVE_SANDBOX_WRITABLE=1 to act on it, as local development does by default.
export function liveReadOnly(): boolean {
  if (process.env.LIVE_SANDBOX_WRITABLE === "1") return false;
  return process.env.NODE_ENV === "production";
}

export const READ_ONLY_MESSAGE = "The live PayPal sandbox is view-only on the hosted demo. Switch to the Simulator to try every step.";

// True when this visitor is looking at the live sandbox and may not change it.
// A seller's own PayPal account is always theirs to act on.
export function viewOnly(): boolean {
  return visitor().mode === "sandbox" && !visitor().seller && liveReadOnly();
}

export function assertWritable() {
  if (viewOnly()) throw new Error(READ_ONLY_MESSAGE);
}
