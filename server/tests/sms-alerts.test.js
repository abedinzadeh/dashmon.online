const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

function createExpressMock() {
  const createRouter = () => {
    const stack = [];
    const router = {
      stack,
      use(path, ...handlers) {
        if (typeof path === 'function') {
          stack.push({ handle: path });
          return;
        }
        const normalized = String(path || '').replace(/^\//, '');
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
  return { Router: createRouter, json: () => (_req, _res, next) => next() };
}

function buildRouterWithMocks(poolMock) {
  const routesPath = path.resolve(__dirname, '../routes.js');
  const dbPath = path.resolve(__dirname, '../db.js');
  const authPath = path.resolve(__dirname, '../auth.js');

  delete require.cache[routesPath];
  delete require.cache[dbPath];
  delete require.cache[authPath];

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'express') return createExpressMock();
    if (request === 'twilio') return () => ({ messages: { create: async () => ({ sid: 'SMxxx', status: 'queued' }) } });
    return originalLoad.call(this, request, parent, isMain);
  };

  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool: poolMock } };
  require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { requireAuth: (_req, _res, next) => next(), passport: {} } };

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
    payload: null,
    redirectedTo: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.payload = obj; return this; },
    redirect(to) { this.redirectedTo = to; this.statusCode = 302; return this; }
  };
}

async function runHandlers(handlers, req, res) {
  let i = 0;
  const next = async () => {
    const h = handlers[i++];
    if (!h) return;
    await h(req, res, next);
  };
  await next();
}

test('SMS alerts: premium required', async () => {
  const poolMock = { query: async () => ({ rows: [] }) };
  const router = buildRouterWithMocks(poolMock);
  const handlers = getRouteHandlers(router, 'get', '/api/alerts/sms');

  const req = { user: { id: 'u1', plan: 'free' }, path: '/api/alerts/sms', headers: { accept: 'application/json' } };
  const res = createRes();
  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.error, 'premium_required');
});

test('SMS alerts: save config writes alerts row', async () => {
  const calls = [];
  const poolMock = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [] };
    }
  };
  const router = buildRouterWithMocks(poolMock);
  const handlers = getRouteHandlers(router, 'put', '/api/alerts/sms');

  const req = {
    user: { id: 'u1', plan: 'premium' },
    path: '/api/alerts/sms',
    headers: { accept: 'application/json' },
    body: { enabled: true, cooldownMinutes: 15, rules: { to: '+61400000000', perStore: { '069': { enabled: true } } } }
  };
  const res = createRes();
  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, { ok: true });
  assert.ok(calls.some((c) => String(c.sql).includes("INSERT INTO alerts") && c.params[0] === 'u1'));
});
