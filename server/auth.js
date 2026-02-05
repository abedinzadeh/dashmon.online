const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
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
