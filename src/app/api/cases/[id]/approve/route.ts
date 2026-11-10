import { z } from "zod";
import { approve } from "@/lib/actions";
import { CaseBusyError } from "@/lib/locks";
import { assertWritable, withVisitor } from "@/lib/visitor";

const Body = z.object({
  decision: z.enum(["FIGHT", "OFFER", "REFUND"]),
  response: z.string().min(1).max(2000),
  offer_amount: z.number().optional(),
  offer_type: z.enum(["REFUND", "REFUND_WITH_RETURN"]).optional(),
});

export const POST = withVisitor(async (req: Request, ctx: RouteContext<"/api/cases/[id]/approve">) => {
  const { id } = await ctx.params;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: body.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  try {
    assertWritable();
    return Response.json(await approve(id, body.data));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: e instanceof CaseBusyError ? 409 : 422 });
  }
});
