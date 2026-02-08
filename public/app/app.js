/* Dashmon Dashboard JS (public SaaS build)
   - Uses /api/projects (aliases exist for /api/stores)
   - Always sends credentials
*/

(function () {
  const $ = (id) => document.getElementById(id);

  const state = {
    user: null,
    projects: [],
    expanded: new Set(),
    tvMode: false,
    mainView: (localStorage.getItem('dashmonMainView') || 'projects'),
    soundOn: (localStorage.getItem('downAlertSound') || 'on') === 'on',
    lastDownCount: 0,
    emailAlert: { enabled: false, cooldownMinutes: 30, to: [] },
    smsAlert: { enabled: false, cooldownMinutes: 30, to: '', storeOverrides: {} }
  };


  // Chart instances
  state.charts = {
    main: null,
    tvMain: null,
    sparks: new Map(),
    deviceModal: null
  };

  const chartLifecycle = typeof createChartLifecycle === 'function' ? createChartLifecycle() : null;
  const sparkRenderGuard = chartLifecycle?.createRenderGuard ? chartLifecycle.createRenderGuard() : null;
  let refreshTimer = null;
  let pendingSparkTimeouts = [];

  
function statusToLevel(s) {
  s = String(s || '').toLowerCase();
  if (s === 'up') return 1;
  if (s === 'warning') return 0.5;
  if (s === 'maintenance') return 0.25;
  return 0; // down/unknown
}

function ensureMixedStatusLatencyChart(existing, canvasId, labels, statuses, latencies) {
  const ctxEl = document.getElementById(canvasId);
  if (!ctxEl || typeof Chart === 'undefined') return existing;
  const ctx = ctxEl.getContext('2d');

  const statusVals = statuses.map(statusToLevel);

  const data = {
    labels,
    datasets: [
      {
        type: 'bar',
        label: 'Status',
        data: statusVals,
        borderWidth: 0,
        yAxisID: 'yStatus',
        barPercentage: 1.0,
        categoryPercentage: 1.0
      },
      {
        type: 'line',
        label: 'Latency (ms)',
        data: latencies,
        tension: 0.25,
        pointRadius: 0,
        borderWidth: 2,
        fill: false,
        spanGaps: false,
        yAxisID: 'yLatency'
      }
    ]
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { maxTicksLimit: 8 } },
      yStatus: {
        position: 'left',
        min: 0,
        max: 1,
        ticks: { stepSize: 1, callback: (v) => (v === 1 ? 'UP' : '') }
      },
      yLatency: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false } }
    }
  };

  if (existing && typeof existing.destroy === 'function') {
    // Chart.js can't safely change mixed chart types by updating config; recreate.
    existing.destroy();
    existing = null;
  }
  return new Chart(ctx, { data, options });
}

function ensureLineChart(canvasId, label, points, existing) {
    const el = $(canvasId);
    if (!el || typeof Chart === 'undefined') return null;

    const labels = points.map(p => {
      const d = new Date(p.ts);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    });
    const data = points.map(p => p.value);

    const cfg = {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label,
          data,
          tension: 0.25,
          pointRadius: 0,
          borderWidth: 2,
          fill: false
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { maxTicksLimit: 8 } },
          y: { beginAtZero: true, ticks: { maxTicksLimit: 6 } }
        }
      }
    };

    if (existing) {
      existing.data.labels = labels;
      existing.data.datasets[0].data = data;
      existing.update();
      return existing;
    }
    return new Chart(el.getContext('2d'), cfg);
  }

  function ensureStatusChart(canvasId, summary, existing) {
    const el = $(canvasId);
    if (!el || typeof Chart === 'undefined') return null;

    const labels = ['Up', 'Down', 'Warning', 'Maintenance'];
    const values = [summary.up || 0, summary.down || 0, summary.warning || 0, summary.maintenance || 0];

    const cfg = {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: ['#22c55e', '#ef4444', '#f59e0b', '#8b5cf6'],
          borderColor: ['#14532d', '#7f1d1d', '#78350f', '#4c1d95'],
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { color: '#d1d5db' } }
        }
      }
    };

    if (existing) {
      existing.data.datasets[0].data = values;
      existing.update();
      return existing;
    }

    return new Chart(el.getContext('2d'), cfg);
  }

  async function updateMainGraphs() {
    const summary = computeSummary(state.projects || []);
    state.charts.main = ensureStatusChart('statusChart', summary, state.charts.main);
    state.charts.tvMain = ensureStatusChart('tvStatusChart', summary, state.charts.tvMain);
  }

  async function renderSparkline(deviceId, renderToken) {
    const canvasId = `spark_${deviceId}`;
    const el = $(canvasId);
    if (!el || typeof Chart === 'undefined') return;
    if (sparkRenderGuard && !sparkRenderGuard.isCurrent(renderToken)) return;

    // fetch small history
    const res = await apiFetch(`/api/devices/${encodeURIComponent(deviceId)}/history?limit=20`);
    if (!res.ok) return;
    const data = await res.json();
    const hist = data.history || [];
    const labels = hist.map(h => '');
    const values = hist.map(h => {
      const st = String(h.status || '').toLowerCase();
      if (st && st !== 'up') return 0; // make DOWN clearly visible in the tiny chart
      return (h.latency_ms == null ? null : Number(h.latency_ms));
    });

    const cfg = {
      type: 'line',
      data: { labels, datasets: [{ data: values, tension: 0.3, pointRadius: 0, borderWidth: 2, fill: false }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false } }
      }
    };

    const existing = state.charts.sparks.get(deviceId);
    if (existing && typeof existing.destroy === 'function') {
      existing.destroy();
    }
    const chart = new Chart(el.getContext('2d'), cfg);
    state.charts.sparks.set(deviceId, chart);
  }


  async function apiFetch(url, opts = {}) {
    const o = Object.assign({ credentials: 'include' }, opts);
    // Default headers for JSON bodies
    if (o.body && typeof o.body === 'object' && !(o.body instanceof FormData)) {
      o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
      o.body = JSON.stringify(o.body);
    }
    const res = await fetch(url, o);
    return res;
  }

  async function checkAuth() {
    const res = await apiFetch('/api/me', { redirect: 'manual' });
    if (!res.ok) {
      window.location.href = '/login.html';
      return false;
    }
    state.user = await res.json();
    updateUserInfo();
    return true;
  }
  function updateUserInfo() {
    const el = $('userInfo');
    if (el && state.user) {
      el.textContent = state.user.email || 'Logged in';
    }

    const badge = $('userPlanBadge');
    if (badge && state.user) {
      const plan = String(state.user.plan || 'free').toLowerCase();
      if (plan === 'premium') {
        // Keep the visible plan badge as "Premium" (not "Billing") and show a crown icon.
        badge.innerHTML = '<i class="fas fa-crown mr-1"></i> Premium';
        badge.className = 'user-plan-badge ml-2';
      } else {
        badge.textContent = 'Free';
        badge.className = 'user-plan-badge free ml-2';
      }
    }

    const smsBtn = $('smsAlertsBtn');
    if (smsBtn && state.user) {
      if (state.user.plan === 'premium') smsBtn.classList.remove('hidden');
      else smsBtn.classList.add('hidden');
    }


    // Billing / Upgrade entry point in navbar
    const upgradeBtn = $('upgradePageBtn');
    if (upgradeBtn && state.user) {
      // Always show the entry point; change label based on plan
      upgradeBtn.classList.remove('hidden');
      if (state.user.plan === 'premium') {
        upgradeBtn.title = 'Manage billing';
        upgradeBtn.href = '/app/pricing.html';
        upgradeBtn.innerHTML = '<i class="fas fa-credit-card mr-2"></i> Billing';
        upgradeBtn.className = 'bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-semibold';
      } else {
        upgradeBtn.title = 'Upgrade to Premium';
        upgradeBtn.href = '/app/pricing.html';
        upgradeBtn.innerHTML = '<i class="fas fa-crown mr-2"></i> Upgrade';
        upgradeBtn.className = 'bg-yellow-500 hover:bg-yellow-600 text-black px-4 py-2 rounded-lg font-semibold';
      }
    }
    const soundToggle = $('soundToggle');
    if (soundToggle) {
      soundToggle.innerHTML = state.soundOn
        ? '<i class="fas fa-volume-up mr-2"></i>Sound: ON'
        : '<i class="fas fa-volume-mute mr-2"></i>Sound: OFF';
    }
  }

  async function loadEmailAlertConfig() {
    const res = await apiFetch('/api/alerts/email');
    if (!res.ok) throw new Error('Failed to load alert settings');

    const payload = await res.json();
    state.emailAlert = payload.alert || { enabled: false, cooldownMinutes: 30, to: [] };

    if ($('emailAlertsEnabled')) $('emailAlertsEnabled').checked = !!state.emailAlert.enabled;
    if ($('emailAlertsCooldown')) $('emailAlertsCooldown').value = Number(state.emailAlert.cooldownMinutes || 30);
    if ($('emailAlertsTo')) $('emailAlertsTo').value = (state.emailAlert.to || []).join(', ');
  }

  async function openEmailAlertsModal() {
    try {
      await loadEmailAlertConfig();
      openModal('emailAlertsModal');
    } catch (e) {
      alert(e?.message || 'Failed to load alert settings');
    }
  }

  async function saveEmailAlerts(e) {
    e.preventDefault();
    const enabled = !!$('emailAlertsEnabled')?.checked;
    const cooldownMinutes = Number($('emailAlertsCooldown')?.value || 30);
    const rawRecipients = String($('emailAlertsTo')?.value || '');
    const to = rawRecipients.split(',').map((x) => x.trim()).filter(Boolean);

    const res = await apiFetch('/api/alerts/email', {
      method: 'PUT',
      body: { enabled, cooldownMinutes, to }
    });

    if (!res.ok) {
      const msg = (await res.json().catch(() => null))?.error || `Failed (${res.status})`;
      alert(msg);
      return;
    }

    const payload = await res.json();
    state.emailAlert = payload.alert || { enabled: false, cooldownMinutes: 30, to: [] };
    closeModal('emailAlertsModal');
    alert('Email alert settings saved.');
  }


  // --- SMS Alerts (Premium) ---
  function isValidE164(v) {
    return /^\+\d{8,15}$/.test(String(v || '').trim());
  }

  function normalizeStoreOverrides(obj) {
    const out = {};
    if (!obj || typeof obj !== 'object') return out;
    for (const [k, v] of Object.entries(obj)) {
      if (!v || typeof v !== 'object') continue;
      out[k] = {
        enabled: !!v.enabled,
        to: String(v.to || '').trim()
      };
    }
    return out;
  }

  function renderSmsOverridesList() {
    const wrap = $('smsOverridesList');
    if (!wrap) return;
    const overrides = normalizeStoreOverrides(state.smsAlert.storeOverrides);

    const projects = Array.isArray(state.projects) ? state.projects : [];
    const sorted = [...projects].sort((a, b) => String(a.id).localeCompare(String(b.id)));

    wrap.innerHTML = '';
    for (const p of sorted) {
      const storeId = String(p.id);
      const ov = overrides[storeId] || { enabled: false, to: '' };

      const row = document.createElement('div');
      row.className = 'flex flex-col sm:flex-row sm:items-center gap-2 p-3 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700';
      row.innerHTML = `
        <div class="flex items-center gap-3">
          <input type="checkbox" class="h-4 w-4 sms-ov-enabled" data-store-id="${escapeHtml(storeId)}" ${ov.enabled ? 'checked' : ''}/>
          <div class="text-sm font-medium">${escapeHtml(p.name || storeId)} <span class="text-xs text-gray-500">(${escapeHtml(storeId)})</span></div>
        </div>
        <div class="flex-1"></div>
        <input type="text" class="w-full sm:w-64 p-2 border rounded-lg dark:bg-gray-900 dark:border-gray-600 text-gray-900 dark:text-gray-100 sms-ov-to" data-store-id="${escapeHtml(storeId)}" placeholder="+61400111222" value="${escapeHtml(ov.to || '')}"/>
      `;
      wrap.appendChild(row);
    }
  }

  async function loadSmsAlertConfig() {
    const res = await apiFetch('/api/alerts/sms');
    if (!res.ok) {
      const msg = (await res.json().catch(() => null))?.error || `Failed (${res.status})`;
      throw new Error(msg);
    }
    const payload = await res.json();
    state.smsAlert = {
      enabled: !!payload.enabled,
      to: String(payload.to || '').trim(),
      cooldownMinutes: Number(payload.cooldownMinutes || 30),
      storeOverrides: normalizeStoreOverrides(payload.storeOverrides)
    };

    if ($('smsAlertsEnabled')) $('smsAlertsEnabled').checked = !!state.smsAlert.enabled;
    if ($('smsAlertsCooldown')) $('smsAlertsCooldown').value = Number(state.smsAlert.cooldownMinutes || 30);
    if ($('smsAlertsTo')) $('smsAlertsTo').value = state.smsAlert.to || '';

    renderSmsOverridesList();
  }

  async function openSmsAlertsModal() {
    if (state.user?.plan !== 'premium') {
      alert('SMS Alerts are Premium only.');
      return;
    }
    try {
      await loadSmsAlertConfig();
      openModal('smsAlertsModal');
    } catch (e) {
      alert(e?.message || 'Failed to load SMS settings');
    }
  }

  function collectSmsOverridesFromUi() {
    const enabledEls = Array.from(document.querySelectorAll('.sms-ov-enabled'));
    const toEls = Array.from(document.querySelectorAll('.sms-ov-to'));

    const toByStore = {};
    for (const el of toEls) {
      const sid = el.getAttribute('data-store-id');
      if (!sid) continue;
      toByStore[sid] = String(el.value || '').trim();
    }

    const out = {};
    for (const el of enabledEls) {
      const sid = el.getAttribute('data-store-id');
      if (!sid) continue;
      const enabled = !!el.checked;
      const to = String(toByStore[sid] || '').trim();
      out[sid] = { enabled, to };
    }
    return out;
  }

  async function saveSmsAlerts(e) {
    e.preventDefault();
    if (state.user?.plan !== 'premium') {
      alert('SMS Alerts are Premium only.');
      return;
    }

    const enabled = !!$('smsAlertsEnabled')?.checked;
    const cooldownMinutes = Number($('smsAlertsCooldown')?.value || 30);
    const to = String($('smsAlertsTo')?.value || '').trim();
    const storeOverrides = collectSmsOverridesFromUi();

    if (enabled && !isValidE164(to)) {
      alert('Global SMS number must be E.164, e.g. +61400111222');
      return;
    }

    for (const [storeId, ov] of Object.entries(storeOverrides)) {
      if (!ov || typeof ov !== 'object') continue;
      if (ov.enabled && ov.to && !isValidE164(ov.to)) {
        alert(`Invalid SMS number for store ${storeId}. Use E.164.`);
        return;
      }
    }

    const res = await apiFetch('/api/alerts/sms', {
      method: 'PUT',
      body: { enabled, to, cooldownMinutes, storeOverrides }
    });

    if (!res.ok) {
      const msg = (await res.json().catch(() => null))?.error || `Failed (${res.status})`;
      alert(msg);
      return;
    }

    const payload = await res.json();
    state.smsAlert = {
      enabled: !!payload.enabled,
      to: String(payload.to || '').trim(),
      cooldownMinutes: Number(payload.cooldownMinutes || 30),
      storeOverrides: normalizeStoreOverrides(payload.storeOverrides)
    };

    closeModal('smsAlertsModal');
    alert('SMS alert settings saved.');
  }

  async function sendSmsTest() {
    if (state.user?.plan !== 'premium') {
      alert('SMS Alerts are Premium only.');
      return;
    }
    const to = String($('smsAlertsTo')?.value || '').trim();
    if (!isValidE164(to)) {
      alert('SMS number must be E.164, e.g. +61400111222');
      return;
    }

    const res = await apiFetch('/api/alerts/sms/test', {
      method: 'POST',
      body: { to }
    });

    if (!res.ok) {
      const msg = (await res.json().catch(() => null))?.error || `Failed (${res.status})`;
      alert(msg);
      return;
    }

    const payload = await res.json();
    alert(`Test SMS sent. Provider=${payload.provider || 'twilio'}${payload.testMode ? ' (test mode)' : ''}`);
  }

  const scrollLock = typeof createScrollLock === 'function' ? createScrollLock(window, document) : null;

  function openModal(id) {
    const m = $(id);
    if (!m) return;
    // Some pages use CSS display:none without an .active rule.
    m.classList.add('active');
    m.style.display = 'block';
    scrollLock?.lock();
  }

  function closeModal(id) {
    const m = $(id);
    if (!m) return;
    m.classList.remove('active');
    m.style.display = 'none';
    if (id === 'deviceDetailsModal' && state.charts.deviceModal) {
      state.charts.deviceModal.destroy();
      state.charts.deviceModal = null;
    }
    scrollLock?.unlock();
  }
function statusClass(status) {
    if (status === 'up') return 'status-up';
    if (status === 'down') return 'status-down';
    if (status === 'warning') return 'status-warning';
    if (status === 'maintenance') return 'status-maintenance';
    return 'status-unknown';
  }

  function computeSummary(projects) {
    let totalStores = projects.length;
    let totalDevices = 0, up = 0, down = 0, warning = 0, maintenance = 0;
    for (const p of projects) {
      totalDevices += p.totalDevices || 0;
      up += p.upDevices || 0;
      down += p.downDevices || 0;
      warning += p.warningDevices || 0;
      maintenance += p.maintenanceDevices || 0;
    }
    return { totalStores, totalDevices, up, down, warning, maintenance };
  }

  function playDownIncreaseAlert() {
    if (!state.soundOn) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = 880;
      g.gain.value = 0.0001;
      o.connect(g);
      g.connect(ctx.destination);
      const t0 = ctx.currentTime;
      // quick triple beep
      const beep = (t) => {
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.2, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      };
      beep(t0);
      beep(t0 + 0.25);
      beep(t0 + 0.5);
      o.start(t0);
      o.stop(t0 + 0.8);
      setTimeout(() => ctx.close().catch(() => {}), 1200);
    } catch (e) {
      console.warn('Sound alert failed:', e);
    }
  }

  async function loadProjects() {
    const res = await apiFetch('/api/projects');
    if (!res.ok) {
      if (res.status === 401) {
        window.location.href = '/login.html';
        return;
      }
      const t = await res.text().catch(() => '');
      throw new Error(`Failed to load projects (${res.status}): ${t}`);
    }
    state.projects = await res.json();
    renderProjects();
    updateSummaryUI();
    updateMainGraphs().catch(()=>{});

    const sum = computeSummary(state.projects);
    if (state.lastDownCount && sum.down > state.lastDownCount) {
      playDownIncreaseAlert();
    }
    state.lastDownCount = sum.down;

    const now = new Date().toLocaleTimeString();
    const tvLastUpdated = $('tvLastUpdated');
    if (tvLastUpdated) tvLastUpdated.textContent = now;
    const dashboardLastUpdated = $('lastUpdated');
    if (dashboardLastUpdated) dashboardLastUpdated.textContent = now;
  }

  function updateSummaryUI() {
    const s = computeSummary(state.projects);
    if ($('totalProjects')) $('totalProjects').textContent = s.totalStores;
    if ($('totalDevicesCount')) $('totalDevicesCount').textContent = s.totalDevices;
    if ($('totalDevices')) $('totalDevices').textContent = s.totalDevices;
    if ($('upDevicesCount')) $('upDevicesCount').textContent = s.up;
    if ($('downDevicesCount')) $('downDevicesCount').textContent = s.down;
    if ($('warningDevicesCount')) $('warningDevicesCount').textContent = s.warning;
    if ($('maintenanceDevicesCount')) $('maintenanceDevicesCount').textContent = s.maintenance;

    if ($('tvTotalDevices')) $('tvTotalDevices').textContent = s.totalDevices;
    if ($('tvUpDevices')) $('tvUpDevices').textContent = s.up;
    if ($('tvDownDevices')) $('tvDownDevices').textContent = s.down;
    if ($('tvWarningDevices')) $('tvWarningDevices').textContent = s.warning;
    if ($('tvMaintenanceDevices')) $('tvMaintenanceDevices').textContent = s.maintenance;
  }

  function sortProjects(list) {
    const sort = $('storeSortSelect') ? $('storeSortSelect').value : 'default';
    const arr = [...list];
    if (sort === 'downDevices') {
      arr.sort((a, b) => (b.downDevices || 0) - (a.downDevices || 0));
    } else if (sort === 'id') {
      arr.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    } else if (sort === 'location') {
      arr.sort((a, b) => String(a.location || '').localeCompare(String(b.location || '')));
    } else if (sort === 'name') {
      arr.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    }
    return arr;
  }

  function filterProjects(list) {
    const filter = $('storeFilterSelect') ? $('storeFilterSelect').value : 'all';
    if (filter === 'all') return list;
    return list.filter(p => (p.status || 'unknown') === filter);
  }

  function listDevicesByStatus(status) {
    const devices = [];
    for (const project of state.projects || []) {
      for (const device of (project.devices || [])) {
        const normalized = (device.status || 'unknown').toLowerCase();
        if (status === 'all' || normalized === status) {
          devices.push({ projectId: project.id, projectName: project.name || project.id, ...device });
        }
      }
    }
    return devices;
  }

  function openSummaryDevicesModal(status) {
    const list = listDevicesByStatus(status);
    const titleMap = { all: 'All Devices', up: 'Devices Up', down: 'Devices Down' };

    if ($('summaryDevicesTitle')) $('summaryDevicesTitle').textContent = titleMap[status] || 'Devices';
    const container = $('summaryDevicesList');
    if (!container) return;

    if (!list.length) {
      container.innerHTML = '<div class="text-gray-400">No devices found for this filter.</div>';
      openModal('summaryDevicesModal');
      return;
    }

    container.innerHTML = list.map((d) => {
      const dot = statusClass(d.status || 'unknown');
      return `
        <button class="w-full text-left p-3 rounded-lg bg-black/20 hover:bg-black/30 border border-white/5"
                data-project-id="${escapeHtml(d.projectId)}"
                data-device-id="${escapeHtml(d.id)}">
          <div class="flex items-center justify-between gap-3">
            <div>
              <div class="font-semibold"><span class="status-dot ${dot}"></span>${escapeHtml(d.name || 'Device')}</div>
              <div class="text-xs text-gray-400 mt-1">Project: ${escapeHtml(d.projectName)} - ${escapeHtml(d.type || 'other')} - ${escapeHtml(d.ip || '')}</div>
            </div>
            <div class="text-xs uppercase text-gray-300">${escapeHtml(d.status || 'unknown')}</div>
          </div>
        </button>
      `;
    }).join('');

    container.querySelectorAll('button[data-project-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const projectId = btn.getAttribute('data-project-id');
        const deviceId = btn.getAttribute('data-device-id');
        closeModal('summaryDevicesModal');
        showDeviceDetails(projectId, deviceId);
      });
    });

    openModal('summaryDevicesModal');
  }


function bindTvSummaryCards() {
  const onlineEl = document.getElementById('tvOnlineCard');
  const downEl = document.getElementById('tvOfflineCard');
  const maintEl = document.getElementById('tvMaintenanceCard');
  if (!onlineEl || !downEl || !maintEl) return;

  const click = (el, title, predicate) => {
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => {
      const list = (state.devices || []).filter(predicate);
      openSummaryDevicesModal(list, title);
    });
  };

  click(onlineEl, 'UP devices', (d) => String(d.status || '').toLowerCase() === 'up');
  click(downEl, 'DOWN devices', (d) => String(d.status || '').toLowerCase() === 'down');
  click(maintEl, 'Maintenance devices', (d) => String(d.status || '').toLowerCase() === 'maintenance');
}


  
  function flattenDevices(projects) {
    const out = [];
    (projects || []).forEach(p => {
      (p.devices || []).forEach(d => {
        out.push({
          ...d,
          projectId: p.id,
          projectName: p.name,
          projectLocation: p.location,
          projectStatus: p.status
        });
      });
    });
    return out;
  }

  function filterDevices(devices) {
    const filterEl = $('storeFilterSelect');
    const tvFilterEl = $('tvStoreFilterSelect');
    const filter = (state.tvMode ? (tvFilterEl?.value) : (filterEl?.value)) || 'all';
    if (filter === 'all') return devices;

    // Reuse existing filter options: down / warning / maintenance / up
    if (filter === 'up') return devices.filter(d => (d.status || 'unknown') === 'up');
    if (filter === 'down') return devices.filter(d => (d.status || 'unknown') === 'down');
    if (filter === 'warning') return devices.filter(d => (d.status || 'unknown') === 'warning');
    if (filter === 'maintenance') return devices.filter(d => (d.status || 'unknown') === 'maintenance');
    return devices;
  }

  function sortDevices(devices) {
    const sortEl = $('storeSortSelect');
    const tvSortEl = $('tvStoreSortSelect');
    const sort = (state.tvMode ? (tvSortEl?.value) : (sortEl?.value)) || 'default';
    const arr = [...devices];

    if (sort === 'downDevices') {
      // Put down/warn first in device view
      const weight = (s) => (s === 'down' ? 3 : s === 'warning' ? 2 : s === 'maintenance' ? 1 : 0);
      arr.sort((a,b) => weight(b.status) - weight(a.status));
    } else if (sort === 'id') {
      arr.sort((a,b) => String(a.projectId).localeCompare(String(b.projectId)));
    } else if (sort === 'location') {
      arr.sort((a,b) => String(a.projectLocation || '').localeCompare(String(b.projectLocation || '')));
    } else if (sort === 'name') {
      arr.sort((a,b) => String(a.name || '').localeCompare(String(b.name || '')));
    }
    return arr;
  }

  function buildDeviceCard(d) {
    const st = d.status || 'unknown';
    const statusText = st === 'up' ? 'Online' : (st === 'down' ? 'Offline' : (st === 'warning' ? 'Warning' : (st === 'maintenance' ? 'Maintenance' : 'Unknown')));
    const dot = statusClass(st);
    const barClass = st === 'up' ? 'bg-green-500' : (st === 'warning' ? 'bg-yellow-500' : (st === 'maintenance' ? 'bg-purple-500' : 'bg-red-500'));

    const card = document.createElement('div');
    card.className = 'store-card glass-card rounded-xl overflow-hidden border border-white/10 bg-blue-900/40 hover:bg-blue-900/55 transition cursor-pointer';
    card.innerHTML = `
      <div class="store-header p-4">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="w-3 h-3 rounded-full ${dot}"></span>
              <h3 class="font-bold text-white truncate">${escapeHtml(d.name || d.id || 'Device')}</h3>
            </div>
            <div class="text-xs text-gray-200/80 mt-1 truncate">
              ${escapeHtml(d.projectName || 'Project')} • ID: ${escapeHtml(d.projectId)}
            </div>
          </div>
          <div class="text-right">
            <div class="text-sm font-bold text-white">${escapeHtml(statusText)}</div>
            <div class="text-xs text-gray-200/70">${escapeHtml(d.type || '')}</div>
          </div>
        </div>
        <div class="mt-3 h-2 rounded-full bg-black/30 overflow-hidden">
          <div class="h-full ${barClass}" style="width:${st==='up'? '100':'100'}%"></div>
        </div>
      </div>
    `;
    card.addEventListener('click', () => openDeviceDetails(d.id, d.projectId));
    return card;
  }

  function renderDevicesView(projects) {
    const container = $('projectsContainer');
    const tvLeft = $('tvProjectsLeft') || $('tvStoresLeft');
    const tvRight = $('tvProjectsRight') || $('tvStoresRight');
    if (!container) return;

    const all = flattenDevices(projects);
    const list = sortDevices(filterDevices(all));

    container.innerHTML = '';
    if (tvLeft) tvLeft.innerHTML = '';
    if (tvRight) tvRight.innerHTML = '';

    // Update counts label if present
    const countEl = $('projectsCount');
    if (countEl) countEl.textContent = `${list.length} devices`;

    const targetDefault = container;
    const targetsTv = (tvLeft && tvRight) ? [tvLeft, tvRight] : [];

    // Chunked render for performance
    const chunkSize = 50;
    let i = 0;

    function appendChunk() {
      const end = Math.min(i + chunkSize, list.length);
      for (; i < end; i++) {
        const card = buildDeviceCard(list[i]);
        if (state.tvMode && targetsTv.length === 2) {
          (i % 2 === 0 ? targetsTv[0] : targetsTv[1]).appendChild(card);
        } else {
          targetDefault.appendChild(card);
        }
      }
      if (i < list.length) {
        requestAnimationFrame(appendChunk);
      }
    }
    requestAnimationFrame(appendChunk);
  }

function renderProjects() {
    if (state.mainView === 'devices') {
      renderDevicesView(sortProjects(filterProjects(state.projects)));
      return;
    }

    const container = $('projectsContainer');
    const tvLeft = $('tvProjectsLeft') || $('tvStoresLeft');
    const tvRight = $('tvProjectsRight') || $('tvStoresRight');
    if (!container) return;

    const filtered = sortProjects(filterProjects(state.projects));
    container.innerHTML = '';
    if (tvLeft) tvLeft.innerHTML = '';
    if (tvRight) tvRight.innerHTML = '';

    pendingSparkTimeouts.forEach((id) => clearTimeout(id));
    pendingSparkTimeouts = [];
    if (chartLifecycle) chartLifecycle.resetChartMap(state.charts.sparks);
    const renderToken = sparkRenderGuard ? sparkRenderGuard.next() : 0;

    filtered.forEach((p, idx) => {
      const isExpanded = state.expanded.has(p.id);
      const overall = p.status || 'unknown';
      const headerStatusClass = statusClass(overall);

      const card = document.createElement('div');
      card.className = 'store-card glass-card rounded-xl overflow-hidden border border-white/10';
      card.dataset.storeId = p.id;

      const devicesHtml = (p.devices || []).map(d => {
        const dotClass = statusClass(d.status || 'unknown');
        const ip = d.ip ? `<span class="text-xs text-gray-400">${escapeHtml(d.ip)}</span>` : '';
        return `
          <div class="device-item flex items-center justify-between p-3 rounded-lg bg-black/20 hover:bg-black/30 cursor-pointer"
               data-device-id="${d.id}">
            <div class="flex items-center gap-3">
              <span class="status-dot ${dotClass}"></span>
              <div>
                <div class="font-semibold">${escapeHtml(d.name || 'Device')}</div>
                <div class="text-xs text-gray-400">${escapeHtml(d.type || 'other')} ${ip}</div>
              </div>
            </div>
            <div class="flex items-center gap-3">
              <div class="w-24 h-7"><canvas id="spark_${d.id}" height="28"></canvas></div>
              <div class="text-xs text-gray-400">${escapeHtml(d.status || 'unknown')}</div>
            </div>
          </div>
        `;
      }).join('');

      card.innerHTML = `
        <div class="store-header p-4 flex items-center justify-between">
          <div class="flex items-center gap-3">
            <span class="status-dot ${headerStatusClass}"></span>
            <div>
              <h3 class="font-bold text-lg leading-tight">${escapeHtml(p.name || p.id)}</h3>
              <div class="text-xs text-gray-400">Project ID: ${escapeHtml(p.id)}</div>
            </div>
          </div>

          <div class="flex items-center gap-3">
            <button class="px-3 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm font-medium"
                    data-action="details">
              <i class="fas fa-external-link-alt mr-2"></i>Details
            </button>
            <button class="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-sm font-medium"
                    data-action="add-device">
              <i class="fas fa-plus mr-2"></i>Device
            </button>
            <button class="p-2 rounded-lg bg-gray-800 hover:bg-gray-700"
                    data-action="toggle-expand" aria-label="Expand">
              <i class="fas ${isExpanded ? 'fa-chevron-up' : 'fa-chevron-down'}"></i>
            </button>
          </div>
        </div>

        <div class="px-4 pb-4">
          <div class="grid grid-cols-5 gap-2 text-center text-xs">
            <div class="rounded-lg bg-black/20 p-2"><div class="text-gray-400">Total</div><div class="font-bold">${p.totalDevices || 0}</div></div>
            <div class="rounded-lg bg-black/20 p-2"><div class="text-gray-400">Up</div><div class="font-bold text-green-400">${p.upDevices || 0}</div></div>
            <div class="rounded-lg bg-black/20 p-2"><div class="text-gray-400">Down</div><div class="font-bold text-red-400">${p.downDevices || 0}</div></div>
            <div class="rounded-lg bg-black/20 p-2"><div class="text-gray-400">Warn</div><div class="font-bold text-yellow-400">${p.warningDevices || 0}</div></div>
            <div class="rounded-lg bg-black/20 p-2"><div class="text-gray-400">Maint</div><div class="font-bold text-purple-400">${p.maintenanceDevices || 0}</div></div>
          </div>
        </div>

        <div class="devices-section px-4 pb-4" style="display:${isExpanded ? 'block' : 'none'}">
          <div class="text-sm font-semibold mb-2 text-gray-300">Devices</div>
          <div class="space-y-2">${devicesHtml || '<div class="text-gray-500 text-sm">No devices yet.</div>'}</div>
        </div>
      `;

      // events
      card.querySelector('[data-action="toggle-expand"]').addEventListener('click', () => {
        if (state.expanded.has(p.id)) state.expanded.delete(p.id);
        else state.expanded.add(p.id);
        renderProjects();
      });

      card.querySelector('[data-action="add-device"]').addEventListener('click', () => openAddDevice(p));
      card.querySelector('[data-action="details"]').addEventListener('click', () => {
        window.location.href = `/app/device-details.html?projectId=${encodeURIComponent(p.id)}`;
      });

      // device click -> details modal
      card.querySelectorAll('.device-item').forEach(el => {
        el.addEventListener('click', () => {
          const deviceId = el.getAttribute('data-device-id');
          showDeviceDetails(p.id, deviceId);
        });
      });

      container.appendChild(card);

      // Render sparklines for visible devices
      if (isExpanded) {
        (p.devices || []).forEach(d => {
          const t = setTimeout(() => renderSparkline(d.id, renderToken), 0);
          pendingSparkTimeouts.push(t);
        });
        (p.devices || []).forEach(d => { setTimeout(() => renderSparkline(d.id, renderToken), 0); });
      }

      // TV mode simple split
      if (tvLeft && tvRight) {
        const clone = card.cloneNode(true);
        // remove existing listeners in clone and just navigate to details
        clone.querySelectorAll('[data-action="toggle-expand"],[data-action="add-device"]').forEach(b => b.remove());
        clone.querySelector('[data-action="details"]').addEventListener('click', () => {
          window.location.href = `/app/device-details.html?projectId=${encodeURIComponent(p.id)}`;
        });
        if (idx % 2 === 0) tvLeft.appendChild(clone); else tvRight.appendChild(clone);
      }
    });

    // title counts
    if ($('projectsCount')) $('projectsCount').textContent = String(filtered.length);
  }

  function openAddDevice(project) {
    $('modalStoreName').textContent = project.name || project.id;
    $('modalStoreId').value = project.id;
    // reset form
    $('deviceForm').reset();
    openModal('deviceModal');
  }

  async function addProject(e) {
    e.preventDefault();
    const name = $('storeName').value.trim();
    const id = $('storeId').value.trim();
    const location = $('storeLocation').value.trim();
    const notes = $('storeNotes').value.trim();

    if (!name || !id) return alert('Project Name and Project ID are required');

    const res = await apiFetch('/api/projects', {
      method: 'POST',
      body: { name, id, location, notes }
    });

    if (!res.ok) {
      const msg = (await res.json().catch(() => null))?.error || `Failed (${res.status})`;
      alert(msg);
      return;
    }

    closeModal('storeModal');
    $('storeForm').reset();
    await loadProjects();
  }

  async function addDevice(e) {
    e.preventDefault();
    const storeId = $('modalStoreId').value;
    const name = $('deviceName').value.trim();
    const type = $('deviceType').value;
    const ip = $('deviceIp').value.trim();
    const port = $('devicePort').value.trim();
    const url = $('deviceUrl').value.trim();
    const notes = $('deviceNotes').value.trim();

    if (!storeId || !name || !type || !ip) return alert('Device Name, Type and IP are required');

    const res = await apiFetch(`/api/projects/${encodeURIComponent(storeId)}/devices`, {
      method: 'POST',
      body: { name, type, ip, port: port ? Number(port) : null, url: url || null, notes: notes || null }
    });

    if (!res.ok) {
      const msg = (await res.json().catch(() => null))?.error || `Failed (${res.status})`;
      alert(msg);
      return;
    }

    closeModal('deviceModal');
    $('deviceForm').reset();
    await loadProjects();
  }

  async function showDeviceDetails(projectId, deviceId) {
    const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/devices/${encodeURIComponent(deviceId)}`);
    if (!res.ok) {
      alert('Failed to load device details');
      return;
    }
    const d = (await res.json()).device;

    $('deviceDetailsName').textContent = d.name || '';
    $('deviceDetailsType').textContent = d.type || '';
    $('deviceDetailsIp').textContent = d.ip || '';
    $('deviceDetailsStatus').textContent = (d.status || 'unknown').toUpperCase();
    $('deviceDetailsStatusDot').className = 'status-dot ' + statusClass(d.status || 'unknown');
    $('deviceDetailsLastCheck').textContent = d.last_check ? new Date(d.last_check).toLocaleString() : 'Never';
    $('deviceDetailsLoss').textContent = (d.packet_loss ?? '-') + '';
    $('deviceDetailsUrl').textContent = d.url || '-';

    // store current device context for test button
    $('testDeviceNow').dataset.deviceId = d.id;
    $('testDeviceNow').dataset.projectId = projectId;
    $('openDeviceUrl').dataset.url = d.url || '';

    // Load recent history for chart + list
    try {
      const hr = await apiFetch(`/api/devices/${encodeURIComponent(d.id)}/history?limit=60`);
      if (hr.ok) {
        const hdata = await hr.json();
        const hist = hdata.history || [];
        // Modal chart: latency
        const pts = hist.map(x => {
          const st = String(x.status || '').toLowerCase();
          if (st && st !== 'up') return { ts: x.ts, value: 0 };
          return { ts: x.ts, value: (x.latency_ms == null ? null : Number(x.latency_ms)) };
        });
        state.charts.deviceModal = ensureLineChart('deviceDetailsChart', 'Latency ms', pts, state.charts.deviceModal);

        const listEl = $('deviceDetailsHistory');
        if (listEl) {
          listEl.innerHTML = hist.slice(-30).reverse().map(x => {
            const t = new Date(x.ts).toLocaleString();
            const s = String(x.status || '').toUpperCase();
            const stLower = String(x.status || '').toLowerCase();
            let l;
            if (stLower && stLower !== 'up') {
              const det = x.detail || {};
              l = det.timeout ? 'timeout' : '-';
            } else {
              l = (x.latency_ms == null ? '-' : x.latency_ms + 'ms');
            }
            return `<div class="flex justify-between gap-3 py-1 border-b border-white/5"><span>${t}</span><span>${s}</span><span>${l}</span></div>`;
          }).join('') || '<div class="text-gray-400">No history yet.</div>';
        }
      }
    } catch (_) {}

    openModal('deviceDetailsModal');
  }

  async function testCurrentDevice() {
    const deviceId = $('testDeviceNow').dataset.deviceId;
    if (!deviceId) return;
    const res = await apiFetch(`/api/devices/${encodeURIComponent(deviceId)}/test-now`, { method: 'POST' });
    if (!res.ok) alert('Failed to queue test');
    else alert('Test queued. Refresh in ~20 seconds.');
  }

  function openDeviceUrl() {
    const url = $('openDeviceUrl').dataset.url;
    if (!url) return;
    window.open(url, '_blank');
  }

  async function logout() {
    try {
      await apiFetch('/logout', { method: 'POST' });
    } catch (_) {}
    window.location.href = '/';
  }

  function toggleTheme() {
    document.body.classList.toggle('dark-theme');
    localStorage.setItem('theme', document.body.classList.contains('dark-theme') ? 'dark' : 'light');
  }

  function applySavedTheme() {
    const t = localStorage.getItem('theme');
    if (t === 'dark') document.body.classList.add('dark-theme');
  }

  function toggleTvMode() {
    state.tvMode = !state.tvMode;
    $('defaultLayout').style.display = state.tvMode ? 'none' : '';
    $('tvLayout').classList.toggle('hidden', !state.tvMode);
    document.body.classList.toggle('tv-mode', state.tvMode);
    renderProjects();
  }

  
  function setMainView(view) {
    state.mainView = view === 'devices' ? 'devices' : 'projects';
    localStorage.setItem('dashmonMainView', state.mainView);
    updateMainViewToggleUI();
    renderProjects();
  }

  function updateMainViewToggleUI() {
    const isDevices = state.mainView === 'devices';
    const pairs = [
      ['mainViewProjectsBtn','mainViewDevicesBtn'],
      ['tvMainViewProjectsBtn','tvMainViewDevicesBtn']
    ];
    pairs.forEach(([a,b]) => {
      const btnA = $(a), btnB = $(b);
      if (!btnA || !btnB) return;
      if (isDevices) {
        btnA.classList.remove('bg-gray-700/60','text-white');
        btnA.classList.add('text-gray-200');
        btnB.classList.add('bg-gray-700/60','text-white');
      } else {
        btnB.classList.remove('bg-gray-700/60','text-white');
        btnB.classList.add('text-gray-200');
        btnA.classList.add('bg-gray-700/60','text-white');
      }
    });
  }

function toggleDownAlertSound() {
    state.soundOn = !state.soundOn;
    localStorage.setItem('downAlertSound', state.soundOn ? 'on' : 'off');
    updateUserInfo();
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

  async function refreshAll() {
    await loadProjects();
  }

  async function init() {
    applySavedTheme();

    const ok = await checkAuth();
    if (!ok) return;

    // Wire events
    $('themeToggle')?.addEventListener('click', toggleTheme);
    $('tvModeToggle')?.addEventListener('click', toggleTvMode);
    $('refreshBtn')?.addEventListener('click', refreshAll);
    $('logoutBtn')?.addEventListener('click', logout);

    // Main view toggle (Projects / Devices)
    $('mainViewProjectsBtn')?.addEventListener('click', () => setMainView('projects'));
    $('mainViewDevicesBtn')?.addEventListener('click', () => setMainView('devices'));
    $('tvMainViewProjectsBtn')?.addEventListener('click', () => setMainView('projects'));
    $('tvMainViewDevicesBtn')?.addEventListener('click', () => setMainView('devices'));

    // TV mode exit button (toolbar)
    $('tvModeToggleTv')?.addEventListener('click', toggleTvMode);

    // Mirror filter/sort selects into TV toolbar
    const baseFilter = $('storeFilterSelect');
    const baseSort = $('storeSortSelect');
    const tvFilter = $('tvStoreFilterSelect');
    const tvSort = $('tvStoreSortSelect');
    if (baseFilter && tvFilter && tvFilter.options.length === 0) {
      tvFilter.innerHTML = baseFilter.innerHTML;
      tvFilter.value = baseFilter.value;
      tvFilter.addEventListener('change', () => { baseFilter.value = tvFilter.value; renderProjects(); });
      baseFilter.addEventListener('change', () => { tvFilter.value = baseFilter.value; renderProjects(); });
    }
    if (baseSort && tvSort && tvSort.options.length === 0) {
      tvSort.innerHTML = baseSort.innerHTML;
      tvSort.value = baseSort.value;
      tvSort.addEventListener('change', () => { baseSort.value = tvSort.value; renderProjects(); });
      baseSort.addEventListener('change', () => { tvSort.value = baseSort.value; renderProjects(); });
    }

    updateMainViewToggleUI();


    $('addStoreBtn')?.addEventListener('click', () => openModal('storeModal'));
    $('closeStoreModal')?.addEventListener('click', () => closeModal('storeModal'));
    $('cancelStore')?.addEventListener('click', () => closeModal('storeModal'));
    $('storeForm')?.addEventListener('submit', addProject);

    $('closeDeviceModal')?.addEventListener('click', () => closeModal('deviceModal'));
    $('cancelDevice')?.addEventListener('click', () => closeModal('deviceModal'));
    $('deviceForm')?.addEventListener('submit', addDevice);

    $('closeDeviceDetails')?.addEventListener('click', () => closeModal('deviceDetailsModal'));
    $('openDeviceUrl')?.addEventListener('click', openDeviceUrl);
    $('testDeviceNow')?.addEventListener('click', testCurrentDevice);

    $('soundToggle')?.addEventListener('click', toggleDownAlertSound);
    $('emailAlertsBtn')?.addEventListener('click', openEmailAlertsModal);
    $('closeEmailAlertsModal')?.addEventListener('click', () => closeModal('emailAlertsModal'));
    $('cancelEmailAlerts')?.addEventListener('click', () => closeModal('emailAlertsModal'));
    $('emailAlertsForm')?.addEventListener('submit', saveEmailAlerts);

    $('smsAlertsBtn')?.addEventListener('click', openSmsAlertsModal);
    $('closeSmsAlertsModal')?.addEventListener('click', () => closeModal('smsAlertsModal'));
    $('cancelSmsAlerts')?.addEventListener('click', () => closeModal('smsAlertsModal'));
    $('smsAlertsForm')?.addEventListener('submit', saveSmsAlerts);
    $('smsTestBtn')?.addEventListener('click', sendSmsTest);

    $('totalDevicesCard')?.addEventListener('click', () => openSummaryDevicesModal('all'));
    $('upDevicesCard')?.addEventListener('click', () => openSummaryDevicesModal('up'));
    $('downDevicesCard')?.addEventListener('click', () => openSummaryDevicesModal('down'));
    $('closeSummaryDevicesModal')?.addEventListener('click', () => closeModal('summaryDevicesModal'));
    $('summaryDevicesModal')?.addEventListener('click', (e) => {
      if (e.target && e.target.id === 'summaryDevicesModal') closeModal('summaryDevicesModal');
    });

    $('storeSortSelect')?.addEventListener('change', renderProjects);
    $('storeFilterSelect')?.addEventListener('change', renderProjects);

    // Initial load
    await loadProjects();

    // Auto refresh (60s)
    refreshTimer = setInterval(() => loadProjects().catch(() => {}), 60 * 1000);
  }

  document.addEventListener('DOMContentLoaded', () => {
    window.addEventListener('beforeunload', () => {
      if (refreshTimer) clearInterval(refreshTimer);
      pendingSparkTimeouts.forEach((id) => clearTimeout(id));
      pendingSparkTimeouts = [];
      if (chartLifecycle) chartLifecycle.resetChartMap(state.charts.sparks);
      if (state.charts.deviceModal) {
        state.charts.deviceModal.destroy();
        state.charts.deviceModal = null;
      }
      if (chartLifecycle) chartLifecycle.resetChartMap(state.charts.sparks);
    }, { once: true });

    init().catch((e) => {
      console.error(e);
      alert('Dashboard error: ' + (e?.message || e));
    });
  });
})();
