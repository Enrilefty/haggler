import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";
import { ROOT, env, integrations } from "./config.ts";
import { Orchestrator, SHOP_ACTOR, GUARDRAIL_INSURANCE, GUARDRAIL_INCENTIVE } from "./orchestrator.ts";
import { Flow } from "./flow.ts";
import { ZooWorkRuntime } from "./zoowork.ts";
import { TelegramOwner } from "./telegram.ts";
import { BandBridge } from "./band.ts";
import { PRIORITIES } from "./engines.ts";

const o = new Orchestrator();
const zw = integrations().zoowork ? new ZooWorkRuntime(o) : undefined;
const flow = new Flow(o, zw);
const tg = new TelegramOwner(o);
const band = new BandBridge(o);
let zwInit: any = { ok: false, error: integrations().zoowork ? "starting" : "ZOOWORK_API_KEY not set" };

// Optional: real public reviews for Drive Auto Body, cached by scripts/fetch-reviews.ts
const reviewsFile = join(ROOT, "data/reviews/drive.json");
if (existsSync(reviewsFile)) { try { o.updateProfile("drive", JSON.parse(readFileSync(reviewsFile, "utf8"))); } catch { /* ignore */ } }

const send = (res: ServerResponse, code: number, body: unknown, type = "application/json") => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : (body as any));
};
const readBody = async (req: IncomingMessage) => { let s = ""; for await (const c of req) s += c; try { return s ? JSON.parse(s) : {}; } catch { return {}; } };
const pinOk = (b: any) => env("ADMIN_PIN") !== "" && String(b?.pin ?? "") === env("ADMIN_PIN");
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml" };

function requestView(id: string) {
  const r = o.requests[id]; if (!r) return undefined;
  const c = o.cases[r.caseId];
  o.refreshComparison(r);
  return {
    ...r, case: { id: c.id, title: c.title, vehicle: c.vehicle, photos: c.photos, photoNote: c.photoNote, reviewNote: c.reviewNote, baseline: c.baseline, labels: Object.fromEntries([...c.baseline, ...(c.amendments?.drive ?? []).map((a: any) => a.item)].map((i: any) => [i.id, i.label])) },
    latest: Object.fromEntries(r.shops.map((s) => [s, o.latest(r, s)]).filter(([, v]) => v)),
    shopsInfo: Object.fromEntries(r.shops.map((s) => { const sh = o.shop(s); return [s, { name: sh.name, display: SHOP_ACTOR[s], simulated: sh.isSimulated, profile: sh.profile, warranty: sh.warranty, turnaround: sh.turnaroundDays }]; })),
    approvals: Object.values(o.approvals).filter((a) => a.requestId === id),
    guardrails: r.mode === "insurance" ? [GUARDRAIL_INCENTIVE, GUARDRAIL_INSURANCE] : ["Preliminary offers. Final details are confirmed at inspection."],
    priorities: PRIORITIES[r.mode],
  };
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    if (req.method === "GET" && (p === "/" || p === "/room" || p === "/admin")) {
      const file = p === "/admin" ? "admin.html" : "index.html";
      return send(res, 200, readFileSync(join(ROOT, "src/ui", file), "utf8"), MIME[".html"]);
    }
    if (req.method === "GET" && p.startsWith("/photos/")) {
      const f = join(ROOT, "data/photos", p.slice(8).replace(/[^a-zA-Z0-9._-]/g, ""));
      if (!existsSync(f)) return send(res, 404, { error: "not_found" });
      return send(res, 200, readFileSync(f), MIME[extname(f)] ?? "application/octet-stream");
    }
    if (req.method === "GET" && p === "/api/status") {
      return send(res, 200, { integrations: integrations(), zoowork: { ready: !!zw?.ready, model: zw?.model, init: zwInit, lastError: zw?.lastError }, band: { status: band.status, lastError: band.lastError }, telegram: { status: tg.status, bot: tg.botName, ownerConnected: !!tg.ownerChatId } });
    }
    if (req.method === "GET" && p === "/api/cases") {
      return send(res, 200, Object.values(o.cases).map((c: any) => ({ id: c.id, title: c.title, vehicle: c.vehicle, defaultMode: c.defaultMode, photos: c.photos, photoNote: c.photoNote, reviewNote: c.reviewNote, baseline: c.baseline, source: c.source })));
    }
    if (req.method === "GET" && p === "/api/requests") return send(res, 200, Object.values(o.requests).map((r) => ({ id: r.id, caseId: r.caseId, mode: r.mode, status: r.status, createdAt: r.createdAt })).reverse());
    if (req.method === "POST" && p === "/api/requests") {
      const b = await readBody(req);
      const r = o.createRequest(String(b.caseId), b.mode === "insurance" ? "insurance" : "self_pay", b.priority ?? "best_value", zw?.ready ? "zoowork" : "scripted");
      void flow.run(r);
      return send(res, 200, { requestId: r.id });
    }
    let m = p.match(/^\/api\/requests\/([\w-]+)$/);
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
    return send(res, 500, { error: String(e?.message ?? e) });
  }
});

const PORT = Number(env("PORT") || 3000);
server.listen(PORT, async () => {
  console.log(`Quote Room on http://localhost:${PORT}  (admin: /admin)`);
  const ints = integrations();
  console.log("integrations:", JSON.stringify(ints));
  if (zw) zwInit = await zw.init();
  console.log("zoowork:", JSON.stringify(zwInit));
  await tg.start(); console.log("telegram:", tg.status);
  await band.start(); console.log("band:", band.status, band.lastError);
});
