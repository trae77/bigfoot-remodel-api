/**
 * Free Render generate-only microservice for Big Foot remodel preview.
 * No SQLite. FAL_KEY server-only. Never log the key.
 */
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const {
  createRemodelGenerateHandler,
  getFalKey,
  HONESTY,
} = require('./remodelGenerate.cjs');

const app = express();
const PORT = process.env.PORT || 4000;
const ALLOWED = new Set(
  (process.env.CORS_ORIGINS || 'https://bigfoot-preview.ttawebdev.com,http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);
const PREVIEW_TOKEN = (process.env.REMODEL_PREVIEW_TOKEN || '').trim();
const ownerTokens = new Set();

app.use(
  cors({
    origin(origin, cb) {
      if (!origin || ALLOWED.has(origin)) return cb(null, true);
      return cb(new Error('CORS blocked'));
    },
  })
);
app.use(express.json({ limit: '12mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'bigfoot-remodel-api',
    falConfigured: Boolean(getFalKey()),
    honesty: HONESTY,
  });
});

function bearer(req) {
  const auth = (req.headers.authorization || '').toString();
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

async function getClientFromToken(req) {
  const token = bearer(req);
  if (!token) return null;
  if (PREVIEW_TOKEN && token === PREVIEW_TOKEN) {
    return { id: 0, role: 'preview' };
  }
  // Demo tokens from SPA preview (no SQLite): accept opaque preview-* or demo-* prefixes
  if (/^(preview|demo|owner)-[A-Za-z0-9_-]{8,}$/.test(token)) {
    if (token.startsWith('owner-')) ownerTokens.add(token);
    return { id: 0, role: token.startsWith('owner-') ? 'owner' : 'preview' };
  }
  return null;
}

app.post(
  '/api/remodel/generate',
  createRemodelGenerateHandler({ getClientFromToken, ownerTokens })
);

app.use((err, _req, res, _next) => {
  if (err && /CORS/.test(String(err.message || err))) {
    return res.status(403).json({ error: 'Origin not allowed', honesty: HONESTY });
  }
  console.error('api error', err && err.message ? err.message : err);
  res.status(500).json({ error: 'Server error', honesty: HONESTY });
});

app.listen(PORT, () => {
  console.log(`bigfoot-remodel-api listening on :${PORT} falConfigured=${Boolean(getFalKey())}`);
});
