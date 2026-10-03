// Owner point of view in Slack (Socket Mode: no public URL needed).
// - #deal-room channel: every shop's offers, clarifications, owner decisions and the booking, live.
// - one owner room per shop (SLACK_SHOP_CHANNELS; Drive falls back to SLACK_DAD_APPROVAL_CHANNEL_ID):
//   new requests with photos + damage report, that shop's own scope and offer, one-tap Approve /
//   Counter / Deny for ITS exceptions, its decisions, and won/lost.
// Channel membership is the gate: a tap decides only approvals of the shop whose room it came from.
// Only ONE backend may hold this app's Socket Mode connection at a time (Slack spreads events).
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { env, STATE_DIR } from "./config.ts";
import type { Orchestrator, Approval, Request, Offer, RoomEvent } from "./orchestrator.ts";
import { SHOP_ACTOR, SHOP_OWNER } from "./orchestrator.ts";

const money = (n?: number) => (n == null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`);
const round = (n: number, step: number) => Math.round(n / step) * step;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// plain-text fallback: drop :emoji: codes first, then mrkdwn emphasis (keeps "9:00 AM" intact)
// Slack section text is capped at 3000 characters.
const cap = (s: string, n = 2900) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const plain = (s: string) => s.replace(/:[a-z0-9_+-]+:/g, "").replace(/[*_]/g, "").trim();

// SLACK_SHOP_CHANNELS = {"drive":"C…","shop-b":"C…","shop-c":"C…"} (only Slack-style ids are kept).
function shopChannelsFromEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const j = JSON.parse(env("SLACK_SHOP_CHANNELS") || "{}");
    if (j && typeof j === "object") for (const [k, v] of Object.entries(j)) if (typeof v === "string" && /^[A-Z0-9]{6,20}$/.test(v.trim())) out[k] = v.trim();
  } catch { /* malformed: no shop rooms beyond Drive's fallback */ }
  return out;
}

export class SlackOwner {
  private o: Orchestrator;
  // SLACK_DRY_RUN=1: never touches Slack; every API call is appended to .state/slack-dry.jsonl.
  private dry = env("SLACK_DRY_RUN") === "1";
  private bot = env("SLACK_BOT_TOKEN");
  private app = env("SLACK_APP_TOKEN");
  private deal = env("SLACK_DEAL_CHANNEL_ID") || (this.dry ? "DRY-DEAL" : "");
  // shopId -> owner room channel id
  rooms: Record<string, string> = {};
  dryFile = join(STATE_DIR, "slack-dry.jsonl");
  status = "off";
  lastError = "";
  private ws?: WebSocket;
  private apMsg = new Map<string, { channel: string; ts: string }>(); // approvalId -> card in the shop's room
  private stopped = false;

  constructor(o: Orchestrator) {
    this.o = o;
    const fromEnv = shopChannelsFromEnv();
    for (const s of o.shops) {
      const id = fromEnv[s.id] || (s.id === "drive" ? env("SLACK_DAD_APPROVAL_CHANNEL_ID") : "") || (this.dry ? (s.id === "drive" ? "DRY-APPROVALS" : `DRY-${String(s.id).toUpperCase()}`) : "");
      if (id) this.rooms[s.id] = id;
    }
  }
  configured() { return this.dry || !!(this.bot && this.app && this.deal && Object.keys(this.rooms).length); }
  roomOf(shopId: string): string | undefined { return this.rooms[shopId]; }
  shopsForChannel(channel: string): string[] { return channel ? Object.keys(this.rooms).filter((s) => this.rooms[s] === channel) : []; }

  private async api(method: string, body: Record<string, unknown>, token = this.bot) {
    if (this.dry) {
      try { appendFileSync(this.dryFile, JSON.stringify({ at: new Date().toISOString(), method, body }) + "\n"); } catch { /* best effort */ }
      return { ok: true, ts: (Date.now() / 1000).toFixed(6), channel: body.channel };
    }
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`https://slack.com/api/${method}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      const j: any = await r.json().catch(() => ({}));
      if ((r.status === 429 || j.error === "ratelimited") && attempt < 3) { await sleep((Number(r.headers.get("retry-after")) || 1) * 1000 + 200); continue; }
      if (!j.ok) throw new Error(`slack ${method}: ${j.error ?? r.status}`);
      return j;
    }
  }
  // Posts go through one queue per channel (~1 msg/s, Slack's chat.postMessage pace) so each room
  // reads in order and nothing is dropped to rate limits. All text is owner-facing wording.
  private queues = new Map<string, Promise<unknown>>();
  private post(channel: string, text: string, blocks?: unknown[]): Promise<any> {
    const prev = this.queues.get(channel) ?? Promise.resolve();
    const run = prev.then(async () => {
      const msg = ownerText({ channel, text, unfurl_links: false, unfurl_media: false });
      const bl = blocks ? ownerText(blocks) : undefined;
      let res = await this.api("chat.postMessage", { ...msg, ...(bl ? { blocks: bl } : {}) })
        .catch((e) => { this.lastError = String(e.message); return undefined; });
      // Slack rejects the whole message if it can't fetch an image: resend without image blocks.
      const noImg = bl?.filter((b: any) => b?.type !== "image");
      if (!res && bl && noImg && noImg.length < bl.length) {
        res = await this.api("chat.postMessage", { ...msg, blocks: noImg }).catch((e) => { this.lastError = String(e.message); return undefined; });
      }
      await sleep(this.dry ? 20 : 1100);
      return res;
    });
    this.queues.set(channel, run.catch(() => undefined));
    return run;
  }

  async start() {
    if (!this.configured()) return;
    if (!this.dry) { try { await this.api("auth.test", {}); } catch (e: any) { this.status = `error: ${e.message}`; return; } }
    // Every shop with a room sends its exceptions to its owner there.
    for (const s of Object.keys(this.rooms)) this.o.ownerRooms.add(s);
    this.o.on("room", (ev: RoomEvent) => { void this.mirror(ev); void this.ownerFeed(ev); });
    this.o.on("approval", (ap: Approval, req: Request, base: Offer) => { void this.sendApproval(ap, req, base); });
    this.o.on("decided", (ap: Approval) => { void this.markDecided(ap); });
    this.o.on("booked", (req: Request, offer: Offer) => { void this.sendOutcome(req, offer); });
    if (this.dry) { this.status = "dry-run (logging to .state/slack-dry.jsonl)"; return; } // never opens Socket Mode
    await this.connect();
  }

  // ---------- Socket Mode ----------
  private async connect() {
    try {
      const { url } = await this.api("apps.connections.open", {}, this.app);
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => { if (!this.status.startsWith("WARNING")) this.status = "connected"; };
      ws.onmessage = (m) => { void this.onEnvelope(String(m.data)); };
      ws.onclose = () => { this.status = "reconnecting"; if (!this.stopped) setTimeout(() => void this.connect(), 2000); };
      ws.onerror = () => { this.lastError = "socket error"; };
    } catch (e: any) {
      this.status = `error: ${e.message}`; this.lastError = String(e.message);
      if (!this.stopped) setTimeout(() => void this.connect(), 5000);
    }
  }
  // Button taps. Channel membership is the gate: a tap in a shop's owner room can decide only that
  // shop's approvals, and any member of that room may tap.
  private async onEnvelope(raw: string) {
    let env: any; try { env = JSON.parse(raw); } catch { return; }
    if (env.envelope_id) this.ws?.send(JSON.stringify({ envelope_id: env.envelope_id })); // ack within 3s
    if (env.type === "hello") {
      const n = Number(env.num_connections ?? 1);
      this.status = n > 1 ? `WARNING: ${n} listeners on this Slack app — another backend is splitting button taps` : "ready";
      return;
    }
    if (env.type === "disconnect") { try { this.ws?.close(); } catch { /* reconnect via onclose */ } return; }
    if (env.type !== "interactive" || env.payload?.type !== "block_actions") return;
    await this.handleTap(env.payload);
  }
  async handleTap(p: any) {
    const action = p?.actions?.[0]; if (!action) return { error: "no_action" };
    const channel = String(p.channel?.id ?? ""), user = String(p.user?.id ?? "");
    const say = (text: string) => this.api("chat.postEphemeral", { channel, user, text }).catch(() => undefined);
    const here = this.shopsForChannel(channel);
    if (!here.length) { await say("Approvals can only be decided in a shop's owner room."); return { error: "not_an_owner_room" }; }
    let v: any = {}; try { v = JSON.parse(action.value ?? "{}"); } catch { return { error: "bad_value" }; }
    const ap = this.o.approvals[v.apId];
    if (!ap) { await say("That tap reached a Haggler server that doesn't know this approval — another server is connected to this Slack app. Stop it and tap again."); return { error: "unknown_approval" }; }
    if (!here.includes(ap.shopId)) { await say(`This approval belongs to ${SHOP_ACTOR[ap.shopId] ?? "another shop"}'s room.`); return { error: "wrong_room" }; }
    const req = this.o.requests[ap.requestId];
    const aid = String(action.action_id ?? "");
    const decision = aid === "qr_approve" ? "approve" : aid.startsWith("qr_counter") ? "counter" : aid === "qr_deny" ? "deny" : undefined;
    if (!decision) return { error: "bad_action" };
    const counter = decision === "counter" ? (req.mode === "self_pay" ? { total: Number(v.amount) } : { deductibleAssist: Number(v.amount) }) : undefined;
    const r: any = this.o.decide(ap.id, decision, counter, "slack");
    if (r?.error) await say(`Couldn't apply that: ${r.error}`);
    return r;
  }

  // ---------- owner point of view (one room per shop) ----------
  // Image blocks need a public https origin Slack can fetch; without one, photos are skipped.
  private imageBlocks(req: Request, max = 3) {
    const origin = this.o.publicOrigin; if (!origin) return [];
    const c = this.o.cases[req.caseId];
    return this.o.photoUrls(c).slice(0, max).map((u, i) => ({ type: "image", image_url: `${origin}${u}`, alt_text: `${c.title} — photo ${i + 1}` }));
  }
  private damageLines(req: Request, max = 8) {
    const r = req.damageReport; if (!r) return "";
    const items = r.items.slice(0, max).map((i) => `• ${i.label}${r.by === "agent" ? ` — ${i.operation} (${i.severity})` : ""}${i.note ? `: ${i.note}` : ""}`);
    if (r.items.length > max) items.push(`…and ${r.items.length - max} more`);
    return items.join("\n");
  }
  private modeText = (req: Request) => (req.mode === "self_pay" ? "self-pay" : "insurance claim");
  private shopOfEvent(ev: RoomEvent): string | undefined {
    const p: any = ev.payload ?? {};
    return p.approval?.shopId ?? p.shopId ?? Object.keys(SHOP_ACTOR).find((k) => SHOP_ACTOR[k] === ev.actor || SHOP_OWNER[k] === ev.actor);
  }
  private async ownerFeed(ev: RoomEvent) {
    const req = this.o.requests[ev.requestId]; if (!req) return;
    const c = this.o.cases[req.caseId];
    const photosNote = this.o.publicOrigin ? [] : [{ type: "context", elements: [{ type: "mrkdwn", text: `${this.o.photoUrls(c).length} photo(s) — open the room to view them.` }] }];
    const rooms = req.shops.filter((s) => this.roomOf(s));
    if (ev.type === "damage_report") {
      const r = req.damageReport!;
      const head = `:inbox_tray: *New request ${req.id}* · ${c.title} · ${this.modeText(req)}`;
      await Promise.all(rooms.map((s) => this.post(this.roomOf(s)!, plain(`New request ${req.id} · ${c.title} · ${r.summary}`), [
        { type: "section", text: { type: "mrkdwn", text: `${head}\n${r.by === "agent" ? "The customer's agent looked at the photos" : "Reviewed damage"}: ${r.summary}` } },
        ...this.imageBlocks(req), ...photosNote,
        { type: "section", text: { type: "mrkdwn", text: cap(`*What's wrong*\n${this.damageLines(req) || "—"}`) } },
        { type: "context", elements: [{ type: "mrkdwn", text: `Your agent is building ${SHOP_ACTOR[s]}'s scope from the photos now.` }] },
      ])));
    } else if (ev.type === "system_note" && (ev.payload as any)?.inspection === "unavailable") {
      await Promise.all(rooms.map((s) => this.post(this.roomOf(s)!, plain(`New request ${req.id} · ${c.title} · AI photo inspection unavailable`), [
        { type: "section", text: { type: "mrkdwn", text: `:inbox_tray: *New request ${req.id}* · ${c.title} · ${this.modeText(req)}\nAI photo inspection was unavailable, so no quote went out.` } }, ...this.imageBlocks(req), ...photosNote,
      ])));
    } else if (ev.type === "offer_posted" && (ev.payload as any)?.version === 1) {
      const offer = ev.payload as Offer, shopId = offer.shopId, room = this.roomOf(shopId); if (!room) return;
      const a = req.assessments[shopId];
      const scope = a
        ? a.items.slice(0, 12).map((i) => `• ${i.label} — ${i.operation}${i.partType ? ` (${i.partType})` : ""}: ${i.reason}`).join("\n")
        : offer.items.slice(0, 12).map((i) => `• ${i.label}`).join("\n");
      const price = req.mode === "self_pay" ? `Quoted *${money(offer.price?.total)}*` : `Job size ~*${money(offer.jobSize)}* · ${(offer.incentives ?? []).map((i) => i.label).join(" + ") || "no incentives"}`;
      await this.post(room, plain(`Your agent quoted ${req.id}: ${req.mode === "self_pay" ? money(offer.price?.total) : `job ~${money(offer.jobSize)}`}`), [
        { type: "section", text: { type: "mrkdwn", text: `:memo: *Your agent quoted ${req.id}* · ${c.title}\n${price} · drop-off ${offer.slot}` } },
        ...(a?.history?.summary ? [{ type: "context", elements: [{ type: "mrkdwn", text: `From your past estimates: ${a.history.summary}` }] }] : []),
        ...(a?.notes ? [{ type: "context", elements: [{ type: "mrkdwn", text: a.notes }] }] : []),
        { type: "section", text: { type: "mrkdwn", text: cap(`*${SHOP_ACTOR[shopId]}'s scope*\n${scope || "—"}`) } },
      ]);
    } else if (ev.type === "offer_revised" || ev.type === "owner_decision") {
      // The shop's own decisions: its agent's moves within authority and its owner's (or rule's) answers.
      const shopId = this.shopOfEvent(ev), room = shopId && this.roomOf(shopId); if (!room) return;
      const line = ev.type === "offer_revised" ? `:pencil2: *Your agent* · ${req.id} · ${ev.text.replace(/\n/g, " — ")}` : `*${ev.actor}* · ${req.id} · ${ev.text}`;
      await this.post(room, plain(line), [{ type: "section", text: { type: "mrkdwn", text: cap(line) } }]);
    }
  }

  // ---------- owner approvals (in the shop's own room) ----------
  private presets(ap: Approval, req: Request): number[] {
    if (req.mode === "self_pay") {
      const ask = ap.requested.total!, lim = ap.agentLimit.total!;
      const a = round((ask + lim) / 2, 10), b = round(ask + (lim - ask) * 0.75, 10);
      return [...new Set([a, b])].filter((x) => x > ask && x < lim);
    }
    const ask = ap.requested.deductibleAssist!, cap = ap.agentLimit.deductibleCap!;
    const a = round((ask + cap) / 2, 25);
    return [a].filter((x) => x > cap && x < ask);
  }
  private async sendApproval(ap: Approval, req: Request, base: Offer) {
    const room = this.roomOf(ap.shopId); if (!room) return;
    const c = this.o.cases[req.caseId];
    const others = this.o.latestOffers(req).filter((x) => x.shopId !== ap.shopId)
      .map((x) => `• ${SHOP_ACTOR[x.shopId]}: ${req.mode === "self_pay" ? money(x.price?.total) : (x.incentives ?? []).map((i) => i.label).join(" + ") || "no incentives"}`).join("\n");
    const ask = req.mode === "self_pay" ? money(ap.requested.total) : `${money(ap.requested.deductibleAssist)} toward the deductible`;
    const lim = req.mode === "self_pay" ? `Your agent can go to *${money(ap.agentLimit.total)}* on its own. Current offer: ${money(base.price?.total)}.` : `Your agent can offer *${money(ap.agentLimit.deductibleCap)}* on its own (job ~${money(base.jobSize)}).`;
    const text = `Approval needed · ${SHOP_ACTOR[ap.shopId]} · ${req.id} · ${c.title} · Customer's agent asks ${ask}.`;
    const val = (amount?: number) => JSON.stringify({ apId: ap.id, amount });
    const buttons: any[] = [{ type: "button", action_id: "qr_approve", style: "primary", text: { type: "plain_text", text: `Approve ${req.mode === "self_pay" ? money(ap.requested.total) : money(ap.requested.deductibleAssist)}` }, value: val() }];
    this.presets(ap, req).forEach((amt, i) => buttons.push({ type: "button", action_id: `qr_counter_${i + 1}`, text: { type: "plain_text", text: `Counter ${money(amt)}` }, value: val(amt) })); // action_ids must be unique per block
    buttons.push({ type: "button", action_id: "qr_deny", style: "danger", text: { type: "plain_text", text: "Deny" }, value: val() });
    const dmg = this.damageLines(req, 3);
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: `:bell: *Approval needed* · ${SHOP_ACTOR[ap.shopId]} · ${req.id} · ${c.title} (${req.mode === "self_pay" ? "self-pay" : "insurance"})\nBest-and-final round: the customer's agent asks *${ask}*. ${lim}` } },
      ...this.imageBlocks(req, 1),
      ...(dmg ? [{ type: "section", text: { type: "mrkdwn", text: `*Damage*\n${dmg}` } }] : []),
      { type: "context", elements: [{ type: "mrkdwn", text: `Competing offers:\n${others || "none"}` }] },
      { type: "actions", block_id: `ap_${ap.id}`, elements: buttons },
      { type: "context", elements: [{ type: "mrkdwn", text: `For ${SHOP_OWNER[ap.shopId] ?? "the owner"} · anyone in this room can decide.` }] },
    ];
    const res: any = await this.post(room, text, blocks);
    if (res?.ts) this.apMsg.set(ap.id, { channel: room, ts: res.ts });
  }
  private async markDecided(ap: Approval) {
    const m = this.apMsg.get(ap.id); if (!m) return;
    const req = this.o.requests[ap.requestId];
    const what = ap.status === "countered" ? `Countered at ${req.mode === "self_pay" ? money(ap.counter?.total) : money(ap.counter?.deductibleAssist) + " toward the deductible"}`
      : ap.status === "approved" ? "Approved" : ap.status === "denied" ? "Denied"
      : ap.decidedVia === "timeout" ? "Expired — no answer in time, current offer held"
      : ap.decidedVia === "request_closed" ? (req.booking ? "Closed — the customer already booked" : "Closed — offers were already presented to the customer") : "Expired — the offer changed";
    const icon = ap.status === "expired" ? ":hourglass:" : ":white_check_mark:";
    const via = ap.status === "expired" ? "" : ` (${SHOP_OWNER[ap.shopId] ?? "owner"} via ${ap.decidedVia})`;
    const t = `${icon} *${what}* · ${SHOP_ACTOR[ap.shopId]} · ${ap.requestId}${via}`;
    await this.api("chat.update", ownerText({ channel: m.channel, ts: m.ts, text: plain(t), blocks: [{ type: "section", text: { type: "mrkdwn", text: t } }] })).catch((e) => { this.lastError = String(e.message); });
  }
  private async sendOutcome(req: Request, offer: Offer) {
    const c = this.o.cases[req.caseId];
    await Promise.all(req.shops.filter((s) => this.roomOf(s)).map((s) => {
      const t = offer.shopId === s
        ? `:trophy: *You won* · ${req.id} · ${c.title}\n${this.o.describeOffer(offer)}\n_No payment taken; final details are confirmed at inspection._`
        : `Lost · ${req.id} · ${c.title} · the customer chose ${SHOP_ACTOR[offer.shopId]} (${req.priority.replace("_", " ")}).`;
      return this.post(this.roomOf(s)!, plain(t), [{ type: "section", text: { type: "mrkdwn", text: t } }]);
    }));
  }

  // ---------- shared deal room (all shops) ----------
  private async mirror(ev: RoomEvent) {
    const req = this.o.requests[ev.requestId]; if (!req || !this.deal) return;
    const c = this.o.cases[req.caseId];
    const short = (s: string, n = 300) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
    let line = "";
    switch (ev.type) {
      case "request_posted": line = `:inbox_tray: *New request ${req.id}* · ${c.title} · ${req.mode === "self_pay" ? "self-pay" : "insurance claim"}`; break;
      case "offer_posted": case "offer_revised": line = `*${ev.actor}* · ${short(ev.text.replace(/\n/g, " — "))}`; break;
      case "scope_amended": if (ev.actor === SHOP_ACTOR.drive) line = `*${ev.actor}* · ${short(ev.text.replace(/\n/g, " "), 400)}`; break;
      case "damage_report": line = `*Customer's agent* · ${short(ev.text.replace(/\n/g, " "), 400)}`; break;
      case "assessment_posted": { const a = (ev.payload as any)?.assessment; line = `*${ev.actor}* · scope from the photos: ${short((a?.items ?? []).map((i: any) => `${i.label} (${i.operation})`).join(", "), 400)}`; break; }
      // clarifications: only Drive's, to keep the room readable (each shop's room has its own story)
      case "clarify_sent": if ((ev.payload as any)?.clarification?.shopId === "drive") line = `*Customer's agent* · ${short(ev.text)}`; break;
      case "clarification_answered": if (ev.actor === SHOP_ACTOR.drive) line = `*${ev.actor}* · ${short(ev.text.replace(/\n/g, " — "))}`; break;
      case "ask_sent": line = `*Customer's agent* · ${short(ev.text)}`; break;
      case "exception_requested": line = `*${ev.actor}* · ${this.o.exceptionModeOf(this.shopOfEvent(ev) ?? "") === "owner" ? "Beyond its authority — asking the owner." : "Checking with the shop's rules."}`; break;
      case "owner_decision": line = `*${ev.actor}* · ${short(ev.text)}`; break;
      case "ranking_ready": line = `*Customer's agent* · ${short(ev.text.replace(/\n/g, "  "), 500)}`; break;
      case "booked": line = `:white_check_mark: ${short(ev.text)}`; break;
      case "system_note": if (req.mode === "insurance" && /Incentives/.test(ev.text)) line = `_${ev.text}_`; break;
    }
    if (line) await this.post(this.deal, plain(line), [{ type: "section", text: { type: "mrkdwn", text: line } }]);
  }
}

// Owner-facing wording: the buyer is "the customer's agent" in Slack (the room feed may say driver).
const toCustomer = (s: string) => s.replace(/Driver's agent/g, "Customer's agent").replace(/driver's agent/g, "customer's agent").replace(/\bDriver\b/g, "Customer").replace(/\bdriver\b/g, "customer");
// Slack control characters in text: agent/customer free text can never inject <!channel>, <@U…> or links.
const escSlack = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Identifiers and URLs pass through untouched; plain_text objects aren't parsed by Slack, so no escaping there.
const RAW_KEYS = new Set(["image_url", "value", "channel", "ts", "action_id", "block_id", "type", "style", "user"]);
function ownerText<T>(x: T, key = "", plainText = false): T {
  if (typeof x === "string") return (RAW_KEYS.has(key) ? x : plainText ? toCustomer(x) : escSlack(toCustomer(x))) as T;
  if (Array.isArray(x)) return x.map((v) => ownerText(v)) as T;
  if (x && typeof x === "object") { const pt = (x as any).type === "plain_text"; return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, ownerText(v, k, pt)])) as T; }
  return x;
}
