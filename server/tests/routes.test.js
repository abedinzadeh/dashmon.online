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
      requireAuth: (_req, _res, next) => next()
    }
  };

  try {
    const { router } = require(routesPath);
    return router;
  } finally {
    Module._load = originalLoad;
  }
}

function findHandler(router, method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `Could not find route ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createRes() {
  return {
    statusCode: 200,
    payload: null,
    ended: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.payload = obj;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    }
  };
}

test('GET /api/devices/:deviceId/history falls back to legacy device_history columns', async () => {
  const calls = [];
  const poolMock = {
    async query(sql, params) {
      calls.push({ sql, params });

      if (sql.includes('SELECT id FROM devices')) {
        return { rows: [{ id: params[0] }] };
      }

      if (sql.includes('FROM device_history') && sql.includes('ORDER BY ts DESC')) {
        const err = new Error('column ts does not exist');
        err.code = '42703';
        throw err;
      }

      if (sql.includes('FROM device_history') && sql.includes('timestamp AS ts')) {
        return {
          rows: [
            { ts: '2026-01-01T00:02:00.000Z', status: 'down', latency_ms: 111, status_code: null, detail: {} },
            { ts: '2026-01-01T00:01:00.000Z', status: 'up', latency_ms: 42, status_code: null, detail: {} }
          ]
        };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };

  const router = buildRouterWithMocks(poolMock);
  const handler = findHandler(router, 'get', '/api/devices/:deviceId/history');

  const req = { params: { deviceId: 'dev-1' }, query: {}, user: { id: 'user-1' } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.history.length, 2);
  assert.equal(res.payload.history[0].status, 'up');
  assert.equal(res.payload.history[1].status, 'down');
  assert.ok(calls.some((c) => c.sql.includes('timestamp AS ts')), 'fallback query should be used');
});

test('GET /api/devices/:deviceId/history rejects invalid limit values', async () => {
  const poolMock = {
    async query() {
      throw new Error('pool.query should not be called for invalid limit');
    }
  };

  const router = buildRouterWithMocks(poolMock);
  const handler = findHandler(router, 'get', '/api/devices/:deviceId/history');

  const req = { params: { deviceId: 'dev-1' }, query: { limit: '-5' }, user: { id: 'user-1' } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.payload, { error: 'limit must be a positive number' });
});



test('GET /api/metrics/down-events falls back to legacy timestamp column', async () => {
  const calls = [];
  const poolMock = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("date_trunc('hour', h.ts)")) {
        const err = new Error('column h.ts does not exist');
        err.code = '42703';
        throw err;
      }
      if (sql.includes("date_trunc('hour', h.timestamp)")) {
        return { rows: [{ bucket: '2026-01-01T00:00:00.000Z', down_events: 3 }] };
      }
      throw new Error('Unexpected SQL in metrics test');
    }
  };

  const router = buildRouterWithMocks(poolMock);
  const handler = findHandler(router, 'get', '/api/metrics/down-events');

  const req = { query: { hours: '12' }, user: { id: 'user-1' } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, { points: [{ ts: '2026-01-01T00:00:00.000Z', value: 3 }] });
  assert.ok(calls.some((c) => c.sql.includes("h.timestamp")), 'fallback metrics query should be used');
});




test('GET /api/alerts/email returns safe defaults when no row exists', async () => {
  const poolMock = {
    async query(sql) {
      if (sql.includes('FROM alerts')) return { rows: [] };
      throw new Error('Unexpected SQL in alerts default test');
    }
  };

  const router = buildRouterWithMocks(poolMock);
  const handler = findHandler(router, 'get', '/api/alerts/email');

  const req = { user: { id: 'user-1' } };
  const res = createRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, {
    alert: { enabled: false, cooldownMinutes: 30, to: [] }
  });
});

test('PUT /api/alerts/email validates and normalizes config', async () => {
  const calls = [];
  const poolMock = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO alerts')) {
        return {
          rows: [{ enabled: true, cooldown_minutes: 45, rules: { to: ['ops@example.com'] } }]
        };
      }
      throw new Error('Unexpected SQL in alerts update test');
    }
  };

  const router = buildRouterWithMocks(poolMock);
  const handler = findHandler(router, 'put', '/api/alerts/email');

  const req = {
    user: { id: 'user-1' },
    body: {
      enabled: true,
      cooldownMinutes: 45,
      to: ['Ops@Example.com', 'ops@example.com', '']
    }
  };
  const res = createRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, {
    alert: { enabled: true, cooldownMinutes: 45, to: ['ops@example.com'] }
  });
  assert.ok(calls[0].params[0] === 'user-1');
  assert.equal(calls[0].params[1], true);
  assert.equal(calls[0].params[3], 45);
  assert.equal(calls[0].params[2], '{"to":["ops@example.com"]}');
});

test('PUT /api/alerts/email supports legacy DBs without unique alerts index', async () => {
  const calls = [];
  const poolMock = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO alerts') && sql.includes('ON CONFLICT')) {
        const err = new Error('there is no unique or exclusion constraint matching the ON CONFLICT specification');
        err.code = '42P10';
        throw err;
      }
      if (sql.includes('UPDATE alerts')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO alerts') && !sql.includes('ON CONFLICT')) {
        return { rows: [{ enabled: false, cooldown_minutes: 30, rules: { to: [] } }] };
      }
      throw new Error('Unexpected SQL in legacy alerts upsert test');
    }
  };

  const router = buildRouterWithMocks(poolMock);
  const handler = findHandler(router, 'put', '/api/alerts/email');

  const req = { user: { id: 'user-1' }, body: { enabled: false, cooldownMinutes: 30, to: [] } };
  const res = createRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, { alert: { enabled: false, cooldownMinutes: 30, to: [] } });
  assert.ok(calls.some((c) => c.sql.includes('UPDATE alerts')));
  assert.ok(calls.some((c) => c.sql.includes('INSERT INTO alerts') && !c.sql.includes('ON CONFLICT')));
});

test('PUT /api/alerts/email rejects invalid email address', async () => {
  const poolMock = {
    async query() {
      throw new Error('should not call DB for invalid email');
    }
  };
  const router = buildRouterWithMocks(poolMock);
  const handler = findHandler(router, 'put', '/api/alerts/email');

  const req = { user: { id: 'user-1' }, body: { enabled: true, cooldownMinutes: 30, to: ['bad-email'] } };
  const res = createRes();
  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.payload, { error: 'Invalid email address: bad-email' });
});



test('POST /api/projects enforces free-plan project limit', async () => {
  let queryCount = 0;
  const poolMock = {
    async query(sql) {
      queryCount += 1;
      if (sql.includes('SELECT plan FROM users')) {
        return { rows: [{ plan: 'free' }] };
      }
      if (sql.includes('COUNT(*)::int AS count FROM stores')) {
        return { rows: [{ count: 3 }] };
      }
      throw new Error('Unexpected SQL for project limit test');
    }
  };

  const router = buildRouterWithMocks(poolMock);
  const handler = findHandler(router, 'post', '/api/projects');

  const req = {
    user: { id: 'user-1', plan: 'free' },
    body: { name: 'Project A', id: 'project-a', location: '', notes: '' }
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.payload, { error: 'Plan limit reached. Your plan allows 3 projects.' });
  assert.equal(queryCount, 2);
});

test('POST /api/projects/:projectId/devices enforces per-project device limit', async () => {
  const poolMock = {
    async query(sql) {
      if (sql.includes('SELECT 1 FROM stores')) return { rows: [{ ok: 1 }] };
      if (sql.includes('COUNT(*)::int AS count FROM devices')) return { rows: [{ count: 15 }] };
      throw new Error('Unexpected SQL for device limit test');
    }
  };

  const router = buildRouterWithMocks(poolMock);
  const handler = findHandler(router, 'post', '/api/projects/:projectId/devices');

  const req = {
    params: { projectId: 'project-a' },
    user: { id: 'user-1', plan: 'premium' },
    body: { name: 'Device 1', type: 'server', ip: '10.0.0.1' }
  };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.payload, { error: 'Plan limit reached. Your plan allows 15 devices per project.' });
});

test('POST /api/devices/:deviceId/test-now blocks free plan', async () => {
  const poolMock = {
    async query() {
      throw new Error('DB should not be called for free plan test-now');
    }
  };

  const router = buildRouterWithMocks(poolMock);
  const handler = findHandler(router, 'post', '/api/devices/:deviceId/test-now');

  const req = { params: { deviceId: 'dev-1' }, user: { id: 'user-1', plan: 'free' } };
  const res = createRes();

  await handler(req, res);

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.payload, { error: 'Manual test is available on Premium plan only' });
});

test('unknown /api routes return JSON 404 payload', () => {
  const poolMock = { async query() { return { rows: [] }; } };
  const router = buildRouterWithMocks(poolMock);

  const fallbackLayer = router.stack.find((l) => l.regexp && String(l.regexp).includes('^\\/api\\/?(?=\\/|$)'));
  assert.ok(fallbackLayer, 'Expected /api fallback middleware');

  const req = { method: 'GET', url: '/not-found' };
  const res = createRes();

  fallbackLayer.handle(req, res, () => {});

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.payload, { error: 'Not found' });
});
