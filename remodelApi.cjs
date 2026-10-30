/**
 * Free Render generate-only microservice for Big Foot remodel preview.
 * No SQLite. FAL_KEY server-only. Never log the key, the token secret, or tokens.
 * P1-3 hardening: signed short-lived tokens, strict Origin, per-IP + global daily caps, fail closed.
 */
const express = require('express');
const {
  createRemodelGenerateHandler,
  getFalKey,
  HONESTY,
} = require('./remodelGenerate.cjs');
const sec = require('./security.cjs');

function createApp(opts = {}) {
  const genCounter = opts.genCounter || sec.createDailyCounter();
  const tokenCounter = opts.tokenCounter || sec.createDailyCounter();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  // Strict Origin gate on every /api/remodel/* request (incl. preflight). No Origin => 403.
  app.use('/api/remodel', (req, res, next) => {
    const cfg = sec.getConfig();
    const origin = (req.headers.origin || '').toString();
    if (!origin || !cfg.origins.has(origin)) {
      return res.status(403).json({ error: 'Origin not allowed', honesty: HONESTY });
    }
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.set('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (!cfg.secret) {
      return res.status(503).json({ error: 'Remodel API is not configured', honesty: HONESTY });
    }
    req.remodelCfg = cfg;
    req.remodelIp = sec.clientIp(req);
    return next();
  });

  app.use(express.json({ limit: '12mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'bigfoot-remodel-api' });
  });

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
    const token = bearer(req);
    if (!token) return null;
    if (cfg.serviceToken && cfg.serviceToken.length >= sec.MIN_SECRET_LEN && sec.safeEqual(token, cfg.serviceToken)) {
      return { id: 0, role: 'service' };
    }
    const p = sec.verifyToken(cfg.secret, token, { ip: req.remodelIp, origin: req.headers.origin });
    return p ? { id: 0, role: 'preview' } : null;
  }

  // Daily caps checked before any fal call; counted per IP and globally (never per token).
  // Attempts count, even if fal later fails: fail-safe for spend.
  function capGate(req, res, next) {
    const cfg = req.remodelCfg;
    if (genCounter.get('global') >= cfg.globalDaily) {
      return res.status(429).json({ error: 'Daily preview limit reached. Try again tomorrow.', honesty: HONESTY });
    }
    if (genCounter.get('ip:' + req.remodelIp) >= cfg.perIpDaily) {
      return res.status(429).json({ error: 'Daily preview limit reached for this network.', honesty: HONESTY });
    }
    // Reserve the slot before calling fal so concurrent requests can't overshoot the cap.
    genCounter.inc('global');
    genCounter.inc('ip:' + req.remodelIp);
    return next();
  }

  app.post(
    '/api/remodel/generate',
    async (req, res, next) => {
      const client = await getClientFromToken(req);
      if (!client) return res.status(401).json({ error: 'Unauthorized', honesty: HONESTY });
      req.remodelClient = client;
      return next();
    },
    capGate,
    createRemodelGenerateHandler({
      getClientFromToken: async (req) => req.remodelClient || null,
      ownerTokens: new Set(),
      fetchImpl: opts.fetchImpl,
    })
  );

  app.use((err, _req, res, _next) => {
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
  });
}
