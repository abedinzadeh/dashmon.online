const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

function createExpressMock() {
  const createRouter = () => {
    const stack = [];
    const router = {
      stack,
      use(pathOrFn, ...handlers) {
        if (typeof pathOrFn === 'function') {
          stack.push({ handle: pathOrFn });
          return;
        }
        const normalized = String(pathOrFn || '').replace(/^\//, '');
        const regexp = new RegExp(`^\\/${normalized}\\/?(?=\\/|$)`, 'i');
        const handler = handlers[handlers.length - 1];
        stack.push({ regexp, handle: handler });
      },
      get(routePath, ...handlers) {
        stack.push({ route: { path: routePath, methods: { get: true }, stack: handlers.map((h) => ({ handle: h })) } });
      },
      post(routePath, ...handlers) {
        stack.push({ route: { path: routePath, methods: { post: true }, stack: handlers.map((h) => ({ handle: h })) } });
      },
      put(routePath, ...handlers) {
        stack.push({ route: { path: routePath, methods: { put: true }, stack: handlers.map((h) => ({ handle: h })) } });
      },
      delete(routePath, ...handlers) {
        stack.push({ route: { path: routePath, methods: { delete: true }, stack: handlers.map((h) => ({ handle: h })) } });
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
    if (request === 'bcryptjs') return { hash: async () => 'hash', compare: async () => true };
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
    exports: { requireAuth: (_req, _res, next) => next(), passport: {} }
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
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(k, v) {
      this.headers[String(k).toLowerCase()] = v;
    },
    json(obj) {
      this.payload = obj;
      return this;
    },
    send(body) {
      this.payload = body;
      return this;
    },
    end() {
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
        const out = h(req, res, (e) => {
          nextCalled = true;
          next(e);
        });
        if (out && typeof out.then === 'function') {
          out.then(() => {
            if (!nextCalled) resolve();
          }).catch(reject);
          return;
        }
        if (!nextCalled) resolve();
      } catch (e) {
        reject(e);
      }
    };
    next();
  });
}

test('Free users are blocked for GET /api/devices/:deviceId/analytics', async () => {
  const poolMock = { query: async () => { throw new Error('pool.query should not be called'); } };
  const router = buildRouterWithMocks(poolMock);
  const handlers = getRouteHandlers(router, 'get', '/api/devices/:deviceId/analytics');
  const req = {
    params: { deviceId: 'dev-1' },
    query: { range: '7d' },
    user: { id: 'user-1', plan: 'free' },
    headers: { accept: 'application/json' },
    path: '/api/devices/dev-1/analytics'
  };
  const res = createRes();
  await runHandlers(handlers, req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload?.error, 'premium_required');
});

test('Premium analytics computes uptime/incident/downtime', async () => {
  // Two down segments; one transition into down.
  const history = [
    { ts: '2026-02-07T00:00:00.000Z', status: 'up', latency_ms: 100 },
    { ts: '2026-02-07T00:01:00.000Z', status: 'down', latency_ms: null },
    { ts: '2026-02-07T00:03:00.000Z', status: 'down', latency_ms: null },
    { ts: '2026-02-07T00:04:00.000Z', status: 'up', latency_ms: 200 }
  ];

  let call = 0;
  const poolMock = {
    async query(sql) {
      call++;
      if (call === 1) {
        // ownership
        return { rows: [{ id: 'dev-1' }] };
      }
      // history query
      assert.ok(String(sql).includes('FROM device_history'));
      return { rows: history };
    }
  };

  const router = buildRouterWithMocks(poolMock);
  const handlers = getRouteHandlers(router, 'get', '/api/devices/:deviceId/analytics');
  const req = {
    params: { deviceId: 'dev-1' },
    query: { range: '24h' },
    user: { id: 'user-1', plan: 'premium' },
    headers: { accept: 'application/json' },
    path: '/api/devices/dev-1/analytics'
  };
  const res = createRes();
  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.deviceId, 'dev-1');
  assert.equal(res.payload.range, '24h');
  const a = res.payload.analytics;
  assert.equal(a.samples, 4);
  // up samples = 2 => 50%
  assert.ok(Math.abs(a.uptime_pct - 50) < 0.0001);
  // avg of 100 and 200
  assert.ok(Math.abs(a.avg_response_ms - 150) < 0.0001);
  // transition up -> down once
  assert.equal(a.incident_count, 1);
  // downtime computed using deltas where current status is down:
  // between t0 and t1: current down => +1m
  // between t1 and t2: current down => +2m
  // total 3m
  assert.equal(a.downtime_minutes, 3);
});

test('Free users are blocked for GET /api/reports/uptime', async () => {
  const poolMock = { query: async () => { throw new Error('pool.query should not be called'); } };
  const router = buildRouterWithMocks(poolMock);
  const handlers = getRouteHandlers(router, 'get', '/api/reports/uptime');
  const req = {
    query: { period: 'weekly' },
    user: { id: 'user-1', plan: 'free' },
    headers: { accept: 'application/json' },
    path: '/api/reports/uptime'
  };
  const res = createRes();
  await runHandlers(handlers, req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload?.error, 'premium_required');
});

test('Premium reports returns stores (projects) and device uptime', async () => {
  let q = 0;
  const poolMock = {
    async query(sql, params) {
      q++;
      // 1) stores
      if (q === 1) {
        assert.ok(String(sql).includes('FROM stores'));
        assert.deepEqual(params, ['user-1']);
        return { rows: [{ id: 's1', name: 'Store 1' }] };
      }
      // 2) devices
      if (q === 2) {
        assert.ok(String(sql).includes('FROM devices'));
        return { rows: [{ id: 'd1', store_id: 's1', name: 'Dev 1', type: 'http', url: 'https://x', ip: '1.1.1.1' }] };
      }
      // 3) aggregates
      assert.ok(String(sql).includes('FROM device_history'));
      return { rows: [{ store_id: 's1', device_id: 'd1', samples: 10, up_samples: 9, avg_latency_ms: 120 }] };
    }
  };

  const router = buildRouterWithMocks(poolMock);
  const handlers = getRouteHandlers(router, 'get', '/api/reports/uptime');
  const req = {
    query: { period: 'weekly' },
    user: { id: 'user-1', plan: 'premium' },
    headers: { accept: 'application/json' },
    path: '/api/reports/uptime'
  };
  const res = createRes();
  await runHandlers(handlers, req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.period, 'weekly');
  assert.equal(res.payload.summary.projects, 1);
  assert.equal(res.payload.summary.devices, 1);
  assert.ok(Math.abs(res.payload.summary.uptime_pct - 90) < 0.0001);
  assert.equal(res.payload.projects[0].id, 's1');
  assert.ok(Math.abs(res.payload.projects[0].devices[0].uptime_pct - 90) < 0.0001);
});
