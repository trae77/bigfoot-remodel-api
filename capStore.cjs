'use strict';
/**
 * Durable spend caps (global monthly, global daily, per-IP daily), counted in fal calls.
 * Production store: Cloudflare D1 over the REST API. Each key is reserved with ONE atomic statement
 * (conditional UPSERT ... RETURNING), so concurrent requests can never push a key past its limit.
 * Fails CLOSED: missing config, network error, timeout, non-2xx or malformed reply -> CapStoreError -> 503.
 * Periods are UTC (day = YYYY-MM-DD, month = YYYY-MM). Raw IPs are never stored (HMAC'd by the caller).
 */

class CapStoreError extends Error {}

const RESERVE_SQL =
  'INSERT INTO remodel_caps (k, n) SELECT ?1, ?2 WHERE ?2 <= ?3 ' +
  'ON CONFLICT(k) DO UPDATE SET n = n + excluded.n WHERE n + excluded.n <= ?3 RETURNING n';
const RELEASE_SQL = 'UPDATE remodel_caps SET n = MAX(n - ?2, 0) WHERE k = ?1';
const SCHEMA_SQL = 'CREATE TABLE IF NOT EXISTS remodel_caps (k TEXT PRIMARY KEY, n INTEGER NOT NULL CHECK (n >= 0))';

function periodKeys(now = Date.now()) {
  const iso = new Date(now).toISOString();
  return { day: iso.slice(0, 10), month: iso.slice(0, 7) };
}

/** D1 via https://api.cloudflare.com/client/v4/accounts/{acct}/d1/database/{db}/query. Token: D1 Edit on this account only. */
function createD1CapStore({ accountId, databaseId, token, fetchImpl = fetch, timeoutMs = 2000 }) {
  const ok = /^[a-f0-9]{32}$/.test(accountId || '') && /^[0-9a-f-]{36}$/.test(databaseId || '') && (token || '').length >= 20;
  const url = ok ? `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query` : '';
  async function q(sql, params) {
    if (!ok) throw new CapStoreError('cap store not configured');
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    let res, body;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, params }),
        signal: ac.signal,
      });
      body = await res.json();
    } catch (_e) {
      throw new CapStoreError('cap store unreachable');
    } finally {
      clearTimeout(t);
    }
    const r = body && body.success === true && Array.isArray(body.result) && body.result[0];
    if (!res.ok || !r || r.success !== true || !Array.isArray(r.results)) throw new CapStoreError('cap store bad reply');
    return r.results;
  }
  return {
    kind: 'd1',
    async reserve(key, n, limit) {
      const rows = await q(RESERVE_SQL, [key, n, limit]);
      if (rows.length === 0) return false;
      const v = rows[0] && rows[0].n;
      if (!Number.isInteger(v) || v < n || v > limit) throw new CapStoreError('cap store bad value');
      return true;
    },
    async release(key, n) { await q(RELEASE_SQL, [key, n]); },
    async init() { await q(SCHEMA_SQL, []); },
  };
}

/** Dev/test store with the same atomic semantics. `backing` may be shared to simulate a restart against one store. */
function createMemoryCapStore(backing = new Map()) {
  return {
    kind: 'memory',
    backing,
    async reserve(key, n, limit) {
      const cur = backing.get(key) || 0;
      if (cur + n > limit) return false;
      backing.set(key, cur + n);
      return true;
    },
    async release(key, n) { backing.set(key, Math.max((backing.get(key) || 0) - n, 0)); },
    peek(key) { return backing.get(key) || 0; },
    /** Test helper: 'global' = today's global day count; 'ip:*' = sum of today's per-IP counts. */
    get(name) {
      const { day } = periodKeys();
      if (name === 'global') return this.peek(`d:${day}:global`);
      let t = 0; for (const [k, v] of backing) if (k.startsWith(`d:${day}:ip:`)) t += v; return t;
    },
    total() { let s = 0; for (const v of backing.values()) s += v; return s; },
  };
}

function capStoreFromEnv(env = process.env, fetchImpl) {
  if ((env.REMODEL_CAPS_STORE || '').trim() === 'memory') return createMemoryCapStore();
  return createD1CapStore({
    accountId: (env.REMODEL_CAPS_D1_ACCOUNT_ID || '').trim(),
    databaseId: (env.REMODEL_CAPS_D1_DATABASE_ID || '').trim(),
    token: (env.REMODEL_CAPS_D1_TOKEN || '').trim(),
    fetchImpl,
  });
}

/** Reserve n slots on every [key, limit] in order; all-or-nothing. Returns {ok:true} | {ok:false, which}. Throws CapStoreError. */
async function reserveAll(store, items, n) {
  const done = [];
  try {
    for (const [key, limit, which] of items) {
      if (!(await store.reserve(key, n, limit))) {
        await releaseAll(store, done, n);
        return { ok: false, which };
      }
      done.push(key);
    }
    return { ok: true };
  } catch (e) {
    await releaseAll(store, done, n);
    throw e instanceof CapStoreError ? e : new CapStoreError('cap store error');
  }
}
async function releaseAll(store, keys, n) {
  // Best effort. If a release fails the slot stays used: errs toward less spend.
  for (const k of keys) { try { await store.release(k, n); } catch (_e) { /* fail-safe */ } }
}

/** REMODEL_MONTHLY_USD_CAP in cents (default 10 USD, well under the prepaid balance). Invalid, <= 0 or above 19 USD falls back to 10 USD. */
function monthlyUsdCapCents(env = process.env) {
  const n = Number(String(env.REMODEL_MONTHLY_USD_CAP || '').trim());
  return Math.round((Number.isFinite(n) && n > 0 && n <= 19 ? n : 10) * 100);
}
module.exports = { monthlyUsdCapCents, CapStoreError, createD1CapStore, createMemoryCapStore, capStoreFromEnv, reserveAll, releaseAll, periodKeys, RESERVE_SQL, SCHEMA_SQL };
