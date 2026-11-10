// The Rebuttal network: one seller's proven dispute protects every other seller.
//
// When a shop on Rebuttal wins a dispute where its evidence contradicted the buyer
// (a "never arrived" claim on a parcel the carrier shows delivered or signed for, or an
// "unauthorized" claim on a payment from the buyer's own account and address), it shares
// a report: a one-way hash of the buyer's PayPal email, the claim type, what the evidence
// showed and the result. No names, addresses, amounts or order details leave the shop.
// Before another shop ships to that buyer, or while it answers their dispute, it sees
// how many other shops reported them.
//
// In this demo the other shops are simulated (fixed reports below, labeled as such in
// the UI). This shop's own reports come from its real case history.

import { currentShop } from "./shop";
import crypto from "node:crypto";
import { listCases } from "./cases";
import type { CaseRecord, DisputeReason } from "./types";

export type NetworkReport = {
  buyer_hash: string;
  shop: string;
  simulated_shop: boolean;
  reason: DisputeReason;
  evidence: string;
  outcome: "WON" | "LOST";
  at: string;
};

export type NetworkMatch = {
  buyer_hash: string;
  // Other shops only: a buyer's disputes with this shop are in its own dispute memory.
  other_shops: number;
  reports: NetworkReport[];
};

// Salted so the hash can't be matched against a plain list of email hashes.
export const buyerHash = (email: string) => crypto.createHash("sha256").update(`rebuttal-network:v1:${email.trim().toLowerCase()}`).digest("hex").slice(0, 16);

const DAY = 86_400_000;

// Reports from other (simulated) Rebuttal shops. Emails are hashed at load, exactly as a
// shop would send them; the plain emails here exist only to build the demo.
const OTHER_SHOPS: Array<{ email: string; shop: string; reason: DisputeReason; evidence: string; outcome: "WON" | "LOST"; days_ago: number }> = [
  // The forwarder order on Protect (JK-1088): two shops already caught this account.
  { email: "t.reyes.shop@example.com", shop: "Northbeam Leather", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", evidence: "Delivered to a package forwarder, signed for by the forwarder", outcome: "WON", days_ago: 21 },
  { email: "t.reyes.shop@example.com", shop: "Copper & Pine Goods", reason: "UNAUTHORISED", evidence: "Paid from a newly opened, unverified PayPal account; shipped overnight to a forwarder", outcome: "LOST", days_ago: 47 },
  // Dana Whitfield: the open "never arrived" dispute on the signed-for tote, and her new order.
  { email: "dana.w@example.com", shop: "Fernhill Ceramics", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", evidence: "UPS shows delivered, signed for by WHITFIELD", outcome: "WON", days_ago: 64 },
  // A repeat disputer from this shop's own history, also reported elsewhere.
  { email: "c.haldane@example.com", shop: "Saltmarsh Prints", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", evidence: "USPS shows delivered to the buyer's address", outcome: "WON", days_ago: 33 },
  { email: "c.haldane@example.com", shop: "Northbeam Leather", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", evidence: "UPS shows delivered, signed for by HALDANE", outcome: "WON", days_ago: 95 },
  // Accounts no one at this shop has met (yet).
  { email: "quick.buyer.77@example.com", shop: "Copper & Pine Goods", reason: "UNAUTHORISED", evidence: "Same device and address as the account's earlier purchases", outcome: "WON", days_ago: 12 },
  { email: "quick.buyer.77@example.com", shop: "Fernhill Ceramics", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", evidence: "Delivered, signed for", outcome: "WON", days_ago: 40 },
  { email: "mel.ortega.shop@example.com", shop: "Saltmarsh Prints", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", evidence: "Delivered to the address on the transaction", outcome: "WON", days_ago: 18 },
];

const PROVEN = /DELIVERY_SIGNATURE|FULFILLMENT/;

// What this shop contributes: disputes it won where its evidence contradicted the claim.
export function reportFromCase(c: CaseRecord): NetworkReport | null {
  const email = c.dispute.disputed_transactions[0]?.buyer?.email;
  if (!email || c.outcome?.result !== "WON") return null;
  if (c.dispute.reason !== "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" && c.dispute.reason !== "UNAUTHORISED") return null;
  const ev = c.recommendation?.evidence.find((e) => PROVEN.test(e.type));
  if (!ev) return null;
  return { buyer_hash: buyerHash(email), shop: currentShop().name, simulated_shop: false, reason: c.dispute.reason, evidence: ev.summary, outcome: "WON", at: c.outcome.at };
}

export async function allReports(now = Date.now()): Promise<NetworkReport[]> {
  const others = OTHER_SHOPS.map((r) => ({
    buyer_hash: buyerHash(r.email),
    shop: r.shop,
    simulated_shop: true,
    reason: r.reason,
    evidence: r.evidence,
    outcome: r.outcome,
    at: new Date(now - r.days_ago * DAY).toISOString(),
  }));
  const own = (await listCases()).map(reportFromCase).filter((r): r is NetworkReport => Boolean(r));
  return [...others, ...own];
}

// Reports from other shops about this buyer.
export async function networkFor(email: string | undefined | null): Promise<NetworkMatch> {
  const hash = buyerHash(email ?? "");
  const reports = email ? (await allReports()).filter((r) => r.buyer_hash === hash && r.simulated_shop) : [];
  return { buyer_hash: hash, other_shops: new Set(reports.map((r) => r.shop)).size, reports };
}

export type NetworkAccount = {
  buyer_hash: string;
  // Known only when this shop has dealt with the buyer; otherwise just the hash.
  email: string | null;
  name: string | null;
  shops: number;
  reports: number;
  reasons: DisputeReason[];
  evidence: string;
  last_at: string;
  yours: number; // reports this shop shared
};

// Every account reported to the network, with the buyer named only when this shop has
// its own record of them (a dispute or a paid order).
export async function listNetwork(known: Array<{ email: string; name: string }>): Promise<{ accounts: NetworkAccount[]; shops: number; reports: number; shared: number }> {
  const reports = await allReports();
  const names = new Map(known.map((k) => [buyerHash(k.email), k]));
  const by = new Map<string, NetworkReport[]>();
  for (const r of reports) by.set(r.buyer_hash, [...(by.get(r.buyer_hash) ?? []), r]);
  const accounts = [...by.entries()]
    .map(([hash, rs]): NetworkAccount => {
      const latest = [...rs].sort((a, b) => b.at.localeCompare(a.at))[0];
      const k = names.get(hash);
      return {
        buyer_hash: hash,
        email: k?.email ?? null,
        name: k?.name ?? null,
        shops: new Set(rs.map((r) => r.shop)).size,
        reports: rs.length,
        reasons: [...new Set(rs.map((r) => r.reason))],
        evidence: latest.evidence,
        last_at: latest.at,
        yours: rs.filter((r) => !r.simulated_shop).length,
      };
    })
    // Accounts seen at more than one shop are the ones the network exists for.
    .sort((a, b) => b.shops - a.shops || b.reports - a.reports || b.last_at.localeCompare(a.last_at));
  return { accounts, shops: new Set(reports.map((r) => r.shop)).size, reports: reports.length, shared: reports.filter((r) => !r.simulated_shop).length };
}
