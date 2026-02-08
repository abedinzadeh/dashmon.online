CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users (Google + Local)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email TEXT UNIQUE NOT NULL,
    username TEXT UNIQUE,
    password_hash TEXT,
    name TEXT,
    provider TEXT NOT NULL DEFAULT 'google',
    plan TEXT NOT NULL DEFAULT 'free', -- free | premium
    plan_status TEXT NOT NULL DEFAULT 'active', -- active | pending | canceled
    plan_source TEXT, -- paypal | bank_transfer | demo | admin
    premium_until TIMESTAMPTZ,
    paypal_subscription_id TEXT,
    bank_transfer_reference TEXT,
    pending_since TIMESTAMPTZ,
    demo_used_at TIMESTAMPTZ,
    demo_expires_at TIMESTAMPTZ,
    timezone TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bank transfer requests (manual payment)
CREATE TABLE IF NOT EXISTS bank_transfer_requests (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reference_code TEXT NOT NULL UNIQUE,
    amount_cents INT NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bank_transfer_requests_user ON bank_transfer_requests(user_id);

-- PayPal subscriptions (idempotent webhook processing)
CREATE TABLE IF NOT EXISTS paypal_subscriptions (
    id TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    raw JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_paypal_subscriptions_user ON paypal_subscriptions(user_id);

-- Stores (formerly projects)
CREATE TABLE IF NOT EXISTS stores (
    id TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    location TEXT,
    notes TEXT,
    maintenance_start TIMESTAMPTZ,
    maintenance_end TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, user_id)
);

-- Devices (checks)
CREATE TABLE IF NOT EXISTS devices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    store_id TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL, -- fortigate, server, hypervisor, bmc, posserver, nxwitness, other
    ip TEXT NOT NULL,
    port INT,
    url TEXT,
    ping_interval INT NOT NULL DEFAULT 60, -- seconds
    ping_packets INT NOT NULL DEFAULT 10,
    notes TEXT,
    maintenance_start TIMESTAMPTZ,
    maintenance_end TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'unknown', -- up, down, warning, maintenance
    packet_loss INT,
    last_check TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (store_id, user_id) REFERENCES stores(id, user_id) ON DELETE CASCADE
);

-- Device history (check results)
CREATE TABLE IF NOT EXISTS device_history (
    id BIGSERIAL PRIMARY KEY,
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    status TEXT NOT NULL, -- up, down, warning, maintenance
    packet_loss INT,
    latency INT, -- milliseconds
    detail JSONB,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Alerts
CREATE TABLE IF NOT EXISTS alerts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL, -- email, sms
    enabled BOOLEAN NOT NULL DEFAULT true,
    rules JSONB NOT NULL DEFAULT '{}',
    cooldown_minutes INT NOT NULL DEFAULT 30,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_stores_user_id ON stores(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_store_id ON devices(store_id);
CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_device_history_device_id ON device_history(device_id);
CREATE INDEX IF NOT EXISTS idx_device_history_timestamp ON device_history(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_user_id ON alerts(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_user_type ON alerts(user_id, type);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_stores_updated_at 
    BEFORE UPDATE ON stores 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_devices_updated_at 
    BEFORE UPDATE ON devices 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- Alert event tracking (cooldown / dedupe)
CREATE TABLE IF NOT EXISTS alert_events (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL, -- email_down, email_up, etc
  last_sent TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_id, event_type)
);

CREATE INDEX IF NOT EXISTS idx_alert_events_user_device ON alert_events(user_id, device_id);

-- Maintenance window indexes
CREATE INDEX IF NOT EXISTS idx_devices_maintenance ON devices(user_id, maintenance_start, maintenance_end);
CREATE INDEX IF NOT EXISTS idx_stores_maintenance ON stores(user_id, maintenance_start, maintenance_end);
