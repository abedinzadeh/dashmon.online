const PLAN_LIMITS = {
  free: { projects: 3, devicesPerProject: 15 },
  premium: { projects: 10, devicesPerProject: 15 }
};

function normalizePlan(plan) {
  const v = String(plan || '').trim().toLowerCase();
  return v === 'premium' ? 'premium' : 'free';
}

function isPremiumActiveFromUserRow(userRow, now = new Date()) {
  const plan = normalizePlan(userRow?.plan);
  if (plan !== 'premium') return false;

  const status = String(userRow?.plan_status || 'active').trim().toLowerCase();
  if (status !== 'active') return false;

  const until = userRow?.premium_until ? new Date(userRow.premium_until) : null;
  if (until && !Number.isNaN(until.getTime()) && now >= until) return false;

  return true;
}

function getEffectivePlanFromUserRow(userRow, now = new Date()) {
  return isPremiumActiveFromUserRow(userRow, now) ? 'premium' : 'free';
}

function getPlanLimits(plan) {
  return normalizePlan(plan) === 'premium' ? PLAN_LIMITS.premium : PLAN_LIMITS.free;
}

async function getUserPlanFromDb(pool, userId) {
  const { rows } = await pool.query(
    'SELECT plan, plan_status, premium_until FROM users WHERE id=$1',
    [userId]
  );
  return getEffectivePlanFromUserRow(rows[0]);
}

async function enforceProjectLimitForUser(pool, userId) {
  const dbPlan = await getUserPlanFromDb(pool, userId);
  const { projects: maxProjects } = getPlanLimits(dbPlan);
  const { rows: projectCountRows } = await pool.query(
    'SELECT COUNT(*)::int AS count FROM stores WHERE user_id=$1',
    [userId]
  );

  const count = Number(projectCountRows[0]?.count || 0);
  return {
    maxProjects,
    count,
    overLimit: count >= maxProjects
  };
}

module.exports = {
  PLAN_LIMITS,
  normalizePlan,
  isPremiumActiveFromUserRow,
  getEffectivePlanFromUserRow,
  getPlanLimits,
  getUserPlanFromDb,
  enforceProjectLimitForUser
};
