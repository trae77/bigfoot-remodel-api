/**
 * P1-3 hardening: signed short-lived tokens, strict Origin allowlist, per-IP + global daily caps.
 * Fails closed when REMODEL_TOKEN_SECRET is missing or weak. Never log secrets or tokens.
 */
const crypto = require('crypto');

const DEFAULT_ORIGINS = 'https://bigfoot-preview.ttawebdev.com';
const TOKEN_TTL_SEC = 30 * 60;
const MIN_SECRET_LEN = 32;
const MIN_SECRET_DISTINCT = 12;
const MAX_REQUESTS_PER_TOKEN = 3;

/** 32+ chars with real variety: rejects 'aaaa…', 'abababab…' and other low-entropy strings. */
function isStrongSecret(s) {
  if (typeof s !== 'string' || s.length < MIN_SECRET_LEN) return false;
  if (new Set(s).size < MIN_SECRET_DISTINCT) return false;
  if (/(.)\1{5,}/.test(s)) return false; // a run of 6+ identical characters
  return true;
}

function intEnv(name, dflt) {
  const n = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

function getConfig() {
  const secret = (process.env.REMODEL_TOKEN_SECRET || '').trim();
  const serviceToken = (process.env.REMODEL_SERVICE_TOKEN || '').trim();
  return {
    secret: isStrongSecret(secret) ? secret : '',
    serviceToken: isStrongSecret(serviceToken) ? serviceToken : '',
    origins: new Set(
      (process.env.CORS_ORIGINS || DEFAULT_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean)
    ),
    perIpDaily: intEnv('REMODEL_PER_IP_DAILY', 5),
    globalDaily: intEnv('REMODEL_GLOBAL_DAILY', 25),
    tokensPerIpDaily: intEnv('REMODEL_TOKENS_PER_IP_DAILY', 10),
    perTokenMax: intEnv('REMODEL_REQUESTS_PER_TOKEN', MAX_REQUESTS_PER_TOKEN),
  };
}

function clientIp(req) {
  // Trust only the hop Render's proxy appends: the RIGHTMOST X-Forwarded-For entry.
  // Anything to its left is client-supplied and ignored. Without XFF (direct hit), use the socket.
  const xff = (req.headers['x-forwarded-for'] || '').toString().split(',').map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : (req.socket && req.socket.remoteAddress) || 'unknown';
}

function ipHash(secret, ip) {
  return crypto.createHmac('sha256', secret).update('ip:' + ip).digest('base64url').slice(0, 16);
}

function sign(secret, payloadB64) {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

function issueToken(secret, { ip, origin, now = Date.now() }) {
  const payload = {
    v: 1,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + TOKEN_TTL_SEC,
    o: origin,
    ip: ipHash(secret, ip),
    n: crypto.randomBytes(9).toString('base64url'),
  };
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `rt1.${p}.${sign(secret, p)}`;
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** @returns {object|null} payload when valid */
function verifyToken(secret, token, { ip, origin, now = Date.now() }) {
  if (!secret || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'rt1') return null;
  if (!safeEqual(sign(secret, parts[1]), parts[2])) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || payload.v !== 1 || typeof payload.n !== 'string') return null;
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) return null;
  if (payload.o !== origin) return null;
  if (payload.ip !== ipHash(secret, ip)) return null;
  return payload;
}

/** UTC-day counters. Keyed on IP and global, never on token, so minting new tokens can't reset them. */
function createDailyCounter() {
  let day = '';
  const map = new Map();
  function roll(now) {
    const d = new Date(now).toISOString().slice(0, 10);
    if (d !== day) {
      day = d;
      map.clear();
    }
  }
  return {
    get(key, now = Date.now()) {
      roll(now);
      return map.get(key) || 0;
    },
    inc(key, now = Date.now()) {
      roll(now);
      map.set(key, (map.get(key) || 0) + 1);
    },
    reset() {
      map.clear();
      day = '';
    },
  };
}

/** Per-token use counts keyed on the token nonce; entries are dropped after the token expires. */
function createTokenUseTracker() {
  const map = new Map();
  function prune(now) {
    for (const [k, v] of map) if (v.exp * 1000 <= now) map.delete(k);
  }
  return {
    /** Reserve n uses (one per fal call). Returns false, reserving nothing, when they don't all fit the allowance. */
    take(payload, max, now = Date.now(), n = 1) {
      if (map.size > 5000) prune(now);
      const row = map.get(payload.n) || { count: 0, exp: payload.exp };
      if (row.count + n > max) return false;
      row.count += n;
      map.set(payload.n, row);
      return true;
    },
    size() { return map.size; },
  };
}

module.exports = {
  TOKEN_TTL_SEC,
  MAX_REQUESTS_PER_TOKEN,
  isStrongSecret,
  createTokenUseTracker,
  MIN_SECRET_LEN,
  getConfig,
  clientIp,
  issueToken,
  verifyToken,
  safeEqual,
  createDailyCounter,
};
