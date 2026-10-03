// Quote Room orchestrator: request lifecycle, server-side tool handlers, authority, approvals.
// Agents (ZooWork or the scripted fallback) act ONLY through these handlers, always with a
// server-bound identity (ctx.role / ctx.shopId). Prompts are never the enforcement.
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJson, STATE_DIR } from "./config.ts";
import {
  priceScope, applyAmendments, pickTier, compareScopes, rank, incentiveValue, PRIORITIES,
  type Mode, type Priority, type ScopeItem, type Incentive, type PriceResult, type Ranked, type ScopeComparison,
} from "./engines.ts";

export type Role = "buyer" | "shop";
export interface Ctx { role: Role; shopId?: string; requestId: string; via: "zoowork" | "scripted" }

export interface Offer {
  id: string; shopId: string; version: number; mode: Mode;
  items: ScopeItem[]; disputed: string[]; amendments: { action: string; itemId: string; reason: string }[];
  price?: PriceResult; jobSize?: number; incentives?: Incentive[];
  initialTotal?: number; slot: string; turnaroundDays: number; warranty: string;
  createdBy: "agent" | "owner" | "rule"; approvalId?: string; note?: string; at: string;
}
export interface Clarification { id: string; shopId: string; itemId: string; question: string; status: "open" | "added" | "disputed" | "timeout"; answer?: string }
export interface Approval {
  id: string; requestId: string; shopId: string; baseOfferId: string; baseOfferVersion: number;
  requested: { total?: number; deductibleAssist?: number }; agentLimit: { total?: number; deductibleCap?: number };
  reason: string; status: "pending" | "approved" | "countered" | "denied" | "expired";
  counter?: { total?: number; deductibleAssist?: number; extra?: string };
  createdAt: string; decidedAt?: string; consumedAt?: string; decidedVia?: string;
}
export interface RoomEvent { seq: number; requestId: string; at: string; type: string; actor: string; text: string; payload?: unknown }
export interface Request {
  id: string; caseId: string; mode: Mode; priority: Priority; status: string; createdAt: string;
  baselineIds: string[]; shops: string[]; offers: Record<string, Offer[]>; clarifications: Clarification[];
  asks: { id: string; shopId: string; text: string; target: { total?: number; deductibleAssist?: number }; outcome?: string }[];
  comparison?: ScopeComparison[]; ranking?: Ranked[]; booking?: { id: string; offerId: string; version: number; shopId: string; at: string; simulated: true };
  roomRef?: string; agentMode: string;
}

const now = () => new Date().toISOString();
let seqCounter = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const money = (n?: number) => (n == null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`);

export const SHOP_ACTOR: Record<string, string> = { drive: "Drive Auto Body", "shop-b": "Bayline Collision (simulated)", "shop-c": "QuickFix Auto Body (simulated)" };
export const GUARDRAIL_INSURANCE = "Your out-of-pocket amount depends on your policy, covered repairs, deductible and insurer payment.";
export const GUARDRAIL_INCENTIVE = "Incentives are paid by the shop and are never added to your insurance bill.";

export class Orchestrator extends EventEmitter {
  shops: any[] = readJson("data/shops.json").shops;
  cases: Record<string, any> = {};
  requests: Record<string, Request> = {};
  approvals: Record<string, Approval> = {};
  events: RoomEvent[] = [];
  private waiters = new Map<string, (v: any) => void>();
  private approvalWaiters = new Map<string, (a: Approval) => void>();

  constructor() {
    super();
    for (const f of ["case-accord-selfpay.json", "case-elantra-insurance.json"]) { const c = readJson(`data/cases/${f}`); this.cases[c.id] = c; }
  }
  shop(id: string) { const s = this.shops.find((x) => x.id === id); if (!s) throw new Error(`unknown shop ${id}`); return s; }
  activeShops() { return this.shops.filter((s) => s.enabled !== false).map((s) => s.id); }
  setShopEnabled(id: string, on: boolean) { this.shop(id).enabled = on; }
  updateProfile(id: string, profile: any) { Object.assign(this.shop(id).profile, profile); }

  // ---------- events ----------
  log(requestId: string, type: string, actor: string, text: string, payload?: unknown, mentions: string[] = []) {
    const ev: RoomEvent = { seq: ++seqCounter, requestId, at: now(), type, actor, text, payload };
    this.events.push(ev);
    this.emit("room", ev, mentions);
    this.persist();
    return ev;
  }
  feed(requestId: string, after = 0) { return this.events.filter((e) => e.requestId === requestId && e.seq > after); }
  private persist() {
    try { writeFileSync(join(STATE_DIR, "state.json"), JSON.stringify({ requests: this.requests, approvals: this.approvals, events: this.events.slice(-500) }, null, 1)); } catch { /* best effort */ }
  }

  // ---------- waiting helpers ----------
  waitFor<T>(key: string, ms: number): Promise<T | undefined> {
    return new Promise((res) => {
      const t = setTimeout(() => { this.waiters.delete(key); res(undefined); }, ms);
      this.waiters.set(key, (v) => { clearTimeout(t); this.waiters.delete(key); res(v); });
    });
  }
  private signal(key: string, v: unknown) { this.waiters.get(key)?.(v); }

  // ---------- request lifecycle ----------
  createRequest(caseId: string, mode: Mode, priority: Priority, agentMode: string): Request {
    const c = this.cases[caseId]; if (!c) throw new Error("unknown case");
    if (!PRIORITIES[mode].includes(priority)) priority = "best_value";
    const id = `R-${Math.floor(100 + Math.random() * 900)}`;
    const req: Request = { id, caseId, mode, priority, status: "room_open", createdAt: now(), baselineIds: c.baseline.map((i: any) => i.id), shops: this.activeShops(), offers: {}, clarifications: [], asks: [], agentMode };
    this.requests[id] = req;
    const scope = c.baseline.map((i: any) => `• ${i.label}`).join("\n");
    this.log(id, "request_posted", "Driver's agent",
      `New repair request: ${c.title}. Mode: ${mode === "self_pay" ? "paying myself" : "insurance claim"}. Needed by ${c.neededBy}.\nProposed scope (photo review, reviewed by a person — each shop may amend it):\n${scope}`,
      { caseId, mode, priority, baseline: c.baseline }, req.shops);
    if (mode === "insurance") this.log(id, "system_note", "Quote Room", `${GUARDRAIL_INCENTIVE} ${GUARDRAIL_INSURANCE}`);
    return req;
  }
  latest(req: Request, shopId: string): Offer | undefined { const v = req.offers[shopId]; return v?.[v.length - 1]; }
  latestOffers(req: Request) { return req.shops.map((s) => this.latest(req, s)).filter(Boolean) as Offer[]; }

  // ---------- SHOP tools (ctx.shopId is the bound identity) ----------
  private priceFor(req: Request, shopId: string, items: ScopeItem[]) {
    const s = this.shop(shopId), c = this.cases[req.caseId];
    if (req.mode === "self_pay") return { price: priceScope(items, shopId, s.rateCards.self_pay, c.parts) };
    const sizing = priceScope(items, shopId, s.rateCards.insurance, c.parts);
    const tier = pickTier(sizing.total, s.incentivePolicy.tiers);
    return { jobSize: sizing.total, incentives: (tier?.autonomous ?? []).map((i: Incentive) => ({ ...i })) };
  }
  private pushOffer(req: Request, shopId: string, o: Omit<Offer, "id" | "version" | "at" | "shopId" | "mode">) {
    const list = (req.offers[shopId] ??= []);
    const offer: Offer = { ...o, id: uid("O"), shopId, mode: req.mode, version: list.length + 1, at: now() };
    list.push(offer);
    return offer;
  }
  describeOffer(o: Offer) {
    const head = o.mode === "self_pay" ? `${money(o.price?.total)} total` : (o.incentives?.length ? o.incentives.map((i) => i.label).join(" + ") : "No incentives offered");
    return `${head} · drop-off ${o.slot} · ${o.turnaroundDays}-day turnaround · ${o.warranty}`;
  }

  tool_review_and_quote(ctx: Ctx) {
    const { shopId } = this.assertShop(ctx); const req = this.requests[ctx.requestId], c = this.cases[req.caseId], s = this.shop(shopId);
    if (this.latest(req, shopId)) return { ok: true, note: "already quoted", offer: this.latest(req, shopId) };
    const adds = shopId === "drive" ? (c.amendments?.drive ?? []) : [];
    const items = applyAmendments(c.baseline, adds);
    const priced = this.priceFor(req, shopId, items);
    const offer = this.pushOffer(req, shopId, {
      items, disputed: [], amendments: adds.map((a: any) => ({ action: a.action, itemId: a.item.id, reason: a.reason })),
      ...priced, initialTotal: priced.price?.total, slot: s.nextSlots[0], turnaroundDays: s.turnaroundDays.value, warranty: s.warranty.label,
      createdBy: ctx.via === "zoowork" ? "agent" : "rule",
    });
    if (adds.length) this.log(req.id, "scope_amended", SHOP_ACTOR[shopId], `Amending the scope:\n${adds.map((a: any) => `+ ${a.item.label} — ${a.reason}`).join("\n")}`, { adds }, ["buyer"]);
    else this.log(req.id, "scope_amended", SHOP_ACTOR[shopId], "Accepting the proposed scope as written.", {}, ["buyer"]);
    this.log(req.id, "offer_posted", SHOP_ACTOR[shopId], `Offer v${offer.version}: ${this.describeOffer(offer)}`, offer, ["buyer"]);
    this.signal(`quote:${req.id}:${shopId}`, offer);
    return { ok: true, offer: this.offerView(offer) };
  }

  tool_respond_clarification(ctx: Ctx, args: { clarificationId: string; message?: string }) {
    const { shopId } = this.assertShop(ctx); const req = this.requests[ctx.requestId], c = this.cases[req.caseId];
    const cl = req.clarifications.find((x) => x.id === args.clarificationId && x.shopId === shopId);
    if (!cl) return { error: "unknown_clarification_for_this_shop" };
    if (cl.status !== "open") return { ok: true, note: "already answered", status: cl.status };
    const rule = c.clarify?.[shopId] ?? { add: [], dispute: [] };
    const base = this.latest(req, shopId)!;
    const addDef = (c.amendments?.drive ?? []).find((a: any) => a.item.id === cl.itemId)?.item ?? c.baseline.find((i: any) => i.id === cl.itemId);
    let next: Offer;
    if (rule.add.includes(cl.itemId) && addDef) {
      const items = [...base.items, { ...addDef }];
      const priced = this.priceFor(req, shopId, items);
      next = this.pushOffer(req, shopId, { ...base, items, disputed: base.disputed, ...priced, createdBy: base.createdBy, note: `added ${cl.itemId} after clarification`, approvalId: undefined });
      cl.status = "added"; cl.answer = args.message || `Good catch — we'll include ${addDef.label.toLowerCase()}.`;
    } else {
      next = this.pushOffer(req, shopId, { ...base, disputed: [...base.disputed, cl.itemId], note: `disputed ${cl.itemId}`, approvalId: undefined });
      cl.status = "disputed"; cl.answer = args.message || "We don't think that's needed from the photos — we'll confirm at inspection.";
    }
    this.log(req.id, "clarification_answered", SHOP_ACTOR[shopId], `${cl.answer}\nOffer v${next.version}: ${this.describeOffer(next)}`, { clarification: cl, offer: next }, ["buyer"]);
    this.signal(`clar:${cl.id}`, cl);
    return { ok: true, status: cl.status, offer: this.offerView(next) };
  }

  limits(req: Request, shopId: string) {
    const s = this.shop(shopId), first = req.offers[shopId]?.[0];
    if (req.mode === "self_pay") {
      const init = first?.initialTotal ?? this.latest(req, shopId)?.price?.total ?? 0;
      const cur = this.latest(req, shopId)?.price?.total ?? init;
      const basis = Math.max(init, cur);
      return { autonomousLimit: Math.round(basis * (1 - s.selfPayAuthority.autonomousDiscountPct)), hardMinimum: Math.round(basis * s.selfPayAuthority.hardMinimumPct) };
    }
    const tier = pickTier(this.latest(req, shopId)?.jobSize ?? 0, s.incentivePolicy.tiers);
    return { deductibleCap: tier?.maxDeductibleAssist ?? 0 };
  }

  tool_revise_offer(ctx: Ctx, args: { total?: number; deductibleAssist?: number; message?: string }) {
    const { shopId } = this.assertShop(ctx); const req = this.requests[ctx.requestId]; const base = this.latest(req, shopId)!;
    const lim = this.limits(req, shopId);
    if (req.mode === "self_pay") {
      const total = Math.round(Number(args.total));
      if (!(total > 0)) return { error: "total_required" };
      if (total < (lim.autonomousLimit as number)) return { error: "beyond_authority", autonomousLimit: lim.autonomousLimit, hint: "Call request_exception to ask the owner." };
      if (total > (base.price?.total ?? Infinity)) return { error: "revision_must_not_raise_price" };
      const next = this.pushOffer(req, shopId, { ...base, price: { ...base.price!, total }, createdBy: base.createdBy, note: "revised within authority", approvalId: undefined });
      this.log(req.id, "offer_revised", SHOP_ACTOR[shopId], `${args.message || "Revised within my authority."}\nOffer v${next.version}: ${this.describeOffer(next)}`, next, ["buyer"]);
      this.signal(`ask:${req.id}:${shopId}`, { outcome: "revised", offer: next });
      return { ok: true, offer: this.offerView(next) };
    }
    const assist = Math.round(Number(args.deductibleAssist));
    if (!(assist >= 0)) return { error: "deductibleAssist_required" };
    if (assist > (lim.deductibleCap as number)) return { error: "beyond_authority", deductibleCap: lim.deductibleCap, hint: "Call request_exception to ask the owner." };
    const incentives = setAssist(base.incentives ?? [], assist);
    const next = this.pushOffer(req, shopId, { ...base, incentives, note: "incentive within authority", approvalId: undefined });
    this.log(req.id, "offer_revised", SHOP_ACTOR[shopId], `${args.message || "Within my authority."}\nOffer v${next.version}: ${this.describeOffer(next)}`, next, ["buyer"]);
    this.signal(`ask:${req.id}:${shopId}`, { outcome: "revised", offer: next });
    return { ok: true, offer: this.offerView(next) };
  }

  // Exception: creates an Approval bound to request/shop/base offer version/exact concession.
  // For the real shop the call PAUSES until the owner decides (Telegram/admin); simulated shops decide by rule.
  async tool_request_exception(ctx: Ctx, args: { total?: number; deductibleAssist?: number; reason: string }) {
    const { shopId } = this.assertShop(ctx); const req = this.requests[ctx.requestId]; const s = this.shop(shopId);
    const base = this.latest(req, shopId)!; const lim = this.limits(req, shopId);
    const requested = req.mode === "self_pay" ? { total: Math.round(Number(args.total)) } : { deductibleAssist: Math.round(Number(args.deductibleAssist)) };
    if (req.mode === "self_pay" && requested.total! >= (lim.autonomousLimit as number)) return { error: "within_authority_use_revise_offer" };
    if (req.mode === "insurance" && requested.deductibleAssist! <= (lim.deductibleCap as number)) return { error: "within_authority_use_revise_offer" };
    const ap: Approval = {
      id: `A-${Math.floor(1000 + Math.random() * 9000)}`, requestId: req.id, shopId, baseOfferId: base.id, baseOfferVersion: base.version,
      requested, agentLimit: req.mode === "self_pay" ? { total: lim.autonomousLimit as number } : { deductibleCap: lim.deductibleCap as number },
      reason: String(args.reason ?? "").slice(0, 300), status: "pending", createdAt: now(),
    };
    this.approvals[ap.id] = ap;
    this.log(req.id, "exception_requested", SHOP_ACTOR[shopId], s.exceptionMode === "owner" ? "That's beyond what I can offer on my own — asking the owner." : "Checking with the shop's rules.", { approval: ap });
    req.status = "awaiting_owner";
    if (s.exceptionMode === "rule") {
      const ok = req.mode === "self_pay" ? requested.total! >= (lim.hardMinimum as number) : requested.deductibleAssist! <= (lim.deductibleCap as number) * 1.0;
      this.decide(ap.id, ok ? "approve" : "deny", undefined, "rule");
    } else {
      this.emit("approval", ap, req, base);
    }
    const decided = ap.status === "pending" ? await new Promise<Approval>((res) => {
      const t = setTimeout(() => { if (ap.status === "pending") { ap.status = "expired"; ap.decidedAt = now(); this.log(req.id, "owner_decision", "Owner", "No answer in time — holding the current offer."); } res(ap); }, 150_000);
      this.approvalWaiters.set(ap.id, (a) => { clearTimeout(t); res(a); });
    }) : ap;
    req.status = "negotiating";
    const latest = this.latest(req, shopId);
    const result = { approvalId: decided.id, status: decided.status, counter: decided.counter, offer: latest ? this.offerView(latest) : undefined };
    this.signal(`ask:${req.id}:${shopId}`, { outcome: decided.status, offer: latest });
    return result;
  }

  // Owner/rule decision. Applies the concession ONLY to the exact bound offer version; single use.
  decide(approvalId: string, decision: "approve" | "counter" | "deny", counter?: { total?: number; deductibleAssist?: number; extra?: string }, via = "telegram") {
    const ap = this.approvals[approvalId];
    if (!ap) return { error: "unknown_approval" };
    if (ap.status !== "pending") return { error: `already_${ap.status}` };
    const req = this.requests[ap.requestId]; const base = this.latest(req, ap.shopId)!;
    if (base.id !== ap.baseOfferId || base.version !== ap.baseOfferVersion) { ap.status = "expired"; return { error: "offer_changed_since_request" }; }
    ap.decidedAt = now(); ap.decidedVia = via;
    const who = via === "rule" ? SHOP_ACTOR[ap.shopId] : "Owner (Gio)";
    if (decision === "deny") {
      ap.status = "denied";
      this.log(req.id, "owner_decision", who, req.mode === "self_pay" ? `Can't go to ${money(ap.requested.total)}. Holding ${money(base.price?.total)}.` : "Can't add more incentives on this job.", { approval: ap });
    } else {
      const conc = decision === "approve" ? ap.requested : { ...ap.requested, ...counter };
      if (req.mode === "self_pay" && !(Number(conc.total) > 0)) return { error: "counter_total_required" };
      ap.status = decision === "approve" ? "approved" : "countered"; if (decision === "counter") ap.counter = counter;
      const next = req.mode === "self_pay"
        ? this.pushOffer(req, ap.shopId, { ...base, price: { ...base.price!, total: Math.round(Number(conc.total)) }, createdBy: via === "rule" ? "rule" : "owner", approvalId: ap.id, note: counter?.extra })
        : this.pushOffer(req, ap.shopId, { ...base, incentives: setAssist(base.incentives ?? [], Math.round(Number(conc.deductibleAssist))), createdBy: via === "rule" ? "rule" : "owner", approvalId: ap.id, note: counter?.extra });
      if (counter?.extra) next.slot = counter.extra;
      ap.consumedAt = now(); // single use: bound to this exact concession and version
      this.log(req.id, "owner_decision", who, `${decision === "approve" ? "Approved" : "Countered"}: ${this.describeOffer(next)}`, { approval: ap, offer: next });
    }
    this.approvalWaiters.get(ap.id)?.(ap); this.approvalWaiters.delete(ap.id);
    this.emit("decided", ap);
    return { ok: true, approval: ap };
  }

  // ---------- BUYER tools ----------
  tool_get_offers(ctx: Ctx) {
    this.assertBuyer(ctx); const req = this.requests[ctx.requestId];
    this.refreshComparison(req);
    return { mode: req.mode, priority: req.priority, offers: this.latestOffers(req).map((o) => this.offerView(o)), comparison: req.comparison };
  }
  tool_clarify_item(ctx: Ctx, args: { shopId: string; itemId: string; question: string }) {
    this.assertBuyer(ctx); const req = this.requests[ctx.requestId];
    if (!req.shops.includes(args.shopId)) return { error: "shop_not_in_room" };
    if (req.clarifications.some((c) => c.shopId === args.shopId && c.itemId === args.itemId)) return { error: "already_asked_once" };
    const cl: Clarification = { id: uid("C"), shopId: args.shopId, itemId: args.itemId, question: String(args.question ?? "").slice(0, 300), status: "open" };
    req.clarifications.push(cl);
    this.log(req.id, "clarify_sent", "Driver's agent", `@${SHOP_ACTOR[args.shopId]} ${cl.question}`, { clarification: cl }, [args.shopId]);
    this.emit("deliver", { requestId: req.id, shopId: args.shopId, kind: "clarify", clarification: cl });
    return { ok: true, clarificationId: cl.id };
  }
  tool_ask_shop(ctx: Ctx, args: { shopId: string; total?: number; deductibleAssist?: number; message: string }) {
    this.assertBuyer(ctx); const req = this.requests[ctx.requestId];
    if (!req.shops.includes(args.shopId)) return { error: "shop_not_in_room" };
    if (req.asks.length >= 1) return { error: "one_negotiation_round_only" };
    const ask = { id: uid("Q"), shopId: args.shopId, text: String(args.message ?? "").slice(0, 300), target: req.mode === "self_pay" ? { total: Math.round(Number(args.total)) } : { deductibleAssist: Math.round(Number(args.deductibleAssist)) } };
    req.asks.push(ask); req.status = "negotiating";
    this.log(req.id, "ask_sent", "Driver's agent", `@${SHOP_ACTOR[args.shopId]} ${ask.text}`, { ask }, [args.shopId]);
    this.emit("deliver", { requestId: req.id, shopId: args.shopId, kind: "ask", ask, limits: this.limits(req, args.shopId) });
    return { ok: true, askId: ask.id };
  }
  tool_rank_offers(ctx: Ctx, args: { priority?: Priority }) {
    this.assertBuyer(ctx); const req = this.requests[ctx.requestId];
    if (args.priority && PRIORITIES[req.mode].includes(args.priority)) req.priority = args.priority;
    this.refreshComparison(req);
    const offers = this.latestOffers(req);
    req.ranking = rank(req.mode, req.priority, offers.map((o, i) => {
      const s = this.shop(o.shopId);
      return {
        shopId: o.shopId, shopName: s.name, total: o.price?.total, incentiveValue: incentiveValue((o.incentives ?? []).filter((x) => x.kind !== "rental_coordination")),
        extrasCount: (o.incentives ?? []).filter((x) => x.value === 0 || x.kind === "pickup" || x.kind === "rental_coordination").length,
        rating: s.profile.rating, reviewCount: s.profile.reviewCount, turnaroundDays: o.turnaroundDays, warrantyScore: s.warranty.score,
        dropOffOrder: i, comparison: req.comparison!.find((c) => c.shopId === o.shopId)!,
      };
    }));
    this.log(req.id, "ranking_ready", "Driver's agent", `Ranked by "${req.priority.replace("_", " ")}":\n${req.ranking.map((r, i) => `${i + 1}. ${SHOP_ACTOR[r.shopId]} — ${r.why || "—"}`).join("\n")}`, { ranking: req.ranking });
    return { ok: true, ranking: req.ranking };
  }
  tool_present_for_confirmation(ctx: Ctx, args: { summary?: string }) {
    this.assertBuyer(ctx); const req = this.requests[ctx.requestId];
    req.status = "ready_for_confirmation";
    this.log(req.id, "ready", "Driver's agent", args.summary || "Here are your offers. Pick the one you want and confirm — nothing is booked until you do. Final details are confirmed at inspection.");
    this.signal(`ready:${req.id}`, true);
    return { ok: true };
  }

  // ---------- driver confirmation ----------
  confirm(requestId: string, offerId: string, version: number) {
    const req = this.requests[requestId]; if (!req) return { error: "unknown_request" };
    if (req.booking) return { error: "already_booked" };
    const o = (req.offers[Object.keys(req.offers).find((s) => req.offers[s].some((x) => x.id === offerId)) ?? ""] ?? []).find((x) => x.id === offerId);
    if (!o || o.version !== version || this.latest(req, o.shopId)!.id !== o.id) return { error: "offer_not_current" };
    req.booking = { id: uid("B"), offerId: o.id, version: o.version, shopId: o.shopId, at: now(), simulated: true };
    req.status = "booked";
    this.log(req.id, "booked", "Quote Room", `Booked (simulated — no payment taken): ${SHOP_ACTOR[o.shopId]} · ${this.describeOffer(o)}`, { booking: req.booking, offer: o });
    this.emit("booked", req, o);
    return { ok: true, booking: req.booking };
  }

  // ---------- helpers ----------
  refreshComparison(req: Request) {
    const offers = this.latestOffers(req);
    req.comparison = compareScopes(req.baselineIds, offers.map((o) => ({ shopId: o.shopId, itemIds: o.items.map((i) => i.id), disputed: o.disputed })));
    return req.comparison;
  }
  offerView(o: Offer) {
    return { offerId: o.id, version: o.version, shop: SHOP_ACTOR[o.shopId], shopId: o.shopId, total: o.price?.total, jobSizeEstimate: o.jobSize, incentives: o.incentives, items: o.items.map((i) => i.id), disputed: o.disputed, slot: o.slot, turnaroundDays: o.turnaroundDays, warranty: o.warranty, createdBy: o.createdBy };
  }
  private assertShop(ctx: Ctx) {
    if (ctx.role !== "shop" || !ctx.shopId) throw new Error("forbidden: shop tool called by non-shop identity");
    const req = this.requests[ctx.requestId]; if (!req) throw new Error("unknown request");
    if (!req.shops.includes(ctx.shopId)) throw new Error("forbidden: shop not invited to this request");
    return { shopId: ctx.shopId };
  }
  private assertBuyer(ctx: Ctx) {
    if (ctx.role !== "buyer") throw new Error("forbidden: buyer tool called by non-buyer identity");
    if (!this.requests[ctx.requestId]) throw new Error("unknown request");
  }
}

function setAssist(list: Incentive[], amount: number): Incentive[] {
  const rest = list.filter((i) => i.kind !== "deductible_assist");
  return amount > 0 ? [{ kind: "deductible_assist", value: amount, label: `$${amount} toward your deductible` }, ...rest] : rest;
}
