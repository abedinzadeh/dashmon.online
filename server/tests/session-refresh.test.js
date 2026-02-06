const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const express = require('express');
const session = require('express-session');
const { createSessionMiddleware } = require('../session-config');

function request(server, { path, method = 'GET', headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path,
        method,
        headers
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test('session survives refresh-style request behind TLS-terminating proxy', async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(createSessionMiddleware({ store: new session.MemoryStore(), secret: 'test-secret' }));

  app.get('/login', (req, res) => {
    req.session.user = { id: 'user-1' };
    res.status(200).json({ ok: true });
  });

  app.get('/api/me', (req, res) => {
    if (!req.session.user) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    return res.status(200).json({ user: req.session.user });
  });

  const server = app.listen(0);

  try {
    const loginRes = await request(server, {
      path: '/login',
      headers: { 'x-forwarded-proto': 'https' }
    });

    assert.equal(loginRes.statusCode, 200);
    const sessionCookie = loginRes.headers['set-cookie']?.[0];
    assert.ok(sessionCookie, 'expected login to issue a session cookie');

    const meRes = await request(server, {
      path: '/api/me',
      headers: {
        cookie: sessionCookie.split(';')[0],
        'x-forwarded-proto': 'https'
      }
    });

    assert.equal(meRes.statusCode, 200);
    assert.deepEqual(JSON.parse(meRes.body), { user: { id: 'user-1' } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
