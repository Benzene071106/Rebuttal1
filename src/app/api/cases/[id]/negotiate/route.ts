import { negotiate } from "@/lib/negotiation";
import { liveRunLimit } from "@/lib/rate-limit";
import { assertWritable, runAs, visitor, withVisitor } from "@/lib/visitor";

export const maxDuration = 300;

// Streams the negotiation as NDJSON: {type:"turn"} lines, then {type:"done"} or {type:"error"}.
// Body: {max_refund} to start; empty to continue after the buyer answered.
export const POST = withVisitor(async (req: Request, ctx: RouteContext<"/api/cases/[id]/negotiate">) => {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { max_refund?: number };
  try {
    assertWritable();
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 422 });
  }
  if (body.max_refund !== undefined) {
    const limited = liveRunLimit(req, "negotiations");
    if (limited) return limited;
  }
  const enc = new TextEncoder();
  const v = visitor();
  const stream = new ReadableStream({
    start(controller) {
      const send = (o: unknown) => controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
      return runAs(v, async () => {
        try {
          const rec = await negotiate(id, { maxRefund: body.max_refund, onTurn: (turn) => send({ type: "turn", turn }) });
          send({ type: "done", case: rec });
        } catch (e) {
          send({ type: "error", error: e instanceof Error ? e.message : String(e) });
        } finally {
          controller.close();
        }
      });
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
});
