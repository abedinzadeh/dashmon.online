require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { createClient } = require('redis');
const RedisStore = require('connect-redis').default;

const { passport } = require('./auth');
const { router } = require('./routes');
const { createMemoryRateLimiter } = require('./rate-limit');

const app = express();

// Redis session store
const redisClient = createClient({ url: process.env.REDIS_URL });
redisClient.connect().catch(console.error);

app.set('trust proxy', 1);

app.use(session({
  store: new RedisStore({ client: redisClient }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

app.use(passport.initialize());
app.use(passport.session());


const authRateState = new Map();
function authRateLimit(req, res, next) {
  const key = `${req.ip || 'unknown'}:${req.path}`;
  const now = Date.now();
  const windowMs = 60 * 1000;
  const max = 20;

  let entry = authRateState.get(key);
  if (!entry || now - entry.start >= windowMs) {
    entry = { start: now, count: 0 };
    authRateState.set(key, entry);
  }

  entry.count += 1;
  if (entry.count > max) {
    const retryAfterSeconds = Math.ceil((windowMs - (now - entry.start)) / 1000);
    res.set('Retry-After', String(Math.max(retryAfterSeconds, 1)));
    return res.status(429).json({ error: 'Too many auth requests. Please retry later.' });
  }

  return next();
}
const authRateLimit = createMemoryRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 20,
  keyFn: (req) => `${req.ip || 'unknown'}:${req.path}`,
  message: 'Too many auth requests. Please retry later.'
});

// Auth routes
app.get('/auth/google', authRateLimit,
  passport.authenticate('google', { scope: ['profile','email'], prompt: 'select_account' })
);

app.get('/auth/google/callback', authRateLimit,
  passport.authenticate('google', { failureRedirect: '/login.html' }),
  (req, res) => {
    console.log('Google OAuth successful, user:', req.user ? req.user.email : 'no user');
    res.redirect('/app/');
  }
);

// Static UI
app.use(express.static('/app/public'));

// API routes
app.use(router);

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(port, () => console.log(`dashmon app listening on ${port}`));
