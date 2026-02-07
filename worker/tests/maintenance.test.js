const test = require('node:test');
const assert = require('node:assert/strict');
const { isInWindow, isInMaintenance } = require('../maintenance');

test('isInWindow: start only means active after start', () => {
  const now = new Date('2026-02-07T00:00:00Z');
  assert.equal(isInWindow(now, '2026-02-06T00:00:00Z', null), true);
  assert.equal(isInWindow(now, '2026-02-08T00:00:00Z', null), false);
});

test('isInMaintenance: store window overrides device', () => {
  const now = new Date('2026-02-07T00:00:00Z');
  const d = {
    store_maintenance_start: '2026-02-06T00:00:00Z',
    store_maintenance_end: '2026-02-08T00:00:00Z',
    maintenance_start: null,
    maintenance_end: null
  };
  assert.equal(isInMaintenance(d, now), true);
});

test('isInMaintenance: device window works', () => {
  const now = new Date('2026-02-07T00:00:00Z');
  const d = {
    store_maintenance_start: null,
    store_maintenance_end: null,
    maintenance_start: '2026-02-06T00:00:00Z',
    maintenance_end: '2026-02-08T00:00:00Z'
  };
  assert.equal(isInMaintenance(d, now), true);
});
