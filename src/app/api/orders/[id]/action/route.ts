import { z } from "zod";
import { plainError } from "@/lib/errors";
import { actOnOrder, PreshipError } from "@/lib/preship";
import { assertWritable, READ_ONLY_MESSAGE, withVisitor } from "@/lib/visitor";

const Body = z.object({
  action: z.enum(["REFUND", "SIGNATURE", "PAYPAL_ADDRESS"], { errorMap: () => ({ message: "Choose REFUND, SIGNATURE or PAYPAL_ADDRESS." }) }),
});

// One action on a paid order before it ships: refund it through PayPal, or set a
// shipping rule (signature required, ship only to the PayPal address).
export const POST = withVisitor(async (req: Request, ctx: RouteContext<"/api/orders/[id]/action">) => {
  const { id } = await ctx.params;
  try {
    assertWritable();
  } catch {
    return Response.json({ error: READ_ONLY_MESSAGE }, { status: 403 });
  }
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    const issue = body.error.issues[0];
    return Response.json({ error: issue && issue.path.length ? issue.message : "Send the action to take." }, { status: 400 });
  }
  try {
    const row = await actOnOrder(id, body.data.action);
    return Response.json({ order: row });
  } catch (e) {
    if (e instanceof PreshipError) return Response.json({ error: e.message }, { status: e.status });
    return Response.json({ error: plainError(e) }, { status: 422 });
  }
});
