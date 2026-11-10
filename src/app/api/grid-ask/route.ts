import { z } from "zod";
import { askGrid, GridAskError, savedAnswer } from "@/lib/grid-ask";
import { liveRunLimit, LiveLimitError } from "@/lib/rate-limit";
import { withVisitor } from "@/lib/visitor";

export const maxDuration = 60;

const Body = z.object({
  grid: z.enum(["disputes", "outcomes"], { errorMap: () => ({ message: "Pick the disputes or the outcomes table." }) }),
  question: z
    .string({ required_error: "Type a question about the table.", invalid_type_error: "Type a question about the table." })
    .trim()
    .min(3, "Type a question of at least 3 characters.")
    .max(300, "Keep the question under 300 characters."),
});

// "Ask the grid": a plain-English question becomes AG Grid filters, sort and grouping.
// Saved answers replay first and cost no model quota; only a new question is limited.
export const POST = withVisitor(async (req: Request) => {
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    const issue = body.error.issues[0];
    return Response.json({ error: issue && issue.path.length ? issue.message : "Send the table name and a question." }, { status: 400 });
  }
  const { grid, question } = body.data;
  const saved = savedAnswer(grid, question);
  if (saved) return Response.json(saved);
  const limited = liveRunLimit(req, "grid questions");
  if (limited) return limited;
  try {
    return Response.json(await askGrid(grid, question));
  } catch (e) {
    if (e instanceof GridAskError) return Response.json({ error: e.message }, { status: e.status });
    if (e instanceof LiveLimitError) return Response.json({ error: e.message }, { status: 429 });
    console.error("grid-ask failed:", e instanceof Error ? e.message : e);
    return Response.json({ error: "The AI couldn't answer that right now. Try again in a minute, or use one of the example questions." }, { status: 502 });
  }
});
