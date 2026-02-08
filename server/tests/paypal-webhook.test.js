const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

function createExpressMock() {
  const createRouter = () => {
    const stack = [];
    const router = {
      stack,
      use(pathArg, ...handlers) {
        if (typeof pathArg === 'function') {
          stack.push({ handle: pathArg });
          return;
        }
        const normalized = String(pathArg || '').replace(/^\//, '');
        const regexp = new RegExp(`^\\/${normalized}\\/?(?=\\/|$)`, 'i');
        const handler = handlers[handlers.length - 1];
        stack.push({ regexp, handle: handler });
      },
      get(p, ...handlers) { stack.push({ route: { path: p, methods: { get: true }, stack: handlers.map((h) => ({ handle: h })) } }); },
      post(p, ...handlers) { stack.push({ route: { path: p, methods: { post: true }, stack: handlers.map((h) => ({ handle: h })) } }); },
      put(p, ...handlers) { stack.push({ route: { path: p, methods: { put: true }, stack: handlers.map((h) => ({ handle: h })) } }); },
      delete(p, ...handlers) { stack.push({ route: { path: p, methods: { delete: true }, stack: handlers.map((h) => ({ handle: h })) } }); }
    };
    return router;
  };

  return {
    Router: createRouter,
    json: () => (_req, _res, next) => next(),
    raw: () => (_req, _res, next) => next()
  };
}

function buildRouterWithMocks({ poolMock, paypalMock }) {
  const routesPath = path.resolve(__dirname, '../routes.js');
  const dbPath = path.resolve(__dirname, '../db.js');
  const authPath = path.resolve(__dirname, '../auth.js');
  const paypalPath = path.resolve(__dirname, '../paypal.js');

  delete require.cache[routesPath];
  delete require.cache[dbPath];
  delete require.cache[authPath];
  delete require.cache[paypalPath];

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'express') return createExpressMock();
    return originalLoad.call(this, request, parent, isMain);
  };

  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool: poolMock } };
  require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { requireAuth: (_req, _res, next) => next(), passport: {} } };
  require.cache[paypalPath] = { id: paypalPath, filename: paypalPath, loaded: true, exports: paypalMock };

  try {
    const { router } = require(routesPath);
    return router;
  } finally {
    Module._load = originalLoad;
  }
}

function getRouteHandlers(router, method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `Could not find route ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack.map((x) => x.handle);
}

function createRes() {
  return {
    statusCode: 200,
    ended: false,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.payload = obj; return this; },
    end() { this.ended = true; return this; }
  };
}

async function runHandlers(handlers, req, res) {
  let idx = 0;
  return new Promise((resolve, reject) => {
    const next = (err) => {
      if (err) return reject(err);
      const h = handlers[idx++];
      if (!h) return resolve();
      try {
        let nextCalled = false;
        const localNext = (e) => { nextCalled = true; next(e); };
        const out = h(req, res, localNext);
        if (out && typeof out.then === 'function') {
          out.then(() => { if (!nextCalled) resolve(); }).catch(reject);
          return;
        }
        if (nextCalled) return;
        resolve();
      } catch (e) {
        reject(e);
      }
    };
    next();
  });
}

test('PayPal webhook rejects invalid signatures', async () => {
  const poolMock = { async query() { throw new Error('should not be called'); } };
  const paypalMock = {
    isPayPalConfigured: () => true,
    verifyWebhookSignature: async () => false
  };

  const router = buildRouterWithMocks({ poolMock, paypalMock });
  const handlers = getRouteHandlers(router, 'post', '/api/billing/paypal/webhook');

  const req = {
    path: '/api/billing/paypal/webhook',
    headers: {},
    body: Buffer.from(JSON.stringify({ event_type: 'BILLING.SUBSCRIPTION.ACTIVATED' }))
  };
  const res = createRes();

  await runHandlers(handlers, req, res);
  assert.equal(res.statusCode, 400);
});

test('PayPal webhook upserts subscription and upgrades user on ACTIVATED', async () => {
  const queries = [];
  const poolMock = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      return { rows: [] };
    }
  };
  const paypalMock = {
    isPayPalConfigured: () => true,
    verifyWebhookSignature: async () => true
  };

  const router = buildRouterWithMocks({ poolMock, paypalMock });
  const handlers = getRouteHandlers(router, 'post', '/api/billing/paypal/webhook');

  const event = {
    event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
    resource: { id: 'SUB-123', status: 'ACTIVE', custom_id: 'user-1' }
  };

  const req = {
    path: '/api/billing/paypal/webhook',
    headers: {
      'paypal-transmission-id': 't',
      'paypal-transmission-time': new Date().toISOString(),
      'paypal-cert-url': 'https://example.com',
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-transmission-sig': 'sig'
    },
    body: Buffer.from(JSON.stringify(event))
  };
  const res = createRes();

  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(queries.some((q) => q.sql.includes('INSERT INTO paypal_subscriptions')));
  assert.ok(queries.some((q) => q.sql.includes("UPDATE users SET plan='premium'")));
});
