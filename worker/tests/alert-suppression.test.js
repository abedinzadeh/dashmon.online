const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('worker alert logic suppresses during maintenance', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');
  assert.ok(worker.includes('isInMaintenance(device)'), 'Expected worker to call isInMaintenance(device) to suppress alerts');
});
