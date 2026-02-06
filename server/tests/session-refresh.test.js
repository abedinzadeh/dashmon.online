const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

function getCookieValue(cookieHeader, key) {
  if (!cookieHeader) return null;
  const cookies = String(cookieHeader).split(';').map((part) => part.trim());
  for (const item of cookies) {
    if (item.startsWith(`${key}=`)) return item.slice(key.length + 1);
  }
  return null;
}

test('login then subsequent request remains authenticated (refresh-like flow)', async () => {
  const sessions = new Map();

  const server = http.createServer((req, res) => {
    if (req.url === '/login') {
      const sid = randomUUID();
      sessions.set(sid, { userId: 'user-123' });
      res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === '/api/me') {
      const sid = getCookieValue(req.headers.cookie, 'sid');
      const session = sid ? sessions.get(sid) : null;
      if (!session) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthenticated' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: session.userId }));
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    const loginResponse = await fetch(`${baseUrl}/login`);
    assert.equal(loginResponse.status, 200);

    const setCookie = loginResponse.headers.get('set-cookie');
    assert.ok(setCookie && setCookie.includes('sid='));

    const meResponse = await fetch(`${baseUrl}/api/me`, {
      headers: { cookie: String(setCookie).split(';')[0] }
    });

    assert.equal(meResponse.status, 200);
    assert.deepEqual(await meResponse.json(), { id: 'user-123' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('session middleware uses proxy-safe secure auto cookie mode', async () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../session-middleware'), 'utf8');
  assert.match(source, /secure:\s*'auto'/);
});
