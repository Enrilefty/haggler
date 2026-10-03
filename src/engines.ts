// Pure engines: pricing, incentives, scope comparison, ranking. No I/O.
// Rules follow QUOTE-ROOM-PLAN.md sections 9–11.

export type Mode = "self_pay" | "insurance";
export type Priority = "best_value" | "lowest_price" | "best_incentives" | "fastest" | "best_reviewed";

export interface ScopeItem {
  id: string; label: string; operation: string;
  bodyHours?: number; refinishHours?: number; mechHours?: number;
  part?: string; fixedCharge?: number;
}
export interface Amendment { action: "add" | "remove" | "change"; item?: ScopeItem; itemId?: string; reason: string }
export interface RateCard { body: number; refinish: number; paintMaterialsPerRefinishHour: number; mechanical: number; frame?: number; taxRateOnPartsAndMaterials: number }
export interface Incentive { kind: string; value: number; label: string }
export interface Tier { minJob: number; maxJob: number | null; autonomous: Incentive[]; maxDeductibleAssist: number }

const r2 = (n: number) => Math.round(n * 100) / 100;

// ---------- pricing (section 9) ----------
export interface PriceLine { itemId: string; label: string; amount: number; detail: string; partType?: string }
export interface PriceResult { lines: PriceLine[]; labor: number; materials: number; parts: number; other: number; subtotal: number; tax: number; total: number }

export function priceScope(items: ScopeItem[], shopId: string, rc: RateCard, parts: Record<string, Record<string, { type: string; price: number }>>): PriceResult {
  const lines: PriceLine[] = [];
  let labor = 0, materials = 0, partsSum = 0, other = 0;
  for (const it of items) {
    const b = (it.bodyHours ?? 0) * rc.body;
    const f = (it.refinishHours ?? 0) * rc.refinish;
    const m = (it.mechHours ?? 0) * rc.mechanical;
    const mat = (it.refinishHours ?? 0) * rc.paintMaterialsPerRefinishHour;
    const p = it.part ? parts[it.part]?.[shopId] : undefined;
    if (it.part && !p) throw new Error(`no part price for ${it.part} at ${shopId}`);
    const partPrice = p?.price ?? 0;
    const fixed = it.fixedCharge ?? 0;
    labor += b + f + m; materials += mat; partsSum += partPrice; other += fixed;
    const bits: string[] = [];
    if (it.bodyHours) bits.push(`${it.bodyHours}h body @ $${rc.body}`);
    if (it.refinishHours) bits.push(`${it.refinishHours}h paint @ $${rc.refinish} + materials @ $${rc.paintMaterialsPerRefinishHour}`);
    if (it.mechHours) bits.push(`${it.mechHours}h mechanical @ $${rc.mechanical}`);
    if (p) bits.push(`${p.type} part $${partPrice.toFixed(2)}`);
    if (fixed) bits.push(`fixed $${fixed.toFixed(2)}`);
    lines.push({ itemId: it.id, label: it.label, amount: r2(b + f + m + mat + partPrice + fixed), detail: bits.join(" · "), partType: p?.type });
  }
  const subtotal = labor + materials + partsSum + other;
  const tax = (partsSum + materials) * rc.taxRateOnPartsAndMaterials;
  return { lines, labor: r2(labor), materials: r2(materials), parts: r2(partsSum), other: r2(other), subtotal: r2(subtotal), tax: r2(tax), total: Math.round(subtotal + tax) };
}

// ---------- scope versions ----------
export function applyAmendments(baseline: ScopeItem[], amendments: Amendment[]): ScopeItem[] {
  let items = baseline.map((i) => ({ ...i }));
  for (const a of amendments) {
    if (a.action === "add" && a.item && !items.some((i) => i.id === a.item!.id)) items.push({ ...a.item });
    if (a.action === "remove" && a.itemId) items = items.filter((i) => i.id !== a.itemId);
    if (a.action === "change" && a.item) items = items.map((i) => (i.id === a.item!.id ? { ...a.item! } : i));
  }
  return items;
}

// ---------- incentives (section 10) ----------
export function pickTier(jobSize: number, tiers: Tier[]): Tier | undefined {
  // maxJob: null means no upper bound
  return tiers.find((t) => jobSize >= t.minJob && (t.maxJob === null || jobSize < t.maxJob));
}
export function incentiveValue(list: Incentive[]): number {
  return list.reduce((s, i) => s + (i.value ?? 0), 0);
}

// ---------- scope comparison (section 11.1) ----------
export type ItemStatus = "covered" | "missing_required" | "disputed" | "recommended_elsewhere";
export interface OfferScope { shopId: string; itemIds: string[]; disputed: string[] }
export interface ScopeComparison { shopId: string; statuses: Record<string, ItemStatus>; missingRequired: string[]; eligible: boolean; completeness: number; disputedCount: number }

export function compareScopes(baselineIds: string[], offers: OfferScope[]): ScopeComparison[] {
  const added = new Set<string>();
  for (const o of offers) for (const id of o.itemIds) if (!baselineIds.includes(id)) added.add(id);
  return offers.map((o) => {
    const statuses: Record<string, ItemStatus> = {};
    const missing: string[] = [];
    for (const id of baselineIds) {
      if (o.itemIds.includes(id)) statuses[id] = "covered";
      else if (o.disputed.includes(id)) statuses[id] = "disputed";
      else { statuses[id] = "missing_required"; missing.push(id); }
    }
    for (const id of added) {
      if (o.itemIds.includes(id)) statuses[id] = "covered";
      else if (o.disputed.includes(id)) statuses[id] = "disputed";
      else statuses[id] = "recommended_elsewhere"; // informational, never required
    }
    const covered = baselineIds.filter((id) => statuses[id] === "covered" || statuses[id] === "disputed").length;
    return { shopId: o.shopId, statuses, missingRequired: missing, eligible: missing.length === 0, completeness: baselineIds.length ? covered / baselineIds.length : 1, disputedCount: o.disputed.length };
  });
}

// ---------- ranking (section 11.2–11.5) ----------
export interface RankInput {
  shopId: string; shopName: string; total?: number; incentiveValue?: number; extrasCount?: number;
  rating?: number | null; reviewCount?: number | null; turnaroundDays: number; warrantyScore: number;
  dropOffOrder: number; // lower = earlier
  comparison: ScopeComparison;
}
export interface Ranked { shopId: string; score: number; eligible: boolean; recommended: boolean; why: string; breakdown: Record<string, number> }

type W = Partial<Record<"price" | "incentives" | "reviews" | "completeness" | "turnaround" | "warranty" | "extras", number>>;
export const WEIGHTS: Record<Mode, Partial<Record<Priority, W>>> = {
  self_pay: {
    best_value:    { price: 0.40, reviews: 0.20, completeness: 0.20, turnaround: 0.10, warranty: 0.10 },
    lowest_price:  { price: 0.65, reviews: 0.10, completeness: 0.15, turnaround: 0.05, warranty: 0.05 },
    fastest:       { price: 0.20, reviews: 0.15, completeness: 0.15, turnaround: 0.45, warranty: 0.05 },
    best_reviewed: { price: 0.20, reviews: 0.50, completeness: 0.15, turnaround: 0.10, warranty: 0.05 },
  },
  insurance: {
    best_value:      { incentives: 0.25, reviews: 0.30, completeness: 0.10, turnaround: 0.20, warranty: 0.10, extras: 0.05 },
    best_incentives: { incentives: 0.50, reviews: 0.20, completeness: 0.10, turnaround: 0.10, warranty: 0.05, extras: 0.05 },
    fastest:         { incentives: 0.15, reviews: 0.15, completeness: 0.10, turnaround: 0.50, warranty: 0.05, extras: 0.05 },
    best_reviewed:   { incentives: 0.15, reviews: 0.50, completeness: 0.10, turnaround: 0.15, warranty: 0.05, extras: 0.05 },
  },
};
export const PRIORITIES: Record<Mode, Priority[]> = {
  self_pay: ["best_value", "lowest_price", "fastest", "best_reviewed"],
  insurance: ["best_value", "best_incentives", "fastest", "best_reviewed"],
};
const LABEL: Record<string, string> = { price: "lowest price", incentives: "best incentives", reviews: "strongest reviews", completeness: "most complete scope", turnaround: "fastest turnaround", warranty: "best warranty", extras: "most extras" };

function norm(values: number[], higherIsBetter: boolean): { scores: number[]; equal: boolean } {
  const max = Math.max(...values), min = Math.min(...values);
  if (max === min) return { scores: values.map(() => 1), equal: true }; // equal values: all 1, excluded from "why"
  return { scores: values.map((v) => (higherIsBetter ? (v - min) / (max - min) : (max - v) / (max - min))), equal: false };
}
const reviewScore = (rating?: number | null, count?: number | null) =>
  rating == null || count == null ? 0 : (rating / 5) * Math.min(1, Math.log10(count + 1) / 2);

export function rank(mode: Mode, priority: Priority, inputs: RankInput[]): Ranked[] {
  if (!PRIORITIES[mode].includes(priority)) throw new Error(`priority ${priority} not offered in ${mode} mode`);
  const w = WEIGHTS[mode][priority]!;
  const crit: Record<string, { scores: number[]; equal: boolean }> = {};
  if (w.price != null) crit.price = norm(inputs.map((i) => i.total ?? 0), false);
  if (w.incentives != null) crit.incentives = norm(inputs.map((i) => i.incentiveValue ?? 0), true);
  if (w.extras != null) crit.extras = norm(inputs.map((i) => i.extrasCount ?? 0), true);
  // Reviews only count when at least two shops have them (demo shops carry no ratings, and one
  // rated shop shouldn't win "strongest reviews" by default).
  const rated = inputs.filter((i) => i.rating != null && i.reviewCount != null).length;
  crit.reviews = rated >= 2 ? norm(inputs.map((i) => reviewScore(i.rating, i.reviewCount)), true) : { scores: inputs.map(() => 1), equal: true };
  crit.completeness = norm(inputs.map((i) => i.comparison.completeness), true);
  crit.turnaround = norm(inputs.map((i) => i.turnaroundDays), false);
  crit.warranty = norm(inputs.map((i) => i.warrantyScore), true);

  const scored = inputs.map((inp, idx) => {
    const breakdown: Record<string, number> = {};
    let s = 0;
    for (const [k, wk] of Object.entries(w)) { const v = crit[k].scores[idx]; breakdown[k] = Math.round(v * 100) / 100; s += (wk as number) * v; }
    return { inp, idx, score: Math.round(s * 1000) / 1000, breakdown };
  });
  scored.sort((a, b) => {
    if (a.inp.comparison.eligible !== b.inp.comparison.eligible) return a.inp.comparison.eligible ? -1 : 1;
    if (Math.abs(a.score - b.score) > 0.01) return b.score - a.score;
    // tie-breakers: fewer disputed, earlier drop-off, higher reviews, price/incentive, name
    if (a.inp.comparison.disputedCount !== b.inp.comparison.disputedCount) return a.inp.comparison.disputedCount - b.inp.comparison.disputedCount;
    if (a.inp.dropOffOrder !== b.inp.dropOffOrder) return a.inp.dropOffOrder - b.inp.dropOffOrder;
    const ra = reviewScore(a.inp.rating, a.inp.reviewCount), rb = reviewScore(b.inp.rating, b.inp.reviewCount);
    if (ra !== rb) return rb - ra;
    if (mode === "self_pay" && (a.inp.total ?? 0) !== (b.inp.total ?? 0)) return (a.inp.total ?? 0) - (b.inp.total ?? 0);
    if (mode === "insurance" && (a.inp.incentiveValue ?? 0) !== (b.inp.incentiveValue ?? 0)) return (b.inp.incentiveValue ?? 0) - (a.inp.incentiveValue ?? 0);
    return a.inp.shopName.localeCompare(b.inp.shopName);
  });
  return scored.map((s, pos) => {
    const leads = Object.keys(w)
      .filter((k) => !crit[k].equal)
      .map((k) => ({ k, v: crit[k].scores[s.idx], best: Math.max(...crit[k].scores) }))
      .filter((x) => x.v === x.best && x.v > 0)
      .sort((a, b) => (w as any)[b.k] - (w as any)[a.k])
      .slice(0, 2)
      .map((x) => LABEL[x.k]);
    const recommended = pos === 0 && s.inp.comparison.eligible;
    const why = !s.inp.comparison.eligible
      ? `Needs clarification: missing ${s.inp.comparison.missingRequired.join(", ")}`
      : leads.length ? `${recommended ? "Recommended: " : ""}${leads.join(" and ")}` : (recommended ? "Recommended: best overall balance" : "");
    return { shopId: s.inp.shopId, score: s.score, eligible: s.inp.comparison.eligible, recommended, why, breakdown: s.breakdown };
  });
}
