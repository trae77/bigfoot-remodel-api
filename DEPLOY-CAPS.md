# Durable caps setup (D1, free tier). Do at deploy time, before REMODEL_LIVE.

Store: Cloudflare D1 database `remodel-caps` (free), table `remodel_caps(k TEXT PRIMARY KEY, n INTEGER >= 0)`.
Keys: `m:YYYY-MM:global` (120/month), `d:YYYY-MM-DD:global` (25/day), `d:YYYY-MM-DD:ip:<HMAC>` (5/IP/day). Periods are UTC. Raw IPs are never stored.
Each reservation is one atomic `INSERT ... ON CONFLICT DO UPDATE ... WHERE n+x<=limit RETURNING n`, so it can't overshoot under concurrency.
It fails CLOSED with a 503 and no fal call when the store is missing, misconfigured, unreachable, slow (2 s timeout) or returns garbage.

1. `npx wrangler d1 create remodel-caps` and note the database_id.
2. `npx wrangler d1 execute remodel-caps --remote --command "CREATE TABLE IF NOT EXISTS remodel_caps (k TEXT PRIMARY KEY, n INTEGER NOT NULL CHECK (n >= 0))"`
3. Cloudflare dashboard > API Tokens > Custom token: permission **Account · D1 · Edit**, scoped to this account only, with no other permissions. William does this, or someone with dashboard access.
4. Render srv-dbekp9bncjis73eir3ng > Environment. Paste the values into the dashboard and never print them:
   - `REMODEL_CAPS_D1_ACCOUNT_ID` (32-hex account id)
   - `REMODEL_CAPS_D1_DATABASE_ID` (from step 1)
   - `REMODEL_CAPS_D1_TOKEN` (secret, from step 3)
   - Optional: `REMODEL_GLOBAL_MONTHLY` (default 120). Leave `REMODEL_GLOBAL_DAILY` (25) and `REMODEL_PER_IP_DAILY` (5) as they are.
   - Do NOT set `REMODEL_CAPS_STORE=memory` in production. It's for tests only.
5. Deploy. Check a generate returns 401 or 400 (not 503) for a junk token or body. QA runs the one live render.

Rollback: Render rollback to the previous deploy. Without the D1 env vars this build returns 503 on every generate, which is safe: it can't spend.
