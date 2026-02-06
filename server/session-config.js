const session = require('express-session');

function createSessionMiddleware({ store, secret = process.env.SESSION_SECRET } = {}) {
  return session({
    store,
    secret,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      secure: 'auto',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  });
}

module.exports = { createSessionMiddleware };
