const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcryptjs');
const { pool } = require('./db');

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [id]);
    done(null, rows[0] || null);
  } catch (e) {
    done(e);
  }
});

// --- Google OAuth ---
passport.use(new GoogleStrategy(
  {
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL
  },
  async (_accessToken, _refreshToken, profile, done) => {
    try {
      const email = profile.emails?.[0]?.value?.toLowerCase();
      const name = profile.displayName || null;
      if (!email) return done(new Error('No email returned from Google'));

      const existing = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
      if (existing.rows[0]) return done(null, existing.rows[0]);

      const created = await pool.query(
        'INSERT INTO users(email, name, provider, plan) VALUES($1,$2,$3,$4) RETURNING *',
        [email, name, 'google', 'free']
      );
      return done(null, created.rows[0]);
    } catch (e) {
      return done(e);
    }
  }
));

// --- Local login (Email or User ID + Password) ---
passport.use(new LocalStrategy(
  { usernameField: 'identifier', passwordField: 'password', session: true },
  async (identifier, password, done) => {
    try {
      const raw = String(identifier || '').trim();
      const pass = String(password || '');

      if (!raw) return done(null, false, { message: 'Email or User ID is required' });
      if (!pass) return done(null, false, { message: 'Password is required' });

      const isEmail = raw.includes('@');
      const q = isEmail
        ? 'SELECT * FROM users WHERE lower(email)=lower($1) LIMIT 1'
        : 'SELECT * FROM users WHERE username=$1 LIMIT 1';

      const { rows } = await pool.query(q, [raw]);
      const user = rows[0];
      if (!user) return done(null, false, { message: 'Invalid credentials' });

      if (!user.password_hash) {
        // Google-only account
        return done(null, false, { message: 'This account uses Google login. Please continue with Google.' });
      }

      const ok = await bcrypt.compare(pass, String(user.password_hash));
      if (!ok) return done(null, false, { message: 'Invalid credentials' });

      return done(null, user);
    } catch (e) {
      return done(e);
    }
  }
));

function requireAuth(req, res, next) {
  if (req.user) return next();

  const wantsJson =
    req.path.startsWith('/api/') ||
    (req.headers.accept && req.headers.accept.includes('application/json')) ||
    req.xhr;

  if (wantsJson) return res.status(401).json({ error: 'unauthenticated' });
  return res.redirect('/login.html');
}

module.exports = { passport, requireAuth };
