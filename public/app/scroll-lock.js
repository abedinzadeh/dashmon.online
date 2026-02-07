// Re-entrant scroll lock for nested modals.
// Fixes page jump / "growing" layout when multiple modals open/close in sequence.
function createScrollLock(win = window, doc = document) {
  let lockCount = 0;
  let scrollY = 0;
  let prevOverflow = '';
  let prevPosition = '';
  let prevTop = '';
  let prevWidth = '';

  function lock() {
    lockCount += 1;
    if (lockCount > 1) return; // already locked

    scrollY = win.scrollY || win.pageYOffset || 0;

    const body = doc.body;
    prevOverflow = body.style.overflow;
    prevPosition = body.style.position;
    prevTop = body.style.top;
    prevWidth = body.style.width;

    body.style.overflow = 'hidden';
    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.width = '100%';
  }

  function unlock() {
    if (lockCount === 0) return;
    lockCount -= 1;
    if (lockCount > 0) return; // still locked by another modal

    const body = doc.body;
    body.style.overflow = prevOverflow;
    body.style.position = prevPosition;
    body.style.top = prevTop;
    body.style.width = prevWidth;

    // restore the scroll position we had when the first lock happened
    win.scrollTo(0, scrollY);
  }

  function reset() {
    lockCount = 0;
    unlock();
  }

  return { lock, unlock, reset };
}


if (typeof module !== 'undefined' && module.exports) {
  module.exports = createScrollLock;
} else {
  window.createScrollLock = createScrollLock;
}
