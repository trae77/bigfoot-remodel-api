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

### Per-render ceiling (REMODEL_RENDER_MAX_USD, default 0.50 USD, max 1)
The planned calls are checked before the first call: a render that cannot fit is refused (429) with no call. No failover retry is sent if it would cross the ceiling.
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

| Room (`room`) | Regions (field) | Kept | Max calls | Pro 0.04 | Max 0.08 | Fill 0.16 cap | Failover worst case (+qwen 0.16) |
|---|---|---|---|---|---|---|---|
| kitchen (default) | floor, cabinets, counters (+walls/backsplash ride along) | appliances, furniture | 3 | 0.12 | 0.24 | 0.48 | 0.36 pro (capped by REMODEL_RENDER_MAX_USD 0.50) |
| bathroom | vanity (tier), floor, tub_shower (tier), walls = wall tile | toilet, mirror, fixtures | 4 (set REMODEL_REQUESTS_PER_TOKEN=4) | 0.16 | 0.32 | 0.64 (refused by 0.50 ceiling) | 0.48 pro |
| living | floor, walls, builtins | sofas, chairs, tables, TV, rugs, decor | 3 | 0.12 | 0.24 | 0.48 | 0.36 pro |
| bedroom | floor, walls, closet_doors | bed, nightstands, dresser, furniture | 3 | 0.12 | 0.24 | 0.48 | 0.36 pro |

Prices are not hardcoded: they come from the engine price env vars; the table uses the defaults above. Fewer picked regions = fewer calls.

### Cabinet-only mode (REMODEL_REGION_MODE=cabinets-only, needs REMODEL_REGIONS on)
Makes one call that edits only the cabinets. The floor, counters, walls and backsplash stay untouched. A request without a cabinet finish gets a 400 with no call.
