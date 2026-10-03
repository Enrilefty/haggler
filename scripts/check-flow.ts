// Offline end-to-end check of the scripted flow and the authority rules (no ZooWork, Slack or BAND).
// Run: node --experimental-strip-types scripts/check-flow.ts
import { readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Orchestrator, type Approval, type Request, decodeImageDataUrl, UPLOAD_DIR, PHOTOS_DIR, UPLOAD_LIMITS, listSamples, CLARIFY_EXTRAS_PER_SHOP, SHOP_OWNER, sha256 } from "../src/orchestrator.ts";
import { Flow } from "../src/flow.ts";
import { SlackOwner } from "../src/slack.ts";
import * as cat from "../src/catalog.ts";
import { rank, type RankInput } from "../src/engines.ts";

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
  ok(ap.requested.total === r.asks.find((a) => a.id === ap.askId)?.target.total && r.asks.find((a) => a.id === ap.askId)?.shopId === "drive", "approval amount is bound to Drive's own ask");
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
  ok(r.asks.length === r.shops.length && new Set(r.asks.map((a) => a.shopId)).size === r.shops.length && r.asks.every((a) => a.outcome), `best-and-final: one ask per shop, all answered (${r.asks.map((a) => `${a.shopId}=${a.outcome}`).join(", ")})`);
  ok(o.feed(r.id).some((e) => e.type === "owner_decision" && e.actor === "Owner (Gio)"), "owner decision signed 'Owner (Gio)'");
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

// ---------- best-and-final: one ask per shop, three owner approvals in parallel ----------
for (const mode of ["self_pay", "insurance"] as const) {
  const o3 = new Orchestrator(); for (const s of ["drive", "shop-b", "shop-c"]) o3.ownerRooms.add(s); // every shop has an owner room
  const r = o3.createRequest(mode === "self_pay" ? "case-accord" : "case-elantra", mode, "best_value", "scripted");
  for (const s of r.shops) o3.tool_review_and_quote(shop(r, s));
  const targetFor = (s: string) => { const lim: any = o3.limits(r, s); const cur = o3.latest(r, s)!; return mode === "self_pay" ? { total: lim.autonomousLimit - 200 } : { deductibleAssist: Math.max(lim.deductibleCap, (cur.incentives ?? []).find((i) => i.kind === "deductible_assist")?.value ?? 0) + 200 }; };
  for (const s of r.shops) ok((o3.tool_ask_shop(buyer(r), { shopId: s, ...targetFor(s), message: "best and final" }) as any).ok, `${mode}: ask_shop to ${s} accepted`);
  ok((o3.tool_ask_shop(buyer(r), { shopId: "drive", ...targetFor("drive"), message: "again" }) as any).error === "one_ask_per_shop", `${mode}: a second ask to the same shop is rejected`);
  const opened: Approval[] = []; const onAp = (ap: Approval) => opened.push(ap); o3.on("approval", onAp);
  const pend = r.shops.map((s) => o3.tool_request_exception(shop(r, s), { reason: "beyond my authority" }));
  ok(opened.length === 3 && new Set(opened.map((a) => a.shopId)).size === 3 && opened.every((a) => a.status === "pending"), `${mode}: three owner approvals pending in parallel (${opened.map((a) => a.shopId).join(", ")})`);
  ok(opened.every((a) => a.askId === r.asks.find((q) => q.shopId === a.shopId)!.id), `${mode}: each approval is bound to its own shop's ask`);
  void o3.tool_request_exception(shop(r, "shop-b"), { reason: "again" });
  ok(Object.values(o3.approvals).filter((a) => a.requestId === r.id).length === 3, `${mode}: a repeat request_exception reuses the shop's approval`);
  const [apD, apB, apC] = ["drive", "shop-b", "shop-c"].map((s) => opened.find((a) => a.shopId === s)!);
  const baseB = o3.latest(r, "shop-b")!;
  const baseC = o3.latest(r, "shop-c")!;
  const counterB = mode === "self_pay" ? { total: Math.round((apB.requested.total! + baseB.price!.total) / 2) } : { deductibleAssist: apB.requested.deductibleAssist! - 25 };
  ok((o3.decide(apB.id, "counter", counterB, "slack") as any).ok && apB.status === "countered", `${mode}: Bayline's owner counters`);
  ok(!o3.allAsksDone(r), `${mode}: negotiation still waiting after one of three decisions`);
  ok((o3.decide(apD.id, "approve", undefined, "slack") as any).ok && apD.status === "approved", `${mode}: Gio approves`);
  ok(!o3.allAsksDone(r), `${mode}: still waiting after two of three decisions`);
  ok((o3.decide(apC.id, "deny", undefined, "slack") as any).ok && apC.status === "denied", `${mode}: QuickFix's owner denies`);
  ok(o3.allAsksDone(r), `${mode}: all asks answered after the third decision`);
  await Promise.all(pend);
  const v = (s: string) => { const x = o3.latest(r, s)!; return mode === "self_pay" ? x.price!.total : (x.incentives ?? []).find((i) => i.kind === "deductible_assist")?.value; };
  ok(v("drive") === (mode === "self_pay" ? apD.requested.total : apD.requested.deductibleAssist), `${mode}: Drive's offer carries the approved amount`);
  ok(v("shop-b") === (mode === "self_pay" ? counterB.total : counterB.deductibleAssist), `${mode}: Bayline's offer carries the counter`);
  ok(o3.latest(r, "shop-c")!.id === baseC.id, `${mode}: QuickFix's offer is unchanged after the deny`);
  ok((o3.decide(apD.id, "deny", undefined, "slack") as any).error === "already_approved", `${mode}: approvals stay single-use`);
  ok((o3.tool_revise_offer(shop(r, "shop-c"), mode === "self_pay" ? { total: o3.latest(r, "shop-c")!.price!.total - 1 } : { deductibleAssist: 9999 }) as any).error === "owner_already_decided", `${mode}: QuickFix's agent can't revise after its owner decided`);
  const actors = new Set(o3.feed(r.id).filter((e) => e.type === "owner_decision").map((e) => e.actor));
  ok(["drive", "shop-b", "shop-c"].every((s) => actors.has(SHOP_OWNER[s])), `${mode}: decisions signed ${[...actors].join(", ")}`);
  o3.off("approval", onAp);
}
// Flow: ranking waits for EVERY ask (owners answer at different times).
{
  const o4 = new Orchestrator(); for (const s of ["drive", "shop-b", "shop-c"]) o4.ownerRooms.add(s);
  const flow4 = new Flow(o4, undefined);
  const delays: Record<string, number> = { drive: 600, "shop-b": 150, "shop-c": 350 };
  let n = 0;
  o4.on("approval", (ap: Approval) => { n++; setTimeout(() => o4.decide(ap.id, ap.shopId === "shop-c" ? "deny" : "approve", undefined, "slack"), delays[ap.shopId]); });
  const r = o4.createRequest("case-elantra", "insurance", "best_incentives", "scripted");
  await flow4.run(r);
  const evs = o4.feed(r.id); const rankSeq = evs.find((e) => e.type === "ranking_ready")?.seq ?? 0;
  const decSeqs = evs.filter((e) => e.type === "owner_decision").map((e) => e.seq);
  ok(n === 3 && decSeqs.length === 3 && decSeqs.every((x) => x < rankSeq), `flow: three parallel approvals, ranking only after all three decisions (approvals ${n}, decisions ${decSeqs.length})`);
  ok(r.status === "ready_for_confirmation" && r.asks.every((a) => a.outcome), `flow: reaches ready_for_confirmation with every ask answered (${r.asks.map((a) => `${a.shopId}=${a.outcome}`).join(", ")})`);
  const t: any = flow4.bestAndFinalTargets(r);
  ok(Array.isArray(t) && t.length === 3, "flow: best-and-final targets computed for every shop");
}

// =====================================================================================
// v2: customer photo uploads, catalog pricing, per-shop photo assessments, Slack dry run
// =====================================================================================
const jpg = (f: string) => `data:image/jpeg;base64,${readFileSync(join(PHOTOS_DIR, f)).toString("base64")}`;
const elantra = ["elantra-front.jpg", "elantra-left-front.jpg", "elantra-left-fender.jpg", "elantra-right-front.jpg"];
const createdFiles: string[] = [];
const track = (r: any) => { for (const u of r?.photos ?? []) if (String(u).startsWith("/uploads/")) createdFiles.push(join(UPLOAD_DIR, String(u).slice(9))); return r; };

// ---------- upload validation ----------
{
  ok("error" in decodeImageDataUrl("data:text/plain;base64,aGVsbG8="), "upload: non-image data URL rejected");
  ok("error" in decodeImageDataUrl("data:image/jpeg;base64," + Buffer.alloc(500, 7).toString("base64")), "upload: jpeg label with non-image bytes rejected");
  const big = Buffer.alloc(UPLOAD_LIMITS.maxBytes + 10, 0); big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
  ok((decodeImageDataUrl("data:image/jpeg;base64," + big.toString("base64")) as any).error === "image_too_large", "upload: image over 1.6 MB rejected");
  ok(!("error" in decodeImageDataUrl(jpg(elantra[0]))), "upload: real JPEG accepted");
  const png = "data:image/png;base64," + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]).toString("base64");
  ok((decodeImageDataUrl(png) as any).ext === "png", "upload: PNG magic bytes accepted");
  ok((o.createPhotoCase(Array(9).fill(jpg(elantra[0]))) as any).error === "at_most_8_images", "upload: more than 8 images rejected");
  const before = existsSync(UPLOAD_DIR) ? readdirSync(UPLOAD_DIR).length : 0;
  const bad: any = o.createPhotoCase([jpg(elantra[0]), "data:image/gif;base64,R0lGODlh"]);
  ok(/^image 2:/.test(bad.error ?? "") && (existsSync(UPLOAD_DIR) ? readdirSync(UPLOAD_DIR).length : 0) === before, "upload: one bad image rejects the whole upload, nothing written");
  ok((o.createPhotoCase([]) as any).error === "images_required", "upload: empty list rejected");
  ok((o.createSampleCase("../../etc") as any).error === "unknown_sample", "upload: sample id traversal rejected");
  const good: any = track(o.createPhotoCase(elantra.map(jpg), { year: 2018, make: "Hyundai", model: "Elantra" }));
  ok(/^photo-[0-9a-f]{6}$/.test(good.caseId) && good.photos.length === 4 && good.photos.every((u: string) => /^\/uploads\/[0-9a-f]{24}\.jpg$/.test(u)), "upload: case created with 4 /uploads URLs");
  ok(good.photos.every((u: string) => existsSync(join(UPLOAD_DIR, u.slice(9)))), "upload: files saved under .state/uploads");
  ok(o.cases[good.caseId].dynamic === true && o.cases[good.caseId].baseline.length === 0, "upload: dynamic case with an empty baseline");
  ok(Array.isArray(good.photoHashes) && good.photoHashes.length === 4 && good.photoHashes.every((h: string, i: number) => /^[0-9a-f]{64}$/.test(h) && h === sha256(readFileSync(join(PHOTOS_DIR, elantra[i])))), "upload: SHA-256 of every image stored on the case");
  const samples = listSamples();
  if (samples.length) { const sc: any = o.createSampleCase(samples[0].id); ok(!!sc.caseId && sc.photos[0].startsWith(`/samples/${samples[0].id}/`), `upload: case from sample ${samples[0].id}`); }
  else console.log("SKIP  no data/samples yet");
}

// ---------- catalog pricing + photo tools ----------
const pickIds = () => {
  const items = cat.catalog().items;
  const a = ["front-bumper-cover", "hood"].filter((id) => cat.catalogItem(id));
  const third = items.find((i) => i.kind === "visible" && i.ops.repair && i.ops.replace && !a.includes(i.id) && i.area !== "front");
  return [...a, ...(third ? [third.id] : [])];
};
{
  const r0: any = track(o.createPhotoCase(elantra.map(jpg)));
  const r = o.createRequest(r0.caseId, "self_pay", "best_value", "scripted");
  ok(r.phase === "inspecting" && !r.damageReport, "dynamic: request starts in phase inspecting with no report");
  const insp: any = o.tool_inspect_photos(buyer(r));
  const imgs = insp.__content.filter((b: any) => b.type === "image");
  const js = insp.__content.find((b: any) => b.type === "json");
  ok(imgs.length === 4 && imgs.every((b: any) => b.source?.type === "base64" && b.source.media_type === "image/jpeg" && b.source.data.length > 1000), "inspect_photos: 4 base64 image blocks in the SDK's shape");
  ok(Array.isArray(js?.value?.catalog) && js.value.catalog.length === cat.catalog().items.length, `inspect_photos: json block lists the catalog (${cat.catalog().source}, ${cat.catalog().items.length} items)`);
  ok(o.tool_inspect_photos(shop(r, "shop-c")).__content.length === 5, "inspect_photos: shops see the same photos");
  const unk: any = o.tool_post_damage_report(buyer(r), { summary: "x", items: [{ id: "flux-capacitor", operation: "replace", severity: "severe" }] });
  ok(unk.error === "unknown_catalog_ids" && unk.validIds.includes("hood"), "post_damage_report: unknown id rejected with the valid list");
  const ids = pickIds();
  const rep: any = o.tool_post_damage_report(buyer(r), { summary: "Front hit.", items: ids.map((id) => ({ id, operation: "replace", severity: "moderate", note: "dented" })) });
  ok(rep.ok && r.baselineIds.join() === ids.join() && o.feed(r.id).some((e) => e.type === "damage_report"), "post_damage_report: report posted, baseline = report ids, damage_report event");
  ok((o.tool_submit_assessment(shop(r, "drive"), { items: [{ id: "warp-core", operation: "replace", reason: "x" }] }) as any).error === "unknown_catalog_ids", "submit_assessment: unknown id rejected");
  let threw = ""; try { o.tool_submit_assessment(buyer(r) as any, { items: [] }); } catch (e: any) { threw = String(e.message); }
  ok(/forbidden/.test(threw), "submit_assessment: the buyer's identity can't post a shop scope");
  // pricing: one bumper replace at Drive self-pay = catalog hours x rate card + aftermarket part + tax
  const ci = cat.catalogItem("front-bumper-cover")!; const op = ci.ops.replace; const rc = o.shop("drive").rateCards.self_pay;
  const partP = ci.parts!.aftermarket!; const mat = (op.refinishHours ?? 0) * rc.paintMaterialsPerRefinishHour;
  const expect = Math.round((op.bodyHours ?? 0) * rc.body + (op.refinishHours ?? 0) * rc.refinish + mat + partP + (partP + mat) * rc.taxRateOnPartsAndMaterials);
  ok(o.itemPrice(r, "drive", ci, "replace") === expect, `catalog pricing: Drive self-pay bumper replace = $${expect}`);
  const sub: any = o.tool_submit_assessment(shop(r, "shop-b"), { items: [{ id: "front-bumper-cover", operation: "replace", reason: "torn" }], notes: "OEM" });
  ok(sub.ok && o.latest(r, "shop-b")!.price!.lines[0].partType === "OEM", "catalog pricing: Bayline prices the part OEM per its parts policy");
  const sub2: any = o.tool_submit_assessment(shop(r, "shop-c"), { items: [{ id: "front-bumper-cover", operation: "replace", partType: "oem", reason: "torn" }] });
  ok(sub2.ok && o.latest(r, "shop-c")!.price!.lines[0].partType !== "OEM", "catalog pricing: QuickFix can't use OEM (not in its allow list)");
  ok(r.assessments["shop-b"]?.items[0]?.reason === "torn" && o.feed(r.id).some((e) => e.type === "assessment_posted"), "submit_assessment: assessment stored with reasons + assessment_posted event");
  const matItem = cat.catalog().items.find((i) => i.kind === "materials");
  if (matItem) ok((o.tool_clarify_item(buyer(r), { shopId: "shop-c", itemId: matItem.id, question: "?" }) as any).error === "materials_lines_are_not_clarified", "clarify_item: materials lines are not clarified on photo cases");
  for (const s of ["shop-b", "shop-c"]) { const h: any = await o.tool_get_gio_history(shop(r, s), {}); ok(/^forbidden/.test(h.error ?? ""), `get_gio_history forbidden for ${s}`); }
  const dh: any = await o.tool_get_gio_history(shop(r, "drive"), {});
  ok(!/forbidden/.test(dh.error ?? "") && (Array.isArray(dh.cashOptions) || dh.summary !== undefined), `get_gio_history works for Drive (${dh.error ?? "summary: " + String(dh.summary).slice(0, 80)})`);
  const st = o.createRequest("case-elantra", "insurance", "best_value", "scripted");
  ok(st.damageReport?.by === "sample" && st.damageReport.items.length === 6, "static Elantra: damage report from its baseline (by sample)");
  ok((o.tool_post_damage_report(buyer(st), { summary: "x", items: [] }) as any).error === "this_sample_already_has_a_reviewed_damage_report", "static Elantra: report can't be overwritten");
  ok((o.tool_submit_assessment(shop(st, "drive"), { items: [] }) as any).error === "use_review_and_quote_for_this_case", "static Elantra: still quotes through review_and_quote");
}

// ---------- dynamic case end-to-end on the scripted fallback (ZooWork disabled) ----------
for (const mode of ["self_pay", "insurance"] as const) {
  const r0: any = track(o.createPhotoCase(elantra.map(jpg), undefined, { sampleBaseline: pickIds().map((id) => ({ id, operation: "replace", severity: "moderate", note: "visible damage" })) }));
  const r = o.createRequest(r0.caseId, mode, "best_value", "scripted");
  const phases: string[] = [r.phase]; const origPhase = o.setPhase.bind(o);
  o.setPhase = (rq: Request, p: any) => { if (rq.id === r.id && phases[phases.length - 1] !== p) phases.push(p); origPhase(rq, p); };
  const onAp = (ap: Approval) => { if (ap.requestId === r.id) setTimeout(() => o.decide(ap.id, "deny", undefined, "slack"), 20); };
  o.on("approval", onAp);
  await flow.run(r);
  o.setPhase = origPhase; o.off("approval", onAp); phases.push(r.phase);
  ok(["inspecting", "quoting", "clarifying", "negotiating", "ranking", "ready"].every((p) => phases.includes(p)), `${mode} dynamic: phases ${phases.join(" > ")}`);
  ok(r.damageReport?.by === "sample" && r.damageReport.items.length >= 2, `${mode} dynamic: sample baseline became the damage report (fallback)`);
  ok(["drive", "shop-b", "shop-c"].every((s) => r.assessments[s]?.by === "fallback" && r.assessments[s].items.length > 0 && r.assessments[s].items.every((i) => i.reason)), `${mode} dynamic: all three shops posted an assessment with reasons`);
  ok(r.shops.every((s) => (o.latest(r, s)?.[mode === "self_pay" ? "price" : "jobSize"] as any) != null), `${mode} dynamic: every shop has a priced offer`);
  ok(r.assessments["shop-b"].items.filter((i) => i.partType).every((i) => i.partType === "OEM"), `${mode} dynamic: Bayline is OEM-only`);
  ok(r.assessments["shop-c"].items.filter((i) => i.partType).every((i) => i.partType !== "OEM"), `${mode} dynamic: QuickFix uses aftermarket/used`);
  ok(r.assessments["shop-b"].items.length > r.assessments["shop-c"].items.length, `${mode} dynamic: Bayline's scope is more thorough than QuickFix's (${r.assessments["shop-b"].items.length} vs ${r.assessments["shop-c"].items.length})`);
  if (mode === "insurance") ok(r.assessments.drive.items.length > r.damageReport!.items.length, `insurance dynamic: Drive adds items beyond the report (${r.assessments.drive.items.length} vs ${r.damageReport!.items.length})`);
  else ok(r.assessments.drive.items.every((i) => !i.partType || i.partType !== "OEM"), "self_pay dynamic: Drive's cash scope uses no OEM parts");
  ok(r.status === "ready_for_confirmation" && r.phase === "ready", `${mode} dynamic: reaches ready_for_confirmation (phases: ${phases.join(" > ")})`);
  ok(r.clarifications.every((c) => c.status !== "open"), `${mode} dynamic: every clarification answered (${r.clarifications.map((c) => `${c.shopId}:${c.itemId}=${c.status}`).join(", ") || "none"})`);
  ok(r.shops.every((s) => r.clarifications.filter((c) => c.shopId === s && !r.baselineIds.includes(c.itemId)).length <= CLARIFY_EXTRAS_PER_SHOP)
    && r.clarifications.every((c) => r.baselineIds.includes(c.itemId) || cat.catalogItem(c.itemId)?.kind !== "materials"), `${mode} dynamic: at most ${CLARIFY_EXTRAS_PER_SHOP} extra clarifications per shop, none about materials (${r.clarifications.length} total)`);
  ok(!o.feed(r.id).some((e) => /No answer from the shop's agent/.test(e.text)), `${mode} dynamic: rule answers are worded as standing rules, not timeouts`);
  const top = r.ranking!.find((x) => x.recommended) ?? r.ranking![0]; const pick = o.latest(r, top.shopId)!;
  ok(o.confirm(r.id, pick.id, pick.version).ok === true && r.phase === "booked", `${mode} dynamic: confirm books ${top.shopId}`);
}
{
  const r0: any = track(o.createPhotoCase([jpg(elantra[0])]));
  const r = o.createRequest(r0.caseId, "self_pay", "best_value", "scripted");
  await flow.run(r);
  ok(r.status === "inspection_unavailable" && !Object.keys(r.offers).length && o.feed(r.id).some((e) => (e.payload as any)?.inspection === "unavailable"), "dynamic without AI or sample baseline: stops gracefully with 'inspection unavailable'");
}

// ---------- Slack owner POV (dry run: nothing leaves this machine) ----------
{
  for (const k of ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_DEAL_CHANNEL_ID", "SLACK_DAD_APPROVAL_CHANNEL_ID", "SLACK_OWNER_USER_ID", "SLACK_SHOP_CHANNELS"]) process.env[k] = "";
  process.env.SLACK_DRY_RUN = "1";
  const o2 = new Orchestrator(); const flow2 = new Flow(o2, undefined); const sl = new SlackOwner(o2);
  sl.dryFile = sl.dryFile.replace(/slack-dry.jsonl$/, "slack-dry-test.jsonl"); // never clobber a running server's dry log
  o2.publicOrigin = "https://rooms.example";
  if (existsSync(sl.dryFile)) rmSync(sl.dryFile);
  await sl.start();
  ok(sl.status.startsWith("dry-run"), "slack: dry-run mode, no socket");
  ok(sl.rooms.drive === "DRY-APPROVALS" && sl.rooms["shop-b"] === "DRY-SHOP-B" && sl.rooms["shop-c"] === "DRY-SHOP-C" && ["drive", "shop-b", "shop-c"].every((s) => o2.exceptionModeOf(s) === "owner"), "slack: one owner room per shop; every shop with a room escalates to its owner");
  const tap = (apId: string, channel: string, action = "qr_approve") => sl.handleTap({ actions: [{ action_id: action, value: JSON.stringify({ apId }) }], channel: { id: channel }, user: { id: "U-ANY-MEMBER" } });
  const tapResults: Record<string, any> = {};
  o2.on("approval", (ap: Approval) => setTimeout(async () => {
    if (ap.shopId === "drive") tapResults.wrongRoom = await tap(ap.id, "DRY-SHOP-B");
    tapResults[ap.shopId] = await tap(ap.id, sl.rooms[ap.shopId], ap.shopId === "shop-c" ? "qr_deny" : "qr_approve");
  }, 50));
  tapResults.unknown = await tap("A-0000", "DRY-SHOP-C");
  tapResults.notRoom = await tap("A-0000", "C-RANDOM");
  const r0: any = track(o2.createPhotoCase(elantra.map(jpg), undefined, { sampleBaseline: pickIds().map((id) => ({ id, operation: "replace", severity: "severe", note: "crushed" })) }));
  const r = o2.createRequest(r0.caseId, "insurance", "best_value", "scripted");
  await flow2.run(r);
  const win = r.ranking!.find((x) => x.recommended) ?? r.ranking![0]; const winOffer = o2.latest(r, win.shopId)!;
  ok(o2.confirm(r.id, winOffer.id, winOffer.version).ok === true, `slack: customer books ${win.shopId}`);
  await sleep(1500); // let the post queue drain
  const lines = readFileSync(sl.dryFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const toAp = lines.filter((l) => l.method === "chat.postMessage" && l.body.channel === "DRY-APPROVALS");
  for (const [s, ch] of Object.entries(sl.rooms)) {
    const msgs = lines.filter((l) => l.method === "chat.postMessage" && l.body.channel === ch);
    ok(msgs.some((l) => /New request/.test(l.body.text)) && msgs.some((l) => /Your agent quoted/.test(l.body.text)) && msgs.some((l) => /Approval needed/.test(l.body.text)) && msgs.some((l) => new RegExp(SHOP_OWNER[s].replace(/[()]/g, "\\$&")).test(l.body.text)),
      `slack: ${s}'s room (${ch}) got the request card, its own quote, its approval card and its owner's decision (${msgs.length} posts)`);
    ok(msgs.filter((l) => /Approval needed/.test(l.body.text)).every((l) => l.body.text.includes(o2.shops.find((x: any) => x.id === s).name)), `slack: ${s}'s room only gets its own approval cards`);
  }
  ok(Object.entries(sl.rooms).every(([s, ch]) => lines.some((l) => l.method === "chat.postMessage" && l.body.channel === ch && (s === win.shopId ? /You won/ : /Lost/).test(l.body.text))), `slack: every shop's room got won/lost (winner ${win.shopId})`);
  ok(tapResults.wrongRoom?.error === "wrong_room" && tapResults.unknown?.error === "unknown_approval" && tapResults.notRoom?.error === "not_an_owner_room", `slack: taps gated by room (wrong room ${tapResults.wrongRoom?.error}, unknown ${tapResults.unknown?.error}, other channel ${tapResults.notRoom?.error})`);
  ok(["drive", "shop-b", "shop-c"].every((s) => tapResults[s]?.ok), "slack: any member of a shop's room decides that shop's approval");
  ok(lines.filter((l) => l.method === "chat.postEphemeral").length === 3, "slack: refused taps answered with an ephemeral warning");
  const ownerTexts = (x: any, k = ""): string[] => typeof x === "string" ? (k === "image_url" || k === "value" ? [] : [x]) : Array.isArray(x) ? x.flatMap((v) => ownerTexts(v)) : x && typeof x === "object" ? Object.entries(x).flatMap(([kk, v]) => ownerTexts(v, kk)) : [];
  const allText = lines.flatMap((l) => ownerTexts(l.body)).join("\n");
  ok(!/simulat|demo/i.test(allText), "slack: no 'simulated'/'demo' wording in any owner-facing text");
  ok(/Customer's agent|customer's agent/.test(allText) && !/driver/i.test(allText), "slack: the buyer is 'the customer's agent' (never 'driver')");
  ok(!o2.feed(r.id).some((e) => /simulat|demo/i.test(e.text + " " + e.actor)), "room feed: no 'simulated'/'demo' wording");
  const card = toAp.find((l) => /New request/.test(l.body.text));
  const imgs = (card?.body.blocks ?? []).filter((b: any) => b.type === "image");
  ok(imgs.length === 3 && imgs.every((b: any) => b.image_url.startsWith("https://rooms.example/uploads/")), "slack: new-request card carries 3 photo image blocks at the public origin");
  ok(JSON.stringify(card?.body.blocks ?? []).includes("What's wrong"), "slack: new-request card lists what's wrong");
  ok(toAp.some((l) => /Your agent quoted/.test(l.body.text)), "slack: Drive's scope + price posted after it quotes");
  const apCard = toAp.find((l) => /Approval needed/.test(l.body.text));
  ok(!!apCard && apCard.body.blocks.some((b: any) => b.type === "image") && apCard.body.blocks.some((b: any) => b.type === "actions") && JSON.stringify(apCard.body.blocks).includes("*Damage*"), "slack: approval card has one photo, the damage lines and the buttons");
  ok(lines.every((l) => !/^https:\/\/slack/.test(String(l.body?.channel))) && !lines.some((l) => l.method === "apps.connections.open"), "slack: dry run never opened Socket Mode");
  o2.publicOrigin = "";
  ok((sl as any).imageBlocks(r).length === 0, "slack: no public origin, no image blocks");
}
// ---------- third pass: decisive priorities, room key, ask text, clamped targets, notes ----------
{
  const cmp = (shopId: string, eligible = true) => ({ shopId, statuses: {}, missingRequired: eligible ? [] : ["x"], eligible, completeness: 1, disputedCount: 0 });
  const inp = (shopId: string, shopName: string, x: Partial<RankInput>): RankInput => ({ shopId, shopName, turnaroundDays: 4, warrantyScore: 0.5, dropOffOrder: 0, rating: null, reviewCount: null, comparison: cmp(shopId), ...x });
  // Drive wins every weighted criterion except incentives; best_incentives must still pick Bayline.
  const ins = [
    inp("drive", "Drive Auto Body", { incentiveValue: 600, rating: 4.9, reviewCount: 400, turnaroundDays: 3, warrantyScore: 1, extrasCount: 2 }),
    inp("shop-b", "Bayline Collision", { incentiveValue: 650, rating: 3.9, reviewCount: 15, turnaroundDays: 6, warrantyScore: 0.5, extrasCount: 0 }),
    inp("shop-c", "QuickFix Auto Body", { incentiveValue: 0, rating: 4.0, reviewCount: 30, turnaroundDays: 5, warrantyScore: 0.3, extrasCount: 0 }),
  ];
  const bi = rank("insurance", "best_incentives", ins);
  ok(bi[0].shopId === "shop-b" && bi[0].recommended && /^Recommended: best incentives/.test(bi[0].why), `rank: best_incentives with Bayline $650 vs Drive $600 recommends Bayline (${bi.map((r) => `${r.shopId}: ${r.why}`).join(" | ")})`);
  ok(rank("insurance", "best_value", ins)[0].shopId === "drive", "rank: best_value keeps the weighted score (Drive)");
  const sp = [
    inp("drive", "Drive Auto Body", { total: 2400, rating: 4.9, reviewCount: 400, turnaroundDays: 3, warrantyScore: 1 }),
    inp("shop-b", "Bayline Collision", { total: 2380, rating: 3.9, reviewCount: 15, turnaroundDays: 6, warrantyScore: 0.5 }),
    inp("shop-c", "QuickFix Auto Body", { total: 2000, rating: 4.0, reviewCount: 30, turnaroundDays: 2, warrantyScore: 0.3, comparison: cmp("shop-c", false) }),
  ];
  const lp = rank("self_pay", "lowest_price", sp);
  ok(lp[0].shopId === "shop-b" && /^Recommended: lowest price/.test(lp[0].why) && lp[2].shopId === "shop-c", `rank: lowest_price picks the cheapest eligible offer (${lp.map((r) => `${r.shopId}: ${r.why}`).join(" | ")})`);
  const fa = rank("self_pay", "fastest", sp);
  ok(fa[0].shopId === "drive" && /^Recommended: fastest turnaround/.test(fa[0].why), `rank: fastest picks the quickest eligible shop (${fa[0].shopId}: ${fa[0].why})`);
  ok(!rank("self_pay", "lowest_price", sp).slice(1).some((r) => /lowest price/.test(r.why) && r.eligible), "rank: no non-leader claims 'lowest price'");

  // room key + ask text validation + clamped best-and-final + named timeout notes
  const o5 = new Orchestrator(); const flow5 = new Flow(o5, undefined); o5.removeAllListeners("deliver");
  const r = o5.createRequest("case-accord", "self_pay", "best_value", "scripted");
  ok(/^[0-9a-f]{32}$/.test(r.roomKey ?? ""), "request: roomKey is 32 hex chars");
  for (const s of r.shops) o5.tool_review_and_quote(shop(r, s));
  const cur = o5.latest(r, "shop-c")!.price!.total;
  o5.tool_ask_shop(buyer(r), { shopId: "shop-c", total: cur - 50, message: "Bayline offered $99 <b>beat it</b>" });
  const a1 = r.asks.find((a) => a.shopId === "shop-c")!;
  ok(a1.text === `Best and final: can you do $${cur - 50}?`, `ask_shop: invented $ amount replaced by the server line (${a1.text})`);
  const leadTotal = o5.latest(r, "drive")!.price!.total;
  o5.tool_ask_shop(buyer(r), { shopId: "shop-b", total: o5.latest(r, "shop-b")!.price!.total - 20, message: `Drive is at $${leadTotal} <script>. Can you do $${o5.latest(r, "shop-b")!.price!.total - 20}?` });
  const a2 = r.asks.find((a) => a.shopId === "shop-b")!;
  ok(a2.text.includes(`$${leadTotal}`) && !/[<>]/.test(a2.text), `ask_shop: real numbers kept, < > stripped (${a2.text})`);
  ok(o5.safeAgentText(r.id, "<@U123> hi") === "@U123 hi", "safeAgentText strips < and >");
  // 15% clamp: a shop far above the leader is asked at most 15% off its own price, without citing the leader
  const r6 = o5.createRequest("case-accord", "self_pay", "lowest_price", "scripted");
  for (const s of r6.shops) o5.tool_review_and_quote(shop(r6, s));
  const big = o5.latest(r6, "shop-b")!; big.price = { ...big.price!, total: 9000 };
  const tg: any[] = flow5.bestAndFinalTargets(r6);
  const tb = tg.find((t) => t.shopId === "shop-b");
  ok(tb.total === Math.round(9000 * 0.85 / 10) * 10 && tb.message === `Best and final: can you do $${tb.total}?`, `best-and-final: non-leader clamped to 15% off its own total (${tb.total}: ${tb.message})`);
  ok(tg.filter((t) => t.shopId !== "shop-b").every((t) => t.total < o5.latest(r6, t.shopId)!.price!.total), "best-and-final: every target is below that shop's own total");
  // named offer-changed note
  o5.ownerRooms.add("shop-c");
  const r7 = o5.createRequest("case-accord", "self_pay", "best_value", "scripted");
  for (const s of r7.shops) o5.tool_review_and_quote(shop(r7, s));
  const lim: any = o5.limits(r7, "shop-c");
  o5.tool_ask_shop(buyer(r7), { shopId: "shop-c", total: lim.autonomousLimit - 100, message: "ask" });
  const pend = o5.tool_request_exception(shop(r7, "shop-c"), { reason: "x" });
  const ap = Object.values(o5.approvals).find((x) => x.requestId === r7.id && x.shopId === "shop-c")!;
  const base = o5.latest(r7, "shop-c")!; (r7.offers["shop-c"] as any).push({ ...base, id: base.id + "-x", version: base.version + 1 });
  o5.decide(ap.id, "approve", undefined, "slack"); await pend;
  ok(!!ap && o5.feed(r7.id).some((e) => e.text === "QuickFix Auto Body: the offer changed while waiting — holding the current offer."), "expire note names the shop");
}

for (const f of createdFiles) { try { rmSync(f); } catch { /* ignore */ } }

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
