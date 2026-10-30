# Deploy note: P1-3 hardening (draft, not deployed)

Nothing here has been deployed. Render env vars were not changed. Deploying this **without** setting
`REMODEL_TOKEN_SECRET` makes the API fail closed (503 on every /api/remodel/* call). That's intentional.

## What changed
- Pattern-based bearer tokens (`preview-*`, `demo-*`, `owner-*`) are no longer accepted.
- `POST /api/remodel/token` issues a 30-minute HMAC-SHA256 token bound to the request Origin and client IP.
- Every `/api/remodel/*` request (including preflight) needs an `Origin` on the allowlist. A missing Origin gets 403.
  The allowlist defaults to `https://bigfoot-preview.ttawebdev.com` only, and localhost is no longer allowed by default.
- Daily caps (UTC day, in memory) are keyed on client IP and global, never on the token. A slot is reserved before fal is called.
- `/api/health` no longer reports `falConfigured`.
- Fails closed if `REMODEL_TOKEN_SECRET` is missing or shorter than 32 characters.

## Env vars William must set on Render (bigfoot-remodel-api)
| Var | Required | Value |
|---|---|---|
| `REMODEL_TOKEN_SECRET` | **yes** | random, 32+ chars: `openssl rand -base64 48` |
| `CORS_ORIGINS` | optional | default `https://bigfoot-preview.ttawebdev.com`. If it's set today with localhost entries, **remove those** |
| `REMODEL_PER_IP_DAILY` | optional | default 5 generates/IP/day |
| `REMODEL_GLOBAL_DAILY` | optional | default 25 generates/day total (about $1.00/day at $0.04) |
| `REMODEL_TOKENS_PER_IP_DAILY` | optional | default 10 |
| `REMODEL_SERVICE_TOKEN` | optional | only for a server-side caller (e.g. a Worker). 32+ chars, and it still needs an allowed Origin |
| `REMODEL_PREVIEW_TOKEN` | **delete** | no longer read |

The fal key vars (`FAL_KEY_A`/`FAL_KEY_B` etc.) stay as they are.

## Front-end change needed (bigfoot-preview SPA)
Before generating, call `POST https://bigfoot-remodel-api.onrender.com/api/remodel/token` (browser fetch, so Origin is sent),
then send `Authorization: Bearer <token>` on `/api/remodel/generate`. Fetch a new token on a 401.
Until the SPA is updated, the remodel preview will return 401 after deploy.

## Strongly recommended: fal spend limit
In the fal dashboard (Billing / Usage limits), set a monthly spend cap (e.g. $10) and a low auto-top-up
(or turn auto-top-up off). The in-memory caps reset when the free Render instance restarts, so the fal-side limit is the hard backstop.
Rotating the fal key after deploy is also worth considering, since the old API was open.

## Residual risks
- Origin can be forged by non-browser clients, so the IP and global caps are what actually bound spend. An attacker with many IPs is held to the global cap.
- Counters are in memory and reset on restart or redeploy.
- Client IP comes from the rightmost `X-Forwarded-For` entry, as appended by Render's proxy. Verify this after deploy.

## Deploy steps
1. Set `REMODEL_TOKEN_SECRET` (and review `CORS_ORIGINS`) on Render, and delete `REMODEL_PREVIEW_TOKEN`.
2. Set the fal dashboard spend limit.
3. Merge the PR and let Render deploy. Then run `curl -s -X POST .../api/remodel/token` (no Origin), which should return 403,
   and the same call with `-H 'Origin: https://bigfoot-preview.ttawebdev.com'`, which should return 200 with a token.
4. Ship the SPA token-fetch change, and QA re-checks P1-3.
