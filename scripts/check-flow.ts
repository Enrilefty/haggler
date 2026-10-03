// Offline end-to-end check of the scripted flow and the authority rules (no ZooWork, Slack or BAND).
// Run: node --experimental-strip-types scripts/check-flow.ts
import { readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Orchestrator, type Approval, type Request, decodeImageDataUrl, UPLOAD_DIR, PHOTOS_DIR, UPLOAD_LIMITS, listSamples, CLARIFY_EXTRAS_PER_SHOP } from "../src/orchestrator.ts";
import { Flow } from "../src/flow.ts";
import { SlackOwner } from "../src/slack.ts";
import * as cat from "../src/catalog.ts";

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
  for (const k of ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_DEAL_CHANNEL_ID", "SLACK_DAD_APPROVAL_CHANNEL_ID", "SLACK_OWNER_USER_ID"]) process.env[k] = "";
  process.env.SLACK_DRY_RUN = "1";
  const o2 = new Orchestrator(); const flow2 = new Flow(o2, undefined); const sl = new SlackOwner(o2);
  sl.dryFile = sl.dryFile.replace(/slack-dry.jsonl$/, "slack-dry-test.jsonl"); // never clobber a running server's dry log
  o2.publicOrigin = "https://demo.example";
  if (existsSync(sl.dryFile)) rmSync(sl.dryFile);
  await sl.start();
  ok(sl.status.startsWith("dry-run"), "slack: dry-run mode, no socket");
  o2.on("approval", (ap: Approval) => setTimeout(() => o2.decide(ap.id, "approve", undefined, "slack"), 50));
  const r0: any = track(o2.createPhotoCase(elantra.map(jpg), undefined, { sampleBaseline: pickIds().map((id) => ({ id, operation: "replace", severity: "severe", note: "crushed" })) }));
  const r = o2.createRequest(r0.caseId, "insurance", "best_value", "scripted");
  await flow2.run(r);
  await sleep(1500); // let the post queue drain
  const lines = readFileSync(sl.dryFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const toAp = lines.filter((l) => l.method === "chat.postMessage" && l.body.channel === "DRY-APPROVALS");
  const card = toAp.find((l) => /New request/.test(l.body.text));
  const imgs = (card?.body.blocks ?? []).filter((b: any) => b.type === "image");
  ok(imgs.length === 3 && imgs.every((b: any) => b.image_url.startsWith("https://demo.example/uploads/")), "slack: new-request card carries 3 photo image blocks at the public origin");
  ok(JSON.stringify(card?.body.blocks ?? []).includes("What's wrong"), "slack: new-request card lists what's wrong");
  ok(toAp.some((l) => /Your agent quoted/.test(l.body.text)), "slack: Drive's scope + price posted after it quotes");
  const apCard = toAp.find((l) => /Approval needed/.test(l.body.text));
  ok(!!apCard && apCard.body.blocks.some((b: any) => b.type === "image") && apCard.body.blocks.some((b: any) => b.type === "actions") && JSON.stringify(apCard.body.blocks).includes("*Damage*"), "slack: approval card has one photo, the damage lines and the buttons");
  ok(lines.every((l) => !/^https:\/\/slack/.test(String(l.body?.channel))) && !lines.some((l) => l.method === "apps.connections.open"), "slack: dry run never opened Socket Mode");
  o2.publicOrigin = "";
  ok((sl as any).imageBlocks(r).length === 0, "slack: no public origin, no image blocks");
}
for (const f of createdFiles) { try { rmSync(f); } catch { /* ignore */ } }

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
