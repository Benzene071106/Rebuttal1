// Whose shop the agents speak for. The Simulator and the shared demo sandbox are the demo
// shop; a signed-in seller is their own shop, under the name they gave at sign-up.

import { SHOP } from "./demo/scenarios";
import { visitor, type Visitor } from "./visitor";

export type Shop = { name: string; about: string };

export const DEMO_SHOP: Shop = { name: SHOP.name, about: "a two-person online shop" };

export function currentShop(v: Visitor = visitor()): Shop {
  if (v.mode === "mock" || !v.seller) {
    // The shared demo sandbox can be renamed for a different demo account.
    const name = v.mode === "mock" ? "" : process.env.SHOP_NAME?.trim();
    return name ? { name, about: "an online shop" } : DEMO_SHOP;
  }
  const name = v.seller.shop_name?.trim();
  return name ? { name, about: "an online shop" } : { name: "the seller's shop", about: "an online shop" };
}

// "Juniper & Kiln, a two-person online shop" for use inside a prompt.
export const describeShop = (s: Shop) => `${s.name}, ${s.about}`;
