const express = require('express');
const { pool } = require('./db');
const { requireAuth } = require('./auth');

const router = express.Router();
router.use(express.json());


const PLAN_LIMITS = {
  free: { projects: 3, devicesPerProject: 15 },
  premium: { projects: 10, devicesPerProject: 15 }
};

const writeRateState = new Map();
function enforceWriteRateLimit(req, res, next) {
  if (!['POST', 'PUT', 'DELETE'].includes(req.method)) return next();

  const userKey = req.user?.id || req.ip || 'anon';
  const key = `${userKey}:${req.path}`;
  const now = Date.now();
  const windowMs = 60 * 1000;
  const max = req.user?.plan === 'premium' ? 120 : 60;

  let entry = writeRateState.get(key);
  if (!entry || now - entry.start >= windowMs) {
    entry = { start: now, count: 0 };
    writeRateState.set(key, entry);
  }

  entry.count += 1;
  if (entry.count > max) {
    const retryAfterSeconds = Math.ceil((windowMs - (now - entry.start)) / 1000);
    res.set('Retry-After', String(Math.max(retryAfterSeconds, 1)));
    return res.status(429).json({ error: 'Too many write requests. Please slow down.' });
  }

  return next();
}

router.use(enforceWriteRateLimit);

function getPlanLimits(plan) {
  return plan === 'premium' ? PLAN_LIMITS.premium : PLAN_LIMITS.free;
}

function normalizePlan(plan) {
  const v = String(plan || '').trim().toLowerCase();
  return v === 'premium' ? 'premium' : 'free';
}

async function getUserPlanFromDb(userId) {
  const { rows } = await pool.query('SELECT plan FROM users WHERE id=$1', [userId]);
  return normalizePlan(rows[0]?.plan);
}

async function enforceProjectLimitForUser(userId) {
  const dbPlan = await getUserPlanFromDb(userId);
  const { projects: maxProjects } = getPlanLimits(dbPlan);
  const { rows: projectCountRows } = await pool.query(
    'SELECT COUNT(*)::int AS count FROM stores WHERE user_id=$1',
    [userId]
  );

  return {
    maxProjects,
    count: Number(projectCountRows[0]?.count || 0),
    overLimit: Number(projectCountRows[0]?.count || 0) >= maxProjects
  };
}

// --- Auth / session helpers ---
router.get('/api/me', requireAuth, (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    name: req.user.name,
    plan: req.user.plan
  });
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
router.get('/logout', (req, res) => res.redirect('/login.html'));

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

  return projects.map(p => {
    const list = devicesByProject.get(p.id) || [];
    const totalDevices = list.length;
    const upDevices = list.filter(x => x.status === 'up').length;
    const downDevices = list.filter(x => x.status === 'down').length;
    const warningDevices = list.filter(x => x.status === 'warning').length;
    const maintenanceDevices = list.filter(x => x.status === 'maintenance').length;

    let status = 'up';
    if (downDevices > 0) status = 'down';
    else if (warningDevices > 0) status = 'warning';
    else if (maintenanceDevices > 0) status = (maintenanceDevices === totalDevices ? 'maintenance' : 'partial_maintenance');

    return {
      ...p,
      devices: list,
      totalDevices,
      upDevices,
      downDevices,
      warningDevices,
      maintenanceDevices,
      status
    };
  });
}

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
    const projectLimit = await enforceProjectLimitForUser(req.user.id);
    if (projectLimit.overLimit) {
      return res.status(400).json({
        error: `Plan limit reached. Your plan allows ${projectLimit.maxProjects} projects.`
      });
    }

    const existing = await pool.query(
      'SELECT 1 FROM stores WHERE user_id=$1 AND id=$2',
      [req.user.id, id]
    );
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
    const projectLimit = await enforceProjectLimitForUser(req.user.id);
    if (projectLimit.overLimit) {
      return res.status(400).json({
        error: `Plan limit reached. Your plan allows ${projectLimit.maxProjects} projects.`
      });
    }

    const existing = await pool.query(
      'SELECT 1 FROM stores WHERE user_id=$1 AND id=$2',
      [req.user.id, id]
    );
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
    const storeCheck = await pool.query(
      'SELECT 1 FROM stores WHERE id=$1 AND user_id=$2',
      [projectId, req.user.id]
    );
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
    const storeCheck = await pool.query(
      'SELECT 1 FROM stores WHERE id=$1 AND user_id=$2',
      [storeId, req.user.id]
    );
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

router.post('/api/projects/:projectId/devices', requireAuth, async (req, res) => {
  const projectId = req.params.projectId;
  const { name, type, ip, port, url, notes } = req.body || {};
  if (!name || !type || !ip) return res.status(400).json({ error: 'Device name, type, and IP are required' });

  try {
    const storeCheck = await pool.query(
      'SELECT 1 FROM stores WHERE id=$1 AND user_id=$2',
      [projectId, req.user.id]
    );
    if (!storeCheck.rows.length) return res.status(404).json({ error: 'Project not found' });

    // Enforce plan limits per project
    const { rows: countRows } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM devices WHERE store_id=$1 AND user_id=$2',
      [projectId, req.user.id]
    );
    const { devicesPerProject: maxDevices } = getPlanLimits(req.user.plan);
    if (countRows[0].count >= maxDevices) {
      return res.status(400).json({
        error: `Plan limit reached. Your plan allows ${maxDevices} devices per project.`
      });
    }

    // Enforce check interval by plan:
    // free = 2 hours, premium = 15 minutes
    const pingInterval = req.user.plan === 'premium' ? 900 : 7200;

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
    const storeCheck = await pool.query(
      'SELECT 1 FROM stores WHERE id=$1 AND user_id=$2',
      [storeId, req.user.id]
    );
    if (!storeCheck.rows.length) return res.status(404).json({ error: 'Store not found' });

    const { rows: countRows } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM devices WHERE store_id=$1 AND user_id=$2',
      [storeId, req.user.id]
    );
    const { devicesPerProject: maxDevices } = getPlanLimits(req.user.plan);
    if (countRows[0].count >= maxDevices) {
      return res.status(400).json({
        error: `Plan limit reached. Your plan allows ${maxDevices} devices per project.`
      });
    }

    const pingInterval = req.user.plan === 'premium' ? 900 : 7200;

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
    const storeCheck = await pool.query(
      'SELECT 1 FROM stores WHERE id=$1 AND user_id=$2',
      [projectId, req.user.id]
    );
    if (!storeCheck.rows.length) return res.status(404).json({ error: 'Project not found' });

    const { rows } = await pool.query(
      'SELECT * FROM devices WHERE id=$1 AND store_id=$2 AND user_id=$3',
      [deviceId, projectId, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Device not found' });
    res.json({ device: rows[0] });
  } catch (e) {
    console.error('Error fetching device:', e);
    res.status(500).json({ error: 'Failed to fetch device' });
  }
});

// Queue a device for immediate check (worker looks at last_check)
router.post('/api/devices/:deviceId/test-now', requireAuth, async (req, res) => {
  const { deviceId } = req.params;
  if (req.user.plan !== 'premium') {
    return res.status(403).json({ error: 'Manual test is available on Premium plan only' });
  }
  try {
    const { rows } = await pool.query(
      'UPDATE devices SET last_check = now() - interval \'365 days\' WHERE id=$1 AND user_id=$2 RETURNING id',
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
  try {
    // Ownership enforced by join on devices.user_id
    const { rows: deviceRows } = await pool.query(
      'SELECT id FROM devices WHERE id=$1 AND user_id=$2',
      [deviceId, req.user.id]
    );
    if (!deviceRows.length) return res.status(404).json({ error: 'Device not found' });

    let historyRows;
    try {
      const { rows } = await pool.query(
        `SELECT ts, status, latency_ms, status_code, detail
         FROM device_history
         WHERE device_id=$1
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
    const { rows } = await pool.query(
      'DELETE FROM devices WHERE id=$1 AND user_id=$2 RETURNING id',
      [deviceId, req.user.id]
    );
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

  const to = Array.isArray(body.to)
    ? body.to
    : typeof body.to === 'string'
      ? body.to.split(',')
      : [];

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

    res.json({ points: rows.map(r => ({ ts: r.bucket, value: r.down_events })) });
  } catch (e) {
    console.error('Error metrics down-events:', e);
    res.status(500).json({ error: 'Failed to fetch metrics' });
  }
});

// Ensure unknown API routes return JSON (not HTML)
router.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

module.exports = { router };
