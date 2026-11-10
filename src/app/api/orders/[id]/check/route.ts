import { liveRunLimit } from "@/lib/rate-limit";
import { runShield } from "@/lib/shield";
import { assertWritable, withVisitor } from "@/lib/visitor";

export const maxDuration = 300;

// Re-checks one order with the model, skipping the saved check.
export const POST = withVisitor(async (req: Request, ctx: RouteContext<"/api/orders/[id]/check">) => {
  const { id } = await ctx.params;
  try {
    assertWritable();
    const limited = liveRunLimit(req, "order re-checks");
    if (limited) return limited;
    return Response.json(await runShield(id, { fresh: true }));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 422 });
  }
});
