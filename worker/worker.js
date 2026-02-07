require('dotenv').config();
const { Pool } = require('pg');
const http = require('http');
const https = require('https');
const net = require('net');
const { execFile } = require('child_process');
const { isInMaintenance } = require('./maintenance');

const pool = new Pool({
  host: process.env.PGHOST || 'postgres',
  port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD
});

// Ensure required tables exist (helps when the DB volume already existed before schema was introduced)
async function ensureAlertEventsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.alert_events (
        id BIGSERIAL PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
        device_id UUID NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        last_sent TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id, device_id, event_type)
      );
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_alert_events_user_device
      ON public.alert_events(user_id, device_id);
    `);
  } catch (e) {
    console.error('ensureAlertEventsTable error:', e?.message || e);
  }
}


function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function httpCheck(url) {
  const start = Date.now();
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: 15000 }, (res) => {
      res.resume();
      const ms = Date.now() - start;
      const ok = res.statusCode && res.statusCode < 500;
      resolve({ status: ok ? 'up' : 'down', latency: ms, packet_loss: ok ? 0 : 100, detail: { statusCode: res.statusCode } });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'down', latency: Date.now()-start, packet_loss: 100, detail: { timeout: true } }); });
    req.on('error', (e) => resolve({ status: 'down', latency: Date.now()-start, packet_loss: 100, detail: { error: e.message } }));
  });
}

function tcpCheck(host, port) {
  const start = Date.now();
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok, detail) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch (_) {}
      resolve({ status: ok ? 'up' : 'down', latency: Date.now() - start, packet_loss: ok ? 0 : 100, detail: detail || {} });
    };
    socket.setTimeout(8000);
    socket.once('connect', () => finish(true, {}));
    socket.once('timeout', () => finish(false, { timeout: true }));
    socket.once('error', (e) => finish(false, { error: e.message }));
    socket.connect(port, host);
  });
}

// Best-effort ping: if ping isn't present or fails, fall back to TCP 443/80
function pingCheck(host) {
  return new Promise((resolve) => {
    execFile('ping', ['-c', '1', '-W', '2', host], { timeout: 6000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, stdout: stdout || '', stderr: (stderr || err.message || '') });
      } else {
        resolve({ ok: true, stdout: stdout || '', stderr: stderr || '' });
      }
    });
  });
}

async function executeDeviceCheck(device) {
  // Prefer explicit URL
  if (device.url) return httpCheck(device.url);

  // Prefer port if present
  if (device.port) return tcpCheck(device.ip, device.port);

  // Try ping, fall back to tcp
  try {
    const p = await pingCheck(device.ip);
    if (p.ok) return { status: 'up', latency: null, packet_loss: 0, detail: { ping: 'ok' } };
  } catch (_) {}

  // fallback ports
  const r1 = await tcpCheck(device.ip, 443);
  if (r1.status === 'up') return r1;
  const r2 = await tcpCheck(device.ip, 80);
  return r2;
}

async function retentionCleanup() {
  // Keep 90 days
  await pool.query(`DELETE FROM device_history WHERE timestamp < now() - interval '90 days'`);
}

async function getDueDevices() {
  const { rows } = await pool.query(
    `SELECT d.*, u.plan, u.email AS user_email,
            s.maintenance_start AS store_maintenance_start,
            s.maintenance_end AS store_maintenance_end
     FROM devices d
     JOIN users u ON u.id = d.user_id
     JOIN stores s ON s.id = d.store_id AND s.user_id = d.user_id
     WHERE d.last_check IS NULL
        OR d.last_check <= now() - (d.ping_interval * interval '1 second')
     ORDER BY COALESCE(d.last_check, to_timestamp(0)) ASC
     LIMIT 100`
  );
  return rows;
}

async function writeHistory(deviceId, status, packetLoss, latency, detail) {
  await pool.query(
    `INSERT INTO device_history(device_id, status, packet_loss, latency, detail)
     VALUES ($1,$2,$3,$4,$5)`,
    [deviceId, status, packetLoss ?? null, latency ?? null, detail ? JSON.stringify(detail) : '{}']
  );
}

async function updateDevice(deviceId, userId, status, packetLoss) {
  await pool.query(
    `UPDATE devices
     SET status=$1, packet_loss=$2, last_check=now(), updated_at=now()
     WHERE id=$3 AND user_id=$4`,
    [status, packetLoss ?? null, deviceId, userId]
  );
}

async function shouldSendEmail(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM alerts WHERE user_id=$1 AND type='email' AND enabled=true LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function updateAlertEvent(userId, deviceId, eventType) {
  await pool.query(
    `INSERT INTO public.alert_events(user_id, device_id, event_type, last_sent)
     VALUES ($1,$2,$3,now())
     ON CONFLICT (user_id, device_id, event_type)
     DO UPDATE SET last_sent = EXCLUDED.last_sent`,
    [userId, deviceId, eventType]
  );
}

async function getLastAlertSent(userId, deviceId, eventType) {
  const { rows } = await pool.query(
    `SELECT last_sent FROM public.alert_events
     WHERE user_id=$1 AND device_id=$2 AND event_type=$3
     ORDER BY last_sent DESC LIMIT 1`,
    [userId, deviceId, eventType]
  );
  return rows[0]?.last_sent || null;
}

async function maybeSendEmailAlert(device, prevStatus, newStatus) {
  // Suppress alerts during maintenance windows (store or device)
  if (isInMaintenance(device)) return;

  const cfg = await shouldSendEmail(device.user_id);
  if (!cfg) return;

  // recipients from rules JSON: {"to":["a@b.com"],"from":"..."}; fallback to user email
  const rules = cfg.rules || {};
  const recipients = Array.isArray(rules.to) && rules.to.length ? rules.to : [device.user_email];

  // cooldown
  const eventType = newStatus === 'down' ? 'email_down' : 'email_up';
  const last = await getLastAlertSent(device.user_id, device.id, eventType);
  if (last) {
    const minutes = cfg.cooldown_minutes || 30;
    const ageMs = Date.now() - new Date(last).getTime();
    if (ageMs < minutes * 60 * 1000) return;
  }

  // Only alert on change
  if (prevStatus && prevStatus === newStatus) return;

  // SMTP must be configured
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || user;

  if (!host || !user || !pass || !from) {
    console.log(`[ALERT] Email not sent (SMTP not configured). Device=${device.name} Status=${newStatus}`);
    return;
  }

  // dynamic import to keep worker light if not configured
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });

  const subject = `Dashmon alert: ${device.name} is ${newStatus.toUpperCase()}`;
  const text = [
    `Device: ${device.name}`,
    `Project: ${device.store_id}`,
    `IP: ${device.ip}`,
    `Type: ${device.type}`,
    `Status: ${newStatus}`,
    `Time: ${new Date().toISOString()}`
  ].join('\n');

  try {
    await transporter.sendMail({
      from,
      to: recipients.join(','),
      subject,
      text
    });
    await updateAlertEvent(device.user_id, device.id, eventType);
    console.log(`[ALERT] Email sent to ${recipients.join(',')} for ${device.name} (${newStatus})`);
  } catch (e) {
    console.error('[ALERT] Email send failed:', e.message);
  }
}

async function tick() {
  const due = await getDueDevices();
  if (!due.length) return;

  for (const device of due) {
    const prevStatus = device.status;

    const result = await executeDeviceCheck(device);
    const newStatus = result.status || 'down';

    await updateDevice(device.id, device.user_id, newStatus, result.packet_loss);
    await writeHistory(device.id, newStatus, result.packet_loss, result.latency, result.detail);

    // optional email alert on change
    if (newStatus !== prevStatus) {
      await maybeSendEmailAlert(device, prevStatus, newStatus);
    }

    // light pacing
    await sleep(150);
  }
}

async function main() {
  console.log('dashmon worker started');
  await ensureAlertEventsTable();
  while (true) {
    try {
      await retentionCleanup();
      await tick();
    } catch (e) {
      console.error('worker tick error:', e);
    }
    // run every 20 seconds; per-device schedule is based on ping_interval
    await sleep(20000);
  }
}

main().catch(e => {
  console.error('fatal worker error:', e);
  process.exit(1);
});
