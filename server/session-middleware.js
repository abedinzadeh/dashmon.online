const session = require('express-session');
const { createClient } = require('redis');
const RedisStore = require('connect-redis').default;

function createSessionMiddleware({ store } = {}) {
  let resolvedStore = store;
  if (!resolvedStore) {
    const redisClient = createClient({ url: process.env.REDIS_URL });
    redisClient.connect().catch((e) => console.error('Redis connect failed:', e));
    resolvedStore = new RedisStore({ client: redisClient });
  }

  return session({
    store: resolvedStore,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: 'auto',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  });
}

module.exports = { createSessionMiddleware };
