# bigfoot-remodel-api

Generate-only Free Render microservice for Big Foot Construction remodel preview stills (fal FLUX.1 Kontext).

- `GET /api/health` — `{ ok }`
- `POST /api/remodel/token` — short-lived HMAC token (allowed Origin required)
- `POST /api/remodel/generate` — Bearer signed token; per-IP + global daily caps

Requires `REMODEL_TOKEN_SECRET` (fails closed). See DEPLOY-NOTE-P1-3.md. Tests: `npm test`.

Set `FAL_KEY` on the host only. Never put the key in the SPA or Cloudflare Worker.
