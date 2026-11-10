import { updateCase } from "../src/lib/cases";
import type { Recommendation } from "../src/lib/types";

// A finished investigation, so approve() accepts a response for the case.
export const REC: Recommendation = {
  decision: "FIGHT", win_probability: 0.9, headline: "Fight", rationale: "Signed delivery.", evidence: [],
  response_to_paypal: "Tracking shows delivery.", tracking_carrier: "", tracking_number: "", offer_amount: 0, offer_type: "REFUND", risks: [],
};

export const ready = (id: string) => updateCase(id, { status: "READY", recommendation: REC });
