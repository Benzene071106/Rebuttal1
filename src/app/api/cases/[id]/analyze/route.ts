import { runAnalysis } from "@/lib/analysis";
import { plainError } from "@/lib/errors";
import { liveRunLimit } from "@/lib/rate-limit";
import { runAs, viewOnly, visitor, withVisitor } from "@/lib/visitor";

export const maxDuration = 300;

// Streams the agent's investigation as NDJSON: {type:"step"} lines, then {type:"done"} or {type:"error"}.
// ?fresh=1 skips the saved investigation and runs the model again.
export const POST = withVisitor(async (req: Request, ctx: RouteContext<"/api/cases/[id]/analyze">) => {
  const { id } = await ctx.params;
  const enc = new TextEncoder();
  // The stream runs after this handler returns, so carry the visitor into it.
  const v = visitor();
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  const savedOnly = viewOnly();
  // A re-run always calls the model; a first look usually replays a saved run.
  const limited = fresh && !savedOnly ? liveRunLimit(req, "fresh investigations") : null;
  if (limited) return limited;
  const stream = new ReadableStream({
    start(controller) {
      const send = (o: unknown) => controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
      return runAs(v, async () => {
        try {
          const rec = await runAnalysis(id, (step) => send({ type: "step", step }), { fresh, savedOnly });
          send({ type: "done", case: rec });
        } catch (e) {
          send({ type: "error", error: plainError(e) });
        } finally {
          controller.close();
        }
      });
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
});
