/**
 * Free Render generate-only microservice for Big Foot remodel preview.
 * No SQLite. FAL_KEY server-only. Never log the key, the token secret, or tokens.
 * P1-3 hardening: signed short-lived tokens, strict Origin, per-IP + global daily caps, fail closed.
 */
const express = require('express');
const {
  createRemodelGenerateHandler,
  getFalKey,
  validateGenerateBody,
  validateGenerateRequest,
  HONESTY,
  planCalls,
  selectEngine,
  resolvedConfig,
} = require('./remodelGenerate.cjs');

const BODY_LIMIT = '10mb';
const sec = require('./security.cjs');

function createApp(opts = {}) {
  const caps = require('./capStore.cjs');
  const capStore = opts.capStore || caps.capStoreFromEnv(process.env);
  const tokenCounter = opts.tokenCounter || sec.createDailyCounter();
  const badTokens = opts.badTokenLimiter || sec.createBadTokenLimiter();
  const tokenUses = opts.tokenUses || sec.createTokenUseTracker();
  const imageStore = opts.imageStore || require('./imageStore.cjs').createImageStore();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  // Baseline security headers on every response.
  app.use((_req, res, next) => {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    return next();
  });

  // CORS on every /api route (health included): echo only an allowlisted Origin, never credentials.
  app.use('/api', (req, res, next) => {
    const cfg = sec.getConfig();
    const origin = (req.headers.origin || '').toString();
    res.set('Vary', 'Origin');
    if (origin && cfg.origins.has(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Remodel-Session');
      res.set('Access-Control-Max-Age', '600');
    }
    req.remodelCfg = cfg;
    return next();
  });

  // Health: open to Render's health check (no Origin) and to allowed origins; a foreign Origin gets no ACAO.
  app.options('/api/health', (req, res) => res.status(req.headers.origin && !req.remodelCfg.origins.has(req.headers.origin) ? 403 : 204).end());
  app.get('/api/health', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, service: 'bigfoot-remodel-api' });
  });

  // Private render download: HMAC-signed, <=15 min, random id only. No Origin needed (used in <img src>).
  app.get('/api/remodel/image/:id', (req, res) => {
    const cfg = sec.getConfig();
    const { exp, sig } = req.query;
    if (!require('./imageStore.cjs').verifyImageSig(cfg.secret, req.params.id, exp, String(sig || ''))) {
      return res.status(403).json({ error: 'Link expired or invalid', honesty: HONESTY });
    }
    const e = imageStore.get(req.params.id);
    if (!e) return res.status(404).json({ error: 'Not found', honesty: HONESTY });
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Type', e.type);
    return res.send(e.buf);
  });
  const sweepTimer = setInterval(() => imageStore.sweep(), 60 * 1000);
  if (sweepTimer.unref) sweepTimer.unref();
  app.stopSweep = () => clearInterval(sweepTimer);
  const listen = app.listen.bind(app);
  app.listen = (...a) => { const srv = listen(...a); srv.on('close', app.stopSweep); return srv; };

  // Token-gated test bypass (POST /api/remodel/generate only). Skips ONLY the Origin check and the
  // IP/Origin-bound session token. Validation, D1 month/day/IP caps, the per-render $ ceiling, the
  // session $ cap, EXIF strip and no-storage all still run. Disabled when REMODEL_TEST_TOKEN is unset/empty.
  app.use('/api/remodel/generate', (req, res, next) => {
    const cfg = req.remodelCfg;
    const given = req.headers[sec.TEST_TOKEN_HEADER];
    if (!cfg.testToken || given === undefined || req.method !== 'POST') return next();
    const ip = sec.clientIp(req);
    if (badTokens.blocked(ip)) {
      return res.status(429).json({ error: 'Too many attempts. Try again later.', honesty: HONESTY });
    }
    if (!sec.testTokenMatches(cfg.testToken, String(given))) {
      if (!badTokens.fail(ip)) return res.status(429).json({ error: 'Too many attempts. Try again later.', honesty: HONESTY });
      // Before any cap reservation. Never echo the header.
      return res.status(401).json({ error: 'Unauthorized', honesty: HONESTY });
    }
    if (!cfg.secret) return res.status(503).json({ error: 'Remodel API is not configured', honesty: HONESTY });
    req.remodelIp = sec.clientIp(req);
    req.remodelBypass = true;
    console.info('test_bypass_used');
    return next();
  });

  // Strict Origin gate on every /api/remodel/* request (incl. preflight). No Origin => 403.
  app.use('/api/remodel', (req, res, next) => {
    if (req.remodelBypass) return next();
    const cfg = req.remodelCfg;
    const origin = (req.headers.origin || '').toString();
    if (!origin || !cfg.origins.has(origin)) {
      return res.status(403).json({ error: 'Origin not allowed', honesty: HONESTY });
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (!cfg.secret) {
      return res.status(503).json({ error: 'Remodel API is not configured', honesty: HONESTY });
    }
    req.remodelIp = sec.clientIp(req);
    return next();
  });

  // 413 for oversized bodies, 400 for bad JSON (see error handler below).
  app.use(express.json({ limit: BODY_LIMIT }));

  // Issue a short-lived token bound to this Origin and client IP.
  app.post('/api/remodel/token', (req, res) => {
    const cfg = req.remodelCfg;
    const ip = req.remodelIp;
    if (tokenCounter.get(ip) >= cfg.tokensPerIpDaily) {
      return res.status(429).json({ error: 'Too many token requests today', honesty: HONESTY });
    }
    tokenCounter.inc(ip);
    const token = sec.issueToken(cfg.secret, { ip, origin: req.headers.origin });
    res.set('Cache-Control', 'no-store');
    return res.json({ token, expiresIn: sec.TOKEN_TTL_SEC });
  });

  function bearer(req) {
    const auth = (req.headers.authorization || '').toString();
    return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  }

  async function getClientFromToken(req) {
    const cfg = req.remodelCfg;
    if (!cfg || !cfg.secret) return null;
    if (req.remodelBypass) return { id: 0, role: 'test' };
    const token = bearer(req);
    if (!token) return null;
    if (cfg.serviceToken && sec.safeEqual(token, cfg.serviceToken)) {
      return { id: 0, role: 'service' };
    }
    const p = sec.verifyToken(cfg.secret, token, { ip: req.remodelIp, origin: req.headers.origin });
    return p ? { id: 0, role: 'preview', payload: p } : null;
  }

  // Reject malformed requests BEFORE any cap is touched, so junk can't lock out real users.
  async function validateGate(req, res, next) {
    let v;
    try { v = await validateGenerateRequest(req.body); } catch (_e) { return res.status(400).json({ error: 'Could not read the request', honesty: HONESTY }); }
    if (v.error) return res.status(v.status || 400).json({ error: v.error, honesty: HONESTY });
    req.remodelValid = v;
    return next();
  }

  // Daily caps checked before any fal call; counted per IP and globally, plus a per-token allowance.
  // Only valid requests reach here. A reserved slot stays used even if fal later fails: fail-safe for spend.
  async function capGate(req, res, next) {
    const cfg = req.remodelCfg;
    const p = req.remodelClient && req.remodelClient.payload;
    // Count fal calls, not generates: two-pass makes 2 calls and needs 2 slots, checked before the first call.
    const n = planCalls(req.remodelValid).length;
    const { day, month } = caps.periodKeys();
    const ipKey = sec.ipHash(cfg.secret, req.remodelIp);
    const capItems = [
      [`m:${month}:global`, cfg.globalMonthly, 'month'],
      [`d:${day}:global`, cfg.globalDaily, 'day'],
      [`d:${day}:ip:${ipKey}`, cfg.perIpDaily, 'ip'],
    ];
    const capKeys = capItems.map((x) => x[0]);
    const usdKey = `m:${month}:usd_cents`;
    const paused = () => res.status(503).json({ error: 'Previews are paused right now. Please try again later.', honesty: HONESTY });
    // QA R65 P2: every check that can refuse runs BEFORE any reservation, so a refusal reserves nothing.
    const engine = selectEngine(req.remodelValid);
    if (!engine) return paused();
    // The ONE per-render USD ceiling (#14, security.cjs, clamped to 1.00): refused with 400 before anything is
    // reserved, at the planned engine's real per-call price (Kontext pro 0.04, or max 0.08 on a hard photo).
    if (n * engine.usdPerCall() > cfg.renderMaxUsd + 1e-9) {
      return res.status(400).json({ error: 'Try fewer changes.', honesty: HONESTY });
    }
    if (n > cfg.perTokenMax) return res.status(429).json({ error: 'Try fewer changes', honesty: HONESTY });
    const cents = Math.ceil(engine.usdPerCall() * 100 - 1e-9) * n;
    // Token uses first (in-process, reversible); given back if any durable reservation then fails.
    if (p && !tokenUses.take(p, cfg.perTokenMax, Date.now(), n)) return res.status(401).json({ error: 'Token used up. Fetch a new one.', honesty: HONESTY });
    const giveToken = (k) => { if (p) tokenUses.give(p, k); };
    let r;
    try {
      // Durable, atomic, all-or-nothing reservation BEFORE any fal call. Fails closed on any store problem.
      r = await caps.reserveAll(capStore, capItems, n);
    } catch (_e) {
      giveToken(n);
      console.warn('remodel_cap_store_unavailable');
      return paused();
    }
    if (!r.ok) {
      giveToken(n);
      const msg = r.which === 'month' ? 'Monthly preview limit reached. Try again next month.'
        : r.which === 'ip' ? 'Daily preview limit reached for this network.' : 'Daily preview limit reached. Try again tomorrow.';
      return res.status(429).json({ error: msg, honesty: HONESTY });
    }
    // Monthly dollar cap (QA R64), in cents, reserved for every call at the engine's per-call price.
    let u;
    try { u = await caps.reserveAll(capStore, [[usdKey, caps.monthlyUsdCapCents(), 'usd']], cents); } catch (_e) { u = null; }
    if (!u || !u.ok) {
      await caps.releaseAll(capStore, capKeys, n); giveToken(n);
      if (!u) return paused();
      return res.status(429).json({ error: 'Monthly preview limit reached. Try again next month.', honesty: HONESTY });
    }
    // The handler calls this on any exit BEFORE its first fal call (session limit, ceiling, missing key, bad image...).
    let released = false;
    req.remodelReleaseAll = async () => {
      if (released) return; released = true;
      await caps.releaseAll(capStore, capKeys, n); await caps.releaseAll(capStore, [usdKey], cents); giveToken(n);
    };
    // Failover retry: one more call. Token taken first, then counts, then dollars; each step undone if a later one fails.
    req.remodelReserveExtra = async (usd) => {
      if (p && !tokenUses.take(p, cfg.perTokenMax, Date.now(), 1)) return false;
      const c = Math.ceil(usd * 100 - 1e-9);
      try {
        const a = await caps.reserveAll(capStore, capItems, 1);
        if (!a.ok) { giveToken(1); return false; }
        let b; try { b = await caps.reserveAll(capStore, [[usdKey, caps.monthlyUsdCapCents(), 'usd']], c); } catch (_e) { b = null; }
        if (!b || !b.ok) { await caps.releaseAll(capStore, capKeys, 1); giveToken(1); return false; }
        return true;
      } catch (_e) { giveToken(1); return false; }
    };
    return next();
  }

  // Tier picker options: ids, labels and availability only. No prices (estimator sell HOLD).
  app.get('/api/remodel/tiers', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json(require('./productCatalog.cjs').publicCatalog());
  });

  app.post(
    '/api/remodel/generate',
    async (req, res, next) => {
      const client = await getClientFromToken(req);
      if (!client) return res.status(401).json({ error: 'Unauthorized', honesty: HONESTY });
      req.remodelClient = client;
      return next();
    },
    validateGate,
    capGate,
    createRemodelGenerateHandler({
      getClientFromToken: async (req) => req.remodelClient || null,
      ownerTokens: new Set(),
      fetchImpl: opts.fetchImpl,
      onFalDeleteFail: opts.onFalDeleteFail,
      imageStore,
    })
  );


  // JSON 404 for unknown routes (no Express HTML page).
  app.use((_req, res) => res.status(404).json({ error: 'Not found', honesty: HONESTY }));

  app.use((err, _req, res, _next) => {
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large', honesty: HONESTY });
    if (err && (err.type === 'entity.parse.failed' || err.status === 400)) {
      return res.status(400).json({ error: 'Invalid JSON', honesty: HONESTY });
    }
    console.error('api error', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Server error', honesty: HONESTY });
  });

  return app;
}

module.exports = { createApp };

if (require.main === module) {
  const PORT = process.env.PORT || 4000;
  createApp().listen(PORT, () => {
    const cfg = sec.getConfig();
    console.log(
      `bigfoot-remodel-api listening on :${PORT} falConfigured=${Boolean(getFalKey())} tokenSecretConfigured=${Boolean(cfg.secret)}`
    );
    console.log('remodel_config', JSON.stringify(resolvedConfig()));
  });
}
