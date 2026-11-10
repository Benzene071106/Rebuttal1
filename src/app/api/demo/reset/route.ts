import { resetCases } from "@/lib/cases";
import { paypal } from "@/lib/paypal";
import { resetMock } from "@/lib/paypal/mock";
import { resetIncidents } from "@/lib/recovery";
import { resetRules } from "@/lib/rules";
import { resetShield } from "@/lib/shield";
import { resetTrail } from "@/lib/trail";
import { withVisitor } from "@/lib/visitor";

// Resets this visitor's simulator only; other visitors keep theirs.
export const POST = withVisitor(async () => {
  if (paypal().mode !== "mock") return Response.json({ error: "Reset is only available in the Simulator." }, { status: 400 });
  resetMock();
  await resetCases();
  resetShield();
  await resetIncidents();
  await resetRules();
  resetTrail();
  return Response.json({ ok: true });
});
