const { pool } = require('./db');

async function ensureLocalAuthSchema() {
  // Safe migrations for existing DBs
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT');

  // Subscription / plan gating
  // Older DBs may not have this column yet.
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free'");
  // Backfill any legacy NULLs
  await pool.query("UPDATE users SET plan='free' WHERE plan IS NULL");


  // Ensure uniqueness for non-null usernames (multiple NULLs allowed)
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users(username) WHERE username IS NOT NULL');
}

module.exports = { ensureLocalAuthSchema };
