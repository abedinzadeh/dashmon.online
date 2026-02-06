const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const express = require('express');
const session = require('express-session');
const { createSessionMiddleware } = require('../session-middleware');

function getSessionCookie(setCookieHeader) {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) return '';
  return String(raw).split(';')[0];
}

test('session persists across refresh-like request sequence', async () => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret';

  const app = express();
  app.set('trust proxy', 1);
  app.use(createSessionMiddleware({ store: new session.MemoryStore() }));

  app.get('/login', (req, res) => {
    req.session.userId = 'user-123';
    res.json({ ok: true });
  });

  app.get('/api/me', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'unauthenticated' });
    return res.json({ id: req.session.userId });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    const loginRes = await fetch(`${base}/login`);
    assert.equal(loginRes.status, 200);

    const cookie = getSessionCookie(loginRes.headers.get('set-cookie'));
    assert.ok(cookie.includes('connect.sid='), 'session cookie should be set');

    // Refresh-like navigation: browser sends same cookie on next request.
    const meRes = await fetch(`${base}/api/me`, {
      headers: { cookie }
    });

    assert.equal(meRes.status, 200);
    assert.deepEqual(await meRes.json(), { id: 'user-123' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
