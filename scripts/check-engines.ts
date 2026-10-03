import { readFileSync } from "node:fs";
import { priceScope, applyAmendments, pickTier, compareScopes, rank, incentiveValue } from "../src/engines.ts";

const shops = JSON.parse(readFileSync("data/shops.json", "utf8")).shops;
const load = (f: string) => JSON.parse(readFileSync(`data/cases/${f}`, "utf8"));

for (const c of [load("case-accord-selfpay.json"), load("case-elantra-insurance.json")]) {
  console.log(`\n=== ${c.title} (real estimate $${c.realEstimateTotal})`);
  const baselineIds = c.baseline.map((i: any) => i.id);
  const offerScopes: any[] = [];
  const priced: any[] = [];
  for (const s of shops.filter((s: any) => s.enabled !== false || s.id === "shop-c")) {
    const items = s.id === "drive" ? applyAmendments(c.baseline, c.amendments.drive) : c.baseline;
    for (const mode of ["self_pay", "insurance"] as const) {
      const p = priceScope(items, s.id, s.rateCards[mode], c.parts);
      const tier = mode === "insurance" ? pickTier(p.total, s.incentivePolicy.tiers) : undefined;
      console.log(`${s.name.padEnd(20)} ${mode.padEnd(9)} total $${p.total}  (labor ${p.labor}, materials ${p.materials}, parts ${p.parts}, tax ${p.tax})${tier ? `  tier→ ${tier.autonomous.map((i: any) => i.label).join(" + ") || "none"}` : ""}`);
      if (mode === "self_pay") priced.push({ s, p, items });
    }
    offerScopes.push({ shopId: s.id, itemIds: (s.id === "drive" ? applyAmendments(c.baseline, c.amendments.drive) : c.baseline).map((i: any) => i.id), disputed: [] });
  }
  const cmp = compareScopes(baselineIds, offerScopes);
  const ranked = rank("self_pay", "best_value", priced.map(({ s, p }, i) => ({
    shopId: s.id, shopName: s.name, total: p.total, rating: s.profile.rating, reviewCount: s.profile.reviewCount,
    turnaroundDays: s.turnaroundDays.value, warrantyScore: s.warranty.score, dropOffOrder: i, comparison: cmp.find((x) => x.shopId === s.id)!,
  })));
  console.log("statuses:", JSON.stringify(cmp.map((x) => ({ shop: x.shopId, eligible: x.eligible, statuses: x.statuses }))));
  console.log("ranking (self-pay, best value):", ranked.map((r) => `${r.shopId} ${r.score} ${r.recommended ? "★" : ""} ${r.why}`).join(" | "));
}
console.log("\nmaxJob null tier check:", pickTier(99999, shops[0].incentivePolicy.tiers)?.autonomous.map((i: any) => i.label));
console.log("incentive value:", incentiveValue(shops[0].incentivePolicy.tiers[1].autonomous));
