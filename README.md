# Haggler

**Snap the damage. Your AI agent gets the body shops competing.**

Built at the AI Commerce Gallery hackathon (ZooWork × AI Valley, San Francisco, October 3, 2026).

A driver uploads photos of their car damage and sends an AI agent to shop the repair. Every body shop's own
AI agent inspects the same photos independently and quotes in its own style. The driver's agent questions
gaps between estimates and asks every shop for its best and final. Past its limit, a shop's agent must ask its
human owner, who taps Approve, Counter or Deny in that shop's own Slack room. The driver confirms; nothing books
until they do.

- **Drive Auto Body is a real shop** (owner Gio Oseguera). Its agent is grounded in 115 anonymized jobs mined
  from his real estimates: on insurance jobs it finds the hidden damage, scans and blends he historically adds;
  on cash jobs it picks the cheapest sound fix. Grounded by retrieval, not fine-tuned.
- **Bayline Collision and QuickFix Auto Body are demo shops** created to show competition.
- Bookings are simulated; no payment is taken.

## How it works

```
Browser (driver app, /room projector view, /admin)
        │
        ▼
Node 22 server (TypeScript, zero frameworks) ── the referee
  • catalog pricing with each shop's rate card      • authority limits + owner exceptions
  • single-use approvals bound to one offer version • rate limits, size caps, PIN lockout
        │
        ├── ZooWork managed agents (Claude Sonnet 5): the driver's agent + one agent per shop
        │     photos reach agents through custom tools; every action is a server-side tool call
        ├── Slack (Socket Mode): an owner room per shop + a shared deal room
        ├── BAND: mirrors the negotiation into a shared agent room
        └── data/: 59-item damage catalog, Gio's anonymized history + playbook
```

Request phases: inspecting → quoting → clarifying → negotiating (best and final to every shop) → ranking → ready → booked.

## Run it

Requires Node 22.20+.

```bash
npm ci
cp .env.example .env        # fill in the keys you have; everything optional falls back gracefully
npm start                   # http://127.0.0.1:3000  (/room for the projector, /admin for the operator)
```

Without a ZooWork key the shops run on scripted rules (photo inspection needs ZooWork). Set `SLACK_DRY_RUN=1`
to log Slack messages to `.state/slack-dry.jsonl` instead of posting. `scripts/start-public.ps1` starts the server
plus a Cloudflare quick tunnel on Windows.

Checks:

```bash
node --experimental-strip-types scripts/check-flow.ts      # 172 end-to-end and authority checks
node --experimental-strip-types scripts/check-engines.ts   # pricing, tiers, ranking
python scripts/check_pii.py                                # privacy scan of data/
```

## Safety

- Agents act only through server tools bound to their identity; prices come from the engine, never from AI text.
- Owner approvals are single-use and tied to one exact offer version; counters are range-checked; offers freeze once shown.
- Per-visitor rate limits and a run cap (so nobody drains credits), body-size caps, admin PIN lockout, security headers.
- Text inside photos is treated as data, never as instructions. Agent text with invented prices is dropped.
- Insurance mode never estimates out-of-pocket cost; incentives are paid by the shop and never billed to insurance.
- Gio's data is anonymized: no customer names, phones, emails, VINs, plates, claim numbers or addresses (`scripts/check_pii.py`).
- Secrets live only in `.env` (gitignored).

## Built with

ZooWork · BAND · Slack · Tavily · Cloudflare Tunnel · Node.js · TypeScript · Python · Claude Code · Codex

Test photos for uploads come from Wikimedia Commons (public domain / CC0 / CC BY); credits in `data/samples/*/meta.json`.
