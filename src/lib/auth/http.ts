// Helpers for the account routes: same-origin checks, a small sign-in rate limit and
// the session cookie.

import { cookie } from "../visitor";
import { SESSION_COOKIE, SESSION_DAYS } from "./sellers";

// Browsers send Origin on POST. A request from another site (a form posting to us)
// is refused, on top of the SameSite=Lax session cookie.
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser clients (curl, tests)
  try {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

// At most 10 failed sign-ins per email or IP per 15 minutes, per server. A shared store
// (Redis) would make this exact across instances; per instance is enough to slow guessing.
const WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 10;
const fails = new Map<string, number[]>();

function recent(key: string): number[] {
  const now = Date.now();
  const list = (fails.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length) fails.set(key, list);
  else fails.delete(key);
  return list;
}

export { clientIp } from "../visitor";

export function tooManyAttempts(...keys: string[]): boolean {
  return keys.some((k) => recent(k).length >= MAX_FAILS);
}

export function recordFailure(...keys: string[]) {
  for (const k of keys) fails.set(k, [...recent(k), Date.now()]);
  if (fails.size > 10_000) fails.delete(fails.keys().next().value as string);
}

export function sessionCookie(token: string): string {
  return cookie(SESSION_COOKIE, token, SESSION_DAYS * 86_400);
}

export function clearSessionCookie(): string {
  return cookie(SESSION_COOKIE, "", 0);
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
