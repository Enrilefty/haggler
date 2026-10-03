// Offline end-to-end check of the scripted flow and the authority rules (no ZooWork, Slack or BAND).
// Run: node --experimental-strip-types scripts/check-flow.ts
import { Orchestrator, type Approval, type Request } from "../src/orchestrator.ts";
import { Flow } from "../src/flow.ts";

let failed = 0;
const ok = (cond: unknown, msg: string) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) failed++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 20_000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(50); } return false; }

const o = new Orchestrator();
const flow = new Flow(o, undefined);
const buyer = (r: Request) => ({ requestId: r.id, role: "buyer" as const, via: "scripted" as const });
const shop = (r: Request, shopId: string) => ({ requestId: r.id, role: "shop" as const, shopId, via: "scripted" as const });

// ---------- self-pay: owner counters from "Slack" ----------
{
  const approvals: Approval[] = [];
  const onAp = (ap: Approval) => approvals.push(ap);
  o.on("approval", onAp);
  const r = o.createRequest("case-accord", "self_pay", "best_value", "scripted");
  ok(o.listeners("deliver").length === 1, "one deliver listener");
  const done = flow.run(r);
  ok(await until(() => approvals.length === 1), "self-pay: exactly one owner approval opened");
  const ap = approvals[0];
  const base = o.latest(r, "drive")!;
  ok(ap.requested.total === r.asks[0].target.total, "approval amount is bound to the driver's ask");
  ok(o.confirm(r.id, base.id, base.version).error === "offers_not_final_yet", "confirm blocked while negotiating");
  const dup: any = o.tool_request_exception(shop(r, "drive"), { total: 1, reason: "again" });
  ok(dup instanceof Promise && Object.keys(o.approvals).filter((k) => o.approvals[k].askId === ap.askId).length === 1, "second request_exception reuses the same approval");
  ok((o.decide(ap.id, "counter", { total: base.price!.total + 50 }, "slack") as any).error?.startsWith("counter_must_be_between"), "counter above the current offer is rejected");
  ok((o.decide(ap.id, "counter", { total: ap.requested.total! - 10 }, "slack") as any).error?.startsWith("counter_must_be_between"), "counter below the ask is rejected");
  ok(ap.status === "pending", "approval stays pending after a bad counter");
  const counterAmt = Math.round((ap.requested.total! + ap.agentLimit.total!) / 2);
  const res: any = o.decide(ap.id, "counter", { total: counterAmt, extra: "275 + pickup" }, "slack");
  ok(res.ok && ap.status === "countered", "valid counter applied");
  const after = o.latest(r, "drive")!;
  ok(after.price!.total === counterAmt, "Drive's offer now shows the counter");
  ok(after.slot === base.slot && (after.incentives ?? []).some((i) => i.kind === "pickup"), "'+ pickup' adds pickup and keeps the drop-off slot");
  ok((o.decide(ap.id, "approve", undefined, "slack") as any).error === "already_countered", "approval is single-use");
  await done;
  ok(r.status === "ready_for_confirmation", "self-pay reaches ready_for_confirmation");
  ok(approvals.length === 1, "no second approval after the owner decided (blocker #1)");
  ok(r.priority === "best_value", "priority unchanged by ranking");
  const readyEv = o.feed(r.id).find((e) => e.type === "ready");
  ok(!!readyEv && /Top pick/.test(readyEv.text), "summary built server-side: " + readyEv?.text.slice(0, 90));
  ok(o.tool_ask_shop(buyer(r), { shopId: "shop-b", total: 100, message: "x" }).error === "negotiation_closed", "no asks after offers are final");
  const top = r.ranking!.find((x) => x.recommended) ?? r.ranking![0];
  const pick = o.latest(r, top.shopId)!;
  ok(o.confirm(r.id, pick.id, pick.version).ok === true, `booked ${top.shopId}`);
  ok(o.confirm(r.id, pick.id, pick.version).error === "already_booked", "double confirm blocked");
  ok(o.safeAgentText(r.id, `Best is $${pick.price!.total}.`) !== "", "agent text with a real price passes");
  ok(o.safeAgentText(r.id, "Best is $1,234,567.") === "", "agent text with an invented price is dropped");
  o.off("approval", onAp);
}

// ---------- insurance: owner approves deductible help ----------
{
  const approvals: Approval[] = [];
  const onAp = (ap: Approval) => approvals.push(ap);
  o.on("approval", onAp);
  const r = o.createRequest("case-elantra", "insurance", "best_incentives", "scripted");
  const done = flow.run(r);
  ok(await until(() => approvals.length >= 1), "insurance: owner approval opened");
  const ap = approvals[0];
  ok(ap.requested.deductibleAssist! > ap.agentLimit.deductibleCap!, `asks $${ap.requested.deductibleAssist} over the $${ap.agentLimit.deductibleCap} cap`);
  ok((o.decide(ap.id, "approve", undefined, "slack") as any).ok, "owner approves");
  await done;
  const d = o.latest(r, "drive")!;
  ok((d.incentives ?? []).some((i) => i.kind === "deductible_assist" && i.value === ap.requested.deductibleAssist), "Drive's offer carries the approved deductible help");
  ok(r.status === "ready_for_confirmation", "insurance reaches ready_for_confirmation");
  ok(o.safeAgentText(r.id, "Your out-of-pocket will be $0.") === "", "insurance out-of-pocket claim dropped");
  ok(approvals.length === 1, "insurance: one approval only");
  o.off("approval", onAp);
}

// ---------- agent concedes part-way, then escalates: the owner must still be asked ----------
for (const mode of ["self_pay", "insurance"] as const) {
  const r = o.createRequest(mode === "self_pay" ? "case-accord" : "case-elantra", mode, "best_value", "zoowork");
  for (const s of r.shops) o.tool_review_and_quote(shop(r, s));
  const d = o.latest(r, "drive")!, lim: any = o.limits(r, "drive");
  const target = mode === "self_pay" ? { total: lim.autonomousLimit - 300 } : { deductibleAssist: lim.deductibleCap + 100 };
  o.removeAllListeners("deliver"); // drive the shop tools by hand, like a live agent would
  o.tool_ask_shop(buyer(r), { shopId: "drive", ...target, message: "ask" });
  const noop: any = o.tool_revise_offer(shop(r, "drive"), mode === "self_pay" ? { total: d.price!.total } : { deductibleAssist: lim.deductibleCap });
  ok(!!noop.error, `${mode}: a no-op revision is rejected (${noop.error})`);
  if (mode === "self_pay") {
    const part: any = o.tool_revise_offer(shop(r, "drive"), { total: lim.autonomousLimit });
    ok(part.ok && part.askStillOpen, "self_pay: partial revision leaves the ask open");
  }
  let opened = 0; const onAp = () => opened++; o.on("approval", onAp);
  const pending = o.tool_request_exception(shop(r, "drive"), { reason: "rest of the way" });
  ok(opened === 1, `${mode}: owner approval still opens after the agent's own move`);
  const ap = Object.values(o.approvals).find((a) => a.requestId === r.id)!;
  o.decide(ap.id, "deny", undefined, "slack"); await pending;
  ok((o.tool_revise_offer(shop(r, "drive"), mode === "self_pay" ? { total: lim.autonomousLimit } : { deductibleAssist: 1 }) as any).error === "owner_already_decided", `${mode}: agent can't revise after the owner decided`);
  o.off("approval", onAp); o.on("deliver", (x: any) => void (flow as any).onDeliver(x));
}

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
