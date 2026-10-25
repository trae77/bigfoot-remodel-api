# bigfoot-remodel-api

Generate-only Free Render microservice for Big Foot Construction remodel preview stills (fal FLUX.1 Kontext).

- `GET /api/health` — `{ ok, falConfigured }`
- `POST /api/remodel/generate` — Bearer preview/demo/owner token; session cap 5 / ~$0.25

Set `FAL_KEY` on the host only. Never put the key in the SPA or Cloudflare Worker.
