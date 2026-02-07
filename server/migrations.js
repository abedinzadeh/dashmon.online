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



  // Maintenance windows (per store and per device)
  await pool.query('ALTER TABLE stores ADD COLUMN IF NOT EXISTS maintenance_start TIMESTAMPTZ');
  await pool.query('ALTER TABLE stores ADD COLUMN IF NOT EXISTS maintenance_end TIMESTAMPTZ');
  await pool.query('ALTER TABLE devices ADD COLUMN IF NOT EXISTS maintenance_start TIMESTAMPTZ');
  await pool.query('ALTER TABLE devices ADD COLUMN IF NOT EXISTS maintenance_end TIMESTAMPTZ');

  await pool.query('CREATE INDEX IF NOT EXISTS idx_devices_maintenance ON devices(user_id, maintenance_start, maintenance_end)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_stores_maintenance ON stores(user_id, maintenance_start, maintenance_end)');


  // Ensure uniqueness for non-null usernames (multiple NULLs allowed)
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users(username) WHERE username IS NOT NULL');
}

module.exports = { ensureLocalAuthSchema };
