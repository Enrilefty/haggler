// Owner notifications + Approve / Counter / Deny over a dedicated Telegram bot (long polling, no webhook).
// Only the allowlisted owner chat can act. Never reuse the Hermes bot token.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env, STATE_DIR } from "./config.ts";
import type { Orchestrator, Approval, Request, Offer } from "./orchestrator.ts";
import { SHOP_ACTOR } from "./orchestrator.ts";

const money = (n?: number) => (n == null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`);

export class TelegramOwner {
  private token = env("TELEGRAM_BOT_TOKEN");
  private api = `https://api.telegram.org/bot${this.token}`;
  private offset = 0;
  private stateFile = join(STATE_DIR, "telegram.json");
  ownerChatId = env("OWNER_TELEGRAM_CHAT_ID");
  botName = "";
  status = "off";
  private pendingCounter = new Map<string, string>(); // chatId -> approvalId
  private approvalMsg = new Map<string, number>();     // approvalId -> message_id

  private o: Orchestrator;
  constructor(o: Orchestrator) {
    this.o = o;
    if (!this.ownerChatId && existsSync(this.stateFile)) this.ownerChatId = JSON.parse(readFileSync(this.stateFile, "utf8")).ownerChatId ?? "";
  }
  private async call(method: string, body: unknown) {
    const r = await fetch(`${this.api}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j: any = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`telegram ${method}: ${j.description ?? r.status}`);
    return j.result;
  }
  async start() {
    if (!this.token) return;
    try {
      const me = await this.call("getMe", {}); this.botName = me.username; this.status = this.ownerChatId ? "ready" : "waiting for owner to message the bot";
    } catch (e: any) { this.status = `error: ${e.message}`; return; }
    this.o.on("approval", (ap: Approval, req: Request, base: Offer) => { void this.sendApproval(ap, req, base); });
    this.o.on("decided", (ap: Approval) => { void this.markDecided(ap); });
    this.o.on("booked", (req: Request, offer: Offer) => { void this.sendOutcome(req, offer); });
    this.o.on("room", (ev: any) => {
      if (ev.type === "offer_posted" && ev.actor === SHOP_ACTOR.drive && ev.payload?.version === 1) {
        const req = this.o.requests[ev.requestId]; const c = this.o.cases[req.caseId];
        void this.send(`🔔 New quote request · ${c.title} · ${req.mode === "self_pay" ? "Self-pay" : "Insurance"}\nYour agent offered: ${this.o.describeOffer(ev.payload)}`);
      }
    });
    void this.poll();
  }
  async send(text: string, extra: Record<string, unknown> = {}) {
    if (!this.ownerChatId) return undefined;
    try { return await this.call("sendMessage", { chat_id: this.ownerChatId, text, ...extra }); } catch (e: any) { this.status = `error: ${e.message}`; return undefined; }
  }
  private async sendApproval(ap: Approval, req: Request, base: Offer) {
    const others = this.o.latestOffers(req).filter((x) => x.shopId !== ap.shopId).map((x) => `${SHOP_ACTOR[x.shopId]}: ${req.mode === "self_pay" ? money(x.price?.total) : (x.incentives ?? []).map((i) => i.label).join(" + ") || "no incentives"}`).join("\n");
    const text = req.mode === "self_pay"
      ? `Approval needed · ${req.id}\nDriver asks ${money(ap.requested.total)}. Your agent can go to ${money(ap.agentLimit.total)} on its own.\nCurrent offer: ${money(base.price?.total)}\nCompeting:\n${others}`
      : `Approval needed · ${req.id} · Insurance\nDriver asks ${money(ap.requested.deductibleAssist)} toward the deductible on a ~${money(base.jobSize)} job. Your agent can offer ${money(ap.agentLimit.deductibleCap)} on its own.\nCompeting:\n${others}`;
    const label = req.mode === "self_pay" ? `Approve ${money(ap.requested.total)}` : `Approve ${money(ap.requested.deductibleAssist)}`;
    const msg = await this.send(text, { reply_markup: { inline_keyboard: [[{ text: label, callback_data: `ap:${ap.id}:approve` }], [{ text: "Counter", callback_data: `ap:${ap.id}:counter` }, { text: "Deny", callback_data: `ap:${ap.id}:deny` }]] } });
    if (msg) this.approvalMsg.set(ap.id, msg.message_id);
  }
  private async markDecided(ap: Approval) {
    const mid = this.approvalMsg.get(ap.id); if (!mid || !this.ownerChatId) return;
    const what = ap.status === "countered" ? `Countered: ${ap.counter?.total ? money(ap.counter.total) : money(ap.counter?.deductibleAssist)}${ap.counter?.extra ? ` · ${ap.counter.extra}` : ""}` : ap.status;
    await this.call("editMessageReplyMarkup", { chat_id: this.ownerChatId, message_id: mid, reply_markup: { inline_keyboard: [[{ text: `✔ ${what}`, callback_data: "noop" }]] } }).catch(() => undefined);
  }
  private async sendOutcome(req: Request, offer: Offer) {
    const c = this.o.cases[req.caseId];
    if (offer.shopId === "drive") await this.send(`✅ You won · ${c.title}\n${this.o.describeOffer(offer)}\n(simulated booking)`);
    else if (req.shops.includes("drive")) await this.send(`Lost · driver chose ${SHOP_ACTOR[offer.shopId]} (${req.priority.replace("_", " ")}).`);
  }
  private async poll() {
    for (;;) {
      try {
        const updates: any[] = await this.call("getUpdates", { offset: this.offset, timeout: 25, allowed_updates: ["message", "callback_query"] });
        for (const u of updates) { this.offset = u.update_id + 1; await this.handle(u); }
      } catch (e: any) { this.status = `error: ${e.message}`; await new Promise((r) => setTimeout(r, 3000)); }
    }
  }
  private async handle(u: any) {
    const chatId = String(u.message?.chat?.id ?? u.callback_query?.message?.chat?.id ?? "");
    if (!this.ownerChatId && u.message) {
      // First person to message the new bot becomes the owner chat (setup step).
      this.ownerChatId = chatId; writeFileSync(this.stateFile, JSON.stringify({ ownerChatId: chatId })); this.status = "ready";
      await this.send("Quote Room owner alerts are connected. Approvals for Drive Auto Body will arrive here.");
      return;
    }
    if (chatId !== this.ownerChatId) return; // allowlist
    if (u.callback_query) {
      const [, apId, action] = String(u.callback_query.data ?? "").split(":");
      await this.call("answerCallbackQuery", { callback_query_id: u.callback_query.id }).catch(() => undefined);
      if (!apId) return;
      if (action === "counter") {
        this.pendingCounter.set(chatId, apId);
        const ap = this.o.approvals[apId]; const req = ap && this.o.requests[ap.requestId];
        await this.send(req?.mode === "insurance" ? "Reply with your counter toward the deductible, e.g. 275 or 275 + pickup" : "Reply with your counter, e.g. 2600 or 2600 Thu 9AM", { reply_markup: { force_reply: true } });
        return;
      }
      const r: any = this.o.decide(apId, action === "approve" ? "approve" : "deny", undefined, "telegram");
      if (r.error) await this.send(`Couldn't apply that: ${r.error}`);
      return;
    }
    const text = String(u.message?.text ?? "").trim();
    const apId = this.pendingCounter.get(chatId);
    if (apId && text) {
      const m = text.match(/(\d[\d,]*)(?:\s*\+?\s*(.*))?/);
      if (!m) { await this.send("Send a number, e.g. 2600"); return; }
      const amount = Number(m[1].replace(/,/g, "")); const extra = (m[2] ?? "").trim() || undefined;
      const ap = this.o.approvals[apId]; const req = this.o.requests[ap.requestId];
      const r: any = this.o.decide(apId, "counter", req.mode === "self_pay" ? { total: amount, extra } : { deductibleAssist: amount, extra }, "telegram");
      this.pendingCounter.delete(chatId);
      if (r.error) await this.send(`Couldn't apply that: ${r.error}`);
    }
  }
}
