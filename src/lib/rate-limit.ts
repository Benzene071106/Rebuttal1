// Limits on live AI runs. The hosted demo spends one free-tier Gemini key, so a single
// visitor (or a script) must not be able to use it up for everyone else. Saved runs
// replay for free and are never limited. Counts are per server instance, in memory:
// enough to stop abuse of a one-instance demo.

import { clientIp, visitor } from "./visitor";

export { clientIp };

const MINUTE = 60_000;
const hits = new Map<string, number[]>();

export class LiveLimitError extends Error {
  readonly status = 429;
}

// Records one hit for every key, or none if any key is over its limit.
function take(keys: Array<{ key: string; max: number; windowMs: number }>): boolean {
  const now = Date.now();
  const lists = keys.map(({ key, windowMs }) => (hits.get(key) ?? []).filter((t) => now - t < windowMs));
  if (keys.some((k, i) => lists[i].length >= k.max)) return false;
  keys.forEach((k, i) => {
    hits.delete(k.key); // re-insert, so the Map stays ordered by last use
    hits.set(k.key, [...lists[i], now]);
  });
  // Drop the least recently used keys instead of clearing everything, so a flood can't
  // reset the limits. The daily cap is never dropped.
  for (const key of hits.keys()) {
    if (hits.size <= 20_000) break;
    if (key !== "call:day") hits.delete(key);
  }
  return true;
}

const num = (v: string | undefined, d: number) => (v && Number(v) > 0 ? Number(v) : d);

// A fresh AI run started from a route (Re-run investigation, Re-check order, a new
// negotiation, an Ask AI question). Returns a 429 response when over the limit.
export function liveRunLimit(req: Request, what = "fresh AI runs"): Response | null {
  const v = visitor();
  const ok = take([
    { key: `run:v:${v.id}`, max: 10, windowMs: 10 * MINUTE },
    { key: `run:ip:${clientIp(req)}`, max: 30, windowMs: 10 * MINUTE },
  ]);
  if (ok) return null;
  return Response.json({ error: `Too many ${what} in a few minutes. Wait a little and try again; saved runs still work.` }, { status: 429 });
}

// Every live model call (one investigation makes several). The daily cap protects the
// shared free quota through judging; set LIVE_MODEL_DAILY_CAP to change it.
export function takeModelCall() {
  const v = visitor();
  const ok = take([
    { key: `call:v:${v.id}`, max: 80, windowMs: 10 * MINUTE },
    ...(v.ip ? [{ key: `call:ip:${v.ip}`, max: 200, windowMs: 10 * MINUTE }] : []),
    { key: "call:day", max: num(process.env.LIVE_MODEL_DAILY_CAP, 1500), windowMs: 24 * 60 * MINUTE },
  ]);
  if (!ok) throw new LiveLimitError("The AI has had too many fresh requests right now. Wait a few minutes and try again; saved runs still work.");
}

export function resetRateLimits() {
  hits.clear();
}
