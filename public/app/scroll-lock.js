(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory;
    return;
  }

  root.createScrollLock = factory;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createScrollLock(win = window, doc = document) {
  const body = doc.body;
  let lockDepth = 0;
  let savedScrollY = 0;
  let savedStyles = null;

  function lock() {
    lockDepth += 1;
    if (lockDepth > 1) return savedScrollY;

    savedScrollY = win.scrollY || win.pageYOffset || 0;
    savedStyles = {
      position: body.style.position,
      top: body.style.top,
      width: body.style.width
    };

    body.style.position = 'fixed';
    body.style.top = `-${savedScrollY}px`;
    body.style.width = '100%';

    return savedScrollY;
  }

  function unlock() {
    if (lockDepth === 0) return savedScrollY;
    lockDepth -= 1;
    if (lockDepth > 0) return savedScrollY;

    const restoreY = savedScrollY;
    body.style.position = savedStyles?.position || '';
    body.style.top = savedStyles?.top || '';
    body.style.width = savedStyles?.width || '';

    savedStyles = null;
    win.scrollTo(0, restoreY);
    return restoreY;
  }

  function reset() {
    lockDepth = 0;
    savedStyles = null;
    savedScrollY = 0;
    body.style.position = '';
    body.style.top = '';
    body.style.width = '';
  }

  return { lock, unlock, reset };
});
