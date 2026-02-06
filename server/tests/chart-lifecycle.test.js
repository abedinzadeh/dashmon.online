const test = require('node:test');
const assert = require('node:assert/strict');

const createChartLifecycle = require('../../public/app/chart-lifecycle.js');

test('resetChartMap destroys existing chart instances and clears map', () => {
  const lifecycle = createChartLifecycle();
  let destroyed = 0;
  const map = new Map([
    ['a', { destroy() { destroyed += 1; } }],
    ['b', { destroy() { destroyed += 1; } }]
  ]);

  lifecycle.resetChartMap(map);

  assert.equal(destroyed, 2);
  assert.equal(map.size, 0);
});

test('render guard marks only the latest render as current', () => {
  const lifecycle = createChartLifecycle();
  const guard = lifecycle.createRenderGuard();
  const first = guard.next();
  const second = guard.next();

  assert.equal(guard.isCurrent(first), false);
  assert.equal(guard.isCurrent(second), true);
});
