import { connection } from "next/server";
import { listCalls } from "@/lib/trail";
import { withVisitor } from "@/lib/visitor";

// The PayPal API trail: every PayPal call made for this visitor (simulator, signed-in
// seller or the shared sandbox), newest first. ?case=<dispute id> narrows it to one dispute.
export const GET = withVisitor(async (req: Request) => {
  await connection();
  const id = new URL(req.url).searchParams.get("case")?.trim();
  return Response.json({ calls: listCalls(id || undefined) });
});
