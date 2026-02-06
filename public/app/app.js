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
    soundOn: (localStorage.getItem('downAlertSound') || 'on') === 'on',
    lastDownCount: 0,
    emailAlert: { enabled: false, cooldownMinutes: 30, to: [] }
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
    const values = hist.map(h => (h.latency_ms == null ? null : Number(h.latency_ms)));

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
      badge.textContent = (state.user.plan || 'free').toUpperCase();
      badge.className = 'ml-3 px-2 py-1 rounded-full text-xs font-bold ' +
        (state.user.plan === 'premium' ? 'bg-yellow-600 text-black' : 'bg-gray-700 text-white');
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

  function renderProjects() {
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
        window.location.href = `/app/project.html?projectId=${encodeURIComponent(p.id)}`;
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
          window.location.href = `/app/project.html?projectId=${encodeURIComponent(p.id)}`;
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
        const pts = hist.map(x => ({ ts: x.ts, value: x.latency_ms == null ? 0 : Number(x.latency_ms) }));
        state.charts.deviceModal = ensureLineChart('deviceDetailsChart', 'Latency ms', pts, state.charts.deviceModal);

        const listEl = $('deviceDetailsHistory');
        if (listEl) {
          listEl.innerHTML = hist.slice(-30).reverse().map(x => {
            const t = new Date(x.ts).toLocaleString();
            const s = String(x.status || '').toUpperCase();
            const l = (x.latency_ms == null ? '-' : x.latency_ms + 'ms');
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
