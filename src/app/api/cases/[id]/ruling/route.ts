import { z } from "zod";
import { simulateRuling } from "@/lib/actions";
import { assertWritable, withVisitor } from "@/lib/visitor";

const Body = z.object({ outcome: z.enum(["SELLER_FAVOR", "BUYER_FAVOR"]) });

export const POST = withVisitor(async (req: Request, ctx: RouteContext<"/api/cases/[id]/ruling">) => {
  const { id } = await ctx.params;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: body.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  try {
    assertWritable();
    return Response.json(await simulateRuling(id, body.data.outcome));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 422 });
  }
});
