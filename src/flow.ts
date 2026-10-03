// Phase driver. Each step asks the real ZooWork agent first; if ZooWork isn't configured or a
// turn fails/times out, the step runs through the same server-side tools as a labeled fallback.
import type { Orchestrator, Request, Ctx } from "./orchestrator.ts";
import { SHOP_ACTOR } from "./orchestrator.ts";
import type { ZooWorkRuntime } from "./zoowork.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const assistOf = (o: any) => (o?.incentives ?? []).find((i: any) => i.kind === "deductible_assist")?.value ?? 0;

export class Flow {
  private o: Orchestrator; private zw?: ZooWorkRuntime;
  constructor(o: Orchestrator, zw?: ZooWorkRuntime) {
    this.o = o; this.zw = zw;
    // Route clarification/ask deliveries to the shop's agent (or fallback).
    o.on("deliver", (d: any) => { void this.onDeliver(d); });
  }
  private useZw() { return !!this.zw?.ready; }
  private ctx(requestId: string, role: "buyer" | "shop", shopId?: string): Ctx { return { requestId, role, shopId, via: "scripted" }; }
  private note(req: Request, text: string) { this.o.log(req.id, "system_note", "Quote Room", text); }

  async run(req: Request) {
    try {
      await Promise.all(req.shops.map((s) => this.shopQuote(req, s)));
      await this.buyerClarify(req);
      await this.buyerNegotiate(req);
      await this.buyerRank(req);
    } catch (e: any) {
      this.note(req, `Flow error: ${String(e?.message ?? e)}`);
    }
  }

  // ----- shops quote -----
  private async shopQuote(req: Request, shopId: string) {
    const key = `quote:${req.id}:${shopId}`;
    if (this.useZw()) {
      const waiting = this.o.waitFor(key, 75_000);
      const c = this.o.cases[req.caseId];
      const r = await this.zw!.turn(req.id, `shop:${shopId}`, `New ${req.mode === "self_pay" ? "self-pay" : "insurance"} repair request ${req.id} in the Quote Room: ${c.title}. Review the proposed scope and post your offer with review_and_quote.`, 75_000);
      const offer = await Promise.race([waiting, sleep(r.ok ? 3000 : 0).then(() => this.o.latest(req, shopId))]);
      if (offer || this.o.latest(req, shopId)) return;
      this.note(req, `${SHOP_ACTOR[shopId]}'s agent didn't answer in time — using its configured rules (fallback).`);
    }
    this.o.tool_review_and_quote(this.ctx(req.id, "shop", shopId));
  }

  // ----- clarification and ask deliveries -----
  private async onDeliver(d: any) {
    const req = this.o.requests[d.requestId]; if (!req) return;
    if (d.kind === "clarify") {
      if (this.useZw()) {
        await this.zw!.turn(req.id, `shop:${d.shopId}`, `The driver's agent asks you to clarify item "${d.clarification.itemId}" (clarificationId: ${d.clarification.id}): ${d.clarification.question}\nAnswer with respond_clarification.`, 60_000);
      }
      if (d.clarification.status === "open") this.o.tool_respond_clarification(this.ctx(req.id, "shop", d.shopId), { clarificationId: d.clarification.id });
    }
    if (d.kind === "ask") {
      const lim = d.limits ?? {};
      if (this.useZw()) {
        const t = req.mode === "self_pay"
          ? `The driver's agent asks: "${d.ask.text}" (target total $${d.ask.target.total}). Your autonomous limit is $${lim.autonomousLimit}. If the target is at or above it, use revise_offer; otherwise call request_exception with a one-line reason and wait for the owner.`
          : `The driver's agent asks: "${d.ask.text}" (target $${d.ask.target.deductibleAssist} toward the deductible). Your cap for this job size is $${lim.deductibleCap}. Within the cap use revise_offer; above it call request_exception and wait for the owner.`;
        await this.zw!.turn(req.id, `shop:${d.shopId}`, t, 200_000);
        // Handled if the agent revised, or opened an approval (even if the turn itself was cut off:
        // the pending approval still resolves on its own). Never open a second approval.
        if (this.askHandled(req, d.ask.id)) return;
      }
      await this.scriptedAnswerAsk(req, d.shopId, d.ask, lim);
    }
  }
  private askHandled(req: Request, askId: string) {
    return !!req.asks.find((a) => a.id === askId)?.outcome || this.o.hasApprovalForAsk(askId);
  }
  private async scriptedAnswerAsk(req: Request, shopId: string, ask: any, lim: any) {
    if (this.askHandled(req, ask.id)) return;
    const ctx = this.ctx(req.id, "shop", shopId);
    let r: any;
    if (req.mode === "self_pay") {
      if (ask.target.total >= lim.autonomousLimit) r = this.o.tool_revise_offer(ctx, { total: ask.target.total, message: "We can do that." });
      else r = await this.o.tool_request_exception(ctx, { reason: `Driver asks $${ask.target.total}; competing offer cited in the room.` });
    } else {
      if (ask.target.deductibleAssist <= lim.deductibleCap) r = this.o.tool_revise_offer(ctx, { deductibleAssist: ask.target.deductibleAssist, message: "We can do that." });
      else r = await this.o.tool_request_exception(ctx, { reason: `Driver asks $${ask.target.deductibleAssist} toward the deductible.` });
    }
    if (r?.error && !this.askHandled(req, ask.id)) {
      this.o.log(req.id, "owner_decision", SHOP_ACTOR[shopId], "We'll hold our current offer.");
      this.o.askAnswered(req, shopId, "held");
    }
  }

  // ----- buyer clarifies -----
  private async buyerClarify(req: Request) {
    const view: any = this.o.tool_get_offers(this.ctx(req.id, "buyer"));
    const flagged = (view.comparison ?? []).flatMap((c: any) => Object.entries(c.statuses).filter(([, s]) => s === "missing_required" || s === "recommended_elsewhere").map(([itemId]) => ({ shopId: c.shopId, itemId })));
    if (!flagged.length) return;
    if (this.useZw()) {
      await this.zw!.turn(req.id, "buyer", `Offers are in for ${req.id}. Here is get_offers output:\n${JSON.stringify(view).slice(0, 6000)}\nCall clarify_item once for each item marked missing_required or recommended_elsewhere, then stop.`, 90_000);
    }
    for (const f of flagged) {
      if (!req.clarifications.some((c) => c.shopId === f.shopId && c.itemId === f.itemId)) {
        const label = this.o.cases[req.caseId].amendments?.drive?.find((a: any) => a.item.id === f.itemId)?.item.label ?? f.itemId;
        this.o.tool_clarify_item(this.ctx(req.id, "buyer"), { shopId: f.shopId, itemId: f.itemId, question: `Another shop recommends "${label}". Does your offer need it?` });
      }
    }
    // wait for all answers in parallel; anything still open gets the shop's configured rule
    await Promise.all(req.clarifications.filter((c) => c.status === "open").map((c) => this.o.waitFor(`clar:${c.id}`, 75_000)));
    for (const c of req.clarifications) {
      if (c.status === "open") this.o.tool_respond_clarification(this.ctx(req.id, "shop", c.shopId), { clarificationId: c.id, message: "No answer from the shop's agent in time — using its configured rules." });
    }
  }

  // ----- buyer negotiates (exactly one ask) -----
  private async buyerNegotiate(req: Request) {
    const offers = this.o.latestOffers(req);
    const drive = offers.find((o) => o.shopId === "drive"); if (!drive) return;
    let target: any;
    if (req.mode === "self_pay") {
      const others = offers.filter((o) => o.shopId !== "drive").map((o) => o.price!.total);
      const cheapest = Math.min(...others);
      if (cheapest >= drive.price!.total) target = { total: Math.round(drive.price!.total * 0.98 / 10) * 10, message: `You're already the lowest. Any room on $${drive.price!.total}?` };
      else { const mid = Math.floor((drive.price!.total + cheapest) / 2 / 10) * 10; target = { total: mid, message: `Your scope is the most complete, but another posted offer is $${cheapest}. Can you do $${mid}?` }; }
    } else {
      const cap = (this.o.limits(req, "drive").deductibleCap as number) ?? 0;
      const cur = assistOf(drive);
      const best = Math.max(...offers.filter((o) => o.shopId !== "drive").map((o) => (o.incentives ?? []).reduce((s, i) => s + i.value, 0)), 0);
      const want = Math.max(cap, cur) + 100;
      target = { deductibleAssist: want, message: `You're at $${cur} toward the deductible and another shop's incentives add up to $${best}. Can you do $${want} toward the deductible?` };
    }
    // Wakes when ANY shop's ask is answered (revised, approved, countered, denied, expired, held).
    const waiting = this.o.waitFor(`askdone:${req.id}`, 240_000);
    if (this.useZw()) {
      await this.zw!.turn(req.id, "buyer", `Clarifications are done. Current offers:\n${JSON.stringify((this.o.tool_get_offers(this.ctx(req.id, "buyer")) as any).offers).slice(0, 5000)}\nMake exactly ONE ask_shop call. Suggested: shopId "drive", ${req.mode === "self_pay" ? `total ${target.total}` : `deductibleAssist ${target.deductibleAssist}`}, message: "${target.message}"`, 60_000);
    }
    if (!req.asks.length) {
      const r: any = this.o.tool_ask_shop(this.ctx(req.id, "buyer"), { shopId: "drive", ...target });
      if (r?.error) return;
    }
    if (req.asks[0]?.outcome) return;
    await waiting;
  }

  // ----- buyer ranks and presents -----
  private async buyerRank(req: Request) {
    req.ranking = undefined; // always rank the final offers
    req.negotiationDone = true;
    if (this.useZw()) {
      await this.zw!.turn(req.id, "buyer", `Negotiation is finished. Call rank_offers, then present_for_confirmation. Do not book. Reply with one short sentence that quotes only the currentOffers numbers rank_offers returned.`, 60_000);
    }
    if (!req.ranking) this.o.tool_rank_offers(this.ctx(req.id, "buyer"), {});
    if (req.status !== "ready_for_confirmation" && !req.booking) this.o.tool_present_for_confirmation(this.ctx(req.id, "buyer"), {});
  }
}
