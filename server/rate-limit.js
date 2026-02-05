function createMemoryRateLimiter({ windowMs, maxRequests, keyFn, message }) {
  const state = new Map();

  return function memoryRateLimiter(req, res, next) {
    const key = keyFn(req);
    const now = Date.now();

    let entry = state.get(key);
    if (!entry || now - entry.start >= windowMs) {
      entry = { start: now, count: 0 };
      state.set(key, entry);
    }

    entry.count += 1;
    const max = typeof maxRequests === 'function' ? maxRequests(req) : maxRequests;
    if (entry.count > max) {
      const retryAfterSeconds = Math.ceil((windowMs - (now - entry.start)) / 1000);
      res.set('Retry-After', String(Math.max(retryAfterSeconds, 1)));
      return res.status(429).json({ error: message });
    }

    return next();
  };
}

module.exports = { createMemoryRateLimiter };
