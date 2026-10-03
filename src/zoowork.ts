// ZooWork Managed Agents runtime: one buyer agent + one agent per shop (same template).
// Tools are ZooWork custom tools executed by this server; each session is bound server-side
// to exactly one role/shop, so an agent can only ever act as itself.
import { createZooworkClient, customToolUse, isRunFinished, assistantText } from "@zoowork-ai/sdk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env, STATE_DIR } from "./config.ts";
import type { Orchestrator, Ctx } from "./orchestrator.ts";
import { SHOP_ACTOR, GUARDRAIL_INSURANCE } from "./orchestrator.ts";

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const num = { type: "number" }, str = { type: "string" };

const SHOP_TOOLS = [
  { name: "review_and_quote", description: "Review the posted scope under this shop's rules (accept or amend with reasons), price it with the shop's own rate card (self-pay) or size the job and offer the shop's autonomous incentives (insurance), and post the offer to the room. Numbers come from the engine; never type prices yourself.", input_schema: obj({}) },
  { name: "respond_clarification", description: "Answer a clarification the driver's agent asked about one item. The server applies this shop's policy (add the item and reprice, or mark it disputed). Optionally include a one-line message.", input_schema: obj({ clarificationId: str, message: str }, ["clarificationId"]) },
  { name: "revise_offer", description: "Improve your offer within your own authority. Self-pay: pass total (must be at or above your autonomous limit). Insurance: pass deductibleAssist (must be within your tier cap).", input_schema: obj({ total: num, deductibleAssist: num, message: str }) },
  { name: "request_exception", description: "Ask the owner to approve something beyond your authority (self-pay: a total below your autonomous limit; insurance: deductible assistance above your cap). This waits for the owner's decision and returns approved, countered or denied.", input_schema: obj({ total: num, deductibleAssist: num, reason: str }, ["reason"]), timeoutMs: 240_000 },
];
const BUYER_TOOLS = [
  { name: "get_offers", description: "Get the latest offer from each shop plus the scope comparison (covered / missing_required / disputed / recommended_elsewhere).", input_schema: obj({}) },
  { name: "clarify_item", description: "Ask one shop to clarify one item (at most once per item). Use for items marked missing_required or recommended_elsewhere.", input_schema: obj({ shopId: str, itemId: str, question: str }, ["shopId", "itemId", "question"]) },
  { name: "ask_shop", description: "The single negotiation ask. Self-pay: target total. Insurance: target deductibleAssist. Cite only real numbers from the room.", input_schema: obj({ shopId: str, total: num, deductibleAssist: num, message: str }, ["shopId", "message"]) },
  { name: "rank_offers", description: "Rank offers by the driver's priority (server formula, eligibility rules applied).", input_schema: obj({ priority: str }) },
  { name: "present_for_confirmation", description: "Present the ranked offers to the driver. Never books; the driver must confirm.", input_schema: obj({ summary: str }) },
];

const BUYER_PERSONA = `You are the driver's agent in Quote Room, a marketplace where body shops' agents compete for a repair.
- Work only through your tools. Compare only what shops actually posted. When negotiating, cite only real numbers or terms from the room; never invent a competing offer.
- Clarify before recommending: if an offer is missing a required item, or another shop recommended an item this offer lacks, use clarify_item (once per item).
- One negotiation round: exactly one ask_shop call, aimed where it could change the ranking. Self-pay: ask about price. Insurance: ask about incentives (deductibleAssist), never repair price.
- Never book. Rank with rank_offers, then present_for_confirmation and wait for the driver.
- Say that final repair details are confirmed at inspection. Insurance mode: never estimate the driver's out-of-pocket amount; the only allowed wording is: "${GUARDRAIL_INSURANCE}"
After tool calls, reply with ONE short sentence. Only quote prices that the latest tool results returned.`;

const shopPersona = (name: string, simulated: boolean) => `You are the quoting agent for ${name}${simulated ? " (a simulated demo shop)" : ""}. You answer repair requests under this shop's rules only.
- To quote: call review_and_quote. It reviews the scope under this shop's rules and prices it with this shop's own numbers. Never type prices yourself.
- If asked to clarify an item: call respond_clarification with the clarification id (optionally a one-line message).
- If the driver's agent asks for more: if it's within your authority use revise_offer; if it's beyond your authority call request_exception with a one-line reason and wait for the owner.
- Compete on fit, completeness, turnaround, parts, warranty and reviews, not just price. Be brief, professional and plain-spoken. After tool calls reply with one short sentence, no tables. Never offer anything the owner hasn't authorized.`;

type Binding = { agentKey: string; agentId: string; sessionId?: string; cursor?: string; ctx: Ctx };

export class ZooWorkRuntime {
  zc = createZooworkClient({ apiKey: env("ZOOWORK_API_KEY"), fetch: (u: string, i?: RequestInit) => fetch(u, { ...i, signal: i?.signal ?? AbortSignal.timeout(30_000) }) });
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
        ...this.o.shops.map((s) => [`shop:${s.id}`, { name: `quote-room-${s.id}`, persona: shopPersona(s.name, s.isSimulated), tools: SHOP_TOOLS }] as [string, any]),
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
          const value = await this.dispatch(b.ctx, call.name ?? call.toolName, call.input ?? {});
          await this.zc.resolveCustomToolCall(b.agentId, call.callId, { content: [{ type: "json", value }], resolvedBy: `quote-room:${agentKey}` } as any);
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
