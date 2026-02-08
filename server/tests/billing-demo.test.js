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
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.payload = obj;
      return this;
    }
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
        const localNext = (e) => {
          nextCalled = true;
          next(e);
        };
        const out = h(req, res, localNext);
        if (out && typeof out.then === 'function') {
          out.then(() => {
            if (nextCalled) return;
            resolve();
          }).catch(reject);
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

test('Demo activation upgrades a free user once for 1 day', async () => {
  process.env.BILLING_DEMO_ENABLED = 'true';
  process.env.BILLING_DEMO_PROMO_END_AT = new Date(Date.now() + 60_000).toISOString();
  process.env.BILLING_DEMO_DURATION_HOURS = '24';

  let updateCalled = false;
  const poolMock = {
    async query(sql, params) {
      if (String(sql).includes('UPDATE users SET plan=\'premium\'')) {
        updateCalled = true;
        assert.equal(params[1], 'user-1');
        return { rows: [] };
      }
      throw new Error('Unexpected query');
    }
  };

  const router = buildRouterWithMocks(poolMock);
  const handlers = getRouteHandlers(router, 'post', '/api/billing/demo/activate');
  const req = { user: { id: 'user-1', plan: 'free', plan_status: 'active', plan_source: null, demo_used_at: null }, headers: { accept: 'application/json' }, path: '/api/billing/demo/activate' };
  const res = createRes();

  await runHandlers(handlers, req, res);

  assert.ok(updateCalled);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload?.ok, true);
  assert.ok(res.payload?.premium_until);
});

test('Demo activation is rejected if already used', async () => {
  process.env.BILLING_DEMO_ENABLED = 'true';
  process.env.BILLING_DEMO_PROMO_END_AT = new Date(Date.now() + 60_000).toISOString();

  const poolMock = { async query() { throw new Error('pool.query should not be called'); } };
  const router = buildRouterWithMocks(poolMock);
  const handlers = getRouteHandlers(router, 'post', '/api/billing/demo/activate');
  const req = { user: { id: 'user-1', plan: 'free', demo_used_at: new Date().toISOString() }, headers: { accept: 'application/json' }, path: '/api/billing/demo/activate' };
  const res = createRes();

  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload?.error, 'already_used');
});
