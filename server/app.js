require('dotenv').config();
const express = require('express');
const { passport } = require('./auth');
const { router } = require('./routes');
const { createMemoryRateLimiter } = require('./rate-limit');
const { createSessionMiddleware } = require('./session-middleware');

function parseTrustProxy(value) {
  if (value == null || value === '') return 1;
  if (value === 'true') return true;
  if (value === 'false') return false;
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

function createApp({ sessionStore } = {}) {
  const app = express();

  app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));
  app.use(createSessionMiddleware({ store: sessionStore }));

  app.use(passport.initialize());
  app.use(passport.session());

  const authRateLimit = createMemoryRateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 20,
    keyFn: (req) => `${req.ip || 'unknown'}:${req.path}`,
    message: 'Too many auth requests. Please retry later.'
  });

  app.get('/auth/google', authRateLimit,
    passport.authenticate('google', { scope: ['profile', 'email'], prompt: 'select_account' })
  );

  app.get('/auth/google/callback', authRateLimit,
    passport.authenticate('google', { failureRedirect: '/login.html' }),
    (req, res) => {
      console.log('Google OAuth successful, user:', req.user ? req.user.email : 'no user');
      res.redirect('/app/');
    }
  );

  app.use(express.static('/app/public'));
  app.use(router);

  return app;
}

module.exports = { createApp, parseTrustProxy };
