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
      get(path, ...handlers) {
        stack.push({ route: { path, methods: { get: true }, stack: handlers.map((h) => ({ handle: h })) } });
      },
      post(path, ...handlers) {
        stack.push({ route: { path, methods: { post: true }, stack: handlers.map((h) => ({ handle: h })) } });
      },
      put(path, ...handlers) {
        stack.push({ route: { path, methods: { put: true }, stack: handlers.map((h) => ({ handle: h })) } });
      },
      delete(path, ...handlers) {
        stack.push({ route: { path, methods: { delete: true }, stack: handlers.map((h) => ({ handle: h })) } });
      }
    };
    return router;
  };

  return {
    Router: createRouter,
    json: () => (_req, _res, next) => next()
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
    if (request === 'bcryptjs') {
      return { hash: async () => 'hash', compare: async () => true };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { pool: poolMock }
  };

  require.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: {
      requireAuth: (_req, _res, next) => next(),
      passport: {}
    }
  };

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
    ended: false,
    redirectedTo: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.payload = obj;
      return this;
    },
    redirect(to) {
      this.redirectedTo = to;
      this.statusCode = 302;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    }
  };
}

async function runHandlers(handlers, req, res) {
  let idx = 0;
  return new Promise((resolve, reject) => {
    let finished = false;
    const next = (err) => {
      if (finished) return;
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
            if (!nextCalled) {
              finished = true;
              return resolve();
            }
          }).catch((e) => {
            finished = true;
            reject(e);
          });
          return;
        }

        // Sync handler that didn't call next => assume it ended the response
        if (!nextCalled) {
          finished = true;
          return resolve();
        }
      } catch (e) {
        finished = true;
        reject(e);
      }
    };
    next();
  });
}

test('Premium middleware blocks Free users for POST /api/devices/:deviceId/test-now', async () => {
  const poolMock = {
    async query() {
      throw new Error('pool.query should not be called for free users');
    }
  };

  const router = buildRouterWithMocks(poolMock);
  const handlers = getRouteHandlers(router, 'post', '/api/devices/:deviceId/test-now');
  const req = { params: { deviceId: 'dev-1' }, user: { id: 'user-1', plan: 'free' }, headers: { accept: 'application/json' }, path: '/api/devices/dev-1/test-now' };
  const res = createRes();

  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.payload?.error, 'premium_required');
});

test('Premium middleware allows Premium users for POST /api/devices/:deviceId/test-now', async () => {
  let called = false;
  const poolMock = {
    async query(sql, params) {
      called = true;
      assert.ok(sql.includes('UPDATE devices SET last_check'));
      assert.deepEqual(params, ['dev-1', 'user-1']);
      return { rows: [{ id: 'dev-1' }] };
    }
  };

  const router = buildRouterWithMocks(poolMock);
  const handlers = getRouteHandlers(router, 'post', '/api/devices/:deviceId/test-now');
  const req = { params: { deviceId: 'dev-1' }, user: { id: 'user-1', plan: 'premium' }, headers: { accept: 'application/json' }, path: '/api/devices/dev-1/test-now' };
  const res = createRes();

  await runHandlers(handlers, req, res);
  assert.ok(called);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, { ok: true });
});

test('Premium middleware blocks Free users for PUT /api/user/preferences/timezone', async () => {
  const poolMock = {
    async query() {
      throw new Error('pool.query should not be called for free users');
    }
  };

  const router = buildRouterWithMocks(poolMock);
  const handlers = getRouteHandlers(router, 'put', '/api/user/preferences/timezone');
  const req = { body: { timezone: 'Australia/Adelaide' }, user: { id: 'user-1', plan: 'free' }, headers: { accept: 'application/json' }, path: '/api/user/preferences/timezone' };
  const res = createRes();

  await runHandlers(handlers, req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload?.error, 'premium_required');
});
