import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, resolve, sep } from "node:path";
import { ROOT, env, integrations } from "./config.ts";
import { Orchestrator, SHOP_ACTOR, GUARDRAIL_INSURANCE, GUARDRAIL_INCENTIVE, UPLOAD_DIR, SAMPLES_DIR, PHOTOS_DIR, UPLOAD_LIMITS, listSamples } from "./orchestrator.ts";
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

// Public origin for Slack image blocks: PUBLIC_URL wins; otherwise the first-seen public Host.
const isLocal = (h: string) => /^(localhost|127\.|0\.0\.0\.0|\[::1\]|::1)/i.test(h);
const fixedOrigin = (() => { const u = env("PUBLIC_URL").replace(/\/+$/, ""); try { const x = new URL(u); return isLocal(x.host) ? "" : x.origin; } catch { return ""; } })();
if (fixedOrigin) o.publicOrigin = fixedOrigin;
function captureOrigin(req: IncomingMessage) {
  if (fixedOrigin || o.publicOrigin) return;
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0].trim().toLowerCase();
  if (!host || isLocal(host) || !/^[a-z0-9.-]+(:\d+)?$/.test(host) || !host.includes(".")) return;
  const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim().toLowerCase();
  o.publicOrigin = `${proto === "http" ? "http" : "https"}://${host}`;
}

const send = (res: ServerResponse, code: number, body: unknown, type = "application/json", cache = "no-store") => {
  res.writeHead(code, { "content-type": type, "cache-control": cache, "x-content-type-options": "nosniff" });
  res.end(type === "application/json" ? JSON.stringify(body) : (body as any));
};
class TooLarge extends Error {}
// JSON body with a byte cap (uploads get the large cap; everything else 1 MB).
const readBody = async (req: IncomingMessage, max = 1024 * 1024) => {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > max) throw new TooLarge(); chunks.push(c as Buffer); }
  const s = Buffer.concat(chunks).toString("utf8");
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
};
const pinOk = (b: any) => env("ADMIN_PIN") !== "" && String(b?.pin ?? "") === env("ADMIN_PIN");
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
  return {
    ...r,
    case: { id: c.id, title: c.title, vehicle: c.vehicle, dynamic: !!c.dynamic, photos: o.photoUrls(c), photoNote: c.photoNote, reviewNote: c.reviewNote, source: c.source, baseline, labels: Object.fromEntries([...ids].map((i) => [i, o.labelOf(r, i)])) },
    latest: Object.fromEntries(r.shops.map((s) => [s, o.latest(r, s)]).filter(([, v]) => v)),
    shopsInfo: Object.fromEntries(r.shops.map((s) => { const sh = o.shop(s); return [s, { name: sh.name, display: SHOP_ACTOR[s], demo: !!sh.isSimulated, profile: sh.profile, warranty: sh.warranty, turnaround: sh.turnaroundDays, incentiveStatus: sh.incentivePolicy?.status }]; })),
    approvals: Object.values(o.approvals).filter((a) => a.requestId === id),
    guardrails: r.mode === "insurance" ? [GUARDRAIL_INCENTIVE, GUARDRAIL_INSURANCE] : ["Preliminary offers. Final details are confirmed at inspection."],
    priorities: PRIORITIES[r.mode],
  };
}
const caseCard = (c: any) => ({ id: c.id, title: c.title, vehicle: c.vehicle, defaultMode: c.defaultMode, photos: o.photoUrls(c), photoNote: c.photoNote, reviewNote: c.reviewNote, baseline: c.baseline, source: c.source });

const server = createServer(async (req, res) => {
  try {
    captureOrigin(req);
    const url = new URL(req.url ?? "/", "http://localhost");
    // Tolerate "/photos//uploads/x.jpg"-style joins from older UI code.
    const p = url.pathname.replace(/^\/photos\/+(uploads|samples)\//, "/$1/");
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
      let b: any;
      try { b = await readBody(req, UPLOAD_LIMITS.maxBody); } catch (e) { if (e instanceof TooLarge) { res.setHeader("connection", "close"); return send(res, 413, { error: "upload_too_large", maxBytes: UPLOAD_LIMITS.maxBody }); } throw e; }
      const r: any = b?.sampleId != null ? o.createSampleCase(b.sampleId) : o.createPhotoCase(b?.images, b?.vehicle);
      return r.error ? send(res, r.error === "upload_limit_reached" ? 429 : 400, r) : send(res, 200, r);
    }
    if (req.method === "GET" && p === "/api/requests") return send(res, 200, Object.values(o.requests).map((r) => ({ id: r.id, caseId: r.caseId, mode: r.mode, status: r.status, phase: r.phase, createdAt: r.createdAt })).reverse());
    if (req.method === "POST" && p === "/api/requests") {
      const b = await readBody(req);
      if (!o.cases[String(b.caseId)]) return send(res, 400, { error: "unknown_case" });
      const r = o.createRequest(String(b.caseId), b.mode === "insurance" ? "insurance" : "self_pay", b.priority ?? "best_value", zw?.ready ? "zoowork" : "scripted");
      void flow.run(r);
      return send(res, 200, { requestId: r.id });
    }
    m = p.match(/^\/api\/requests\/([\w-]+)$/);
    if (req.method === "GET" && m) { const v = requestView(m[1]); return v ? send(res, 200, v) : send(res, 404, { error: "not_found" }); }
    m = p.match(/^\/api\/requests\/([\w-]+)\/feed$/);
    if (req.method === "GET" && m) return send(res, 200, { events: o.feed(m[1], Number(url.searchParams.get("after") ?? 0)) });
    m = p.match(/^\/api\/requests\/([\w-]+)\/confirm$/);
    if (req.method === "POST" && m) { const b = await readBody(req); return send(res, 200, o.confirm(m[1], String(b.offerId), Number(b.version))); }
    m = p.match(/^\/api\/approvals\/([\w-]+)\/decision$/);
    if (req.method === "POST" && m) {
      const b = await readBody(req); if (!pinOk(b)) return send(res, 403, { error: "pin_required" });
      return send(res, 200, o.decide(m[1], b.decision, b.counter, "admin override"));
    }
    if (req.method === "POST" && p === "/api/admin/shop") {
      const b = await readBody(req); if (!pinOk(b)) return send(res, 403, { error: "pin_required" });
      o.setShopEnabled(String(b.id), !!b.enabled); return send(res, 200, { ok: true, active: o.activeShops() });
    }
    if (req.method === "GET" && p === "/api/admin/approvals") return send(res, 200, Object.values(o.approvals).filter((a) => a.status === "pending"));
    return send(res, 404, { error: "not_found" });
  } catch (e: any) {
    if (e instanceof TooLarge) return send(res, 413, { error: "body_too_large" });
    return send(res, 500, { error: String(e?.message ?? e) });
  }
});

const PORT = Number(env("PORT") || 3000);
server.listen(PORT, async () => {
  console.log(`Quote Room on http://localhost:${PORT}  (admin: /admin)`);
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
