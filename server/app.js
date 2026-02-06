require('dotenv').config();

const express = require('express');
const { passport } = require('./auth');
const { router } = require('./routes');
const { createSessionMiddleware } = require('./session-middleware');

function parseTrustProxy(value) {
  if (!value) return 1;
  if (value === 'true') return true;
  if (value === 'false') return false;

  const asNumber = Number(value);
  if (!Number.isNaN(asNumber)) return asNumber;

  return value;
}

function createApp() {
  const app = express();

  app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));
  app.use(createSessionMiddleware());

  app.use(passport.initialize());
  app.use(passport.session());

  app.get(
    '/auth/google',
    passport.authenticate('google', { scope: ['profile', 'email'], prompt: 'select_account' })
  );

  app.get(
    '/auth/google/callback',
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
