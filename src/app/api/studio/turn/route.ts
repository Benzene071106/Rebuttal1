import { runStudioTurn, type StudioTurnRequest } from "@/lib/model/studio-turn";
import { LiveLimitError, takeModelCall } from "@/lib/rate-limit";
import { loadStudioTurn, saveStudioTurn, studioKey } from "@/lib/studio-cache";
import { clientIp, readCookie, withVisitor } from "@/lib/visitor";

// AG Studio's agents call this once per model turn (see src/lib/model/studio-turn.ts).
// It spends the server's free-tier Gemini key, so requests are size-capped and each
// browser address gets a modest number of turns per minute.
const MAX_BODY = 600_000;
const PER_MINUTE = 40;
const recent = new Map<string, number[]>();

function allowed(ip: string) {
  const now = Date.now();
  const hits = (recent.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (hits.length >= PER_MINUTE) return false;
  hits.push(now);
  recent.set(ip, hits);
  // Drop the oldest addresses instead of clearing everything, so a flood can't reset it.
  while (recent.size > 5_000) recent.delete(recent.keys().next().value as string);
  return true;
}

export const POST = withVisitor(async (req: Request) => {
  const ip = clientIp(req);
  const raw = await req.text();
  if (raw.length > MAX_BODY) return Response.json({ error: "This conversation got too long. Start a new chat." }, { status: 413 });
  let body: StudioTurnRequest;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }
  if (!Array.isArray(body.input)) return Response.json({ error: "Bad request." }, { status: 400 });
  const key = studioKey({ input: body.input, instructions: body.instructions, tools: body.tools, toolChoice: body.toolChoice, responseFormat: body.responseFormat });
  const saved = loadStudioTurn(key);
  if (saved) {
    // A short pause so the agent's steps are readable as they replay.
    await new Promise((r) => setTimeout(r, 350));
    console.log(`studio turn replayed ${key}`);
    return Response.json({ ...(saved as object), replayed: true });
  }
  // Live turns are for the Ask AI page only: the browser must already have the visitor
  // cookie the app sets, so a bare script can't use this as a free Gemini proxy.
  if (!/^[a-f0-9-]{36}$/.test(readCookie(req, "rebuttal_visitor") ?? "")) return Response.json({ error: "Reload the page and ask again." }, { status: 401 });
  // Only live turns count against the limits; replays cost nothing.
  if (!allowed(ip) || !allowed(`v:${readCookie(req, "rebuttal_visitor")}`)) return Response.json({ error: "Too many AI requests in a minute. Wait a moment and ask again." }, { status: 429 });
  if (!process.env.GEMINI_API_KEY) return Response.json({ error: "The AI analyst needs GEMINI_API_KEY on the server." }, { status: 503 });
  try {
    const t0 = Date.now();
    // Recording saved runs: pace the turns and wait out rate limits, so a run is never
    // cut short by the free tier's per-minute quota.
    const recording = process.env.STUDIO_RECORD === "1";
    if (recording) await new Promise((r) => setTimeout(r, 4_000));
    takeModelCall();
    const out = await runStudioTurn(body, recording ? { retryDelaysMs: [20_000, 40_000, 60_000] } : {});
    saveStudioTurn(key, out);
    console.log(`studio turn ${key} ${out.model} ${Date.now() - t0}ms tools=${body.tools?.length ?? 0} calls=${out.output.filter((o) => o.type === "function_call").map((o) => (o.type === "function_call" ? o.name : "")).join(",")}`);
    return Response.json(out);
  } catch (e) {
    if (e instanceof LiveLimitError) return Response.json({ error: e.message }, { status: 429 });
    const status = (e as { status?: number }).status;
    const msg = e instanceof Error ? e.message : String(e);
    console.error("studio turn failed", status, msg.slice(0, 300));
    return Response.json({ error: status === 429 || /rate limit/i.test(msg) ? "The free Gemini quota is busy. Try again in a minute." : "The AI model didn't answer. Try again." }, { status: 502 });
  }
});
