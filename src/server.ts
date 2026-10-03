import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, resolve, sep } from "node:path";
import { ROOT, env, integrations } from "./config.ts";
import { Orchestrator, SHOP_ACTOR, SHOP_OWNER, GUARDRAIL_INSURANCE, GUARDRAIL_INCENTIVE, UPLOAD_DIR, SAMPLES_DIR, PHOTOS_DIR, UPLOAD_LIMITS, listSamples } from "./orchestrator.ts";
import { Flow } from "./flow.ts";
import { ZooWorkRuntime } from "./zoowork.ts";
import { TelegramOwner } from "./telegram.ts";
import { BandBridge } from "./band.ts";
import { SlackOwner } from "./slack.ts";
import { PRIORITIES } from "./engines.ts";

const o = new Orchestrator();
const zw = integrations().zoowork ? new ZooWorkRuntime(o) : undefined;
const flow = new Flow(o, zw);
const tg = new TelegramOwner(o);
const band = new BandBridge(o);
const slack = new SlackOwner(o);
let zwInit: any = { ok: false, error: integrations().zoowork ? "starting" : "ZOOWORK_API_KEY not set" };

// Optional: real public reviews for Drive Auto Body, cached by scripts/fetch-reviews.ts
const reviewsFile = join(ROOT, "data/reviews/drive.json");
if (existsSync(reviewsFile)) { try { o.updateProfile("drive", JSON.parse(readFileSync(reviewsFile, "utf8"))); } catch { /* ignore */ } }

// Public origin for Slack image blocks: PUBLIC_URL wins. Otherwise the first-seen Host header, only
// when the request came through the local Cloudflare tunnel (loopback socket + cf-ray) and only for
// our own tunnel/hosting domains (a client can't point Slack at an arbitrary host).
const isLoopback = (req: IncomingMessage) => { const a = String(req.socket.remoteAddress ?? ""); return a === "::1" || a.startsWith("127.") || a.startsWith("::ffff:127."); };
const isLocal = (h: string) => /^(localhost|127\.|0\.0\.0\.0|\[::1\]|::1)/i.test(h);
const fixedOrigin = (() => { const u = env("PUBLIC_URL").replace(/\/+$/, ""); try { const x = new URL(u); return isLocal(x.host) ? "" : x.origin; } catch { return ""; } })();
if (fixedOrigin) o.publicOrigin = fixedOrigin;
const PUBLIC_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.(?:trycloudflare\.com|run\.app)$/;
function captureOrigin(req: IncomingMessage) {
  if (fixedOrigin || o.publicOrigin) return;
  if (!isLoopback(req) || !req.headers["cf-ray"]) return;
  const host = String(req.headers.host ?? "").trim().toLowerCase();
  if (PUBLIC_HOST.test(host)) o.publicOrigin = `https://${host}`;
}

// Security headers on every response.
const SECURITY_HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY" };
const send = (res: ServerResponse, code: number, body: unknown, type = "application/json", cache = "no-store", extra: Record<string, string> = {}) => {
  res.writeHead(code, { "content-type": type, "cache-control": cache, ...SECURITY_HEADERS, ...extra });
  res.end(type === "application/json" ? JSON.stringify(body) : (body as any));
};

// ---------- abuse limits ----------
// Client IP: the socket address. CF-Connecting-IP is honored only when the socket is loopback (the
// local cloudflared tunnel is the only thing that can reach us there); X-Forwarded-For is ignored.
function clientIp(req: IncomingMessage) {
  const sock = String(req.socket.remoteAddress ?? "unknown");
  if (isLoopback(req)) { const cf = String(req.headers["cf-connecting-ip"] ?? "").trim(); if (cf) return cf.slice(0, 64); }
  return sock;
}
const envInt = (k: string, d: number) => { const n = Math.floor(Number(env(k))); return Number.isFinite(n) && n > 0 ? n : d; };
const LIMITS = { bodyBytes: 1024 * 1024, runsPerWindow: envInt("RUNS_PER_WINDOW", 5), runWindowMs: 10 * 60_000, maxActive: envInt("MAX_ACTIVE_RUNS", 3), activeMaxAgeMs: 15 * 60_000, pinFailures: 5, pinWindowMs: 10 * 60_000 };
// Constant-time string compare (false when either side is empty).
function sameSecret(a: string, b: string) {
  if (!a || !b) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
// Stage bypass: a request carrying x-stage-key equal to env STAGE_KEY skips the per-IP limit and the busy cap.
const stageBypass = (req: IncomingMessage) => sameSecret(env("STAGE_KEY"), String(req.headers["x-stage-key"] ?? ""));
// Sliding-window counters keyed by "<bucket>:<ip>".
const hits = new Map<string, number[]>();
function retryAfter(key: string, max: number, windowMs: number): number {
  const t = Date.now(); const list = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
  if (list.length) hits.set(key, list); else hits.delete(key);
  return list.length >= max ? Math.max(1, Math.ceil((list[0] + windowMs - t) / 1000)) : 0;
}
function hit(key: string) {
  const list = hits.get(key) ?? []; list.push(Date.now()); hits.set(key, list);
  if (hits.size > 10_000) for (const [k, v] of hits) if (!v.length || Date.now() - v[v.length - 1] > LIMITS.runWindowMs) hits.delete(k);
}
// Runs still working (not ready/booked/stopped) and younger than 15 minutes.
function activeRuns() {
  const t = Date.now();
  return Object.values(o.requests).filter((r) => !["ready_for_confirmation", "booked", "inspection_unavailable"].includes(r.status) && r.phase !== "ready" && r.phase !== "booked" && t - Date.parse(r.createdAt) < LIMITS.activeMaxAgeMs).length;
}
// Per-IP run limit + global concurrency. Returns true if a 429 was sent.
function refuseRun(req: IncomingMessage, res: ServerResponse, bucket: string): boolean {
  if (stageBypass(req)) return false;
  const key = `${bucket}:${clientIp(req)}`;
  const wait = retryAfter(key, LIMITS.runsPerWindow, LIMITS.runWindowMs);
  if (wait) { send(res, 429, { error: "rate_limited", retryAfterSec: wait, message: "Too many tries from this connection. Please wait a few minutes and try again." }, "application/json", "no-store", { "retry-after": String(wait) }); return true; }
  if (activeRuns() >= LIMITS.maxActive) { send(res, 429, { error: "busy", retryAfterSec: 60, message: "The shops are busy with other requests right now. Please try again in a minute." }, "application/json", "no-store", { "retry-after": "60" }); return true; }
  hit(key);
  return false;
}
// Admin PIN with a lockout: 5 wrong PINs from one IP lock it out for 10 minutes. Returns true if allowed.
// The PIN comes from the JSON body (POST) or the x-admin-pin header (GET and POST).
function pinAllowed(req: IncomingMessage, res: ServerResponse, b: any = {}): boolean {
  const key = `pin:${clientIp(req)}`;
  const wait = retryAfter(key, LIMITS.pinFailures, LIMITS.pinWindowMs);
  if (wait) { send(res, 429, { error: "pin_locked", retryAfterSec: wait }, "application/json", "no-store", { "retry-after": String(wait) }); return false; }
  if (pinOk(b?.pin ?? req.headers["x-admin-pin"])) return true;
  hit(key);
  send(res, 403, { error: "pin_required" });
  return false;
}
class TooLarge extends Error {}
// JSON body with a byte cap (uploads get the large cap; everything else 1 MB).
const readBody = async (req: IncomingMessage, max = 1024 * 1024) => {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > max) throw new TooLarge(); chunks.push(c as Buffer); }
  const s = Buffer.concat(chunks).toString("utf8");
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
};
const pinOk = (pin: unknown) => sameSecret(env("ADMIN_PIN"), String(pin ?? ""));
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml" };
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
// Serves one image file only if it resolves inside `dir` (no traversal, no dotfiles).
function sendImage(res: ServerResponse, dir: string, file: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(file) || file.includes("..")) return send(res, 404, { error: "not_found" });
  const base = resolve(dir), f = resolve(base, file);
  if (!f.startsWith(base + sep) || !IMAGE_EXT.has(extname(f).toLowerCase()) || !existsSync(f)) return send(res, 404, { error: "not_found" });
  return send(res, 200, readFileSync(f), MIME[extname(f).toLowerCase()], "public, max-age=86400");
}

function requestView(id: string) {
  const r = o.requests[id]; if (!r) return undefined;
  const c = o.cases[r.caseId];
  o.refreshComparison(r);
  const baseline = c.dynamic ? (r.damageReport?.items ?? []).map((i) => ({ id: i.id, label: i.label, operation: i.operation })) : c.baseline;
  const ids = new Set<string>([...baseline.map((i: any) => i.id), ...(c.amendments?.drive ?? []).map((a: any) => a.item.id), ...Object.values(r.offers).flat().flatMap((x) => x.items.map((i) => i.id))]);
  const { roomKey: _roomKey, ...pub } = r as any; // the room key never leaves POST /api/requests
  return {
    ...pub,
    case: { id: c.id, title: c.title, vehicle: c.vehicle, dynamic: !!c.dynamic, photos: o.photoUrls(c), photoHashes: c.photoHashes ?? [], photoNote: c.photoNote, reviewNote: c.reviewNote, source: c.source, baseline, labels: Object.fromEntries([...ids].map((i) => [i, o.labelOf(r, i)])) },
    latest: Object.fromEntries(r.shops.map((s) => [s, o.latest(r, s)]).filter(([, v]) => v)),
    shopsInfo: Object.fromEntries(r.shops.map((s) => { const sh = o.shop(s); return [s, { name: sh.name, display: SHOP_ACTOR[s], demo: !!sh.isSimulated, profile: sh.profile, warranty: sh.warranty, turnaround: sh.turnaroundDays, incentiveStatus: sh.incentivePolicy?.status }]; })),
    approvals: Object.values(o.approvals).filter((a) => a.requestId === id).map(publicApproval),
    guardrails: r.mode === "insurance" ? [GUARDRAIL_INCENTIVE, GUARDRAIL_INSURANCE] : ["Preliminary offers. Final details are confirmed at inspection."],
    priorities: PRIORITIES[r.mode],
  };
}
// Approvals as the customer may see them: no shop authority limit, no agent's internal reason.
function publicApproval(a: any) { const { agentLimit: _l, reason: _r, ...rest } = a ?? {}; return rest; }
const publicEvent = (e: any) => (e?.payload && typeof e.payload === "object" && e.payload.approval ? { ...e, payload: { ...e.payload, approval: publicApproval(e.payload.approval) } } : e);
const caseCard = (c: any) => ({ id: c.id, title: c.title, vehicle: c.vehicle, defaultMode: c.defaultMode, photos: o.photoUrls(c), photoNote: c.photoNote, reviewNote: c.reviewNote, baseline: c.baseline, source: c.source });

const server = createServer(async (req, res) => {
  try {
    captureOrigin(req);
    const url = new URL(req.url ?? "/", "http://localhost");
    // Tolerate "/photos//uploads/x.jpg"-style joins from older UI code.
    const p = url.pathname.replace(/^\/photos\/+(uploads|samples)\//, "/$1/");
    // Body cap on every endpoint: 14 MB for photo uploads, 1 MB for everything else.
    const maxBody = req.method === "POST" && p === "/api/uploads" ? UPLOAD_LIMITS.maxBody : LIMITS.bodyBytes;
    if (Number(req.headers["content-length"] ?? 0) > maxBody) { res.setHeader("connection", "close"); return send(res, 413, { error: "body_too_large", maxBytes: maxBody }); }
    if (req.method === "GET" && (p === "/" || p === "/admin" || /^\/room(?:\/[\w-]+)?\/?$/.test(p))) {
      const file = p === "/admin" ? "admin.html" : "index.html";
      return send(res, 200, readFileSync(join(ROOT, "src/ui", file), "utf8"), MIME[".html"]);
    }
    let m = p.match(/^\/photos\/+(?:photos\/)?([^/]+)$/);
    if (req.method === "GET" && m) return sendImage(res, PHOTOS_DIR, m[1]);
    m = p.match(/^\/uploads\/([^/]+)$/);
    if (req.method === "GET" && m) return sendImage(res, UPLOAD_DIR, m[1]);
    m = p.match(/^\/samples\/([a-z0-9][a-z0-9-]{0,59})\/([^/]+)$/);
    if (req.method === "GET" && m) return sendImage(res, join(SAMPLES_DIR, m[1]), m[2]);
    if (req.method === "GET" && p === "/api/status") {
      return send(res, 200, { integrations: integrations(), publicOrigin: o.publicOrigin || null, zoowork: { ready: !!zw?.ready, model: zw?.model, init: zwInit, lastError: zw?.lastError }, band: { status: band.status, lastError: band.lastError }, telegram: { status: tg.status, bot: tg.botName, ownerConnected: !!tg.ownerChatId }, slack: { configured: slack.configured(), status: slack.status, lastError: slack.lastError } });
    }
    if (req.method === "GET" && p === "/api/cases") {
      // Only static cases that have photos (the Accord stays for tests); customer uploads are private.
      const cases = Object.values(o.cases).filter((c: any) => !c.dynamic && c.photos?.length).map(caseCard);
      return send(res, 200, { cases, samples: listSamples() });
    }
    if (req.method === "POST" && p === "/api/uploads") {
      if (refuseRun(req, res, "upload")) return;
      let b: any;
      try { b = await readBody(req, UPLOAD_LIMITS.maxBody); } catch (e) { if (e instanceof TooLarge) { res.setHeader("connection", "close"); return send(res, 413, { error: "upload_too_large", maxBytes: UPLOAD_LIMITS.maxBody }); } throw e; }
      const r: any = b?.sampleId != null ? o.createSampleCase(b.sampleId) : o.createPhotoCase(b?.images, b?.vehicle);
      return r.error ? send(res, r.error === "upload_limit_reached" ? 429 : 400, r) : send(res, 200, r);
    }
    if (req.method === "GET" && p === "/api/requests") { if (!pinAllowed(req, res)) return; return send(res, 200, Object.values(o.requests).map((r) => ({ id: r.id, caseId: r.caseId, mode: r.mode, status: r.status, phase: r.phase, createdAt: r.createdAt })).reverse()); }
    if (req.method === "POST" && p === "/api/requests") {
      if (refuseRun(req, res, "run")) return;
      const b = await readBody(req);
      if (!o.cases[String(b.caseId)]) return send(res, 400, { error: "unknown_case" });
      const r = o.createRequest(String(b.caseId), b.mode === "insurance" ? "insurance" : "self_pay", b.priority ?? "best_value", zw?.ready ? "zoowork" : "scripted");
      void flow.run(r);
      return send(res, 200, { requestId: r.id, roomKey: r.roomKey });
    }
    m = p.match(/^\/api\/requests\/([\w-]+)$/);
    if (req.method === "GET" && m) { const v = requestView(m[1]); return v ? send(res, 200, v) : send(res, 404, { error: "not_found" }); }
    m = p.match(/^\/api\/requests\/([\w-]+)\/feed$/);
    if (req.method === "GET" && m) return send(res, 200, { events: o.feed(m[1], Number(url.searchParams.get("after") ?? 0)).map(publicEvent) });
    m = p.match(/^\/api\/requests\/([\w-]+)\/confirm$/);
    if (req.method === "POST" && m) {
      const b = await readBody(req); const r = o.requests[m[1]];
      if (!r) return send(res, 404, { error: "not_found" });
      if (!sameSecret(String(r.roomKey ?? ""), String(b?.key ?? ""))) return send(res, 403, { error: "not_your_request" });
      return send(res, 200, o.confirm(m[1], String(b.offerId), Number(b.version)));
    }
    m = p.match(/^\/api\/approvals\/([\w-]+)\/decision$/);
    if (req.method === "POST" && m) {
      const b = await readBody(req); if (!pinAllowed(req, res, b)) return;
      return send(res, 200, o.decide(m[1], b.decision, b.counter, "admin override"));
    }
    if (req.method === "POST" && p === "/api/admin/shop") {
      const b = await readBody(req); if (!pinAllowed(req, res, b)) return;
      o.setShopEnabled(String(b.id), !!b.enabled); return send(res, 200, { ok: true, active: o.activeShops() });
    }
    if (req.method === "GET" && p === "/api/admin/approvals") {
      if (!pinAllowed(req, res)) return;
      // Pending approvals plus light context (shop, owner, case title, photo SHA-256s).
      return send(res, 200, Object.values(o.approvals).filter((a) => a.status === "pending").map((a) => {
        const r = o.requests[a.requestId], c = r ? o.cases[r.caseId] : undefined;
        return { ...a, context: { shop: SHOP_ACTOR[a.shopId], owner: SHOP_OWNER[a.shopId], mode: r?.mode, caseTitle: c?.title, photos: c ? o.photoUrls(c) : [], photoHashes: c?.photoHashes ?? [] } };
      }));
    }
    return send(res, 404, { error: "not_found" });
  } catch (e: any) {
    if (e instanceof TooLarge) { res.setHeader("connection", "close"); return send(res, 413, { error: "body_too_large" }); }
    return send(res, 500, { error: String(e?.message ?? e) });
  }
});

const PORT = Number(env("PORT") || 3000);
const HOST = env("HOST") || "127.0.0.1";
server.listen(PORT, HOST, async () => {
  console.log(`Haggler on http://${HOST}:${PORT}  (admin: /admin)`);
  const ints = integrations();
  console.log("integrations:", JSON.stringify(ints));
  // Owner channels and BAND come up alongside ZooWork; none of them blocks the others.
  await Promise.all([
    (async () => { if (zw) zwInit = await zw.init(); console.log("zoowork:", JSON.stringify(zwInit)); })(),
    tg.start().then(() => console.log("telegram:", tg.status)).catch((e) => console.log("telegram error:", e?.message)),
    band.start().then(() => console.log("band:", band.status, band.lastError)).catch((e) => console.log("band error:", e?.message)),
    slack.start().then(() => console.log("slack:", slack.status, slack.lastError)).catch((e) => console.log("slack error:", e?.message)),
  ]);
});
