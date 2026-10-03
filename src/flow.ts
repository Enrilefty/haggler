// Phase driver. Each step asks the real ZooWork agent first; if ZooWork isn't configured or a
// turn fails/times out, the step runs through the same server-side tools as a labeled fallback.
import type { Orchestrator, Request, Ctx } from "./orchestrator.ts";
import { SHOP_ACTOR } from "./orchestrator.ts";
import type { ZooWorkRuntime } from "./zoowork.ts";
import * as cat from "./catalog.ts";

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
    const t0 = Date.now(); const timings: Record<string, number> = (req.timings ??= {});
    const lap = (k: string, from: number) => { timings[k] = Date.now() - from; };
    try {
      if (this.o.cases[req.caseId].dynamic) {
        this.o.setPhase(req, "inspecting");
        let t = Date.now();
        const ok = await this.buyerInspect(req); lap("inspectMs", t);
        if (!ok) return;
        this.o.setPhase(req, "quoting");
        t = Date.now();
        await Promise.all(req.shops.map((s) => this.shopAssess(req, s).then(() => lap(`quote_${s}_Ms`, t))));
        lap("quotesMs", t);
      } else {
        this.o.setPhase(req, "quoting");
        await Promise.all(req.shops.map((s) => this.shopQuote(req, s)));
      }
      let t = Date.now();
      this.o.setPhase(req, "clarifying");
      await this.buyerClarify(req); lap("clarifyMs", t);
      t = Date.now();
      this.o.setPhase(req, "negotiating");
      await this.buyerNegotiate(req); lap("negotiateMs", t);
      t = Date.now();
      this.o.setPhase(req, "ranking");
      await this.buyerRank(req); lap("rankMs", t);
    } catch (e: any) {
      this.note(req, `Flow error: ${String(e?.message ?? e)}`);
    } finally {
      timings.totalMs = Date.now() - t0;
    }
  }

  // ----- buyer inspects the customer's photos (dynamic cases) -----
  private async buyerInspect(req: Request): Promise<boolean> {
    const c = this.o.cases[req.caseId];
    const n = c.photos.length, what = c.vehicle ? [c.vehicle.year, c.vehicle.make, c.vehicle.model].filter(Boolean).join(" ") : "car";
    if (this.useZw()) {
      await this.zw!.turn(req.id, "buyer", `New request ${req.id}: your customer uploaded ${n} photo${n === 1 ? "" : "s"} of their ${what} (${req.mode === "self_pay" ? "paying themselves" : "insurance claim"}). Call inspect_photos and look carefully at every photo. Then call post_damage_report: a one-sentence summary, vehicleGuess if you can tell (year range, make, model, color), and items with catalog id, operation, severity (minor|moderate|severe) and a short note of what you see. List only damage you can see or that is directly implied. Never price anything. Then stop.`, 150_000);
      if (req.damageReport) return true;
    }
    // Fallback: a sample's reviewed damage list, else stop gracefully.
    const base = (c.sampleBaseline ?? []).map((b: any) => ({ id: String(b?.id ?? b?.catalogId ?? ""), operation: b?.operation ?? b?.op, severity: b?.severity, note: b?.note })).filter((b: any) => cat.catalogItem(b.id));
    if (base.length) {
      this.o.tool_post_damage_report(this.ctx(req.id, "buyer"), { summary: "Damage from the sample's reviewed scope.", items: base });
      if (req.damageReport) { if (this.useZw()) this.note(req, "My photo inspection didn't finish in time — using the sample's reviewed damage list."); return true; }
    }
    req.status = "inspection_unavailable";
    this.o.log(req.id, "system_note", "Driver's agent", "AI photo inspection is unavailable right now, so I can't build a damage report from these photos. Please try again in a minute.", { inspection: "unavailable" });
    return false;
  }

  // ----- each shop assesses the photos itself (dynamic cases) -----
  private async shopAssess(req: Request, shopId: string) {
    const c = this.o.cases[req.caseId], report = req.damageReport!;
    if (this.useZw()) {
      const lines = report.items.map((i) => `- ${i.id} (${i.operation}, ${i.severity})${i.note ? `: ${i.note}` : ""}`).join("\n");
      const first = shopId === "drive" ? "First call get_gio_history with the areas and catalog ids from the report. Then call" : "Call";
      await this.zw!.turn(req.id, `shop:${shopId}`, `New ${req.mode === "self_pay" ? "self-pay (cash)" : "insurance"} repair request ${req.id}: ${c.title}. The customer's agent posted this damage report from ${c.photos.length} photos:\n${report.summary}\n${lines}\n\n${first} inspect_photos and look at the photos yourself. Build your own scope in your shop's style and post it with submit_assessment (catalog id, operation, a short reason per line; add what the report missed, leave out what you disagree with). Never type prices.`, 200_000);
      if (this.o.latest(req, shopId)) return;
      this.note(req, `${SHOP_ACTOR[shopId]}'s agent didn't finish its photo review in time — using the shop's configured rules.`);
    }
    await this.fallbackAssess(req, shopId);
  }
  // Rule-based scope per shop style (contract fallbacks). Never throws; worst case posts the report as-is.
  private async fallbackAssess(req: Request, shopId: string) {
    const report = req.damageReport!;
    const sev = (id: string) => report.items.find((r) => r.id === id)?.severity;
    const items: { id: string; operation: string; reason: string; partType?: string }[] = report.items.map((i) => ({ id: i.id, operation: i.operation, reason: i.note || "Seen in the customer's photos." }));
    const areas = [...new Set(report.items.map((i) => cat.catalogItem(i.id)?.area).filter((a): a is string => !!a && a !== "all"))];
    const add = (id: string, op: string | undefined, reason: string) => {
      const ci = cat.catalogItem(id); if (!ci || items.some((x) => x.id === ci.id)) return;
      items.push({ id: ci.id, operation: (op && cat.normalizeOp(ci, op)) || cat.defaultOp(ci), reason });
    };
    const hidden = (n: number) => cat.catalog().items.filter((ci) => ci.kind === "hidden" && areas.includes(ci.area)).slice(0, n);
    const scans = cat.catalog().items.filter((ci) => ci.kind === "procedure" && /scan/i.test(ci.id));
    const toRepair = (pred: (id: string) => boolean, reason: string) => { for (const it of items) { const ci = cat.catalogItem(it.id); if (ci && it.operation === "replace" && ci.ops?.repair && pred(it.id)) { it.operation = "repair"; it.reason = reason; } } };
    let notes = "";
    if (shopId === "drive") {
      const h: any = await this.o.gioHistory(req, {});
      if (req.mode === "insurance") {
        const adds = (h?.playbook?.adds ?? []).filter((a: any) => a.rate >= 0.5).slice(0, 6);
        for (const a of adds) add(a.catalogId, undefined, a.why || `Gio adds this on ${Math.round(a.rate * 100)}% of similar jobs.`);
        if (!adds.length) { for (const ci of hidden(3)) add(ci.id, "replace", "Usually damaged behind an impact like this; confirmed at teardown."); for (const ci of scans) add(ci.id, undefined, "Scans confirm the safety systems after the hit."); }
        notes = "Complete insurance scope, written the way Gio writes similar jobs.";
      } else {
        // Cheapest sound fix: repair vs replace with a used/aftermarket part, whichever costs less
        // (severe damage is never "repaired" to save money). Gio's repair habits break near-ties.
        const repairs = new Map<string, number>((h?.playbook?.repairs ?? []).map((r: any) => [r.catalogId, r.rate]));
        for (const it of items) {
          const ci = cat.catalogItem(it.id); if (!ci) continue;
          const partOf = () => (["used", "aftermarket"] as const).filter((k) => ci.parts?.[k]).map((k) => ({ k, p: this.o.itemPrice(req, "drive", ci, "replace", k) })).sort((a, b) => a.p - b.p)[0];
          if (ci.ops?.repair && ci.ops?.replace) {
            const rep = this.o.itemPrice(req, "drive", ci, "repair"), best = partOf();
            const favorRepair = (repairs.get(ci.id) ?? 0) >= 0.5 ? 1.1 : 1;
            if (best && (sev(ci.id) === "severe" || best.p * favorRepair < rep)) { it.operation = "replace"; it.partType = best.k; it.reason = sev(ci.id) === "severe" ? `Too damaged to repair; ${best.k} part keeps it cheap.` : `A ${best.k} part costs less than repairing it.`; }
            else { it.operation = "repair"; it.reason = repairs.get(ci.id) ? `Repairable — cheaper than a new part (Gio repairs this on cash jobs).` : "Repairable — cheaper than a new part."; }
          } else if (it.operation === "replace") { const best = partOf(); if (best) it.partType = best.k; }
        }
        notes = "Cheapest sound fix: repair or a used/aftermarket part, whichever costs less.";
      }
    } else if (shopId === "shop-b") {
      for (const ci of hidden(3)) add(ci.id, "replace", "OEM repair procedures call for the parts behind the impact.");
      for (const ci of scans) add(ci.id, undefined, "Pre- and post-repair scans per OEM procedures.");
      for (const it of items) { const ci = cat.catalogItem(it.id); if (ci && it.operation === "repair" && ci.ops?.replace) { it.operation = "replace"; it.reason = "New OEM part instead of repairing."; } }
      notes = "OEM parts only, factory repair procedures.";
    } else {
      toRepair((id) => sev(id) !== "severe", "Quick repair instead of a new part.");
      notes = "Fast, minimal repair with aftermarket parts.";
    }
    const ctx = this.ctx(req.id, "shop", shopId);
    const r: any = this.o.tool_submit_assessment(ctx, { items, notes });
    if (r?.error && !this.o.latest(req, shopId)) this.o.tool_submit_assessment(ctx, { items: report.items.map((i) => ({ id: i.id, operation: i.operation, reason: "Seen in the customer's photos." })), notes });
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
        const dyn = !!this.o.cases[req.caseId].dynamic;
        await this.zw!.turn(req.id, `shop:${d.shopId}`, `The driver's agent asks you to clarify item "${d.clarification.itemId}" (clarificationId: ${d.clarification.id}): ${d.clarification.question}\nAnswer with respond_clarification${dyn ? ` and decide: decision "add" (include it; the server prices it) or "dispute" (you don't think it's needed from the photos). Decide the way your shop would, with a one-line message` : ""}.`, 60_000);
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
    const dyn = !!this.o.cases[req.caseId].dynamic;
    let flagged: { shopId: string; itemId: string }[] = (view.comparison ?? []).flatMap((c: any) => Object.entries(c.statuses).filter(([, s]) => s === "missing_required" || s === "recommended_elsewhere").map(([itemId]) => ({ shopId: c.shopId, itemId })));
    if (dyn) {
      // Report items first, then hidden parts, visible parts, scans/calibrations; never materials lines.
      const rankOf = (id: string) => { if (req.baselineIds.includes(id)) return 0; const k = cat.catalogItem(id)?.kind; return k === "hidden" ? 1 : k === "visible" ? 2 : k === "procedure" ? 3 : 9; };
      flagged = flagged.filter((f) => rankOf(f.itemId) < 9).sort((a, b) => rankOf(a.itemId) - rankOf(b.itemId));
    }
    if (!flagged.length) return;
    if (this.useZw()) {
      const ask = dyn
        ? "Call clarify_item for every item marked missing_required (it's in your damage report). For recommended_elsewhere items ask each shop about at most 3 that matter most (hidden parts first, then scans/calibrations; never materials lines like tint, cover car or hazardous waste). Then stop."
        : "Call clarify_item once for each item marked missing_required or recommended_elsewhere, then stop.";
      await this.zw!.turn(req.id, "buyer", `Offers are in for ${req.id}. Here is get_offers output:\n${JSON.stringify(view).slice(0, 6000)}\n${ask}`, 90_000);
    }
    for (const f of flagged) {
      if (!req.clarifications.some((c) => c.shopId === f.shopId && c.itemId === f.itemId)) {
        const label = this.o.labelOf(req, f.itemId);
        const missing = req.baselineIds.includes(f.itemId);
        this.o.tool_clarify_item(this.ctx(req.id, "buyer"), { shopId: f.shopId, itemId: f.itemId, question: missing ? `The photos show damage to the ${label.toLowerCase()}, and your offer leaves it out. Does your offer need it?` : `Another shop recommends "${label}". Does your offer need it?` });
      }
    }
    // wait for all answers in parallel; anything still open gets the shop's configured rule
    await Promise.all(req.clarifications.filter((c) => c.status === "open").map((c) => this.o.waitFor(`clar:${c.id}`, 75_000)));
    const late = req.clarifications.filter((c) => c.status === "open");
    // Photo cases: the shop's standing rule answers (worded as such); one note instead of one per item.
    if (dyn && late.length && this.useZw()) this.note(req, `${[...new Set(late.map((c) => SHOP_ACTOR[c.shopId]))].join(" and ")} didn't answer every question in time; the shop's standing rules answered the rest.`);
    for (const c of late) {
      if (c.status === "open") this.o.tool_respond_clarification(this.ctx(req.id, "shop", c.shopId), dyn ? { clarificationId: c.id } : { clarificationId: c.id, message: "No answer from the shop's agent in time — using its configured rules." });
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
