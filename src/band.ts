// BAND bridge: every request gets a BAND room; each room message is posted under the speaking
// agent's own BAND identity, with @mentions. The room is the shared, auditable deal record.
import { env } from "./config.ts";
import type { Orchestrator, RoomEvent } from "./orchestrator.ts";
import { SHOP_ACTOR, SHOP_OWNER } from "./orchestrator.ts";

const ROOT = "https://app.band.ai/api/v1";
type Ident = { key: string; id: string; name: string };

export class BandBridge {
  ids: Record<string, Ident> = {};
  rooms: Record<string, string> = {}; // requestId -> chatId
  status = "off";
  lastError = "";
  private queue: Promise<unknown> = Promise.resolve();
  private prefix = "/agent";
  private humans: string[] = [];

  private o: Orchestrator;
  constructor(o: Orchestrator) {
    this.o = o;
    const pair = (who: string, name: string, k: string, i: string) => { if (env(k) && env(i)) this.ids[who] = { key: env(k), id: env(i), name }; };
    pair("buyer", "Driver's agent", "BAND_BUYER_KEY", "BAND_BUYER_ID");
    pair("drive", "Drive Auto Body", "BAND_DRIVE_KEY", "BAND_DRIVE_ID");
    pair("shop-b", "Bayline Collision", "BAND_SHOPB_KEY", "BAND_SHOPB_ID");
    pair("shop-c", "QuickFix Auto Body", "BAND_SHOPC_KEY", "BAND_SHOPC_ID");
  }
  private async api(who: string, method: string, path: string, body?: unknown) {
    const id = this.ids[who]; if (!id) throw new Error(`no BAND identity for ${who}`);
    const r = await fetch(`${ROOT}${this.prefix}${path}`, { method, headers: { "X-API-Key": id.key, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000) });
    const text = await r.text();
    if (!r.ok) throw new Error(`BAND ${method} ${path} ${r.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }
  async start() {
    if (!this.ids.buyer || !this.ids.drive) return;
    try {
      // Docs show both ".../api/v1/agent" as base and "/agent/me" as path; probe which one this deployment uses.
      try { await this.api("buyer", "GET", "/me"); } catch { this.prefix = "/agent/agent"; await this.api("buyer", "GET", "/me"); }
      this.status = "ready";
      try { const peers: any = await this.api("buyer", "GET", "/peers"); this.humans = (peers?.data ?? []).filter((p: any) => String(p.type ?? "").toLowerCase() === "user" || !Object.values(this.ids).some((i) => i.id === p.id) && !/sim$|agent$|auto-body$/.test(String(p.name ?? ""))).map((p: any) => p.id); } catch { /* optional */ }
      this.o.on("room", (ev: RoomEvent, mentions: string[]) => { this.queue = this.queue.then(() => this.mirror(ev, mentions)).catch((e) => { this.lastError = String(e.message); }); });
    } catch (e: any) { this.status = "error"; this.lastError = String(e.message); }
  }
  // BAND identity that speaks an event: the shop's own identity for its agent and its owner's
  // decisions ("Owner (Bayline)" -> shop-b, "Owner (QuickFix)" -> shop-c, "Owner (Gio)" -> drive;
  // the approval's shopId wins when the payload has one). Falls back to the buyer if that shop has no identity.
  private who(ev: RoomEvent) {
    const actor = String(ev.actor ?? "");
    let id = "buyer";
    if (isOwner(actor)) {
      const fromPayload = (ev.payload as any)?.approval?.shopId;
      id = typeof fromPayload === "string" && SHOP_ACTOR[fromPayload] ? fromPayload
        : Object.keys(SHOP_OWNER).find((s) => SHOP_OWNER[s] === actor) ?? (/gio|drive/i.test(actor) ? "drive" : "buyer");
    } else {
      id = Object.keys(SHOP_ACTOR).find((s) => SHOP_ACTOR[s] === actor) ?? "buyer";
    }
    return this.ids[id] ? id : "buyer";
  }
  private async ensureRoom(requestId: string) {
    if (this.rooms[requestId]) return this.rooms[requestId];
    const created: any = await this.api("buyer", "POST", "/chats", { chat: {} });
    const chatId = created?.data?.id ?? created?.id ?? created?.chat?.id;
    if (!chatId) throw new Error(`BAND create chat: unexpected response ${JSON.stringify(created).slice(0, 160)}`);
    this.rooms[requestId] = chatId;
    const req = this.o.requests[requestId];
    for (const shopId of req.shops) {
      const pid = this.ids[shopId]?.id; if (!pid) continue;
      await this.api("buyer", "POST", `/chats/${chatId}/participants`, { participant: { participant_id: pid, role: "member" } })
        .catch(() => this.api("buyer", "POST", `/chats/${chatId}/participants`, { participant_id: pid }))
        .catch((e) => { this.lastError = String(e.message); });
    }
    for (const hid of this.humans) {
      await this.api("buyer", "POST", `/chats/${chatId}/participants`, { participant: { participant_id: hid, role: "member" } }).catch(() => undefined);
    }
    req.roomRef = chatId;
    return chatId;
  }
  private async mirror(ev: RoomEvent, mentionShopIds: string[]) {
    const chatId = await this.ensureRoom(ev.requestId);
    const speaker = this.who(ev);
    let targets = mentionShopIds.length ? mentionShopIds.filter((s) => s !== speaker) : [speaker === "buyer" ? "drive" : "buyer"];
    if (targets.includes("buyer") && speaker === "buyer") targets = ["drive"];
    const mentions = targets.map((t) => this.ids[t]).filter(Boolean).map((i) => ({ id: i.id, name: i.name }));
    const prefix = mentions.map((m) => `@${m.name}`).join(" ");
    const content = `${prefix} ${isOwner(String(ev.actor ?? "")) ? "[Owner decision] " : ""}${ev.text}`.slice(0, 3500);
    await this.api(speaker, "POST", `/chats/${chatId}/messages`, { message: { content, mentions } });
  }
}
// Any "Owner (…)" actor is an owner decision.
function isOwner(actor: string) { return actor.startsWith("Owner ("); }
