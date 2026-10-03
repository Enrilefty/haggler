// Quote Room orchestrator: request lifecycle, server-side tool handlers, authority, approvals.
// Agents (ZooWork or the scripted fallback) act ONLY through these handlers, always with a
// server-bound identity (ctx.role / ctx.shopId). Prompts are never the enforcement.
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { readJson, ROOT, STATE_DIR } from "./config.ts";
import * as cat from "./catalog.ts";
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
  id: string; requestId: string; shopId: string; askId: string; baseOfferId: string; baseOfferVersion: number;
  requested: { total?: number; deductibleAssist?: number }; agentLimit: { total?: number; deductibleCap?: number };
  reason: string; status: "pending" | "approved" | "countered" | "denied" | "expired";
  counter?: { total?: number; deductibleAssist?: number; extra?: string };
  createdAt: string; decidedAt?: string; consumedAt?: string; decidedVia?: string;
}
export interface RoomEvent { seq: number; requestId: string; at: string; type: string; actor: string; text: string; payload?: unknown }
export type Phase = "inspecting" | "quoting" | "clarifying" | "negotiating" | "ranking" | "ready" | "booked";
export interface DamageItem { id: string; label: string; operation: string; severity: "minor" | "moderate" | "severe"; note: string }
export interface DamageReport { summary: string; vehicleGuess?: string; items: DamageItem[]; by: "agent" | "sample" }
export interface AssessmentItem { id: string; label: string; operation: string; partType?: string; reason: string }
export interface Assessment { items: AssessmentItem[]; notes: string; history?: { summary: string; jobs: number }; by: "agent" | "fallback" }
export interface Request {
  id: string; caseId: string; mode: Mode; priority: Priority; status: string; createdAt: string;
  baselineIds: string[]; shops: string[]; offers: Record<string, Offer[]>; clarifications: Clarification[];
  asks: { id: string; shopId: string; text: string; target: { total?: number; deductibleAssist?: number }; outcome?: string }[];
  comparison?: ScopeComparison[]; ranking?: Ranked[]; booking?: { id: string; offerId: string; version: number; shopId: string; at: string; simulated: true };
  roomRef?: string; agentMode: string; negotiationDone?: boolean;
  phase: Phase; damageReport?: DamageReport; assessments: Record<string, Assessment>; gioHistory?: { summary: string; jobs: number };
  timings?: Record<string, number>;
}

const now = () => new Date().toISOString();
let seqCounter = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const money = (n?: number) => (n == null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`);
// Agent free text shown in the room: no markdown, no dollar figures, bounded length.
const cleanText = (s: unknown, n: number) => String(s ?? "").replace(/[*_`#|<>]/g, "")
  .replace(/\(\s*(?:about\s+|~)?\$\s?[\d,]+(?:\.\d+)?\s*\)/gi, "").replace(/(?:about\s+|~)?\$\s?[\d,]+(?:\.\d+)?/gi, "")
  .replace(/\(\s*\)/g, "").replace(/\s+([,.;:])/g, "$1").replace(/\s+/g, " ").trim().slice(0, n);
const SEVERITIES = ["minor", "moderate", "severe"] as const;
export const CLARIFY_EXTRAS_PER_SHOP = 3;

export const SHOP_ACTOR: Record<string, string> = { drive: "Drive Auto Body", "shop-b": "Bayline Collision", "shop-c": "QuickFix Auto Body" };
export const GUARDRAIL_INSURANCE = "Your out-of-pocket amount depends on your policy, covered repairs, deductible and insurer payment.";
export const GUARDRAIL_INCENTIVE = "Incentives are paid by the shop and are never added to your insurance bill.";

// ---------- uploads (customer photos) ----------
export const UPLOAD_DIR = join(STATE_DIR, "uploads");
export const SAMPLES_DIR = join(ROOT, "data/samples");
export const PHOTOS_DIR = join(ROOT, "data/photos");
export const UPLOAD_LIMITS = { maxImages: 8, maxBytes: Math.round(1.6 * 1024 * 1024), maxBody: 14 * 1024 * 1024, maxCases: 500 };
const IMG_MIME: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };
// Validates one data URL (jpeg/png/webp, size cap, real magic bytes). Never trusts the declared type alone.
export function decodeImageDataUrl(s: unknown): { buf: Buffer; ext: "jpg" | "png" | "webp" } | { error: string } {
  if (typeof s !== "string") return { error: "image_must_be_a_data_url" };
  if (s.length > UPLOAD_LIMITS.maxBytes * 1.37 + 200) return { error: "image_too_large" };
  const m = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/\s]+={0,2})$/.exec(s.trim());
  if (!m) return { error: "unsupported_image_type (jpeg, png or webp data URL)" };
  const buf = Buffer.from(m[2].replace(/\s+/g, ""), "base64");
  if (buf.length < 100) return { error: "image_empty_or_corrupt" };
  if (buf.length > UPLOAD_LIMITS.maxBytes) return { error: "image_too_large" };
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP";
  const ext = isJpg ? "jpg" : isPng ? "png" : isWebp ? "webp" : undefined;
  if (!ext) return { error: "image_content_not_jpeg_png_or_webp" };
  return { buf, ext };
}
const safeSampleId = (id: unknown) => (typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,59}$/.test(id) ? id : undefined);
const safeFile = (f: unknown) => (typeof f === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(f) && !f.includes("..") ? f : undefined);
// Reads data/samples/<id>/meta.json; photo entries may be file names or URL paths (basename used).
export function readSample(id: string): any | undefined {
  const sid = safeSampleId(id); if (!sid) return undefined;
  const p = join(SAMPLES_DIR, sid, "meta.json");
  if (!existsSync(p)) return undefined;
  try {
    const meta = JSON.parse(readFileSync(p, "utf8"));
    const files = (Array.isArray(meta.photos) ? meta.photos : []).map((x: any) => safeFile(basename(String(typeof x === "string" ? x : x?.file ?? x?.url ?? "")))).filter((f: any) => f && existsSync(join(SAMPLES_DIR, sid, f)));
    return { ...meta, id: sid, files, photos: files.map((f: string) => `/samples/${sid}/${f}`) };
  } catch { return undefined; }
}
export function listSamples() {
  if (!existsSync(SAMPLES_DIR)) return [];
  return readdirSync(SAMPLES_DIR).map((d) => readSample(d)).filter((m) => m && m.photos.length)
    .map(({ files: _f, baseline: _b, ...m }: any) => m);
}

export class Orchestrator extends EventEmitter {
  shops: any[] = readJson("data/shops.json").shops;
  cases: Record<string, any> = {};
  requests: Record<string, Request> = {};
  approvals: Record<string, Approval> = {};
  events: RoomEvent[] = [];
  private waiters = new Map<string, (v: any) => void>();
  private approvalWaiters = new Map<string, (a: Approval) => void>();
  // Public origin (https://host) for Slack image URLs; captured by the server from real requests.
  publicOrigin = "";

  constructor() {
    super();
    for (const f of ["case-accord-selfpay.json", "case-elantra-insurance.json"]) {
      const c = readJson(`data/cases/${f}`);
      c.photoFiles = (c.photos ?? []).map((p: string) => join(PHOTOS_DIR, basename(p)));
      this.cases[c.id] = c;
    }
  }
  // URL paths for a case's photos (static cases store bare file names).
  photoUrls(c: any): string[] { return (c?.photos ?? []).map((p: string) => (p.startsWith("/") ? p : `/photos/${p}`)); }

  // ---------- photo cases ----------
  private dynamicCount() { return Object.values(this.cases).filter((c) => c.dynamic).length; }
  private newPhotoCaseId() { let id: string; do { id = `photo-${randomBytes(3).toString("hex")}`; } while (this.cases[id]); return id; }
  private vehicleOf(v: any) {
    if (!v || typeof v !== "object") return undefined;
    const year = Number(v.year); const make = cleanText(v.make, 30); const model = cleanText(v.model, 40);
    const out: any = {}; if (year >= 1950 && year <= 2100) out.year = Math.round(year); if (make) out.make = make; if (model) out.model = model;
    return Object.keys(out).length ? out : undefined;
  }
  private vehicleName = (v: any) => (v ? [v.year, v.make, v.model].filter(Boolean).join(" ") : "");
  // Customer upload: all images validated before anything is written.
  createPhotoCase(images: unknown, vehicle?: unknown, extra: { sampleBaseline?: any[]; title?: string } = {}) {
    if (!Array.isArray(images) || !images.length) return { error: "images_required" };
    if (images.length > UPLOAD_LIMITS.maxImages) return { error: `at_most_${UPLOAD_LIMITS.maxImages}_images` };
    if (this.dynamicCount() >= UPLOAD_LIMITS.maxCases) return { error: "upload_limit_reached" };
    const decoded: { buf: Buffer; ext: string }[] = [];
    for (let i = 0; i < images.length; i++) { const d = decodeImageDataUrl(images[i]); if ("error" in d) return { error: `image ${i + 1}: ${d.error}` }; decoded.push(d); }
    if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });
    const names = decoded.map((d) => { const n = `${randomBytes(12).toString("hex")}.${d.ext}`; writeFileSync(join(UPLOAD_DIR, n), d.buf); return n; });
    const v = this.vehicleOf(vehicle);
    const c = this.addPhotoCase({ title: extra.title ?? (v ? `${this.vehicleName(v)} · your photos` : `Your photos (${names.length})`), vehicle: v, photos: names.map((n) => `/uploads/${n}`), photoFiles: names.map((n) => join(UPLOAD_DIR, n)), sampleBaseline: extra.sampleBaseline, source: "Uploaded by the customer" });
    return { caseId: c.id, photos: c.photos };
  }
  createSampleCase(sampleId: unknown) {
    const s = readSample(String(sampleId ?? "")); if (!s || !s.files.length) return { error: "unknown_sample" };
    if (this.dynamicCount() >= UPLOAD_LIMITS.maxCases) return { error: "upload_limit_reached" };
    const v = this.vehicleOf(s.vehicle);
    const c = this.addPhotoCase({ title: cleanText(s.title, 90) || `${this.vehicleName(v)} · sample photos`, vehicle: v, photos: s.photos, photoFiles: s.files.map((f: string) => join(SAMPLES_DIR, s.id, f)), sampleId: s.id, sampleBaseline: Array.isArray(s.baseline) ? s.baseline : undefined, source: cleanText(s.credit, 200) || "Sample photos", defaultMode: s.defaultMode ?? s.mode });
    return { caseId: c.id, photos: c.photos };
  }
  private addPhotoCase(p: { title: string; vehicle?: any; photos: string[]; photoFiles: string[]; sampleId?: string; sampleBaseline?: any[]; source: string; defaultMode?: string }) {
    const c = {
      id: this.newPhotoCaseId(), dynamic: true, title: p.title, vehicle: p.vehicle, photos: p.photos, photoFiles: p.photoFiles, baseline: [],
      sampleId: p.sampleId, sampleBaseline: p.sampleBaseline, source: p.source, defaultMode: p.defaultMode === "insurance" ? "insurance" : "self_pay",
      neededBy: "as soon as possible", photoNote: "Customer photos.", reviewNote: "Scopes are built from photos by each shop's agent. Final details are confirmed at inspection.", createdAt: now(),
    };
    this.cases[c.id] = c;
    return c;
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
    let id: string;
    do { id = `R-${Math.floor(100 + Math.random() * 900)}`; } while (this.requests[id]);
    const req: Request = { id, caseId, mode, priority, status: "room_open", createdAt: now(), baselineIds: c.baseline.map((i: any) => i.id), shops: this.activeShops(), offers: {}, clarifications: [], asks: [], agentMode, phase: c.dynamic ? "inspecting" : "quoting", assessments: {} };
    this.requests[id] = req;
    const modeText = mode === "self_pay" ? "paying myself" : "insurance claim";
    if (c.dynamic) {
      this.log(id, "request_posted", "Driver's agent",
        `New repair request: ${c.title}. Mode: ${modeText}. ${c.photos.length} photo${c.photos.length === 1 ? "" : "s"} attached. I'm looking at the photos now and will post a damage report for the shops.`,
        { caseId, mode, priority, photos: this.photoUrls(c), dynamic: true }, req.shops);
    } else {
      const scope = c.baseline.map((i: any) => `• ${i.label}`).join("\n");
      this.log(id, "request_posted", "Driver's agent",
        `New repair request: ${c.title}. Mode: ${modeText}. Needed by ${c.neededBy}.\nProposed scope (photo review, reviewed by a person — each shop may amend it):\n${scope}`,
        { caseId, mode, priority, baseline: c.baseline }, req.shops);
    }
    if (mode === "insurance") this.log(id, "system_note", "Quote Room", `${GUARDRAIL_INCENTIVE} ${GUARDRAIL_INSURANCE}`);
    // The static sample already has a person-reviewed scope: that is its damage report.
    if (!c.dynamic) this.setDamageReport(req, {
      summary: c.reviewNote ?? "Visible damage from the sample photos, reviewed by a person.",
      items: c.baseline.map((b: any) => ({ id: b.id, label: b.label, operation: b.operation, severity: "moderate", note: "" })), by: "sample",
    });
    return req;
  }
  setPhase(req: Request, phase: Phase) { if (req.phase !== phase) { req.phase = phase; this.persist(); } }
  private setDamageReport(req: Request, report: DamageReport) {
    req.damageReport = report;
    req.baselineIds = report.items.map((i) => i.id);
    const lines = report.items.map((i) => `• ${i.label}${report.by === "agent" ? ` — ${cat.opPhrase(i.operation)} (${i.severity})` : ""}${i.note ? `: ${i.note}` : ""}`).join("\n");
    const head = report.by === "agent" ? `Here's what I see in the photos${report.vehicleGuess ? ` (${report.vehicleGuess})` : ""}: ${report.summary}` : `Damage report: ${report.summary}`;
    this.log(req.id, "damage_report", "Driver's agent", `${head}\n${lines}`, { damageReport: report }, req.shops);
    this.signal(`report:${req.id}`, report);
  }
  // Labels for any item id the request may show (sample scope, Drive's sample amendments, catalog).
  labelOf(req: Request, id: string): string {
    const c = this.cases[req.caseId];
    return c?.baseline?.find((i: any) => i.id === id)?.label
      ?? (c?.amendments?.drive ?? []).find((a: any) => a.item.id === id)?.item.label
      ?? req.damageReport?.items.find((i) => i.id === id)?.label
      ?? cat.catalogItem(id)?.label ?? id;
  }
  // Allowed part source for this shop and mode (shops.json partsPolicy).
  private partPolicy(shopId: string, mode: Mode): { policy: cat.PartKey; allow?: string[] } {
    const pp = this.shop(shopId).partsPolicy ?? {};
    return { policy: cat.toPartKey(pp[mode]) ?? (shopId === "shop-b" ? "oem" : "aftermarket"), allow: pp.allow };
  }
  // A catalog-priced scope item for this shop (hours from the catalog, part per the shop's policy).
  catalogScopeItemFor(req: Request, shopId: string, item: cat.CatalogItem, op: string, partType?: string) {
    const { policy, allow } = this.partPolicy(shopId, req.mode);
    const part = item.ops?.[op]?.needsPart ? cat.choosePart(item, cat.toPartKey(partType), policy, allow) : undefined;
    const scope = cat.catalogScopeItem(item, op, part);
    if (part && partType && /capa/i.test(partType) && allow?.includes("CAPA")) return { scope, partType: "CAPA" };
    return { scope, partType: part?.type };
  }
  latest(req: Request, shopId: string): Offer | undefined { const v = req.offers[shopId]; return v?.[v.length - 1]; }
  latestOffers(req: Request) { return req.shops.map((s) => this.latest(req, s)).filter(Boolean) as Offer[]; }

  // ---------- SHOP tools (ctx.shopId is the bound identity) ----------
  private priceFor(req: Request, shopId: string, items: ScopeItem[]) {
    const s = this.shop(shopId), c = this.cases[req.caseId];
    const parts = { ...(c.parts ?? {}), ...cat.catalogParts(items, shopId) };
    if (req.mode === "self_pay") return { price: priceScope(items, shopId, s.rateCards.self_pay, parts) };
    const sizing = priceScope(items, shopId, s.rateCards.insurance, parts);
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
    const head = o.mode === "self_pay"
      ? `${money(o.price?.total)} total${o.incentives?.length ? ` + ${o.incentives.map((i) => i.label.toLowerCase()).join(" + ")}` : ""}`
      : (o.incentives?.length ? o.incentives.map((i) => i.label).join(" + ") : "No incentives offered");
    return `${head} · drop-off ${o.slot} · ${o.turnaroundDays}-day turnaround · ${o.warranty}`;
  }

  tool_review_and_quote(ctx: Ctx) {
    const { shopId } = this.assertShop(ctx); const req = this.requests[ctx.requestId], c = this.cases[req.caseId], s = this.shop(shopId);
    if (this.latest(req, shopId)) return { ok: true, note: "already quoted", offer: this.latest(req, shopId) };
    if (this.closed(req)) return { error: "negotiation_closed" };
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

  // ----- photo tools (dynamic cases) -----
  // Returns the case photos as image blocks (the agent really looks at them) plus the catalog.
  tool_inspect_photos(ctx: Ctx) {
    if (ctx.role === "shop") this.assertShop(ctx); else this.assertBuyer(ctx);
    const req = this.requests[ctx.requestId], c = this.cases[req.caseId];
    const content: any[] = []; let budget = 7_000_000; const included: string[] = []; const skipped: string[] = [];
    (c.photoFiles ?? []).forEach((f: string, i: number) => {
      const url = this.photoUrls(c)[i];
      try {
        if (content.length >= 6 || !existsSync(f)) { skipped.push(url); return; }
        const data = readFileSync(f).toString("base64");
        if (data.length > budget) { skipped.push(url); return; }
        budget -= data.length;
        const ext = f.toLowerCase().endsWith(".png") ? "png" : f.toLowerCase().endsWith(".webp") ? "webp" : "jpg";
        content.push({ type: "image", source: { type: "base64", media_type: IMG_MIME[ext], data } });
        included.push(url);
      } catch { skipped.push(url); }
    });
    const value: any = {
      requestId: req.id, mode: req.mode, vehicle: c.vehicle ?? null, photosIncluded: included.length, photosSkipped: skipped.length,
      catalog: cat.catalogBrief(),
      next: ctx.role === "buyer"
        ? "Describe only damage you can see (or that is directly implied, e.g. a crushed bumper hides the impact bar — mark that as a note). Then call post_damage_report with catalog ids."
        : "Build YOUR shop's scope from what you see, in your shop's style, then call submit_assessment with catalog ids, operations and a short reason per line.",
    };
    if (ctx.role === "shop" && req.damageReport) value.customersAgentReport = { summary: req.damageReport.summary, items: req.damageReport.items.map((i) => ({ id: i.id, operation: i.operation, severity: i.severity, note: i.note })) };
    if (!included.length) value.warning = "No photos could be loaded for this request.";
    return { __content: [...content, { type: "json", value }] };
  }

  tool_post_damage_report(ctx: Ctx, args: { summary?: string; vehicleGuess?: string; items?: any[] }) {
    this.assertBuyer(ctx); const req = this.requests[ctx.requestId], c = this.cases[req.caseId];
    if (!c.dynamic) return { error: "this_sample_already_has_a_reviewed_damage_report" };
    if (req.damageReport) return { ok: true, note: "already posted", damageReport: req.damageReport };
    const raw = Array.isArray(args?.items) ? args.items.slice(0, 30) : [];
    if (!raw.length) return { error: "items_required", hint: "List each damaged part with a catalog id, operation, severity (minor|moderate|severe) and a short note." };
    const unknown: string[] = []; const items: DamageItem[] = []; const seen = new Set<string>();
    for (const r of raw) {
      const item = cat.catalogItem(String(r?.id ?? r?.catalogId ?? ""));
      if (!item) { unknown.push(String(r?.id ?? "")); continue; }
      if (seen.has(item.id)) continue; seen.add(item.id);
      const severity = (SEVERITIES as readonly string[]).includes(String(r?.severity)) ? r.severity : "moderate";
      const op = cat.normalizeOp(item, String(r?.operation ?? "")) ?? cat.defaultOp(item, severity);
      items.push({ id: item.id, label: item.label, operation: op, severity, note: cleanText(r?.note, 200) });
    }
    if (unknown.length) return { error: "unknown_catalog_ids", unknown, validIds: cat.catalogIds(), hint: "Resubmit the whole report using only these ids." };
    let summary = cleanText(args?.summary, 400) || `${items.length} damaged area${items.length === 1 ? "" : "s"} found in the photos.`;
    if (req.mode === "insurance" && /out[- ]of[- ]pocket|covered|insurer will|insurance will|deductible/i.test(summary)) summary = `${items.length} damaged area${items.length === 1 ? "" : "s"} found in the photos.`;
    const vehicleGuess = cleanText(args?.vehicleGuess, 60) || undefined;
    if (vehicleGuess && !c.vehicle && /^Your photos/.test(c.title)) c.title = `${vehicleGuess} · your photos`;
    this.setDamageReport(req, { summary, vehicleGuess, items, by: ctx.via === "zoowork" ? "agent" : "sample" });
    return { ok: true, items: items.length };
  }

  // Drive only: retrieval over Gio's anonymized past estimates + the playbook mined from them.
  async tool_get_gio_history(ctx: Ctx, args: { areas?: string[]; catalogIds?: string[] } = {}) {
    const { shopId } = this.assertShop(ctx);
    if (shopId !== "drive") return { error: "forbidden: Gio's estimate history belongs to Drive Auto Body only" };
    const req = this.requests[ctx.requestId];
    const r = await this.gioHistory(req, args);
    const cashOptions = req.mode === "self_pay" ? this.cashOptions(req, "drive") : undefined;
    if (!r) return { error: "history_unavailable", note: "Use your judgment and the shop's style.", ...(cashOptions ? { cashOptions } : {}) };
    return { summary: r.summary, playbook: r.playbook, jobs: (r.jobs ?? []).slice(0, 8), ...(cashOptions ? { cashOptions, cashNote: "Your own prices for repairing vs replacing with a cheaper part, per reported item. Pick the cheaper sound option." } : {}) };
  }
  // One item priced alone with this shop's rate card (no tax rounding games: same engine).
  itemPrice(req: Request, shopId: string, item: cat.CatalogItem, op: string, partType?: string) {
    const { scope } = this.catalogScopeItemFor(req, shopId, item, op, partType);
    const s = this.shop(shopId);
    return priceScope([scope], shopId, s.rateCards[req.mode], cat.catalogParts([scope], shopId)).total;
  }
  // For each reported item that can be repaired or replaced: which is cheaper for this shop.
  cashOptions(req: Request, shopId: string) {
    return (req.damageReport?.items ?? []).flatMap((d) => {
      const ci = cat.catalogItem(d.id); if (!ci?.ops?.repair || !ci.ops?.replace) return [];
      const repair = this.itemPrice(req, shopId, ci, "repair");
      const replace = Math.min(...(["used", "aftermarket"] as const).map((k) => (ci.parts?.[k] ? this.itemPrice(req, shopId, ci, "replace", k) : Infinity)));
      if (!Number.isFinite(replace)) return [];
      return [{ id: ci.id, severity: d.severity, repair, replaceWithCheaperPart: replace, cheaper: repair <= replace ? "repair" : "replace" }];
    });
  }
  async gioHistory(req: Request, args: { areas?: string[]; catalogIds?: string[] } = {}) {
    const mod = await loadHistory(); if (!mod?.searchHistory) return undefined;
    const c = this.cases[req.caseId];
    const reportIds = req.damageReport?.items.map((i) => i.id) ?? [];
    const catalogIds = (Array.isArray(args.catalogIds) && args.catalogIds.length ? args.catalogIds : reportIds).map(String).slice(0, 30);
    const areas = (Array.isArray(args.areas) && args.areas.length ? args.areas.map(String) : [...new Set(catalogIds.map((id) => cat.catalogItem(id)?.area).filter((a): a is string => !!a && a !== "all"))]).slice(0, 8);
    try {
      const r = mod.searchHistory({ areas, mode: req.mode, make: c.vehicle?.make, model: c.vehicle?.model, catalogIds, limit: 8 });
      req.gioHistory = { summary: String(r?.summary ?? ""), jobs: Array.isArray(r?.jobs) ? r.jobs.length : 0 };
      return r;
    } catch { return undefined; }
  }

  // Each shop's own scope from the photos. The server prices it: catalog hours x this shop's rate
  // card, part prices per this shop's parts policy. Agents never type prices.
  tool_submit_assessment(ctx: Ctx, args: { items?: any[]; notes?: string }) {
    const { shopId } = this.assertShop(ctx); const req = this.requests[ctx.requestId], c = this.cases[req.caseId], s = this.shop(shopId);
    if (!c.dynamic) return { error: "use_review_and_quote_for_this_case" };
    if (this.latest(req, shopId)) return { ok: true, note: "already quoted", offer: this.offerView(this.latest(req, shopId)!) };
    if (this.closed(req)) return { error: "negotiation_closed" };
    const raw = Array.isArray(args?.items) ? args.items.slice(0, 40) : [];
    if (!raw.length) return { error: "items_required", hint: "Each line: { id (catalog id), operation, reason }." };
    const unknown: string[] = []; const badOps: any[] = []; const seen = new Set<string>();
    const built: { scope: ScopeItem; view: AssessmentItem }[] = [];
    for (const r of raw) {
      const item = cat.catalogItem(String(r?.id ?? r?.catalogId ?? ""));
      if (!item) { unknown.push(String(r?.id ?? "")); continue; }
      if (seen.has(item.id)) continue;
      const op = r?.operation ? cat.normalizeOp(item, String(r.operation)) : cat.defaultOp(item);
      if (!op) { badOps.push({ id: item.id, operation: r?.operation, validOps: Object.keys(item.ops ?? {}) }); continue; }
      seen.add(item.id);
      const { scope, partType } = this.catalogScopeItemFor(req, shopId, item, op, r?.partType);
      built.push({ scope, view: { id: item.id, label: item.label, operation: op, ...(partType ? { partType } : {}), reason: this.plainItems(req, cleanText(r?.reason, 220)) || "Seen in the photos." } });
    }
    if (unknown.length || badOps.length) return { error: unknown.length ? "unknown_catalog_ids" : "invalid_operation", unknown, badOps, validIds: cat.catalogIds(), hint: "Resubmit the whole assessment using only valid ids and operations." };
    const items = built.map((b) => b.scope);
    const priced = this.priceFor(req, shopId, items);
    const notes = this.plainItems(req, cleanText(args?.notes, 300));
    const assessment: Assessment = { items: built.map((b) => b.view), notes, ...(shopId === "drive" && req.gioHistory ? { history: req.gioHistory } : {}), by: ctx.via === "zoowork" ? "agent" : "fallback" };
    req.assessments[shopId] = assessment;
    const adds = built.filter((b) => !req.baselineIds.includes(b.scope.id)).map((b) => ({ action: "add", itemId: b.scope.id, reason: b.view.reason }));
    const omits = req.baselineIds.filter((id) => !seen.has(id)).map((id) => ({ action: "remove", itemId: id, reason: "Not in this shop's scope" }));
    const offer = this.pushOffer(req, shopId, {
      items, disputed: [], amendments: [...adds, ...omits], ...priced, initialTotal: priced.price?.total,
      slot: s.nextSlots[0], turnaroundDays: s.turnaroundDays.value, warranty: s.warranty.label, createdBy: ctx.via === "zoowork" ? "agent" : "rule",
    });
    const hist = assessment.history?.summary ? `${assessment.history.summary}\n` : "";
    const lines = assessment.items.map((i) => `• ${i.label} — ${cat.opPhrase(i.operation)}${i.partType ? ` (${i.partType})` : ""}: ${i.reason}`).join("\n");
    this.log(req.id, "assessment_posted", SHOP_ACTOR[shopId], `${hist}Looked at the photos.${notes ? ` ${notes}` : ""}\n${lines}`, { shopId, assessment }, ["buyer"]);
    this.log(req.id, "offer_posted", SHOP_ACTOR[shopId], `Offer v${offer.version}: ${this.describeOffer(offer)}`, offer, ["buyer"]);
    this.signal(`quote:${req.id}:${shopId}`, offer);
    return { ok: true, offer: this.offerView(offer), lines: priced.price?.lines.map((l) => ({ item: l.label, amount: l.amount })) };
  }
  // Fallback clarification decision for photo cases when the shop's agent didn't decide.
  fallbackClarify(req: Request, shopId: string, itemId: string): "add" | "dispute" {
    const kind = cat.catalogItem(itemId)?.kind ?? "visible";
    if (shopId === "shop-b") return "add";
    if (shopId === "shop-c") return kind === "visible" ? "add" : "dispute";
    if (req.mode === "insurance") return "add";
    return kind === "visible" || /scan/.test(itemId) ? "add" : "dispute";
  }

  tool_respond_clarification(ctx: Ctx, args: { clarificationId: string; message?: string; decision?: string }) {
    const { shopId } = this.assertShop(ctx); const req = this.requests[ctx.requestId], c = this.cases[req.caseId];
    const cl = req.clarifications.find((x) => x.id === args.clarificationId && x.shopId === shopId);
    if (!cl) return { error: "unknown_clarification_for_this_shop" };
    if (cl.status !== "open") return { ok: true, note: "already answered", status: cl.status };
    if (this.closed(req)) return { error: "negotiation_closed" };
    if (c.dynamic) return this.respondDynamic(req, shopId, cl, args);
    const rule = c.clarify?.[shopId] ?? { add: [], dispute: [] };
    const base = this.latest(req, shopId)!;
    const addDef = (c.amendments?.drive ?? []).find((a: any) => a.item.id === cl.itemId)?.item ?? c.baseline.find((i: any) => i.id === cl.itemId);
    let next: Offer;
    if (rule.add.includes(cl.itemId) && addDef) {
      const items = [...base.items, { ...addDef }];
      const priced = this.priceFor(req, shopId, items);
      next = this.pushOffer(req, shopId, { ...base, items, disputed: base.disputed, ...priced, createdBy: base.createdBy, note: `added ${cl.itemId} after clarification`, approvalId: undefined });
      cl.status = "added"; cl.answer = `Good catch — we'll include ${addDef.label.toLowerCase()}.`;
    } else {
      next = this.pushOffer(req, shopId, { ...base, disputed: [...base.disputed, cl.itemId], note: `disputed ${cl.itemId}`, approvalId: undefined });
      cl.status = "disputed"; cl.answer = "We don't think that's needed from the photos — we'll confirm at inspection.";
    }
    this.log(req.id, "clarification_answered", SHOP_ACTOR[shopId], `${cl.answer}\nOffer v${next.version}: ${this.describeOffer(next)}`, { clarification: cl, offer: next }, ["buyer"]);
    this.signal(`clar:${cl.id}`, cl);
    return { ok: true, status: cl.status, offer: this.offerView(next) };
  }
  // Photo cases: the shop's agent decides add|dispute; without a decision the shop's fallback rule applies.
  private respondDynamic(req: Request, shopId: string, cl: Clarification, args: { message?: string; decision?: string }) {
    const base = this.latest(req, shopId); if (!base) return { error: "quote_first" };
    const decision = args.decision === "add" || args.decision === "dispute" ? args.decision : this.fallbackClarify(req, shopId, cl.itemId);
    const item = cat.catalogItem(cl.itemId);
    const msg = this.plainItems(req, this.safeAgentText(req.id, String(args.message ?? "")).slice(0, 240));
    let next: Offer;
    if (decision === "add" && item && !base.items.some((i) => i.id === item.id)) {
      // Same operation the customer's agent or another shop used for it, else the catalog default.
      const seenOp = req.damageReport?.items.find((i) => i.id === item.id)?.operation
        ?? this.latestOffers(req).flatMap((o) => o.items).find((i) => i.id === item.id)?.operation;
      const op = (seenOp && cat.normalizeOp(item, seenOp)) || cat.defaultOp(item);
      const { scope, partType } = this.catalogScopeItemFor(req, shopId, item, op);
      const items = [...base.items, scope];
      const priced = this.priceFor(req, shopId, items);
      next = this.pushOffer(req, shopId, { ...base, items, disputed: base.disputed, ...priced, createdBy: base.createdBy, note: `added ${cl.itemId} after clarification`, approvalId: undefined });
      req.assessments[shopId]?.items.push({ id: item.id, label: item.label, operation: op, ...(partType ? { partType } : {}), reason: "Added after the driver's agent asked." });
      cl.status = "added"; cl.answer = msg || (args.decision ? `Good catch — we'll include ${item.label.toLowerCase()}.` : `Standing rule: we include ${item.label.toLowerCase()} on jobs like this.`);
    } else if (decision === "add" && base.items.some((i) => i.id === cl.itemId)) {
      next = base; cl.status = "added"; cl.answer = msg || "That's already in our scope.";
    } else {
      next = this.pushOffer(req, shopId, { ...base, disputed: [...base.disputed, cl.itemId], note: `disputed ${cl.itemId}`, approvalId: undefined });
      cl.status = "disputed"; cl.answer = msg || (args.decision ? "We don't think that's needed from the photos — we'll confirm at inspection." : `Standing rule: we don't add ${this.labelOf(req, cl.itemId).toLowerCase()} from photos alone; we'll check it at inspection.`);
    }
    this.log(req.id, "clarification_answered", SHOP_ACTOR[shopId], `${cl.answer}\nOffer v${next.version}: ${this.describeOffer(next)}`, { clarification: cl, offer: next, by: args.decision ? "agent" : "rule" }, ["buyer"]);
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
    if (this.closed(req)) return { error: "negotiation_closed" };
    if (!base) return { error: "quote_first" };
    // Once the owner has decided on this shop's ask, the agent can't contradict that decision.
    const openAsk = req.asks.find((a) => a.shopId === shopId && !a.outcome);
    if (req.asks.some((a) => a.shopId === shopId && Object.values(this.approvals).some((ap) => ap.askId === a.id && ap.status !== "pending"))) return { error: "owner_already_decided" };
    const lim = this.limits(req, shopId);
    if (req.mode === "self_pay") {
      const total = Math.round(Number(args.total));
      if (!(total > 0)) return { error: "total_required" };
      if (total < (lim.autonomousLimit as number)) return { error: "beyond_authority", autonomousLimit: lim.autonomousLimit, hint: "Call request_exception to ask the owner." };
      if (total >= (base.price?.total ?? 0)) return { error: "revision_must_lower_price", currentTotal: base.price?.total };
      const next = this.pushOffer(req, shopId, { ...base, price: { ...base.price!, total }, createdBy: base.createdBy, note: "revised within authority", approvalId: undefined });
      this.log(req.id, "offer_revised", SHOP_ACTOR[shopId], `${this.safeAgentText(req.id, String(args.message ?? "")) || "Revised within my authority."}\nOffer v${next.version}: ${this.describeOffer(next)}`, next, ["buyer"]);
      // A partial move leaves the ask open, so the owner is still asked for the rest.
      if (openAsk && total <= (openAsk.target.total ?? -Infinity)) this.askAnswered(req, shopId, "revised");
      return { ok: true, offer: this.offerView(next), askStillOpen: !!openAsk && !openAsk.outcome };
    }
    const assist = Math.round(Number(args.deductibleAssist));
    if (!(assist >= 0)) return { error: "deductibleAssist_required" };
    if (assist > (lim.deductibleCap as number)) return { error: "beyond_authority", deductibleCap: lim.deductibleCap, hint: "Call request_exception to ask the owner." };
    if (assist <= currentAssist(base)) return { error: "revision_must_raise_assist", currentAssist: currentAssist(base) };
    const incentives = setAssist(base.incentives ?? [], assist);
    const next = this.pushOffer(req, shopId, { ...base, incentives, note: "incentive within authority", approvalId: undefined });
    this.log(req.id, "offer_revised", SHOP_ACTOR[shopId], `${this.safeAgentText(req.id, String(args.message ?? "")) || "Within my authority."}\nOffer v${next.version}: ${this.describeOffer(next)}`, next, ["buyer"]);
    if (openAsk && assist >= (openAsk.target.deductibleAssist ?? Infinity)) this.askAnswered(req, shopId, "revised");
    return { ok: true, offer: this.offerView(next), askStillOpen: !!openAsk && !openAsk.outcome };
  }

  // Exception: creates an Approval bound to the driver's open ask, the request/shop, the base offer
  // version and the exact concession (the ask's target). One approval per ask. For the real shop the
  // call PAUSES until the owner decides (Slack/Telegram/admin); simulated shops decide by rule.
  async tool_request_exception(ctx: Ctx, args: { total?: number; deductibleAssist?: number; reason: string }) {
    const { shopId } = this.assertShop(ctx); const req = this.requests[ctx.requestId]; const s = this.shop(shopId);
    if (this.closed(req)) return { error: "negotiation_closed" };
    const ask = req.asks.find((a) => a.shopId === shopId);
    if (!ask) return { error: "no_driver_ask_for_this_shop" };
    const existing = Object.values(this.approvals).find((a) => a.askId === ask.id);
    if (existing) return existing.status === "pending" ? this.awaitApproval(req, existing) : this.exceptionResult(req, existing);
    if (ask.outcome) return { error: "ask_already_answered", outcome: ask.outcome };
    const base = this.latest(req, shopId); if (!base) return { error: "quote_first" };
    const lim = this.limits(req, shopId);
    const requested = req.mode === "self_pay" ? { total: ask.target.total } : { deductibleAssist: ask.target.deductibleAssist };
    if (req.mode === "self_pay" && requested.total! >= (lim.autonomousLimit as number)) return { error: "within_authority_use_revise_offer", total: requested.total };
    if (req.mode === "insurance" && requested.deductibleAssist! <= (lim.deductibleCap as number)) return { error: "within_authority_use_revise_offer", deductibleAssist: requested.deductibleAssist };
    let id: string;
    do { id = `A-${Math.floor(1000 + Math.random() * 9000)}`; } while (this.approvals[id]);
    const ap: Approval = {
      id, requestId: req.id, shopId, askId: ask.id, baseOfferId: base.id, baseOfferVersion: base.version,
      requested, agentLimit: req.mode === "self_pay" ? { total: lim.autonomousLimit as number } : { deductibleCap: lim.deductibleCap as number },
      reason: String(args.reason ?? "").slice(0, 300), status: "pending", createdAt: now(),
    };
    this.approvals[ap.id] = ap;
    this.log(req.id, "exception_requested", SHOP_ACTOR[shopId], s.exceptionMode === "owner" ? "That's beyond what I can offer on my own — asking the owner." : "Checking with the shop's rules.", { approval: ap });
    req.status = "awaiting_owner";
    if (s.exceptionMode === "rule") {
      const ok = req.mode === "self_pay" ? requested.total! >= (lim.hardMinimum as number) : requested.deductibleAssist! <= (lim.deductibleCap as number);
      this.decide(ap.id, ok ? "approve" : "deny", undefined, "rule");
    } else {
      this.emit("approval", ap, req, base);
    }
    return ap.status === "pending" ? this.awaitApproval(req, ap) : this.exceptionResult(req, ap);
  }
  private awaitApproval(req: Request, ap: Approval) {
    return new Promise<any>((res) => {
      const t = setTimeout(() => { if (ap.status === "pending") this.expire(ap, "timeout", "No answer in time — holding the current offer."); }, 150_000);
      const prev = this.approvalWaiters.get(ap.id);
      this.approvalWaiters.set(ap.id, (a) => { clearTimeout(t); prev?.(a); res(this.exceptionResult(req, a)); });
    });
  }
  private exceptionResult(req: Request, ap: Approval) {
    const latest = this.latest(req, ap.shopId);
    return { approvalId: ap.id, status: ap.status, counter: ap.counter, offer: latest ? this.offerView(latest) : undefined };
  }
  // Closes a pending approval without a concession (timeout, stale offer, request closed).
  private expire(ap: Approval, via: string, note?: string) {
    if (ap.status !== "pending") return;
    const req = this.requests[ap.requestId];
    ap.status = "expired"; ap.decidedAt = now(); ap.decidedVia = via;
    if (note && !req.booking) this.log(req.id, "owner_decision", "Quote Room", note, { approval: ap });
    this.finishApproval(req, ap);
  }
  private finishApproval(req: Request, ap: Approval) {
    if (req.status === "awaiting_owner") req.status = "negotiating";
    const ask = req.asks.find((a) => a.id === ap.askId);
    if (ask && !ask.outcome) { ask.outcome = ap.status; this.signal(`askdone:${req.id}`, { shopId: ap.shopId, outcome: ap.status }); }
    this.approvalWaiters.get(ap.id)?.(ap); this.approvalWaiters.delete(ap.id);
    this.emit("decided", ap);
  }

  // Owner/rule decision. Applies the concession ONLY to the exact bound offer version; single use.
  // Counters must sit between the driver's ask and the current offer, so a counter can never make
  // the offer worse for the driver than it already is.
  decide(approvalId: string, decision: "approve" | "counter" | "deny", counter?: { total?: number; deductibleAssist?: number; extra?: string }, via = "telegram") {
    const ap = this.approvals[approvalId];
    if (!ap) return { error: "unknown_approval" };
    if (ap.status !== "pending") return { error: `already_${ap.status}` };
    const req = this.requests[ap.requestId];
    if (this.closed(req)) { this.expire(ap, "request_closed"); return { error: "request_already_closed" }; }
    const base = this.latest(req, ap.shopId)!;
    if (base.id !== ap.baseOfferId || base.version !== ap.baseOfferVersion) { this.expire(ap, "offer_changed", "The offer changed while waiting — holding the current offer."); return { error: "offer_changed_since_request" }; }
    if (!["approve", "counter", "deny"].includes(decision)) return { error: "bad_decision" };
    if (decision === "counter") {
      const v = Math.round(Number(req.mode === "self_pay" ? counter?.total : counter?.deductibleAssist));
      if (!Number.isFinite(v)) return { error: "counter_amount_required" };
      if (req.mode === "self_pay") {
        const cur = base.price?.total ?? 0, ask = ap.requested.total ?? 0;
        if (!(v >= ask && v < cur)) return { error: `counter_must_be_between_${ask}_and_${cur - 1}` };
      } else {
        const cur = currentAssist(base), ask = ap.requested.deductibleAssist ?? 0;
        if (!(v > cur && v <= ask)) return { error: `counter_must_be_between_${cur + 1}_and_${ask}` };
      }
      counter = req.mode === "self_pay" ? { total: v, extra: counter?.extra } : { deductibleAssist: v, extra: counter?.extra };
    }
    ap.decidedAt = now(); ap.decidedVia = via;
    const who = via === "rule" ? SHOP_ACTOR[ap.shopId] : "Owner (Gio)";
    if (decision === "deny") {
      ap.status = "denied";
      this.log(req.id, "owner_decision", who, req.mode === "self_pay" ? `Can't go to ${money(ap.requested.total)}. Holding ${money(base.price?.total)}.` : "Can't add more incentives on this job.", { approval: ap });
    } else {
      const conc = decision === "approve" ? ap.requested : { ...ap.requested, ...counter };
      ap.status = decision === "approve" ? "approved" : "countered"; if (decision === "counter") ap.counter = counter;
      const extra = counter?.extra?.trim();
      const pickup = !!extra && /pick\s*-?\s*up/i.test(extra);
      const next = req.mode === "self_pay"
        ? this.pushOffer(req, ap.shopId, { ...base, price: { ...base.price!, total: Math.round(Number(conc.total)) }, createdBy: via === "rule" ? "rule" : "owner", approvalId: ap.id, note: extra })
        : this.pushOffer(req, ap.shopId, { ...base, incentives: setAssist(base.incentives ?? [], Math.round(Number(conc.deductibleAssist))), createdBy: via === "rule" ? "rule" : "owner", approvalId: ap.id, note: extra });
      if (pickup) { if (!(next.incentives ?? []).some((i) => i.kind === "pickup")) next.incentives = [...(next.incentives ?? []), { kind: "pickup", value: 0, label: "Free pickup" }]; }
      else if (extra) next.slot = extra;
      ap.consumedAt = now(); // single use: bound to this exact concession and version
      this.log(req.id, "owner_decision", who, `${decision === "approve" ? "Approved" : "Countered"}: ${this.describeOffer(next)}`, { approval: ap, offer: next });
    }
    this.finishApproval(req, ap);
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
    if (this.closed(req)) return { error: "negotiation_closed" };
    if (!req.shops.includes(args.shopId)) return { error: "shop_not_in_room" };
    if (req.clarifications.some((c) => c.shopId === args.shopId && c.itemId === args.itemId)) return { error: "already_asked_once" };
    // Photo cases: items from the damage report can always be asked about; other shops' extras are
    // capped per shop and materials lines are never worth a question (keeps the room readable).
    if (this.cases[req.caseId].dynamic && !req.baselineIds.includes(args.itemId)) {
      if (cat.catalogItem(args.itemId)?.kind === "materials") return { error: "materials_lines_are_not_clarified", hint: "Ask about parts, hidden damage, scans or calibrations instead." };
      const extras = req.clarifications.filter((c) => c.shopId === args.shopId && !req.baselineIds.includes(c.itemId)).length;
      if (extras >= CLARIFY_EXTRAS_PER_SHOP) return { error: "clarification_limit_reached", limit: CLARIFY_EXTRAS_PER_SHOP, hint: "Only the most important extras: hidden parts first, then scans/calibrations." };
    }
    const question = this.plainItems(req, String(args.question ?? "")).slice(0, 300);
    const cl: Clarification = { id: uid("C"), shopId: args.shopId, itemId: args.itemId, question, status: "open" };
    req.clarifications.push(cl);
    this.log(req.id, "clarify_sent", "Driver's agent", `@${SHOP_ACTOR[args.shopId]} ${cl.question}`, { clarification: cl }, [args.shopId]);
    this.emit("deliver", { requestId: req.id, shopId: args.shopId, kind: "clarify", clarification: cl });
    return { ok: true, clarificationId: cl.id };
  }
  tool_ask_shop(ctx: Ctx, args: { shopId: string; total?: number; deductibleAssist?: number; message: string }) {
    this.assertBuyer(ctx); const req = this.requests[ctx.requestId];
    if (this.closed(req)) return { error: "negotiation_closed" };
    if (!req.shops.includes(args.shopId)) return { error: "shop_not_in_room" };
    if (req.asks.length >= 1) return { error: "one_negotiation_round_only" };
    const cur = this.latest(req, args.shopId); if (!cur) return { error: "shop_has_no_offer" };
    let target: { total?: number; deductibleAssist?: number };
    if (req.mode === "self_pay") {
      const t = Math.round(Number(args.total));
      if (!(Number.isFinite(t) && t > 0 && t < (cur.price?.total ?? 0))) return { error: "total_must_be_below_current_offer", currentTotal: cur.price?.total };
      target = { total: t };
    } else {
      const t = Math.round(Number(args.deductibleAssist));
      if (!(Number.isFinite(t) && t > currentAssist(cur))) return { error: "deductibleAssist_must_exceed_current", currentAssist: currentAssist(cur) };
      target = { deductibleAssist: t };
    }
    const ask = { id: uid("Q"), shopId: args.shopId, text: this.plainItems(req, String(args.message ?? "")).slice(0, 300), target };
    req.asks.push(ask); req.status = "negotiating";
    this.log(req.id, "ask_sent", "Driver's agent", `@${SHOP_ACTOR[args.shopId]} ${ask.text}`, { ask }, [args.shopId]);
    this.emit("deliver", { requestId: req.id, shopId: args.shopId, kind: "ask", ask, limits: this.limits(req, args.shopId) });
    return { ok: true, askId: ask.id };
  }
  // Ranking always uses the driver's chosen priority (agents can't change it).
  tool_rank_offers(ctx: Ctx, _args: { priority?: Priority } = {}) {
    this.assertBuyer(ctx); const req = this.requests[ctx.requestId];
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
    return { ok: true, ranking: req.ranking, currentOffers: offers.map((x) => this.offerView(x)), note: "Quote only these current numbers." };
  }
  // The summary the driver sees is built here from the ranking, never from agent free text.
  tool_present_for_confirmation(ctx: Ctx, _args: { summary?: string } = {}) {
    this.assertBuyer(ctx); const req = this.requests[ctx.requestId];
    if (req.booking) return { error: "already_booked" };
    if (!req.negotiationDone) return { error: "negotiation_still_running" };
    if (!req.ranking) this.tool_rank_offers(ctx);
    req.status = "ready_for_confirmation"; req.phase = "ready";
    for (const ap of Object.values(this.approvals)) if (ap.requestId === req.id && ap.status === "pending") this.expire(ap, "request_closed");
    const top = req.ranking?.find((r) => r.recommended) ?? req.ranking?.find((r) => r.eligible) ?? req.ranking?.[0];
    const offer = top ? this.latest(req, top.shopId) : undefined;
    const pick = offer ? `Top pick for "${req.priority.replace("_", " ")}": ${SHOP_ACTOR[offer.shopId]} — ${this.describeOffer(offer)}. ` : "";
    const tail = req.mode === "insurance" ? `${GUARDRAIL_INCENTIVE} ${GUARDRAIL_INSURANCE}` : "Final details are confirmed at inspection.";
    this.log(req.id, "ready", "Driver's agent", `${pick}Pick the offer you want and confirm — nothing is booked until you do. ${tail}`);
    this.signal(`ready:${req.id}`, true);
    return { ok: true };
  }

  // ---------- driver confirmation ----------
  confirm(requestId: string, offerId: string, version: number) {
    const req = this.requests[requestId]; if (!req) return { error: "unknown_request" };
    if (req.booking) return { error: "already_booked" };
    if (req.status !== "ready_for_confirmation") return { error: "offers_not_final_yet" };
    const o = (req.offers[Object.keys(req.offers).find((s) => req.offers[s].some((x) => x.id === offerId)) ?? ""] ?? []).find((x) => x.id === offerId);
    if (!o || o.version !== version || this.latest(req, o.shopId)!.id !== o.id) return { error: "offer_not_current" };
    req.booking = { id: uid("B"), offerId: o.id, version: o.version, shopId: o.shopId, at: now(), simulated: true };
    req.status = "booked"; req.phase = "booked";
    this.log(req.id, "booked", "Quote Room", `Booked: ${SHOP_ACTOR[o.shopId]} · ${this.describeOffer(o)}. No payment taken; final details are confirmed at inspection.`, { booking: req.booking, offer: o });
    for (const ap of Object.values(this.approvals)) if (ap.requestId === req.id && ap.status === "pending") this.expire(ap, "request_closed");
    this.emit("booked", req, o);
    return { ok: true, booking: req.booking };
  }

  // ---------- helpers ----------
  // Once offers are presented (or booked) nothing can change them.
  closed(req: Request) { return !!req.booking || req.status === "ready_for_confirmation" || req.status === "booked"; }
  // Marks the shop's open ask answered and wakes the negotiation step.
  askAnswered(req: Request, shopId: string, outcome: string) {
    const ask = req.asks.find((a) => a.shopId === shopId && !a.outcome);
    if (!ask) return;
    ask.outcome = outcome;
    this.signal(`askdone:${req.id}`, { shopId, outcome });
  }
  plainItems(req: Request, text: string) {
    const c = this.cases[req.caseId];
    const items: { id: string; label: string }[] = [...c.baseline, ...(c.amendments?.drive ?? []).map((a: any) => a.item)];
    if (c.dynamic) for (const ci of cat.catalog().items) if (ci.id.includes("-")) items.push({ id: ci.id, label: ci.label }); // only hyphenated ids: never rewrite plain words like "hood"
    let out = text;
    for (const i of items) out = out.replace(new RegExp(`\\b${i.id.replace(/[-&]/g, "\\$&")}\\b`, "g"), String(i.label).toLowerCase());
    return out;
  }
  hasApprovalForAsk(askId: string) { return Object.values(this.approvals).some((a) => a.askId === askId); }
  // Agent free text is shown only if every dollar figure matches a current offer number and, in
  // insurance mode, it makes no out-of-pocket or coverage claims.
  safeAgentText(requestId: string, text: string) {
    const req = this.requests[requestId]; if (!req) return "";
    const t = text.replace(/[*_`#|]/g, "").replace(/\s+/g, " ").trim();
    if (!t) return "";
    const allowed = new Set<number>();
    for (const o of this.latestOffers(req)) {
      if (o.price?.total != null) allowed.add(Math.round(o.price.total));
      if (o.jobSize != null) allowed.add(Math.round(o.jobSize));
      for (const i of o.incentives ?? []) if (i.value) allowed.add(Math.round(i.value));
    }
    const amounts = [...t.matchAll(/\$\s?([\d,]+(?:\.\d+)?)/g)].map((m) => Math.round(Number(m[1].replace(/,/g, ""))));
    if (amounts.some((a) => ![...allowed].some((x) => Math.abs(x - a) <= 1))) return "";
    if (req.mode === "insurance" && /out[- ]of[- ]pocket|you(?:'ll| will)? (?:only )?(?:pay|owe)|covered|insurer will|insurance will|deductible will be|free repair/i.test(t)) return "";
    return t;
  }
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

// src/history.ts is built by the data builder; until it exists Drive works without history.
let historyMod: any;
async function loadHistory() {
  if (historyMod) return historyMod;
  try { historyMod = await import("./history.ts"); } catch { historyMod = undefined; }
  return historyMod;
}

function currentAssist(o: Offer) { return (o.incentives ?? []).find((i) => i.kind === "deductible_assist")?.value ?? 0; }
function setAssist(list: Incentive[], amount: number): Incentive[] {
  const rest = list.filter((i) => i.kind !== "deductible_assist");
  return amount > 0 ? [{ kind: "deductible_assist", value: amount, label: `$${amount} toward your deductible` }, ...rest] : rest;
}
