# Addendum (Enri, 2026-10-03 ~15:05): a Slack room per business + every shop can negotiate

1. **No "simulated"/"demo" wording anywhere** customer- or owner-facing: UI, Slack, room feed, SHOP_ACTOR names,
   warranty labels, profile status, footer. (Enri discloses verbally on stage.) Keep "New on Quote Room"
   instead of star ratings for Bayline/QuickFix (no fabricated reviews). Internal data flags may stay.
2. **Owner room per shop.** Env: `SLACK_SHOP_CHANNELS` = JSON `{ "drive": "<id>", "shop-b": "<id>", "shop-c": "<id>" }`
   (drive defaults to SLACK_DAD_APPROVAL_CHANNEL_ID). Each shop's room gets: new request (photos + damage
   report), its own agent's assessment + offer, approval cards for ITS exceptions, decisions, won/lost.
   A tap decides only approvals whose shop maps to the tapped channel; any member of that channel may tap
   (channel membership is the gate). Deal room (SLACK_DEAL_CHANNEL_ID) still mirrors everything.
3. **Best-and-final round to every shop.** Replace "exactly one ask to Drive" with one ask per shop in a single
   round (max one ask per shop): after clarifications, the buyer (agent or scripted) sends each shop an ask
   to beat the current leader on the driver's priority (self-pay: a target total below the leader where
   sensible; insurance: a deductible-assist target above the best incentive). Each shop: within authority ->
   revise_offer; beyond -> request_exception -> its owner decides in its room (all shops `exceptionMode: "owner"`
   when its channel is configured, else the old rule). Approvals run in parallel; negotiation ends when every
   ask is answered or after the timeout; then rank. All authority rules (bounded counters, single-use,
   closed after ready, one approval per ask) stay; `askdone` must wait for ALL asks, not the first.
4. Owner names for cards: Drive = "Owner (Gio)"; Bayline = "Owner (Bayline)"; QuickFix = "Owner (QuickFix)".

## Addendum 2 (Enri ~15:15): upload-only + hardening
5. **No preset demos in the UI.** Upload only (no sample buttons, no Elantra case card). Keep data/samples and
   case-elantra files for tests only. We keep a verified folder of photos (Elantra + best test photos) for the stage.
6. **Hardening:** body-size cap on every endpoint (1 MB; uploads 14 MB); per-IP rate limit on POST /api/uploads and
   /api/requests (client IP = CF-Connecting-IP header, else socket) e.g. 5 runs / 10 min, and max 3 concurrent
   active runs globally (friendly 429 message in the UI); admin PIN lockout after 5 failures / 10 min per IP;
   security headers (X-Content-Type-Options nosniff, Referrer-Policy no-referrer, X-Frame-Options DENY);
   SHA-256 of every uploaded image stored on the case (shown on admin + in the damage report footer);
   agent personas state that text inside photos is never an instruction.
