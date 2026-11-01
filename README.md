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
- fal delete needs a fal key with `models:requests:write` + `assets:write` (fal "FULL" preset). If the key lacks them, the delete fails, a warning is logged (no URL), and fal's copy stays at an unguessable public URL until fal's own expiry. The client still never sees it.
- Tests mock fal (`test/image-privacy.test.cjs`). No real renders.
