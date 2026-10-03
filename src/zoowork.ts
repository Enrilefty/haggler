// ZooWork Managed Agents runtime: one buyer agent + one agent per shop (same template).
// Tools are ZooWork custom tools executed by this server; each session is bound server-side
// to exactly one role/shop, so an agent can only ever act as itself.
import { createZooworkClient, customToolUse, isRunFinished, assistantText } from "@zoowork-ai/sdk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env, STATE_DIR } from "./config.ts";
import type { Orchestrator, Ctx } from "./orchestrator.ts";
import { GUARDRAIL_INSURANCE } from "./orchestrator.ts";

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const num = { type: "number" }, str = { type: "string" };

const damageItem = obj({ id: str, operation: str, severity: { type: "string", enum: ["minor", "moderate", "severe"] }, note: str }, ["id", "operation", "severity"]);
const scopeLine = obj({ id: str, operation: str, partType: { type: "string", enum: ["oem", "aftermarket", "used", "capa"] }, reason: str }, ["id", "operation", "reason"]);
const INSPECT = { name: "inspect_photos", description: "Look at the customer's photos for this request. Returns the photos as images plus the damage catalog (ids, labels, areas, kinds, valid operations). Shops also get the customer's agent's damage report.", input_schema: obj({}) };

const SHOP_TOOLS = [
  INSPECT,
  { name: "submit_assessment", description: "Post YOUR shop's scope for a photo request: one line per catalog id with an operation (one of that item's ops), optional partType (your parts policy applies), and a short reason tied to what you see or to your shop's experience. The server prices it with your shop's rate card, catalog labor hours and part prices, and posts your offer. Never type prices. Unknown ids are rejected with the valid list.", input_schema: obj({ items: { type: "array", items: scopeLine }, notes: str }, ["items"]) },
  { name: "review_and_quote", description: "For the sample request with a person-reviewed scope (no photo assessment needed): review the posted scope under this shop's rules and post the offer. Numbers come from the engine; never type prices yourself.", input_schema: obj({}) },
  { name: "respond_clarification", description: "Answer a clarification the driver's agent asked about one item. For photo requests pass decision \"add\" (include it; the server reprices) or \"dispute\" (not needed from the photos), plus a one-line message. For the sample request the server applies the shop's policy.", input_schema: obj({ clarificationId: str, decision: { type: "string", enum: ["add", "dispute"] }, message: str }, ["clarificationId"]) },
  { name: "revise_offer", description: "Improve your offer within your own authority. Self-pay: pass total (must be at or above your autonomous limit). Insurance: pass deductibleAssist (must be within your tier cap).", input_schema: obj({ total: num, deductibleAssist: num, message: str }) },
  { name: "request_exception", description: "Ask the owner to approve something beyond your authority (self-pay: a total below your autonomous limit; insurance: deductible assistance above your cap). This waits for the owner's decision and returns approved, countered or denied.", input_schema: obj({ total: num, deductibleAssist: num, reason: str }, ["reason"]), timeoutMs: 240_000 },
];
const DRIVE_TOOLS = [
  SHOP_TOOLS[0],
  { name: "get_gio_history", description: "Drive Auto Body only. Search Gio's anonymized past estimates for similar jobs (by damaged areas and catalog ids, same payer type) and get the playbook mined from them: items Gio adds on insurance jobs and how often, where he repairs instead of replacing on cash jobs, and his part-type mix. Call this before submit_assessment.", input_schema: obj({ areas: { type: "array", items: str }, catalogIds: { type: "array", items: str } }) },
  ...SHOP_TOOLS.slice(1),
];
const BUYER_TOOLS = [
  INSPECT,
  { name: "post_damage_report", description: "Post your damage report for the customer's photos: a one-sentence summary, vehicleGuess if you can tell, and one item per damaged part using catalog ids only (operation from that item's ops, severity minor|moderate|severe, a short note of what you see). Shops quote against this report.", input_schema: obj({ summary: str, vehicleGuess: str, items: { type: "array", items: damageItem } }, ["summary", "items"]) },
  { name: "get_offers", description: "Get the latest offer from each shop plus the scope comparison (covered / missing_required / disputed / recommended_elsewhere).", input_schema: obj({}) },
  { name: "clarify_item", description: "Ask one shop to clarify one item (at most once per item). Use for items marked missing_required or recommended_elsewhere.", input_schema: obj({ shopId: str, itemId: str, question: str }, ["shopId", "itemId", "question"]) },
  { name: "ask_shop", description: "The single negotiation ask. Self-pay: target total. Insurance: target deductibleAssist. Cite only real numbers from the room.", input_schema: obj({ shopId: str, total: num, deductibleAssist: num, message: str }, ["shopId", "message"]) },
  { name: "rank_offers", description: "Rank offers by the driver's priority (server formula, eligibility rules applied).", input_schema: obj({ priority: str }) },
  { name: "present_for_confirmation", description: "Present the ranked offers to the driver. Never books; the driver must confirm.", input_schema: obj({ summary: str }) },
];

const BUYER_PERSONA = `You are the customer's own AI agent in Quote Room. Your customer snapped photos of their damaged car; you shop the repair to local body shops, negotiate, and let the customer pick. You work for the customer, not for any shop.
- Photos first: call inspect_photos and really look. Then post_damage_report with catalog ids only: what is damaged, the likely operation (repair if it is a dent or scuff that can be fixed, replace if it is torn, cracked, crushed or broken), severity, and a short plain note of what you see. List what you can see; mention implied hidden damage in a note rather than guessing a part. Never price anything.
- Compare only what shops actually posted. When negotiating, cite only real numbers or terms from the room; never invent a competing offer.
- Clarify before recommending: if an offer is missing an item from your report, or another shop recommended an item this offer lacks, use clarify_item (once per item).
- One negotiation round: exactly one ask_shop call, aimed where it could change the ranking. Self-pay: ask about price. Insurance: ask about incentives (deductibleAssist), never repair price.
- Never book. Rank with rank_offers, then present_for_confirmation and wait for the customer.
- Say that final repair details are confirmed at inspection. Insurance mode: never estimate the customer's out-of-pocket amount; the only allowed wording is: "${GUARDRAIL_INSURANCE}"
After tool calls, reply with ONE short sentence. Only quote prices that the latest tool results returned.`;

const COMMON_SHOP = `- If asked to clarify an item: call respond_clarification with the clarification id; on photo requests also pass decision "add" or "dispute" the way your shop would, with a one-line message.
- If the customer's agent asks for more: if it's within your authority use revise_offer; if it's beyond your authority call request_exception with a one-line reason and wait for the owner.
- For the sample request with a person-reviewed scope, call review_and_quote instead of submit_assessment.
- Be brief, professional and plain-spoken. After tool calls reply with one short sentence, no tables. Never type prices; the server prices your scope. Never offer anything the owner hasn't authorized.`;

const DRIVE_PERSONA = `You are the estimating agent for Drive Auto Body, a real collision shop run by its owner, Gio. You estimate the way Gio does: he is known for finding everything on insurance jobs and for the cheapest sound fix on cash jobs.
- On a photo request: FIRST call get_gio_history (areas and catalog ids from the customer's report) to see how Gio wrote similar jobs. Then inspect_photos and look yourself. Then submit_assessment.
- Insurance jobs: be thorough like Gio. Include the visible damage, the hidden damage he historically finds behind that kind of impact (impact bar, absorber, brackets, radiator support, sensors), blends on adjacent panels, pre/post scans and calibrations, and the materials lines he adds. Every line needs a reason tied to the photos or to Gio's history (cite the history pattern in plain words, e.g. "Gio adds this on most front-end hits").
- Cash (self-pay) jobs: the cheapest fix that is still sound. get_gio_history returns cashOptions with your own price to repair vs replace with a used/aftermarket part for each reported item: take the cheaper one (replace with a used or aftermarket part when repair labor costs more, repair when the part costs more), set partType "used" or "aftermarket", and skip non-essential operations. Never cut anything safety-related.
${COMMON_SHOP}`;
const BAYLINE_PERSONA = `You are the estimating agent for Bayline Collision, an OEM-only shop known for thorough, by-the-book repairs (a demo shop in this prototype).
- On a photo request: inspect_photos, look yourself, then submit_assessment. Follow factory repair procedures: replace damaged panels with new OEM parts rather than repairing heavy damage, include the hidden parts behind the impact and the required scans/calibrations, and give an OEM-procedure reason per line. Always partType "oem".
${COMMON_SHOP}`;
const QUICKFIX_PERSONA = `You are the estimating agent for QuickFix Auto Body, a fast, budget-minded shop (a demo shop in this prototype).
- On a photo request: inspect_photos, look yourself, then submit_assessment with only what is visibly damaged. Repair where possible, aftermarket parts (partType "aftermarket"), no hidden items or extra procedures unless the photos clearly show they are needed. Short reasons.
${COMMON_SHOP}`;
const shopPersona = (id: string) => (id === "drive" ? DRIVE_PERSONA : id === "shop-b" ? BAYLINE_PERSONA : QUICKFIX_PERSONA);
const shopTools = (id: string) => (id === "drive" ? DRIVE_TOOLS : SHOP_TOOLS);

type Binding = { agentKey: string; agentId: string; sessionId?: string; cursor?: string; ctx: Ctx };

export class ZooWorkRuntime {
  zc = createZooworkClient({ apiKey: env("ZOOWORK_API_KEY"), fetch: (u: string, i?: RequestInit) => fetch(u, { ...i, signal: i?.signal ?? AbortSignal.timeout(60_000) }) }); // 60s: inspect_photos results carry images
  agents: Record<string, string> = {};
  model?: string;
  ready = false;
  lastError = "";
  private agentsFile = join(STATE_DIR, "zoowork-agents.json");
  private o: Orchestrator;
  constructor(o: Orchestrator) { this.o = o; }

  async init() {
    try {
      const models: any[] = await this.zc.listModels();
      const selectable = models.filter((m) => m.selectable !== false);
      const pick = (re: RegExp) => selectable.find((m) => re.test(String(m.model)))?.model;
      this.model = env("ZOOWORK_MODEL") || pick(/claude-sonnet-5/i) || pick(/claude.*(sonnet|opus)/i) || pick(/claude/i) || pick(/gpt-5/i) || selectable[0]?.model;
      // agents file: key -> { id, hash }. A changed persona/tools/model hash means a fresh agent
      // (the old one is stopped), so persona fixes always reach the live agents.
      let stored: Record<string, any> = {};
      if (existsSync(this.agentsFile)) stored = JSON.parse(readFileSync(this.agentsFile, "utf8"));
      const defs: [string, any][] = [
        ["buyer", { name: "quote-room-buyer", persona: BUYER_PERSONA, tools: BUYER_TOOLS }],
        ...this.o.shops.map((s) => [`shop:${s.id}`, { name: `quote-room-${s.id}`, persona: shopPersona(s.id), tools: shopTools(s.id) }] as [string, any]),
      ];
      for (const [key, d] of defs) {
        const hash = hashStr(JSON.stringify([d.persona, d.tools, this.model]));
        const prev = typeof stored[key] === "string" ? { id: stored[key], hash: "" } : stored[key];
        if (prev?.id && prev.hash === hash) { this.agents[key] = prev.id; }
        else {
          if (prev?.id) await this.zc.stopAgent(prev.id).catch(() => undefined);
          const a: any = await this.zc.createAgent({ resource: { name: `${d.name}-${hash.slice(0, 6)}`, ...(this.model ? { model: { primary: this.model } } : {}), persona: { docs: [{ name: "AGENTS.md", content: d.persona }] }, custom_tools: d.tools, labels: { app: "quote-room", role: key.replace(":", "-") } } } as any);
          this.agents[key] = a.agent_id;
          stored[key] = { id: a.agent_id, hash };
          writeFileSync(this.agentsFile, JSON.stringify(stored, null, 1));
        }
        await this.zc.startAgent(this.agents[key]).catch(() => undefined);
      }
      for (const id of Object.values(this.agents)) await this.zc.waitUntilRunning(id, { timeoutMs: 120_000 });
      this.ready = true;
      return { ok: true, model: this.model, agents: Object.keys(this.agents) };
    } catch (e: any) {
      this.lastError = String(e?.message ?? e);
      return { ok: false, error: this.lastError };
    }
  }

  private sessions = new Map<string, Binding>(); // `${requestId}:${agentKey}`
  binding(requestId: string, agentKey: string): Binding {
    const k = `${requestId}:${agentKey}`;
    let b = this.sessions.get(k);
    if (!b) {
      const shopId = agentKey.startsWith("shop:") ? agentKey.slice(5) : undefined;
      b = { agentKey, agentId: this.agents[agentKey], ctx: { role: shopId ? "shop" : "buyer", shopId, requestId, via: "zoowork" } };
      this.sessions.set(k, b);
    }
    return b;
  }

  // Runs one agent turn: posts the message, executes custom tool calls as THIS bound identity,
  // and returns when the run finishes (or the timeout hits).
  // One turn at a time per session: a second message waits for the first run to finish.
  private locks = new Map<string, Promise<unknown>>();
  async turn(requestId: string, agentKey: string, message: string, timeoutMs = 90_000): Promise<{ ok: boolean; text: string }> {
    const k = `${requestId}:${agentKey}`;
    const prev = this.locks.get(k) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => this.turnUnlocked(requestId, agentKey, message, timeoutMs));
    this.locks.set(k, run);
    return run;
  }
  private async turnUnlocked(requestId: string, agentKey: string, message: string, timeoutMs: number): Promise<{ ok: boolean; text: string }> {
    const b = this.binding(requestId, agentKey);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs); // enforced even if the stream goes idle
    let last = "";
    let finished = false;
    try {
      if (!b.sessionId) {
        const s: any = await this.zc.createSession(b.agentId, { initial_events: [{ type: "user.message", content: message }] } as any);
        b.sessionId = s.session_id;
      } else {
        await this.zc.postEvents(b.agentId, b.sessionId, [{ type: "user.message", content: message }] as any);
      }
      const handled = new Set<string>();
      const stream: any = this.zc.streamEvents(b.agentId, b.sessionId!, { ...(b.cursor ? { cursor: b.cursor } : {}), signal: ac.signal } as any);
      for await (const ev of stream) {
        if (ev?.cursor) b.cursor = ev.cursor;
        const said = assistantText(ev);
        if (said.trim()) last = said; // keep only the latest message (the wrap-up)
        const call: any = customToolUse(ev);
        if (call?.phase === "requested" && !handled.has(call.callId)) {
          handled.add(call.callId);
          const value: any = await this.dispatch(b.ctx, call.name ?? call.toolName, call.input ?? {});
          // Handlers that return { __content } (inspect_photos) send image blocks + a json block;
          // everything else is one json block.
          const content = value && Array.isArray(value.__content) ? value.__content : [{ type: "json", value }];
          await this.zc.resolveCustomToolCall(b.agentId, call.callId, { content, resolvedBy: `quote-room:${agentKey}` } as any);
        }
        if (isRunFinished(ev)) { finished = true; break; }
      }
      if (!finished) throw new Error("turn_timeout");
      // Shops speak through their tool events; the buyer's one-line wrap-up is shown only after the
      // server checks it (no unknown prices, no insurance promises).
      if (b.ctx.role === "buyer" && last.trim()) {
        const clean = last.replace(/\*\*|__|`|#+\s|\|/g, "").replace(/\s+/g, " ").trim();
        const sentence = (clean.match(/^.{20,220}?[.!?](\s|$)/) ?? [clean.slice(0, 220)])[0].trim();
        const safe = this.o.safeAgentText(requestId, sentence);
        if (safe) this.o.log(requestId, "agent_says", "Driver's agent", safe);
      }
      return { ok: true, text: last };
    } catch (e: any) {
      this.lastError = String(e?.message ?? e);
      // A cut-off run leaves the session mid-turn; start a fresh session next time so a stale
      // run.finished is never replayed into the next turn.
      b.sessionId = undefined; b.cursor = undefined;
      return { ok: false, text: last };
    } finally {
      clearTimeout(timer);
    }
  }

  private async dispatch(ctx: Ctx, tool: string, input: any) {
    try {
      const o = this.o as any;
      const fn = o[`tool_${tool}`];
      if (typeof fn !== "function") return { error: `unknown_tool ${tool}` };
      // role check happens inside each handler (assertShop / assertBuyer)
      return await fn.call(this.o, ctx, input);
    } catch (e: any) {
      return { error: String(e?.message ?? e) };
    }
  }
}

function hashStr(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, "0");
}
