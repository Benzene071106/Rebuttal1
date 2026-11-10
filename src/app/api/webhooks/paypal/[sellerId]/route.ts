import { getSeller } from "@/lib/auth/sellers";
import { handlePayPalWebhook } from "@/lib/webhooks/paypal";

export const maxDuration = 300;

// Dispute webhooks from one seller's own PayPal app. The signature is checked against
// that seller's registered webhook, so one seller can't post events into another's
// account.
export async function POST(req: Request, ctx: RouteContext<"/api/webhooks/paypal/[sellerId]">) {
  const { sellerId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(sellerId)) return Response.json({ error: "Unknown account" }, { status: 404 });
  const seller = await getSeller(sellerId).catch(() => null);
  if (!seller?.paypal?.webhook_id) return Response.json({ error: "Unknown account" }, { status: 404 });
  return handlePayPalWebhook(req, { id: "server", mode: "sandbox", seller: { id: seller.id, email: seller.email, paypal: seller.paypal, shop_name: seller.shop_name } });
}
