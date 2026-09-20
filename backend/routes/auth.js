const crypto = require('crypto');

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

function signToken(payload) {
  const secret = process.env.JWT_SECRET || 'change-this-secret';
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyToken(token) {
  const secret = process.env.JWT_SECRET || 'change-this-secret';
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac('sha256', secret).update(parts[0]).digest('base64url');
  const left = Buffer.from(expected);
  const right = Buffer.from(parts[1]);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  if (process.env.AUTH_REQUIRED === 'false') return next();
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Authentication required' });
  req.user = payload;
  next();
}

function buildRouter(db) {
  const express = require('express');
  const router = express.Router();

  router.post('/login', (req, res) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const expectedPassword = process.env.ADMIN_PASSWORD || '';
    if (!expectedPassword) return res.status(503).json({ error: 'ADMIN_PASSWORD is not configured on the backend' });
    const received = Buffer.from(password);
    const expected = Buffer.from(expectedPassword);
    if (!received.length || received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    const token = signToken({ role: 'admin', iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS });
    res.json({ token, expiresIn: Math.floor(TOKEN_TTL_MS / 1000) });
  });

  router.get('/me', requireAuth, async (req, res) => {
    res.json({ authenticated: true, role: req.user?.role || 'admin' });
  });

  return router;
}

module.exports = { buildRouter, requireAuth };
