const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const requirePremium = require('../require-premium');

function createRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.payload = obj; return this; },
    send(obj) { this.payload = obj; return this; }
  };
}

test('Maintenance endpoints are guarded by requirePremium in routes', () => {
  const routesPath = path.join(__dirname, '..', 'routes.js');
  const src = fs.readFileSync(routesPath, 'utf8');

  // Device maintenance
  assert.ok(
    src.includes("router.post('/api/maintenance/device/:deviceId', requireAuth, requirePremium") ||
    src.includes('router.post("/api/maintenance/device/:deviceId", requireAuth, requirePremium'),
    'Expected device maintenance POST endpoint to include requirePremium'
  );
  assert.ok(
    src.includes("router.delete('/api/maintenance/device/:deviceId', requireAuth, requirePremium") ||
    src.includes('router.delete("/api/maintenance/device/:deviceId", requireAuth, requirePremium'),
    'Expected device maintenance DELETE endpoint to include requirePremium'
  );

  // Store maintenance
  assert.ok(
    src.includes("router.post('/api/maintenance/store/:storeId', requireAuth, requirePremium") ||
    src.includes('router.post("/api/maintenance/store/:storeId", requireAuth, requirePremium'),
    'Expected store maintenance POST endpoint to include requirePremium'
  );
  assert.ok(
    src.includes("router.delete('/api/maintenance/store/:storeId', requireAuth, requirePremium") ||
    src.includes('router.delete("/api/maintenance/store/:storeId", requireAuth, requirePremium'),
    'Expected store maintenance DELETE endpoint to include requirePremium'
  );
});

test('Maintenance: Free users get 403 (premium_required)', async () => {
  const req = { user: { plan: 'free' }, headers: { accept: 'application/json' } };
  const res = createRes();
  let nextCalled = false;

  await requirePremium(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload?.error, 'premium_required');
});

test('Maintenance: Premium users pass middleware', async () => {
  const req = { user: { plan: 'premium' }, headers: { accept: 'application/json' } };
  const res = createRes();
  let nextCalled = false;

  await requirePremium(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
});
