# Quote Room v2 — build contract (shared by all builders)

Repo (worktree, branch `v2`): `D:/Vault/Enril/tmp/quote-room-v2`. Node 22.22, TypeScript run with
`node --experimental-strip-types` (no build step; **constructor parameter properties are NOT supported**;
use explicit fields). Zero new npm dependencies unless the task says otherwise. Do not touch
`D:/Vault/Enril/projects/quote-room` (the live demo runs from there). Do not start a Slack listener
(only one may exist; the live server holds it) — never run `src/server.ts` with SLACK_* env set; for
local tests use `PORT=3200 SLACK_APP_TOKEN= SLACK_BOT_TOKEN= node --experimental-strip-types src/server.ts`.

## Product (what Enri asked for, 2026-10-03 14:45)
Customer point of view: "Snap your damage. Your AI agent shops it to local body shops, negotiates, and you pick."
1. Customer uploads their own photos (or taps a sample), says insurance or paying themselves, and what matters.
2. Their agent (ZooWork buyer agent) LOOKS at the photos (real vision) and writes a damage report.
3. Each shop's agent independently LOOKS at the same photos and builds its own scope in its own style:
   - **Drive Auto Body (real shop, owner Gio)** — grounded in Gio's real past estimates (retrieval over his
     anonymized history + a playbook mined from it). Insurance jobs: finds everything a thorough estimator
     finds (hidden damage behind the bumper, blend adjacent panels, scans, materials, supplements Gio
     historically adds). Cash jobs: the cheapest sound fix (repair instead of replace where Gio does,
     aftermarket/used parts, skip non-essential ops).
   - **Bayline Collision** — OEM-only, thorough, pricier. **QuickFix Auto Body** — fast/minimal, aftermarket.
4. Driver's agent clarifies gaps, makes ONE ask, Gio approves/counters/denies in Slack (Slack shows the
   photos + damage report), ranking, customer confirms.
- No "simulated" badges/dashed cards in the customer UI. One quiet footer line discloses: "Bayline Collision
  and QuickFix Auto Body are demo shops in this prototype; Drive Auto Body is a real shop." No fake star
  ratings for demo shops (show "New on Quote Room").
- Remove the 2023 Accord case from the UI/case list (keep its JSON for tests). Keep the Elantra sample.
- Insurance wording rules stay: never estimate out-of-pocket; show GUARDRAIL_INSURANCE / GUARDRAIL_INCENTIVE.
- PRIVACY: Gio's estimates contain customer PII. Nothing from `.../drive-estimate-ai-discovery-2026-10-03/private`
  may enter the repo except anonymized aggregates/line items (no names, phones, emails, addresses, VINs,
  plates, claim/policy numbers, insurer adjuster names, dates finer than month). Never copy his photos.

## Data files (built by the data builder; others code against these shapes)
`data/catalog.json` — canonical damage vocabulary. Scope item identity = catalog `id` (operation is an attribute).
```json
{ "version": 1, "note": "Hours/prices are medians from Gio's estimates where n>=3, else marked default",
  "items": [ { "id": "front-bumper-cover", "label": "Front bumper cover", "area": "front",
      "kind": "visible",                       // visible | hidden | procedure | materials
      "ops": { "repair":  { "bodyHours": 2.0, "refinishHours": 2.6 },
               "replace": { "bodyHours": 1.4, "refinishHours": 2.9, "needsPart": true },
               "refinish":{ "refinishHours": 2.6 },
               "r&i":     { "bodyHours": 0.8 } },          // only ops that make sense
      "parts": { "oem": 612, "aftermarket": 340, "used": 210 },  // null if no part
      "mechHours": 0, "fixedCharge": 0,                  // e.g. scans: fixedCharge 220
      "evidence": "n=14", "aliases": ["bumper cover", "front bumper"] } ] }
```
~40–60 items covering front/rear/sides/top + hidden (impact bar, absorber, radiator support, condenser,
headlamp brackets, sensors) + procedures (pre/post scans, ADAS calibration, wheel alignment) + materials
(color tint/blend, flex additive, hazardous waste, cover car).

`data/gio/history.json` — `{ "jobs": [ { "id": "job-017", "month": "2026-08", "payer": "insurance"|"self_pay",
"vehicle": { "year": 2018, "make": "Hyundai", "model": "Elantra" }, "areas": ["front"], "stage": "preliminary"|"supplement"|...,
"lines": [ { "catalogId": "front-bumper-cover", "op": "replace", "partType": "CAPA", "bodyHours": 1.4, "refinishHours": 2.9, "partPrice": 383 } ],
"total": 14230, "supplementAdds": ["impact-bar", "adas-scans"] } ] }` (anonymized).
`data/gio/playbook.json` — mined patterns, e.g. `{ "insurance": { "addsByArea": { "front": [ { "catalogId": "impact-bar", "rate": 0.78, "n": 23, "why": "..." } ] }, "blendRate": 0.6 }, "self_pay": { "repairInsteadOfReplace": [ { "catalogId": "...", "rate": 0.5 } ], "partTypeMix": { "aftermarket": 0.6, "used": 0.2, "oem": 0.2 } }, "stats": { "estimates": 205, "supplements": 60, "selfPay": 35 } }`.
`src/history.ts` — `export function searchHistory(q: { areas?: string[]; mode: "self_pay"|"insurance"; make?: string; model?: string; catalogIds?: string[]; limit?: number }): { jobs: Job[]; playbook: { adds: {catalogId:string;rate:number;n:number;why:string}[]; repairs: {catalogId:string;rate:number}[]; partTypeMix: Record<string,number> }; summary: string }`
(`summary` = one or two plain sentences, e.g. "On 23 similar front-end insurance jobs Gio added the impact bar 78% of the time."). Pure, sync, reads the JSON once.

## Shops (`data/shops.json`, core builder) — add `partsPolicy`: drive `{ "self_pay": "aftermarket", "insurance": "oem" }` (refine from playbook), shop-b `{ "self_pay": "oem", "insurance": "oem" }`, shop-c `{ "self_pay": "aftermarket", "insurance": "aftermarket" }`. Demo shops' rate cards unchanged.

## Cases
- Static sample: `case-elantra` (has photos, baseline, legacy rules) — keep working exactly as today.
- Dynamic photo case (new): created by `POST /api/uploads`; `{ id: "photo-xxxx", title, vehicle?, photos: [file names], dynamic: true, baseline: [] }`. Baseline comes from the buyer agent's damage report; shop scopes come from each shop agent's own assessment.

## HTTP API (core builder implements; UI builder consumes)
- `GET /api/status` (unchanged shape + `publicOrigin`).
- `GET /api/cases` → only cases with photos (Elantra) + `samples` (from `data/samples/*/meta.json`: `{ id, title, vehicle, photos:[url], credit }`).
- `POST /api/uploads` body `{ images: ["data:image/jpeg;base64,..."], vehicle?: { year?, make?, model? } }` (client resizes to ≤1280px JPEG, ≤8 images, ≤1.5 MB each) → `{ caseId, photos: ["/uploads/<file>.jpg", ...] }`. Also accepts `{ sampleId }` to create a case from a sample.
- `GET /uploads/<file>` and `GET /samples/<id>/<file>` serve images (also used by Slack image blocks via the public origin).
- `POST /api/requests` `{ caseId, mode, priority }` → `{ requestId }` (unchanged).
- `GET /api/requests/:id` → today's view PLUS: `damageReport` `{ summary, vehicleGuess?, items:[{ id, label, operation, severity, note }] , by: "agent"|"sample" }`; `assessments` `{ [shopId]: { items:[{ id, label, operation, partType?, reason }], notes, history?: { summary, jobs:n } , by:"agent"|"fallback" } }`; `phase` one of `inspecting|quoting|clarifying|negotiating|ranking|ready|booked`; `shopsInfo[shop]` adds `demo: boolean` (true for shop-b/shop-c) and drops `simulated` from display.
- Feed `GET /api/requests/:id/feed?after=n` unchanged (new event types: `damage_report`, `assessment_posted`).

## ZooWork tools (core builder)
Custom tool results may contain images: `{ content: [ { type: "image", source: { type: "base64", media_type: "image/jpeg", data } }, { type: "json", value } ] }` (see `CustomToolResultContent` in `node_modules/@zoowork-ai/sdk/dist/client.d.ts` ~line 785; verify exact shape there).
- Buyer: `inspect_photos` → images + catalog list (ids/labels/areas); `post_damage_report({ summary, vehicleGuess?, items:[{ id, operation, severity, note }] })` (ids must be catalog ids; unknown ids rejected with the valid list).
- Shops: `inspect_photos` (same); Drive only: `get_gio_history({ areas, catalogIds })` → `searchHistory` result; `submit_assessment({ items:[{ id, operation, reason }], notes })` → server prices with the shop's rate card + catalog hours + `partsPolicy` part prices, posts the offer (replaces `review_and_quote` for dynamic cases; `review_and_quote` stays for the Elantra sample and fallbacks).
- `respond_clarification` gains optional `decision: "add"|"dispute"` used for dynamic cases (static case keeps its server rules).
- Fallbacks (ZooWork down/timeouts): buyer report → for samples use their meta baseline if present, else post "AI inspection unavailable" and stop gracefully; shops → Drive applies the playbook to the buyer's report, Bayline adds hidden items for the area with OEM, QuickFix takes the report as-is with aftermarket.

## Slack (core builder)
Owner POV in the approvals channel: on each new request post the photos (image blocks, max 3, `image_url` = publicOrigin + photo path; public origin captured from incoming request Host/X-Forwarded-Host when not localhost) + the damage report + Drive's scope/price once quoted. The approval card repeats one photo + the key damage lines + the ask + buttons. Deal room keeps mirroring.
