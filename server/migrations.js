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

  // Billing / subscription state
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_status TEXT NOT NULL DEFAULT 'active'");
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_source TEXT');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_until TIMESTAMPTZ');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS paypal_subscription_id TEXT');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_transfer_reference TEXT');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_since TIMESTAMPTZ');

  // One-time demo upgrade (per-user)
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS demo_used_at TIMESTAMPTZ');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS demo_expires_at TIMESTAMPTZ');

  // Bank transfer requests
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bank_transfer_requests (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reference_code TEXT NOT NULL UNIQUE,
      amount_cents INT NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_bank_transfer_requests_user ON bank_transfer_requests(user_id)');

  // PayPal subscriptions tracking (idempotent webhook processing)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS paypal_subscriptions (
      id TEXT PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      raw JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_paypal_subscriptions_user ON paypal_subscriptions(user_id)');



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
