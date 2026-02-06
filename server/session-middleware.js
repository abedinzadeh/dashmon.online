const session = require('express-session');
const { createClient } = require('redis');
const RedisStore = require('connect-redis').default;

function createSessionMiddleware(options = {}) {
  const client = options.client || createClient({ url: process.env.REDIS_URL });

  if (!options.client) {
    client.connect().catch(console.error);
  }

  return session({
    store: options.store || new RedisStore({ client }),
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
