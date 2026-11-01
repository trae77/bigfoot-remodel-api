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

| `REMODEL_REQUESTS_PER_TOKEN` | optional | default 3 generates per token, then the page fetches a new token |
| `FAL_KEY` | **yes** | the rotated fal key, as a single Render secret. **This is now the only key var read.** |
| `FAL_KEY_A`, `FAL_KEY_B`, `FAL_KEY_B64`, `FAL_API_KEY`, `REMODEL_AI_API_KEY` | **delete** | no longer read (QA P3: split-key pattern removed) |

`REMODEL_TOKEN_SECRET` and `REMODEL_SERVICE_TOKEN` must be 32+ chars with at least 12 distinct characters and no run
of 6+ identical characters, or the API fails closed. `openssl rand -base64 48` passes.

## Front-end change needed (bigfoot-preview SPA)
Before generating, call `POST https://bigfoot-remodel-api.onrender.com/api/remodel/token` (browser fetch, so Origin is sent),
then send `Authorization: Bearer <token>` on `/api/remodel/generate`. Fetch a new token on a 401.
Until the SPA is updated, the remodel preview will return 401 after deploy.

## QA punch 2026-10-31 fixes (this branch)
- CORS: every `/api` route, `/api/health` included, echoes `Access-Control-Allow-Origin` for an allowlisted Origin only.
  Preflight allows `Authorization, Content-Type, X-Remodel-Session`. No credentials header is sent.
- Image: only `data:image/(jpeg|png|webp);base64,...` whose magic bytes match the type. URLs, `file://`, metadata IPs,
  relative paths, HTML, SVG and EXE are refused with 400 before fal. Max ~7 MB decoded.
- Prompt: room must be one of the page's rooms; finishes are 4 known string fields, 100 chars each, plain characters only;
  the final prompt is capped at 1,000 chars.
- Bad requests are rejected **before** any cap is counted, so junk can't lock out real users.
- Body over 10 MB gives 413; bad JSON gives 400.
- Per-token allowance (default 3), on top of the per-IP and global daily caps.

## Required: fal spend limit (this is the real bound)
The in-code caps are in memory and reset whenever the free Render instance restarts or sleeps, so they are **not** a hard
daily bound (25 × $0.04 = $1.00 per process lifetime, not per day). **The fal-side spend cap is the real bound.**
Ops is setting it: $10 cap, auto-top-up off, key rotated into Render's `FAL_KEY`. Don't resume the service before that's done.
In the fal dashboard (Billing / Usage limits), set a monthly spend cap (e.g. $10) and a low auto-top-up
(or turn auto-top-up off). The in-memory caps reset when the free Render instance restarts, so the fal-side limit is the hard backstop.
Rotating the fal key after deploy is also worth considering, since the old API was open.

## Residual risks
- Origin can be forged by non-browser clients, so the IP and global caps are what actually bound spend. An attacker with many IPs is held to the global cap.
- Counters are in memory and reset on restart or redeploy (see the fal cap above).
- Client IP comes from the rightmost `X-Forwarded-For` entry, as appended by Render's proxy. Anything left of it is client-supplied and ignored. A direct hit that bypasses Render's proxy could spoof it, which can't happen on Render. Verify after deploy.

## Deploy steps
1. Set `REMODEL_TOKEN_SECRET` (and review `CORS_ORIGINS`) on Render, and delete `REMODEL_PREVIEW_TOKEN`.
2. Ops: fal spend cap, auto-top-up off, rotated key in `FAL_KEY`, old key vars deleted.
3. Merge the PR and let Render deploy. Then run `curl -s -X POST .../api/remodel/token` (no Origin), which should return 403,
   and the same call with `-H 'Origin: https://bigfoot-preview.ttawebdev.com'`, which should return 200 with a token.
4. Ship the SPA token-fetch change, and QA re-checks P1-3.
