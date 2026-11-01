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
