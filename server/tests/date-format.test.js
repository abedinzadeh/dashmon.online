const test = require('node:test');
const assert = require('node:assert/strict');

const { formatDateTime, isValidIanaTimeZone } = require('../../public/app/date-format.js');

test('isValidIanaTimeZone validates common IANA timezones', () => {
  assert.equal(isValidIanaTimeZone('UTC'), true);
  assert.equal(isValidIanaTimeZone('Australia/Adelaide'), true);
  assert.equal(isValidIanaTimeZone('Not/AZone'), false);
  assert.equal(isValidIanaTimeZone(''), false);
});

test('formatDateTime defaults to UTC and formats deterministically', () => {
  const iso = '2026-02-07T12:34:56.000Z';
  const outUtc = formatDateTime(iso); // default UTC
  assert.ok(outUtc.includes('07/02/2026') || outUtc.includes('02/07/2026')); // locale dependent but date should exist
});

test('formatDateTime applies timezone when provided (different from UTC for Adelaide in summer)', () => {
  const iso = '2026-01-15T00:00:00.000Z';
  const utc = formatDateTime(iso, { timeZone: 'UTC' });
  const adl = formatDateTime(iso, { timeZone: 'Australia/Adelaide' });
  assert.notEqual(utc, adl);
});
