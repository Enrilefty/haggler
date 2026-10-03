// Owner point of view in Slack (Socket Mode: no public URL needed).
// - #deal-room channel: every shop's offers, clarifications, owner decisions and the booking, live.
// - private approvals channel: Gio's one-tap Approve / Counter / Deny, plus new-request and won/lost notices.
// Only the allowlisted owner user, in the approvals channel, can decide. Only ONE backend may hold
// this app's Socket Mode connection at a time (Slack spreads events across connections).
import { env } from "./config.ts";
import type { Orchestrator, Approval, Request, Offer, RoomEvent } from "./orchestrator.ts";
import { SHOP_ACTOR } from "./orchestrator.ts";

const money = (n?: number) => (n == null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`);
const round = (n: number, step: number) => Math.round(n / step) * step;

export class SlackOwner {
  private o: Orchestrator;
  private bot = env("SLACK_BOT_TOKEN");
  private app = env("SLACK_APP_TOKEN");
  private deal = env("SLACK_DEAL_CHANNEL_ID");
  private approvals = env("SLACK_DAD_APPROVAL_CHANNEL_ID");
  private owner = env("SLACK_OWNER_USER_ID");
  status = "off";
  lastError = "";
  private ws?: WebSocket;
  private apMsg = new Map<string, string>(); // approvalId -> message ts in approvals channel
  private stopped = false;

  constructor(o: Orchestrator) { this.o = o; }
  configured() { return !!(this.bot && this.app && this.deal && this.approvals && this.owner); }

  private async api(method: string, body: Record<string, unknown>, token = this.bot) {
    const r = await fetch(`https://slack.com/api/${method}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
    const j: any = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`slack ${method}: ${j.error ?? r.status}`);
    return j;
  }
  private post(channel: string, text: string, blocks?: unknown[]) {
    return this.api("chat.postMessage", { channel, text, ...(blocks ? { blocks } : {}), unfurl_links: false, unfurl_media: false })
      .catch((e) => { this.lastError = String(e.message); return undefined; });
  }

  async start() {
    if (!this.configured()) return;
    try { await this.api("auth.test", {}); } catch (e: any) { this.status = `error: ${e.message}`; return; }
    this.o.on("room", (ev: RoomEvent) => { void this.mirror(ev); });
    this.o.on("approval", (ap: Approval, req: Request, base: Offer) => { void this.sendApproval(ap, req, base); });
    this.o.on("decided", (ap: Approval) => { void this.markDecided(ap); });
    this.o.on("booked", (req: Request, offer: Offer) => { void this.sendOutcome(req, offer); });
    await this.connect();
  }

  // ---------- Socket Mode ----------
  private async connect() {
    try {
      const { url } = await this.api("apps.connections.open", {}, this.app);
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => { this.status = "ready"; };
      ws.onmessage = (m) => { void this.onEnvelope(String(m.data)); };
      ws.onclose = () => { this.status = "reconnecting"; if (!this.stopped) setTimeout(() => void this.connect(), 2000); };
      ws.onerror = () => { this.lastError = "socket error"; };
    } catch (e: any) {
      this.status = `error: ${e.message}`; this.lastError = String(e.message);
      if (!this.stopped) setTimeout(() => void this.connect(), 5000);
    }
  }
  private async onEnvelope(raw: string) {
    let env: any; try { env = JSON.parse(raw); } catch { return; }
    if (env.envelope_id) this.ws?.send(JSON.stringify({ envelope_id: env.envelope_id })); // ack within 3s
    if (env.type === "disconnect") { try { this.ws?.close(); } catch { /* reconnect via onclose */ } return; }
    if (env.type !== "interactive" || env.payload?.type !== "block_actions") return;
    const p = env.payload;
    const action = p.actions?.[0]; if (!action) return;
    if (p.user?.id !== this.owner || p.channel?.id !== this.approvals) {
      await this.api("chat.postEphemeral", { channel: p.channel?.id, user: p.user?.id, text: "Only the shop owner can decide this approval." }).catch(() => undefined);
      return;
    }
    let v: any = {}; try { v = JSON.parse(action.value ?? "{}"); } catch { return; }
    const ap = this.o.approvals[v.apId]; if (!ap) return;
    const req = this.o.requests[ap.requestId];
    const decision = action.action_id === "qr_approve" ? "approve" : action.action_id === "qr_counter" ? "counter" : "deny";
    const counter = decision === "counter" ? (req.mode === "self_pay" ? { total: Number(v.amount) } : { deductibleAssist: Number(v.amount) }) : undefined;
    const r: any = this.o.decide(ap.id, decision, counter, "slack");
    if (r?.error) await this.api("chat.postEphemeral", { channel: this.approvals, user: this.owner, text: `Couldn't apply that: ${r.error}` }).catch(() => undefined);
  }

  // ---------- owner approvals ----------
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
    const c = this.o.cases[req.caseId];
    const others = this.o.latestOffers(req).filter((x) => x.shopId !== ap.shopId)
      .map((x) => `• ${SHOP_ACTOR[x.shopId]}: ${req.mode === "self_pay" ? money(x.price?.total) : (x.incentives ?? []).map((i) => i.label).join(" + ") || "no incentives"}`).join("\n");
    const ask = req.mode === "self_pay" ? money(ap.requested.total) : `${money(ap.requested.deductibleAssist)} toward the deductible`;
    const lim = req.mode === "self_pay" ? `Your agent can go to *${money(ap.agentLimit.total)}* on its own. Current offer: ${money(base.price?.total)}.` : `Your agent can offer *${money(ap.agentLimit.deductibleCap)}* on its own (job ~${money(base.jobSize)}).`;
    const text = `Approval needed · ${req.id} · ${c.title}\nDriver asks ${ask}.`;
    const val = (amount?: number) => JSON.stringify({ apId: ap.id, amount });
    const buttons: any[] = [{ type: "button", action_id: "qr_approve", style: "primary", text: { type: "plain_text", text: `Approve ${req.mode === "self_pay" ? money(ap.requested.total) : money(ap.requested.deductibleAssist)}` }, value: val() }];
    for (const amt of this.presets(ap, req)) buttons.push({ type: "button", action_id: "qr_counter", text: { type: "plain_text", text: `Counter ${money(amt)}` }, value: val(amt) });
    buttons.push({ type: "button", action_id: "qr_deny", style: "danger", text: { type: "plain_text", text: "Deny" }, value: val() });
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: `:bell: *Approval needed* · ${req.id} · ${c.title} (${req.mode === "self_pay" ? "self-pay" : "insurance"})\nDriver asks *${ask}*. ${lim}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: `Competing offers:\n${others || "none"}` }] },
      { type: "actions", block_id: `ap_${ap.id}`, elements: buttons },
    ];
    const res: any = await this.post(this.approvals, text, blocks);
    if (res?.ts) this.apMsg.set(ap.id, res.ts);
  }
  private async markDecided(ap: Approval) {
    const ts = this.apMsg.get(ap.id); if (!ts) return;
    const req = this.o.requests[ap.requestId];
    const what = ap.status === "countered" ? `Countered at ${req.mode === "self_pay" ? money(ap.counter?.total) : money(ap.counter?.deductibleAssist) + " toward the deductible"}` : ap.status === "approved" ? "Approved" : ap.status === "denied" ? "Denied" : ap.status;
    await this.api("chat.update", { channel: this.approvals, ts, text: `${what} · ${ap.requestId}`, blocks: [{ type: "section", text: { type: "mrkdwn", text: `:white_check_mark: *${what}* · ${ap.requestId} (via ${ap.decidedVia})` } }] }).catch((e) => { this.lastError = String(e.message); });
  }
  private async sendOutcome(req: Request, offer: Offer) {
    const c = this.o.cases[req.caseId];
    const t = offer.shopId === "drive" ? `:trophy: *You won* · ${c.title}\n${this.o.describeOffer(offer)}\n_Simulated booking — no payment taken._` : `Lost · ${c.title} · driver chose ${SHOP_ACTOR[offer.shopId]} (${req.priority.replace("_", " ")}).`;
    await this.post(this.approvals, t.replace(/[*_:]/g, ""), [{ type: "section", text: { type: "mrkdwn", text: t } }]);
  }

  // ---------- shared deal room (all shops) ----------
  private async mirror(ev: RoomEvent) {
    const req = this.o.requests[ev.requestId]; if (!req) return;
    const c = this.o.cases[req.caseId];
    const short = (s: string, n = 300) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
    let line = "";
    switch (ev.type) {
      case "request_posted": line = `:inbox_tray: *New request ${req.id}* · ${c.title} · ${req.mode === "self_pay" ? "self-pay" : "insurance claim"}`; break;
      case "offer_posted": case "offer_revised": line = `*${ev.actor}* · ${short(ev.text.replace(/\n/g, " — "))}`; break;
      case "scope_amended": if (ev.actor === SHOP_ACTOR.drive) line = `*${ev.actor}* · ${short(ev.text.replace(/\n/g, " "), 400)}`; break;
      case "clarify_sent": line = `*Driver's agent* · ${short(ev.text)}`; break;
      case "clarification_answered": line = `*${ev.actor}* · ${short(ev.text.replace(/\n/g, " — "))}`; break;
      case "ask_sent": line = `*Driver's agent* · ${short(ev.text)}`; break;
      case "exception_requested": if (ev.actor === SHOP_ACTOR.drive) line = `*${ev.actor}* · Beyond its authority — asking the owner.`; break;
      case "owner_decision": line = `*${ev.actor}* · ${short(ev.text)}`; break;
      case "ranking_ready": line = `*Driver's agent* · ${short(ev.text.replace(/\n/g, "  "), 500)}`; break;
      case "booked": line = `:white_check_mark: ${short(ev.text)}`; break;
      case "system_note": if (req.mode === "insurance" && /Incentives/.test(ev.text)) line = `_${ev.text}_`; break;
    }
    if (line) await this.post(this.deal, line.replace(/[*_]/g, "").replace(/:[a-z_]+:/g, "").trim(), [{ type: "section", text: { type: "mrkdwn", text: line } }]);
  }
}
