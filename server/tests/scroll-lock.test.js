const test = require('node:test');
const assert = require('node:assert/strict');

const createScrollLock = require('../../public/app/scroll-lock.js');

test('scroll lock saves scroll position, applies lock styles, and restores on unlock', () => {
  const body = { style: { position: '', top: '', width: '' } };
  const calls = [];
  const win = {
    scrollY: 320,
    pageYOffset: 320,
    scrollTo(x, y) {
      calls.push([x, y]);
    }
  };
  const doc = { body };

  const lock = createScrollLock(win, doc);

  lock.lock();
  assert.equal(body.style.position, 'fixed');
  assert.equal(body.style.top, '-320px');
  assert.equal(body.style.width, '100%');

  lock.unlock();
  assert.equal(body.style.position, '');
  assert.equal(body.style.top, '');
  assert.equal(body.style.width, '');
  assert.deepEqual(calls, [[0, 320]]);
});

test('scroll lock supports nested opens without leaking styles', () => {
  const body = { style: { position: '', top: '', width: '' } };
  let scrollCalls = 0;
  const win = {
    scrollY: 150,
    pageYOffset: 150,
    scrollTo() {
      scrollCalls += 1;
    }
  };
  const doc = { body };

  const lock = createScrollLock(win, doc);
  lock.lock();
  lock.lock();
  lock.unlock();

  assert.equal(body.style.position, 'fixed');
  assert.equal(scrollCalls, 0);

  lock.unlock();
  assert.equal(body.style.position, '');
  assert.equal(scrollCalls, 1);
});
