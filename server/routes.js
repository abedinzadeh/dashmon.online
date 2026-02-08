const express = require('express');
const { pool } = require('./db');
const { requireAuth, passport } = require('./auth');
const { requirePremium } = require('./require-premium');
const bcrypt = require('bcryptjs');
const {
  getPlanLimits: resolvePlanLimits,
  enforceProjectLimitForUser,
  getUserPlanFromDb
} = require('./plan-limits');
const { createMemoryRateLimiter } = require('./rate-limit');
const { sendSms } = require('./sms');

// Maintenance window helpers
function parseMaybeTime(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
function isNowInMaintenanceWindow(now, start, end) {
  if (!start) return false;
  const s = new Date(start);
  if (Number.isNaN(s.getTime())) return false;
  if (!end) return now >= s;
  const e = new Date(end);
  if (Number.isNaN(e.getTime())) return now >= s;
  return now >= s && now <= e;
}

// --- Premium analytics helpers ---
function normalizeRangeToInterval(range) {
  const r = String(range || '').trim().toLowerCase();
  if (r === '24h' || r === '1d' || r === 'day') return { key: '24h', intervalSql: "interval '24 hours'" };
  if (r === '30d' || r === 'month') return { key: '30d', intervalSql: "interval '30 days'" };
  // default 7d
  return { key: '7d', intervalSql: "interval '7 days'" };
}

function computeAnalyticsFromHistory(historyAsc) {
  const rows = Array.isArray(historyAsc) ? historyAsc : [];
  const totalSamples = rows.length;
  let upSamples = 0;
  let latencySum = 0;
  let latencyCount = 0;
  let incidents = 0;
  let downtimeMs = 0;

  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i];
    const status = String(cur.status || '').toLowerCase();
    if (status === 'up') upSamples++;
    const lat = Number(cur.latency_ms);
    if (status === 'up' && Number.isFinite(lat)) {
      latencySum += lat;
      latencyCount += 1;
    }

    if (i > 0) {
      const prev = rows[i - 1];
      const prevStatus = String(prev.status || '').toLowerCase();
      if (prevStatus !== 'down' && status === 'down') incidents++;

      const prevTs = new Date(prev.ts);
      const curTs = new Date(cur.ts);
      const dt = curTs.getTime() - prevTs.getTime();
      if (Number.isFinite(dt) && dt > 0 && status === 'down') {
        downtimeMs += dt;
      }
    }
  }

  const uptimePct = totalSamples ? (upSamples / totalSamples) * 100 : null;
  const avgLatency = latencyCount ? latencySum / latencyCount : null;

  return {
    samples: totalSamples,
    uptime_pct: uptimePct,
    avg_response_ms: avgLatency,
    incident_count: incidents,
    downtime_minutes: Math.round(downtimeMs / 60000)
  };
}

const router = express.Router();
router.use(express.json());

// --- UTC normalization ---
// Server returns ISO 8601 UTC strings for any Date objects in JSON responses.
function _convertDatesToIsoUtc(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(_convertDatesToIsoUtc);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = _convertDatesToIsoUtc(v);
    return out;
  }
  return value;
}

router.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = (body) => originalJson(_convertDatesToIsoUtc(body));
  next();
});


// --- Health (public) ---
// Used by smoke tests / load balancers to validate app + DB connectivity.
router.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      ok: true,
      service: 'dashmon',
      time: new Date().toISOString()
    });
  } catch (e) {
    res.status(503).json({
      ok: false,
      service: 'dashmon',
      time: new Date().toISOString(),
      error: 'db_unavailable'
    });
  }
});

// --- Local auth (Email/UserID + Password) ---
router.post('/auth/local/signup', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const usernameRaw = String(req.body?.username || '').trim();
    const username = usernameRaw ? usernameRaw : null;
    const password = String(req.body?.password || '');

    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email is required' });
    if (username && username.length < 3) return res.status(400).json({ error: 'User ID must be at least 3 characters' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const existingEmail = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    if (existingEmail.rows[0]) {
      if (!existingEmail.rows[0].password_hash) {
        return res.status(409).json({ error: 'This email is already registered via Google. Please continue with Google.' });
      }
      return res.status(409).json({ error: 'Email already registered. Please sign in.' });
    }

    if (username) {
      const existingUsername = await pool.query('SELECT 1 FROM users WHERE username=$1', [username]);
      if (existingUsername.rows[0]) return res.status(409).json({ error: 'User ID already taken' });
    }

    const hash = await bcrypt.hash(password, 12);
    const created = await pool.query(
      'INSERT INTO users(email, username, password_hash, provider, plan) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [email, username, hash, 'local', 'free']
    );

    const user = created.rows[0];
    req.login(user, (err) => {
      if (err) return res.status(500).json({ error: 'Failed to create session' });
      return res.json({ ok: true });
    });
  } catch (e) {
    console.error('signup error', e);
    res.status(500).json({ error: 'Signup failed' });
  }
});

router.post('/auth/local/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) return res.status(500).json({ error: 'Login failed' });
    if (!user) return res.status(401).json({ error: info?.message || 'Invalid credentials' });
    req.login(user, (e) => {
      if (e) return res.status(500).json({ error: 'Failed to create session' });
      return res.json({ ok: true });
    });
  })(req, res, next);
});


// --- Write rate limiting (POST/PUT/DELETE) ---
const writeRateLimiter = createMemoryRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: (req) => (req.user?.plan === 'premium' ? 120 : 60),
  keyFn: (req) => `${req.user?.id || req.ip || 'anon'}:${req.path}`,
  message: 'Too many write requests. Please slow down.'
});

router.use((req, res, next) => {
  if (!['POST', 'PUT', 'DELETE'].includes(req.method)) return next();
  return writeRateLimiter(req, res, next);
});

// --- Auth / session helpers ---
router.get('/api/me', requireAuth, (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    name: req.user.name,
    plan: req.user.plan,
    timezone: req.user.timezone || null
  });
});

// --- Billing / subscription (placeholder) ---
// This is intentionally a basic stub. Wire this up to Stripe/Chargebee later.
router.get('/api/billing/plans', (_req, res) => {
  res.json({
    plans: [
      {
        id: 'free',
        name: 'Free',
        price: 0,
        currency: 'USD',
        interval: 'month',
        features: ['Up to 3 projects', 'Up to 15 devices per project', 'Checks every 2 hours']
      },
      {
        id: 'premium',
        name: 'Premium',
        price: 19,
        currency: 'USD',
        interval: 'month',
        features: ['Up to 10 projects', 'Up to 15 devices per project', 'Checks every 15 minutes', 'Manual test-now', 'Timezone preference']
      }
    ]
  });
});

router.post('/api/billing/checkout', requireAuth, async (req, res) => {
  // Placeholder: return a "checkout session" object for the UI.
  // In a real implementation, create a Stripe checkout session and return its URL.
  res.json({
    ok: true,
    provider: 'placeholder',
    message: 'Checkout flow is not configured yet. This is a placeholder endpoint.',
    next: '/app/pricing.html'
  });
});

router.get('/api/billing/test-mode', requireAuth, (req, res) => {
  const enabled = String(process.env.BILLING_ALLOW_TEST_UPGRADE || '').toLowerCase() === 'true';
  res.json({ enabled });
});

// Optional: enable a safe test-only upgrade path (for CI/tests/demo environments).
// Set BILLING_ALLOW_TEST_UPGRADE=true to enable.
router.post('/api/billing/simulate-upgrade', requireAuth, async (req, res) => {
  if (String(process.env.BILLING_ALLOW_TEST_UPGRADE || '').toLowerCase() !== 'true') {
    return res.status(404).json({ error: 'Not found' });
  }

  const requested = String(req.body?.plan || 'premium').trim().toLowerCase();
  const plan = requested === 'free' ? 'free' : 'premium';

  try {
    const { rows } = await pool.query('UPDATE users SET plan=$1 WHERE id=$2 RETURNING plan', [plan, req.user.id]);
    // Keep req.user in sync for this request.
    if (req.user) req.user.plan = rows[0]?.plan || plan;
    res.json({ ok: true, plan: rows[0]?.plan || plan });
  } catch (e) {
    console.error('simulate-upgrade error', e);
    res.status(500).json({ error: 'Failed to update plan' });
  }
});

// Logout should always work (even if session is half-broken)
router.post('/logout', (req, res) => {
  try {
    req.logout(() => {
      if (req.session) req.session.destroy(() => res.status(204).end());
      else res.status(204).end();
    });
  } catch (e) {
    try {
      if (req.session) req.session.destroy(() => res.status(204).end());
      else res.status(204).end();
    } catch (_) {
      res.status(204).end();
    }
  }
});

// Optional GET logout (useful for manual testing)
router.get('/logout', (_req, res) => res.redirect('/login.html'));

// --- Projects (formerly "stores") ---
// NOTE: We keep DB table name "stores" but UI uses "projects".
async function getProjectsWithDevices(userId) {
  const { rows: projects } = await pool.query(
    `SELECT id, name, location, notes, created_at, updated_at
     FROM stores
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );

  const { rows: devices } = await pool.query(
    `SELECT *
     FROM devices
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );

  const devicesByProject = new Map();
  for (const d of devices) {
    const key = d.store_id;
    if (!devicesByProject.has(key)) devicesByProject.set(key, []);
    devicesByProject.get(key).push(d);
  }

  return projects.map((p) => {
    const list = devicesByProject.get(p.id) || [];
    const totalDevices = list.length;
    const upDevices = list.filter((x) => x.status === 'up').length;
    const downDevices = list.filter((x) => x.status === 'down').length;
    const warningDevices = list.filter((x) => x.status === 'warning').length;
    const now = new Date();
    const storeMaintenanceActive = isNowInMaintenanceWindow(now, p.maintenance_start, p.maintenance_end);
    const listWithMaint = list.map((d) => {
      const deviceMaintenanceActive = storeMaintenanceActive || isNowInMaintenanceWindow(now, d.maintenance_start, d.maintenance_end);
      return { ...d, maintenanceActive: deviceMaintenanceActive };
    });
    const maintenanceDevices = listWithMaint.filter((x) => x.maintenanceActive || x.status === 'maintenance').length;

    let status = 'up';
    if (downDevices > 0) status = 'down';
    else if (warningDevices > 0) status = 'warning';
    else if (maintenanceDevices > 0) {
      status = maintenanceDevices === totalDevices ? 'maintenance' : 'partial_maintenance';
    }

    return {
      ...p,
      maintenanceActive: storeMaintenanceActive,
      devices: listWithMaint,
      totalDevices,
      upDevices,
      downDevices,
      warningDevices,
      maintenanceDevices,
      status
    };
  });
}


// Maintenance mode (Premium only)
// Set maintenance for a device: startTime required, endTime optional (null = until manually cleared)
router.post('/api/maintenance/device/:deviceId', requireAuth, requirePremium, async (req, res) => {
  try {
    const deviceId = req.params.deviceId;
    const { startTime, endTime } = req.body || {};
    const start = parseMaybeTime(startTime);
    const end = parseMaybeTime(endTime);

    if (!start) return res.status(400).json({ error: 'startTime is required (ISO datetime)' });
    if (end && end < start) return res.status(400).json({ error: 'endTime must be after startTime' });

    const r = await pool.query(
      `UPDATE devices
         SET maintenance_start=$1, maintenance_end=$2
       WHERE id=$3 AND user_id=$4
       RETURNING id, maintenance_start, maintenance_end`,
      [start.toISOString(), end ? end.toISOString() : null, deviceId, req.user.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'device not found' });
    res.json({ ok: true, device: r.rows[0] });
  } catch (e) {
    console.error('maintenance device set error', e);
    res.status(500).json({ error: 'failed' });
  }
});

// Clear maintenance for device
router.delete('/api/maintenance/device/:deviceId', requireAuth, requirePremium, async (req, res) => {
  try {
    const deviceId = req.params.deviceId;
    const r = await pool.query(
      `UPDATE devices
         SET maintenance_start=NULL, maintenance_end=NULL
       WHERE id=$1 AND user_id=$2
       RETURNING id`,
      [deviceId, req.user.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'device not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('maintenance device clear error', e);
    res.status(500).json({ error: 'failed' });
  }
});

// Set maintenance for a project/store (applies to all devices via suppression)
router.post('/api/maintenance/store/:storeId', requireAuth, requirePremium, async (req, res) => {
  try {
    const storeId = req.params.storeId;
    const { startTime, endTime } = req.body || {};
    const start = parseMaybeTime(startTime);
    const end = parseMaybeTime(endTime);

    if (!start) return res.status(400).json({ error: 'startTime is required (ISO datetime)' });
    if (end && end < start) return res.status(400).json({ error: 'endTime must be after startTime' });

    const r = await pool.query(
      `UPDATE stores
         SET maintenance_start=$1, maintenance_end=$2
       WHERE id=$3 AND user_id=$4
       RETURNING id, maintenance_start, maintenance_end`,
      [start.toISOString(), end ? end.toISOString() : null, storeId, req.user.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'store not found' });
    res.json({ ok: true, store: r.rows[0] });
  } catch (e) {
    console.error('maintenance store set error', e);
    res.status(500).json({ error: 'failed' });
  }
});

// Clear maintenance for store
router.delete('/api/maintenance/store/:storeId', requireAuth, requirePremium, async (req, res) => {
  try {
    const storeId = req.params.storeId;
    const r = await pool.query(
      `UPDATE stores
         SET maintenance_start=NULL, maintenance_end=NULL
       WHERE id=$1 AND user_id=$2
       RETURNING id`,
      [storeId, req.user.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'store not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('maintenance store clear error', e);
    res.status(500).json({ error: 'failed' });
  }
});

router.get('/api/projects', requireAuth, async (req, res) => {
  try {
    const data = await getProjectsWithDevices(req.user.id);
    res.json(data);
  } catch (e) {
    console.error('Error fetching projects:', e);
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

// Legacy alias
router.get('/api/stores', requireAuth, async (req, res) => {
  try {
    const data = await getProjectsWithDevices(req.user.id);
    res.json(data);
  } catch (e) {
    console.error('Error fetching stores:', e);
    res.status(500).json({ error: 'Failed to fetch stores' });
  }
});

router.post('/api/projects', requireAuth, async (req, res) => {
  const { name, id, location, notes } = req.body || {};
  if (!name || !id) return res.status(400).json({ error: 'Project name and Project ID are required' });

  try {
    const projectLimit = await enforceProjectLimitForUser(pool, req.user.id);
    if (projectLimit.overLimit) {
      return res.status(400).json({
        error: `Plan limit reached. Your plan allows ${projectLimit.maxProjects} projects.`
      });
    }

    const existing = await pool.query('SELECT 1 FROM stores WHERE user_id=$1 AND id=$2', [req.user.id, id]);
    if (existing.rows.length) return res.status(400).json({ error: 'Project ID already exists' });

    const { rows } = await pool.query(
      `INSERT INTO stores (user_id, id, name, location, notes)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, name, location, notes, created_at, updated_at`,
      [req.user.id, id, name, location || null, notes || null]
    );

    res.json({ project: rows[0] });
  } catch (e) {
    console.error('Error adding project:', e);
    res.status(500).json({ error: 'Failed to add project' });
  }
});

// Legacy alias
router.post('/api/stores', requireAuth, async (req, res) => {
  const { name, id, location, notes } = req.body || {};
  if (!name || !id) return res.status(400).json({ error: 'Store name and ID are required' });

  try {
    const projectLimit = await enforceProjectLimitForUser(pool, req.user.id);
    if (projectLimit.overLimit) {
      return res.status(400).json({
        error: `Plan limit reached. Your plan allows ${projectLimit.maxProjects} projects.`
      });
    }

    const existing = await pool.query('SELECT 1 FROM stores WHERE user_id=$1 AND id=$2', [req.user.id, id]);
    if (existing.rows.length) return res.status(400).json({ error: 'Store ID already exists' });

    const { rows } = await pool.query(
      `INSERT INTO stores (user_id, id, name, location, notes)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, name, location, notes, created_at, updated_at`,
      [req.user.id, id, name, location || null, notes || null]
    );

    res.json({ store: rows[0] });
  } catch (e) {
    console.error('Error adding store:', e);
    res.status(500).json({ error: 'Failed to add store' });
  }
});

router.get('/api/projects/:projectId', requireAuth, async (req, res) => {
  const projectId = req.params.projectId;
  try {
    const { rows } = await pool.query(
      `SELECT id, name, location, notes, created_at, updated_at
       FROM stores
       WHERE user_id=$1 AND id=$2`,
      [req.user.id, projectId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Project not found' });
    res.json({ project: rows[0] });
  } catch (e) {
    console.error('Error fetching project:', e);
    res.status(500).json({ error: 'Failed to fetch project' });
  }
});


router.put('/api/projects/:projectId', requireAuth, async (req, res) => {
  const projectId = req.params.projectId;
  const { name, location, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Project name is required' });

  try {
    const { rows } = await pool.query(
      `UPDATE stores
         SET name=$3, location=$4, notes=$5, updated_at=NOW()
       WHERE user_id=$1 AND id=$2
       RETURNING id, name, location, notes, created_at, updated_at`,
      [req.user.id, projectId, name, location || null, notes || null]
    );
    if (!rows.length) return res.status(404).json({ error: 'Project not found' });
    res.json({ project: rows[0] });
  } catch (e) {
    console.error('Error updating project:', e);
    res.status(500).json({ error: 'Failed to update project' });
  }
});

router.delete('/api/projects/:projectId', requireAuth, async (req, res) => {
  const projectId = req.params.projectId;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Ensure project exists
    const pr = await client.query('SELECT id FROM stores WHERE user_id=$1 AND id=$2', [req.user.id, projectId]);
    if (!pr.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Project not found' });
    }

    const devs = await client.query('SELECT id FROM devices WHERE user_id=$1 AND store_id=$2', [req.user.id, projectId]);
    const deviceIds = devs.rows.map(r => r.id);

    if (deviceIds.length) {
      await client.query('DELETE FROM device_history WHERE user_id=$1 AND device_id = ANY($2::text[])', [req.user.id, deviceIds]);
      await client.query('DELETE FROM devices WHERE user_id=$1 AND store_id=$2', [req.user.id, projectId]);
    }

    await client.query('DELETE FROM stores WHERE user_id=$1 AND id=$2', [req.user.id, projectId]);
    await client.query('COMMIT');

    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Error deleting project:', e);
    res.status(500).json({ error: 'Failed to delete project' });
  } finally {
    client.release();
  }
});

// Legacy alias
router.get('/api/stores/:storeId', requireAuth, async (req, res) => {
  const storeId = req.params.storeId;
  try {
    const { rows } = await pool.query(
      `SELECT id, name, location, notes, created_at, updated_at
       FROM stores
       WHERE user_id=$1 AND id=$2`,
      [req.user.id, storeId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Store not found' });
    res.json({ store: rows[0] });
  } catch (e) {
    console.error('Error fetching store:', e);
    res.status(500).json({ error: 'Failed to fetch store' });
  }
});

// --- Devices ---
router.get('/api/projects/:projectId/devices', requireAuth, async (req, res) => {
  const projectId = req.params.projectId;
  try {
    const storeCheck = await pool.query('SELECT 1 FROM stores WHERE id=$1 AND user_id=$2', [
      projectId,
      req.user.id
    ]);
    if (!storeCheck.rows.length) return res.status(404).json({ error: 'Project not found' });

    const { rows } = await pool.query(
      'SELECT * FROM devices WHERE store_id=$1 AND user_id=$2 ORDER BY created_at DESC',
      [projectId, req.user.id]
    );
    res.json({ devices: rows });
  } catch (e) {
    console.error('Error fetching devices:', e);
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
});

// Legacy alias
router.get('/api/stores/:storeId/devices', requireAuth, async (req, res) => {
  const storeId = req.params.storeId;
  try {
    const storeCheck = await pool.query('SELECT 1 FROM stores WHERE id=$1 AND user_id=$2', [
      storeId,
      req.user.id
    ]);
    if (!storeCheck.rows.length) return res.status(404).json({ error: 'Store not found' });

    const { rows } = await pool.query(
      'SELECT * FROM devices WHERE store_id=$1 AND user_id=$2 ORDER BY created_at DESC',
      [storeId, req.user.id]
    );
    res.json({ devices: rows });
  } catch (e) {
    console.error('Error fetching devices:', e);
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
});

async function enforceDeviceLimitOr400({ userId, projectId }) {
  const { rows: countRows } = await pool.query(
    'SELECT COUNT(*)::int AS count FROM devices WHERE store_id=$1 AND user_id=$2',
    [projectId, userId]
  );

  const dbPlan = await getUserPlanFromDb(pool, userId);
  const { devicesPerProject: maxDevices } = resolvePlanLimits(dbPlan);

  if (Number(countRows[0]?.count || 0) >= maxDevices) {
    return {
      ok: false,
      maxDevices,
      plan: dbPlan
    };
  }

  return { ok: true, maxDevices, plan: dbPlan };
}

router.post('/api/projects/:projectId/devices', requireAuth, async (req, res) => {
  const projectId = req.params.projectId;
  const { name, type, ip, port, url, notes } = req.body || {};
  if (!name || !type || !ip) return res.status(400).json({ error: 'Device name, type, and IP are required' });

  try {
    const storeCheck = await pool.query('SELECT 1 FROM stores WHERE id=$1 AND user_id=$2', [
      projectId,
      req.user.id
    ]);
    if (!storeCheck.rows.length) return res.status(404).json({ error: 'Project not found' });

    const limitCheck = await enforceDeviceLimitOr400({ userId: req.user.id, projectId });
    if (!limitCheck.ok) {
      return res.status(400).json({
        error: `Plan limit reached. Your plan allows ${limitCheck.maxDevices} devices per project.`
      });
    }

    // Enforce check interval by plan:
    // free = 2 hours, premium = 15 minutes
    const pingInterval = limitCheck.plan === 'premium' ? 900 : 7200;

    const { rows } = await pool.query(
      `INSERT INTO devices (store_id, user_id, name, type, ip, port, url, ping_interval, ping_packets, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'unknown')
       RETURNING *`,
      [projectId, req.user.id, name, type, ip, port || null, url || null, pingInterval, 3, notes || null]
    );

    res.json({ device: rows[0] });
  } catch (e) {
    console.error('Error adding device:', e);
    res.status(500).json({ error: 'Failed to add device' });
  }
});

// Legacy alias
router.post('/api/stores/:storeId/devices', requireAuth, async (req, res) => {
  const storeId = req.params.storeId;
  const { name, type, ip, port, url, notes } = req.body || {};
  if (!name || !type || !ip) return res.status(400).json({ error: 'Device name, type, and IP are required' });

  try {
    const storeCheck = await pool.query('SELECT 1 FROM stores WHERE id=$1 AND user_id=$2', [
      storeId,
      req.user.id
    ]);
    if (!storeCheck.rows.length) return res.status(404).json({ error: 'Store not found' });

    const limitCheck = await enforceDeviceLimitOr400({ userId: req.user.id, projectId: storeId });
    if (!limitCheck.ok) {
      return res.status(400).json({
        error: `Plan limit reached. Your plan allows ${limitCheck.maxDevices} devices per project.`
      });
    }

    const pingInterval = limitCheck.plan === 'premium' ? 900 : 7200;

    const { rows } = await pool.query(
      `INSERT INTO devices (store_id, user_id, name, type, ip, port, url, ping_interval, ping_packets, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'unknown')
       RETURNING *`,
      [storeId, req.user.id, name, type, ip, port || null, url || null, pingInterval, 3, notes || null]
    );

    res.json({ device: rows[0] });
  } catch (e) {
    console.error('Error adding device:', e);
    res.status(500).json({ error: 'Failed to add device' });
  }
});

router.get('/api/projects/:projectId/devices/:deviceId', requireAuth, async (req, res) => {
  const { projectId, deviceId } = req.params;
  try {
    const storeCheck = await pool.query('SELECT 1 FROM stores WHERE id=$1 AND user_id=$2', [
      projectId,
      req.user.id
    ]);
    if (!storeCheck.rows.length) return res.status(404).json({ error: 'Project not found' });

    const { rows } = await pool.query('SELECT * FROM devices WHERE id=$1 AND store_id=$2 AND user_id=$3', [
      deviceId,
      projectId,
      req.user.id
    ]);
    if (!rows.length) return res.status(404).json({ error: 'Device not found' });
    res.json({ device: rows[0] });
  } catch (e) {
    console.error('Error fetching device:', e);
    res.status(500).json({ error: 'Failed to fetch device' });
  }
});

// Queue a device for immediate check (worker looks at last_check)
router.post('/api/devices/:deviceId/test-now', requireAuth, requirePremium, async (req, res) => {
  const { deviceId } = req.params;

  try {
    const { rows } = await pool.query(
      "UPDATE devices SET last_check = now() - interval '365 days' WHERE id=$1 AND user_id=$2 RETURNING id",
      [deviceId, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Device not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('Error test-now:', e);
    res.status(500).json({ error: 'Failed to queue test' });
  }
});

// --- Device history (for graphs) ---
router.get('/api/devices/:deviceId/history', requireAuth, async (req, res) => {
  const { deviceId } = req.params;
  const requestedLimit = Number(req.query.limit || 60);
  if (!Number.isFinite(requestedLimit) || requestedLimit < 1) {
    return res.status(400).json({ error: 'limit must be a positive number' });
  }
  const limit = Math.min(Math.floor(requestedLimit), 500);

  // Free plan data retention: only expose the last 7 days of history.
  // (Premium can access longer windows via analytics + reports.)
  const plan = String(req.user?.plan || 'free');
  const isFree = plan !== 'premium';

  try {
    // Ownership enforced by join on devices.user_id
    const { rows: deviceRows } = await pool.query('SELECT id FROM devices WHERE id=$1 AND user_id=$2', [
      deviceId,
      req.user.id
    ]);
    if (!deviceRows.length) return res.status(404).json({ error: 'Device not found' });

    let historyRows;
    try {
      const { rows } = await pool.query(
        `SELECT ts, status, latency_ms, status_code, detail
         FROM device_history
         WHERE device_id=$1
         ${isFree ? "AND ts >= now() - interval '7 days'" : ''}
         ORDER BY ts DESC
         LIMIT $2`,
        [deviceId, limit]
      );
      historyRows = rows;
    } catch (historyErr) {
      if (historyErr && historyErr.code !== '42703') throw historyErr;

      const { rows } = await pool.query(
        `SELECT timestamp AS ts, status, latency AS latency_ms, NULL::int AS status_code, detail
         FROM device_history
         WHERE device_id=$1
         ${isFree ? "AND timestamp >= now() - interval '7 days'" : ''}
         ORDER BY timestamp DESC
         LIMIT $2`,
        [deviceId, limit]
      );
      historyRows = rows;
    }

    res.json({ history: historyRows.reverse() }); // oldest->newest for charts
  } catch (e) {
    console.error('Error fetching device history:', e);
    res.status(500).json({ error: 'Failed to fetch device history' });
  }
});

// --- Advanced device analytics (Premium) ---
router.get('/api/devices/:deviceId/analytics', requireAuth, requirePremium, async (req, res) => {
  const { deviceId } = req.params;
  const { key, intervalSql } = normalizeRangeToInterval(req.query.range);

  try {
    const { rows: deviceRows } = await pool.query('SELECT id FROM devices WHERE id=$1 AND user_id=$2', [
      deviceId,
      req.user.id
    ]);
    if (!deviceRows.length) return res.status(404).json({ error: 'Device not found' });

    // Pull enough samples for accurate downtime calculations.
    let historyAsc;
    try {
      const { rows } = await pool.query(
        `SELECT ts, status, latency_ms
         FROM device_history
         WHERE device_id=$1 AND ts >= now() - ${intervalSql}
         ORDER BY ts ASC`,
        [deviceId]
      );
      historyAsc = rows;
    } catch (historyErr) {
      if (historyErr && historyErr.code !== '42703') throw historyErr;
      const { rows } = await pool.query(
        `SELECT timestamp AS ts, status, latency AS latency_ms
         FROM device_history
         WHERE device_id=$1 AND timestamp >= now() - ${intervalSql}
         ORDER BY timestamp ASC`,
        [deviceId]
      );
      historyAsc = rows;
    }

    const analytics = computeAnalyticsFromHistory(historyAsc);
    res.json({
      deviceId,
      range: key,
      analytics
    });
  } catch (e) {
    console.error('Error fetching device analytics:', e);
    res.status(500).json({ error: 'Failed to fetch device analytics' });
  }
});

// --- Time-based uptime reports (Premium) ---
// Dashmon uses "stores" as the top-level container (devices.store_id -> stores.id).
router.get('/api/reports/uptime', requireAuth, requirePremium, async (req, res) => {
  const periodRaw = String(req.query.period || 'weekly').trim().toLowerCase();
  const period = periodRaw === 'monthly' ? 'monthly' : 'weekly';
  const intervalSql = period === 'monthly' ? "interval '30 days'" : "interval '7 days'";
  const format = String(req.query.format || 'json').trim().toLowerCase();

  try {
    const { rows: storeRows } = await pool.query(
      'SELECT id, name FROM stores WHERE user_id=$1 ORDER BY created_at ASC',
      [req.user.id]
    );

    const { rows: deviceRows } = await pool.query(
      'SELECT id, store_id, name, type, url, ip FROM devices WHERE user_id=$1',
      [req.user.id]
    );

    const deviceById = new Map(deviceRows.map((d) => [d.id, d]));
    const devicesByStore = new Map();
    for (const d of deviceRows) {
      const sid = d.store_id;
      if (!devicesByStore.has(sid)) devicesByStore.set(sid, []);
      devicesByStore.get(sid).push(d.id);
    }

    const deviceIds = deviceRows.map((d) => d.id);
    const aggregates = new Map();

    if (deviceIds.length) {
      // Aggregate samples in SQL for performance.
      const placeholders = deviceIds.map((_, i) => `$${i + 2}`).join(',');
      const baseParams = [req.user.id, ...deviceIds];

      const tryQueries = [
        {
          sql: `
            SELECT d.store_id AS store_id,
                   h.device_id,
                   COUNT(*)::int AS samples,
                   SUM(CASE WHEN lower(h.status)='up' THEN 1 ELSE 0 END)::int AS up_samples,
                   AVG(CASE WHEN lower(h.status)='up' THEN h.latency_ms ELSE NULL END) AS avg_latency_ms
            FROM device_history h
            JOIN devices d ON d.id = h.device_id
            WHERE d.user_id=$1
              AND h.device_id IN (${placeholders})
              AND h.ts >= now() - ${intervalSql}
            GROUP BY d.store_id, h.device_id
          `
        },
        {
          sql: `
            SELECT d.store_id AS store_id,
                   h.device_id,
                   COUNT(*)::int AS samples,
                   SUM(CASE WHEN lower(h.status)='up' THEN 1 ELSE 0 END)::int AS up_samples,
                   AVG(CASE WHEN lower(h.status)='up' THEN h.latency ELSE NULL END) AS avg_latency_ms
            FROM device_history h
            JOIN devices d ON d.id = h.device_id
            WHERE d.user_id=$1
              AND h.device_id IN (${placeholders})
              AND h.timestamp >= now() - ${intervalSql}
            GROUP BY d.store_id, h.device_id
          `
        }
      ];

      let rows;
      try {
        rows = (await pool.query(tryQueries[0].sql, baseParams)).rows;
      } catch (err) {
        if (!(err && err.code === '42703')) throw err;
        rows = (await pool.query(tryQueries[1].sql, baseParams)).rows;
      }

      for (const r of rows) {
        aggregates.set(r.device_id, {
          store_id: r.store_id,
          samples: Number(r.samples) || 0,
          up_samples: Number(r.up_samples) || 0,
          avg_latency_ms: r.avg_latency_ms == null ? null : Number(r.avg_latency_ms)
        });
      }
    }

    const stores = storeRows.map((s) => {
      const ids = devicesByStore.get(s.id) || [];
      const devices = ids.map((id) => {
        const d = deviceById.get(id);
        const a = aggregates.get(id) || { samples: 0, up_samples: 0, avg_latency_ms: null };
        const uptimePct = a.samples ? (a.up_samples / a.samples) * 100 : null;
        return {
          id,
          name: d?.name || id,
          type: d?.type || null,
          url: d?.url || null,
          ip: d?.ip || null,
          samples: a.samples,
          uptime_pct: uptimePct,
          avg_response_ms: a.avg_latency_ms
        };
      });

      const totalSamples = devices.reduce((sum, d) => sum + (d.samples || 0), 0);
      const totalUp = devices.reduce((sum, d) => sum + Math.round(((d.uptime_pct ?? 0) / 100) * (d.samples || 0)), 0);
      const uptimePct = totalSamples ? (totalUp / totalSamples) * 100 : null;

      return {
        id: s.id,
        name: s.name,
        uptime_pct: uptimePct,
        devices
      };
    });

    const allSamples = stores.reduce(
      (sum, s) => sum + s.devices.reduce((t, d) => t + (d.samples || 0), 0),
      0
    );
    const allUp = stores.reduce(
      (sum, s) =>
        sum +
        s.devices.reduce((t, d) => t + Math.round(((d.uptime_pct ?? 0) / 100) * (d.samples || 0)), 0),
      0
    );

    const payload = {
      period,
      generated_at: new Date().toISOString(),
      summary: {
        uptime_pct: allSamples ? (allUp / allSamples) * 100 : null,
        projects: stores.length,
        devices: deviceRows.length
      },
      projects: stores
    };

    if (format === 'csv') {
      const header = 'project_id,project_name,device_id,device_name,type,ip,url,samples,uptime_pct,avg_response_ms\n';
      const lines = [];
      for (const p of payload.projects) {
        for (const d of p.devices) {
          const esc = (v) => {
            const s = v == null ? '' : String(v);
            if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
            return s;
          };
          lines.push(
            [
              esc(p.id),
              esc(p.name),
              esc(d.id),
              esc(d.name),
              esc(d.type),
              esc(d.ip),
              esc(d.url),
              esc(d.samples),
              esc(d.uptime_pct == null ? '' : d.uptime_pct.toFixed(2)),
              esc(d.avg_response_ms == null ? '' : d.avg_response_ms.toFixed(2))
            ].join(',')
          );
        }
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="uptime-${period}.csv"`);
      return res.send(header + lines.join('\n') + '\n');
    }

    res.json(payload);
  } catch (e) {
    console.error('Error generating uptime report:', e);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

// --- Update/Delete devices (detail page actions) ---
router.put('/api/devices/:deviceId', requireAuth, async (req, res) => {
  const { deviceId } = req.params;
  const { name, type, ip, port, url, notes } = req.body || {};
  if (!name || !type || !ip) return res.status(400).json({ error: 'name, type, ip required' });

  try {
    const { rows } = await pool.query(
      `UPDATE devices
       SET name=$1, type=$2, ip=$3, port=$4, url=$5, notes=$6, updated_at=now()
       WHERE id=$7 AND user_id=$8
       RETURNING *`,
      [name, type, ip, port || null, url || null, notes || null, deviceId, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Device not found' });
    res.json({ device: rows[0] });
  } catch (e) {
    console.error('Error updating device:', e);
    res.status(500).json({ error: 'Failed to update device' });
  }
});

router.delete('/api/devices/:deviceId', requireAuth, async (req, res) => {
  const { deviceId } = req.params;
  try {
    const { rows } = await pool.query('DELETE FROM devices WHERE id=$1 AND user_id=$2 RETURNING id', [
      deviceId,
      req.user.id
    ]);
    if (!rows.length) return res.status(404).json({ error: 'Device not found' });
    res.status(204).end();
  } catch (e) {
    console.error('Error deleting device:', e);
    res.status(500).json({ error: 'Failed to delete device' });
  }
});

// --- Email alert configuration ---
router.get('/api/alerts/email', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT enabled, cooldown_minutes, rules
       FROM alerts
       WHERE user_id=$1 AND type='email'
       ORDER BY created_at DESC
       LIMIT 1`,
      [req.user.id]
    );

    const cfg = rows[0];
    const to = Array.isArray(cfg?.rules?.to)
      ? cfg.rules.to.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
      : [];

    res.json({
      alert: {
        enabled: Boolean(cfg?.enabled),
        cooldownMinutes: Number(cfg?.cooldown_minutes || 30),
        to
      }
    });
  } catch (e) {
    console.error('Error fetching email alert config:', e);
    res.status(500).json({ error: 'Failed to fetch email alert config' });
  }
});

router.put('/api/alerts/email', requireAuth, async (req, res) => {
  const body = req.body || {};
  const enabled = body.enabled === true;
  const cooldownRaw = Number(body.cooldownMinutes);
  const cooldownMinutes = Number.isFinite(cooldownRaw) ? Math.floor(cooldownRaw) : 30;
  if (cooldownMinutes < 1 || cooldownMinutes > 10080) {
    return res.status(400).json({ error: 'cooldownMinutes must be between 1 and 10080' });
  }

  const to = Array.isArray(body.to) ? body.to : typeof body.to === 'string' ? body.to.split(',') : [];

  const emails = [];
  const seen = new Set();
  for (const raw of to) {
    const email = String(raw || '').trim().toLowerCase();
    if (!email) continue;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: `Invalid email address: ${email}` });
    }
    if (seen.has(email)) continue;
    seen.add(email);
    emails.push(email);
  }

  try {
    let rows;
    try {
      const result = await pool.query(
        `INSERT INTO alerts (user_id, type, enabled, rules, cooldown_minutes)
         VALUES ($1, 'email', $2, $3::jsonb, $4)
         ON CONFLICT (user_id, type)
         DO UPDATE SET
           enabled = EXCLUDED.enabled,
           rules = EXCLUDED.rules,
           cooldown_minutes = EXCLUDED.cooldown_minutes
         RETURNING enabled, cooldown_minutes, rules`,
        [req.user.id, enabled, JSON.stringify({ to: emails }), cooldownMinutes]
      );
      rows = result.rows;
    } catch (upsertErr) {
      // Existing databases may not yet have UNIQUE(user_id,type) index.
      if (!upsertErr || upsertErr.code !== '42P10') throw upsertErr;

      const updated = await pool.query(
        `UPDATE alerts
         SET enabled=$1, rules=$2::jsonb, cooldown_minutes=$3
         WHERE user_id=$4 AND type='email'
         RETURNING enabled, cooldown_minutes, rules`,
        [enabled, JSON.stringify({ to: emails }), cooldownMinutes, req.user.id]
      );

      if (updated.rows.length) {
        rows = updated.rows;
      } else {
        const inserted = await pool.query(
          `INSERT INTO alerts (user_id, type, enabled, rules, cooldown_minutes)
           VALUES ($1, 'email', $2, $3::jsonb, $4)
           RETURNING enabled, cooldown_minutes, rules`,
          [req.user.id, enabled, JSON.stringify({ to: emails }), cooldownMinutes]
        );
        rows = inserted.rows;
      }
    }

    res.json({
      alert: {
        enabled: Boolean(rows[0].enabled),
        cooldownMinutes: Number(rows[0].cooldown_minutes),
        to: Array.isArray(rows[0].rules?.to) ? rows[0].rules.to : []
      }
    });
  } catch (e) {
    console.error('Error updating email alert config:', e);
    res.status(500).json({ error: 'Failed to update email alert config' });
  }
});

// --- Metrics for dashboard charts ---


// --- SMS Alerts (Premium) ---
// Stored in alerts table: type='sms'
function isValidE164(v) {
  return /^\+\d{8,15}$/.test(String(v || '').trim());
}

async function getSmsAlertRow(userId) {
  const { rows } = await pool.query(
    `SELECT enabled, rules, cooldown_minutes
     FROM alerts
     WHERE user_id=$1 AND type='sms'
     LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function upsertSmsAlert(userId, enabled, rulesObj, cooldownMinutes) {
  // Prefer ON CONFLICT if a unique constraint exists; fallback otherwise.
  try {
    await pool.query(
      `INSERT INTO alerts(user_id, type, enabled, rules, cooldown_minutes)
       VALUES ($1, 'sms', $2, $3, $4)
       ON CONFLICT (user_id, type)
       DO UPDATE SET enabled=EXCLUDED.enabled, rules=EXCLUDED.rules, cooldown_minutes=EXCLUDED.cooldown_minutes`,
      [userId, enabled, JSON.stringify(rulesObj), cooldownMinutes]
    );
    return;
  } catch (e) {
    // 42P10 = invalid_column_reference (e.g., no matching unique constraint)
    if (e && e.code !== '42P10') throw e;
  }

  // Fallback upsert (no unique constraint)
  const upd = await pool.query(
    `UPDATE alerts
     SET enabled=$3, rules=$4, cooldown_minutes=$5
     WHERE user_id=$1 AND type=$2`,
    [userId, 'sms', enabled, JSON.stringify(rulesObj), cooldownMinutes]
  );
  if (upd.rowCount === 0) {
    await pool.query(
      `INSERT INTO alerts(user_id, type, enabled, rules, cooldown_minutes)
       VALUES ($1, 'sms', $2, $3, $4)`,
      [userId, enabled, JSON.stringify(rulesObj), cooldownMinutes]
    );
  }
}

router.get('/api/alerts/sms', requireAuth, requirePremium, async (req, res) => {
  try {
    const row = await getSmsAlertRow(req.user.id);
    const rules = row?.rules || {};
    res.json({
      enabled: row ? !!row.enabled : false,
      to: rules.to || '',
      cooldownMinutes: row?.cooldown_minutes ?? 30,
      storeOverrides: rules.storeOverrides || {}
    });
  } catch (e) {
    console.error('GET /api/alerts/sms error:', e);
    res.status(500).json({ error: 'Failed to load SMS settings' });
  }
});

router.put('/api/alerts/sms', requireAuth, requirePremium, async (req, res) => {
  try {
    const enabled = !!req.body?.enabled;
    const to = String(req.body?.to || '').trim();
    const cooldownMinutesRaw = Number(req.body?.cooldownMinutes ?? 30);
    const cooldownMinutes = Number.isFinite(cooldownMinutesRaw)
      ? Math.min(10080, Math.max(1, Math.round(cooldownMinutesRaw)))
      : 30;

    const storeOverridesIn = (req.body?.storeOverrides && typeof req.body.storeOverrides === 'object')
      ? req.body.storeOverrides
      : {};

    // Validate numbers
    if (enabled && !isValidE164(to)) {
      return res.status(400).json({ error: 'Global SMS number must be E.164, e.g. +61400111222' });
    }
    for (const [storeId, ov] of Object.entries(storeOverridesIn)) {
      if (!ov || typeof ov !== 'object') continue;
      const ovEnabled = !!ov.enabled;
      const ovTo = String(ov.to || '').trim();
      if (ovEnabled && ovTo && !isValidE164(ovTo)) {
        return res.status(400).json({ error: `Invalid SMS number for store ${storeId}. Use E.164.` });
      }
    }

    const rules = {
      to,
      storeOverrides: storeOverridesIn
    };

    await upsertSmsAlert(req.user.id, enabled, rules, cooldownMinutes);

    res.json({
      ok: true,
      enabled,
      to,
      cooldownMinutes,
      storeOverrides: storeOverridesIn
    });
  } catch (e) {
    console.error('PUT /api/alerts/sms error:', e);
    res.status(500).json({ error: 'Failed to save SMS settings' });
  }
});

router.post('/api/alerts/sms/test', requireAuth, requirePremium, async (req, res) => {
  try {
    const row = await getSmsAlertRow(req.user.id);
    const rules = row?.rules || {};
    const to = String(req.body?.to || rules.to || '').trim();
    if (!isValidE164(to)) return res.status(400).json({ error: 'SMS number must be E.164, e.g. +61400111222' });

    const message = `Dashmon test SMS (${new Date().toISOString()})`;
    const r = await sendSms({ to, body: message });
    res.json({ ok: true, provider: r.provider || 'twilio', sid: r.sid || null, testMode: !!r.testMode });
  } catch (e) {
    console.error('POST /api/alerts/sms/test error:', e);
    res.status(500).json({ error: 'Failed to send test message' });
  }
});

router.get('/api/metrics/down-events', requireAuth, async (req, res) => {
  const hours = Math.min(Number(req.query.hours || 24) || 24, 168); // up to 7 days
  try {
    let rows;
    try {
      const result = await pool.query(
        `SELECT date_trunc('hour', h.ts) AS bucket, COUNT(*)::int AS down_events
         FROM device_history h
         JOIN devices d ON d.id = h.device_id
         WHERE d.user_id=$1
           AND h.ts >= now() - ($2 || ' hours')::interval
           AND h.status='down'
         GROUP BY bucket
         ORDER BY bucket ASC`,
        [req.user.id, String(hours)]
      );
      rows = result.rows;
    } catch (metricsErr) {
      if (metricsErr && metricsErr.code !== '42703') throw metricsErr;

      const result = await pool.query(
        `SELECT date_trunc('hour', h.timestamp) AS bucket, COUNT(*)::int AS down_events
         FROM device_history h
         JOIN devices d ON d.id = h.device_id
         WHERE d.user_id=$1
           AND h.timestamp >= now() - ($2 || ' hours')::interval
           AND h.status='down'
         GROUP BY bucket
         ORDER BY bucket ASC`,
        [req.user.id, String(hours)]
      );
      rows = result.rows;
    }

    res.json({ points: rows.map((r) => ({ ts: r.bucket, value: r.down_events })) });
  } catch (e) {
    console.error('Error metrics down-events:', e);
    res.status(500).json({ error: 'Failed to fetch metrics' });
  }
});



// --- User preferences (timezone) ---
function isValidIanaTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    // Throws RangeError for invalid tz
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch (_) {
    return false;
  }
}

router.get('/api/user/preferences', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT timezone FROM users WHERE id=$1', [req.user.id]);
    const timezone = rows[0]?.timezone || null;
    res.json({ preferences: { timezone } });
  } catch (e) {
    console.error('Error fetching user preferences:', e);
    res.status(500).json({ error: 'Failed to fetch preferences' });
  }
});

router.put('/api/user/preferences/timezone', requireAuth, requirePremium, async (req, res) => {
  const tz = (req.body && typeof req.body.timezone === 'string') ? req.body.timezone.trim() : '';

  if (!tz) {
    // Allow clearing preference
    try {
      await pool.query('UPDATE users SET timezone=NULL WHERE id=$1', [req.user.id]);
      return res.json({ preferences: { timezone: null } });
    } catch (e) {
      console.error('Error clearing timezone:', e);
      return res.status(500).json({ error: 'Failed to update timezone' });
    }
  }

  if (!isValidIanaTimeZone(tz)) {
    return res.status(400).json({ error: 'Invalid timezone (must be an IANA timezone like Australia/Adelaide)' });
  }

  try {
    const { rows } = await pool.query('UPDATE users SET timezone=$1 WHERE id=$2 RETURNING timezone', [tz, req.user.id]);
    res.json({ preferences: { timezone: rows[0]?.timezone || tz } });
  } catch (e) {
    console.error('Error updating timezone:', e);
    res.status(500).json({ error: 'Failed to update timezone' });
  }
});

// Ensure unknown API routes return JSON (not HTML)
router.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

module.exports = { router };

