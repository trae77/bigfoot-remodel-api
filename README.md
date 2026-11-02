# bigfoot-remodel-api

Generate-only Free Render microservice for Big Foot Construction remodel preview stills (fal FLUX.1 Kontext).

- `GET /api/health` — `{ ok }`
- `POST /api/remodel/token` — short-lived HMAC token (allowed Origin required)
- `POST /api/remodel/generate` — Bearer signed token; per-IP + global daily caps

Requires `REMODEL_TOKEN_SECRET` (fails closed). See DEPLOY-NOTE-P1-3.md. Tests: `npm test`.

Set `FAL_KEY` on the host only (the only key var read; see DEPLOY-NOTE-P1-3.md). Never put the key in the SPA or Cloudflare Worker.

## Responses
- No cost or price fields are returned (`estimatedCostUsd` removed).
- Unknown routes return JSON `404 {"error":"Not found"}`. All responses send HSTS and `X-Content-Type-Options: nosniff`.
- Output images: fal's raw output lives at a **public, unguessable fal CDN URL** until deleted. See "Image privacy" below for how the API keeps that URL away from clients.

## Image privacy (CEO security ruling 10/31)
- After a generate, the server downloads the render from fal (https `*.fal.media` only, image types only, 10 MB max, no redirects) into **private in-process memory** (`imageStore.cjs`), then calls fal's `DELETE /v1/models/requests/{request_id}/payloads` to remove fal's copy.
- The client gets only `afterImageUrl` = `/api/remodel/image/<random id>?exp=&sig=` (HMAC-SHA256 with `REMODEL_TOKEN_SECRET`, **15 min max**). There's no IP, email, project or prompt in the URL. `Cache-Control: private, no-store`. The fal URL is never returned.
- Retention: deleted at TTL (15 min default, hard cap 7 days) by a 60 s sweep. Memory is also wiped whenever the free instance sleeps or restarts. Capped at 50 images / 60 MB.
- Storage cost: $0 (Render free instance RAM). No bucket, no new account. R2/S3 were not used because they need a billing setup.
- fal delete needs a fal key with `models:requests:write` + `assets:write` (fal "FULL" preset). If the key lacks them, the delete fails, an `ALERT fal_payload_delete_failed` error is logged (no URL, key or id; per-file failures in a 200 also count), and fal's copy stays at an unguessable public URL until fal's own expiry. The client still never sees it.
- Tests mock fal (`test/image-privacy.test.cjs`). No real renders.

## Region targeting (REMODEL_REGIONS, default OFF)
One fal call per changed region: floor, then cabinets, then counters (walls/backsplash ride on the last pass).
Each prompt edits one region only, excludes tables, chairs, stools and other furniture, and the floor pass carries
an anti-stripe guard. Engines (`engines.cjs`): `kontext` (default, prompt-scoped, no mask) and `fill`
(fal FLUX pro fill with a free heuristic band mask; only enabled when `REMODEL_FILL_USD` is set from fal's price page).
Every call is reserved in the D1 caps before the first one goes out. Max 3 calls per render: $0.12 on Kontext pro, $0.24 on Kontext max ($0.08/call), and at most $0.48 on fill (REMODEL_FILL_USD is hard-capped at $0.16/call; above that fill is refused with 503). Regions OFF always uses Kontext. A monthly dollar cap (REMODEL_MONTHLY_USD_CAP, default $10) is reserved in D1 per call before any fal call.

### Declutter pre-pass (REMODEL_DECLUTTER, default OFF; minimal stub, lowered scores in AI Bot's A/B, keep OFF)
One extra call first: removes loose items on the counters and free-standing furniture in the middle of the room (dining table, chairs, stools, rugs).
Walls, windows, cabinets and appliances stay. The remodel passes then run on the cleared image. The call is reserved up front in the D1 count caps and the monthly dollar cap.

### Failover (REMODEL_FAILOVER, default OFF)
Kontext runs first. If a call errors or times out (REMODEL_ENGINE_TIMEOUT_MS, default 60000), that call is retried once on fal Qwen-Image-Edit inpaint.
The retry uses a structure guard prompt and the region mask. It only works when REMODEL_QWEN_USD is set (0 < x <= 0.16), from fal's price page; no price is hard-coded.
Before the retry goes out, it is reserved atomically on the monthly, daily and per-IP caps, the per-token allowance, the session limit and the monthly dollar cap. The failed Kontext attempt is charged too, since it may have billed.

### Per-render ceiling (REMODEL_RENDER_MAX_USD, default 0.50 USD, clamped to 1.00)
ONE setting (security.cjs, from #14). The planned calls x the selected engine's per-call price are checked in capGate before any reservation: a render that cannot fit is refused (400) with no call. The in-handler per-call check reads the same setting. No failover retry is sent if it would cross the ceiling.
Note: the per-token allowance (REMODEL_REQUESTS_PER_TOKEN, default 3) must be at least the call count, or multi-call renders get a 401. Use 4 with declutter + regions, or 8 with failover too.

### Worst-case calls and dollars per render (Kontext pro 0.04, Kontext max 0.08, fill/qwen at most 0.16 per call)
| Flags | Calls | Pro | Max | Fill (at 0.16) |
|---|---|---|---|---|
| all OFF (two-pass) | 2 | 0.08 | 0.16 | n/a |
| DECLUTTER | 3 | 0.12 | 0.24 | n/a |
| REGIONS | 3 | 0.12 | 0.24 | 0.48 |
| REGIONS + REMODEL_REGION_MODE=cabinets-only | 1 | 0.04 | 0.08 | 0.16 |
| REGIONS + DECLUTTER | 4 | 0.16 | 0.32 | 0.64, refused at the 0.50 ceiling |
| + FAILOVER (qwen at 0.16) | up to 2x calls | capped at the 0.50 ceiling | capped at 0.50 | fill has no failover |

### Room presets (REMODEL_ROOM_PRESETS, default OFF, needs REMODEL_REGIONS on)

Kitchen keeps the floor/cabinets/counters plan. Other rooms get their own regions, one cap-counted call per region the user picked. Every prompt has the keep-objects line plus a room keep line. No exterior/siding preset.

| Room (`room`) | Regions (field) | Kept | Max calls | Pro 0.04 | Max 0.08 | Fill 0.16 cap | Failover (each failed call +0.16 qwen) |
|---|---|---|---|---|---|---|---|
| kitchen (default) | floor, cabinets, counters (+walls/backsplash ride along) | appliances, furniture | 3 | 0.12 | 0.24 | 0.48 | stopped at REMODEL_RENDER_MAX_USD (default 0.50) |
| bathroom | vanity (tier), floor, tub_shower (tier); walls = wall tile rides along on the last call | toilet, mirror, fixtures | 3 (fits default REMODEL_REQUESTS_PER_TOKEN=3) | 0.12 | 0.24 | 0.48 | stopped at REMODEL_RENDER_MAX_USD (default 0.50) |
| living | floor, walls, builtins | sofas, chairs, tables, TV, rugs, decor | 3 | 0.12 | 0.24 | 0.48 | stopped at REMODEL_RENDER_MAX_USD (default 0.50) |
| bedroom | floor, walls, closet_doors | bed, nightstands, dresser, furniture | 3 | 0.12 | 0.24 | 0.48 | stopped at REMODEL_RENDER_MAX_USD (default 0.50) |

Prices are not hardcoded: they come from the engine price env vars; the table uses the defaults above. Fewer picked regions = fewer calls.

### Cabinet-only mode (REMODEL_REGION_MODE=cabinets-only, needs REMODEL_REGIONS on)
Makes one call that edits only the cabinets. The floor, counters, walls and backsplash stay untouched. A request without a cabinet finish gets a 400 with no call.
## Operator test bypass (REMODEL_TEST_TOKEN)
Off unless `REMODEL_TEST_TOKEN` is set to a strong secret (32+ chars). An operator sends it in the
`X-Remodel-Test-Token` header on `POST /api/remodel/generate`; no Origin or session token is needed.
It skips ONLY the Origin allowlist and the IP/Origin-bound session token (the box's egress IP changes per
connection, which broke scripted renders with 401s). Everything else still runs: validation, metadata strip,
the per-render $ ceiling (`REMODEL_RENDER_MAX_USD`, default 0.50), D1 month/day/IP caps (fail closed), one
shared session $ budget for all bypass renders, `X-Fal-Store-IO: 0` and private storage. A wrong token gets 401
before any reservation. The secret is compared in constant time and never logged; only `test_bypass_used` is.
Unset the var to disable.

## Launch recipe (William via CEO, 2026-11-02)
Source: AI Bot's 12-photo test, /workspace/remodel-test/ab/t12/ (run12.py, scores_12.csv): arm A Kontext pro two-pass, arm B Fill, arm C Kontext max.
- **Kontext pro two-pass** (default: REMODEL_TWO_PASS on, REMODEL_FAL_MODEL unset = pro): floor first, then the other finishes.
- **Keep rugs and mats**: every prompt's keep line names rugs and mats (t12 floor passes removed a rug and bath mats); the floor guard no longer says "no rug".
- **Recipe spec (AI Bot, 2026-11-02, `recipe-spec.md`)**:
  - **Base keep-list on every call**: all appliances, counter items, shelf items, furniture, rugs, mats, towels, lighting and windows are kept; "change only the {targets}".
  - **Hard photo** = `hardPhoto: true` (strict boolean, default false) OR the worker's own signals, computed with sharp at 256 px before any cap or paid call: busy_dark (edge >= `HARD_EDGE_MIN` 0.17 AND dark share >= `HARD_DARK_MIN` 0.14), panorama (aspect >= `HARD_ASPECT_MAX` 2.0, also returns a crop warning), tall_narrow (aspect <= `HARD_ASPECT_MIN` 0.70). Low light alone is not hard. Hard adds the extended keep-list ("do not remove, tidy or restyle anything; same camera framing; same floor coverings") and "clearly" wording. If that alone would push a call past 1200 chars, the base prompt is sent instead.
  - **Engine for hard photos**: `REMODEL_HARD_ENGINE` defaults to `kontext-pro`. Kontext max (0.08/call) runs only when `REMODEL_HARD_ENGINE=kontext-max` AND `REMODEL_MAX_ON_HARD=1` (exactly '1'; anything else = off). Env can never select max for normal photos.
  - **Paint colors**: `colorHex` (`#RRGGBB`; `paintHex` is the old name) wins over `colorText` (max 60 chars, same word filter as finishes). Text is matched to our own 30-color generic palette (`palette/palette.json`, CC0, approximate preview colors, not any manufacturer's color), then CSS named colors; no match keeps the text and returns `colorMatch: "none"`. The walls get "repaint the walls {color} ({hex}), a muted matte paint".
  - **Brand aliases OFF**: `PALETTE_BRAND_ALIASES` is off unless exactly '1'. Off, brand color names are dropped from the text before matching, so they never reach the prompt or the response. Colors are approximate previews, not manufacturer matches.
  - **Response `meta`**: `hard`, `hardReasons`, `signals` (w, h, aspect, darkFrac, edgeDensity), `engine`, `warning`, `colorMatch`, `colorId`, `colorHexUsed`.
- **Fill dropped**: REMODEL_REGION_ENGINE=fill runs Kontext unless REMODEL_FILL_ENABLE is exactly '1' (plus a valid REMODEL_FILL_USD).

## Flags and image-safety notes (QA punch PR #15)
- Strict flags (`REMODEL_MAX_ON_HARD`, `REMODEL_FILL_ENABLE`, `PALETTE_BRAND_ALIASES`): ON only when the value is exactly `1` after trimming whitespace. `true`, `yes`, `01`, unset = OFF.
- Kontext max on hard photos is **OFF in prod** unless BOTH `REMODEL_MAX_ON_HARD=1` AND `REMODEL_HARD_ENGINE=kontext-max` are set (behaviour change: before PR #15 max-on-hard defaulted on). Otherwise hard photos use kontext-pro.
- `meta.colorMatch` is `brand_dropped` when colorText was only a paint-brand name and brand aliases are off; it is ignored (no phrase).
- Hard-photo signals (sharp ^0.35.5): magic-byte check allows only jpeg/png/webp; a header-only `metadata()` probe rejects images over 40 MP (`limitInputPixels`) before any full decode; libvips cache off, concurrency 1. Any failure = signals null (client flag only). Keeps memory bounded on Render's 512 MB plan.
