/* ================================================================
   Statusline Metrics -- Dashboard Application
   Main logic: init, routing, polling, data binding.
   ================================================================ */

'use strict';

/* ── State ────────────────────────────────────────────────────── */

const state = {
  currentPage: 'overview',
  currentProject: null,     // null = all projects
  timeRange: '1d',          // active time filter
  projects: [],
  pollTimer: null,
  charts: {},               // chart instances keyed by name
  lastUpdate: 0,
  prevKpi: {},              // previous KPI values for trend badges
  refreshProgressTimer: null, // auto-refresh progress ring timer
  isRefreshing: false,
  pendingRefresh: false,
  sessionsPage: 0,            // current page in sessions table
  sessionsPerPage: 10,        // projects per page after grouping
  _lastSessions: null,        // cached sessions for pagination re-render
  barChartPage: 0,            // current page in bar chart
  _barChartSummaries: null,
  _barChartProjects: null,
};

const GITHUB_REPO = 'kolindes/Claude-StatusLine-Metrics';

/* ── Time Range Definitions (seconds) ─────────────────────────── */

const TIME_RANGES = {
  '1h':  3600,
  '6h':  21600,
  '1d':  86400,
  '7d':  604800,
  '30d': 2592000,
};

/* ── Count Formatter (stars, etc.) ────────────────────────────── */

function fmtCount(n) {
  if (n == null || isNaN(n)) return '0';
  if (n >= 1000000000) return (n / 1000000000).toFixed(1) + 'B';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

/* ── Formatting Helpers ───────────────────────────────────────── */

function fmtTokens(n) {
  if (n == null || isNaN(n) || n <= 0) return '0';
  n = Math.round(n);
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return '0%';
  return n.toFixed(1) + '%';
}

function fmtDur(value, unit) {
  // unit: 'ms' (default), 's', 'm'
  if (value == null || value <= 0) return '0m';
  let sec;
  if (unit === 'm') sec = Math.round(value) * 60;
  else if (unit === 's') sec = Math.round(value);
  else sec = Math.floor(value / 1000);
  if (sec <= 0) return '0m';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + 'm';
  return s + 's';
}

function fmtCost(usd) {
  if (!usd || usd <= 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return '$' + usd.toFixed(2);
}

function fmtTimeAgo(ts) {
  if (!ts) return 'never';
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

function fmtTimeUntil(ts) {
  if (!ts) return '--';
  const diff = ts - Math.floor(Date.now() / 1000);
  if (diff <= 0) return 'now';
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  if (h > 24) return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

function fmtDateTime(ts) {
  if (!ts) return '--';
  const d = new Date(ts * 1000);
  return d.toLocaleString([], {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '...' : str;
}

function plural(n, one, many) {
  return n === 1 ? n + ' ' + one : n + ' ' + many;
}

/* ── DOM Helpers ──────────────────────────────────────────────── */

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }
function setText(sel, text) {
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (el) el.textContent = text;
}

function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function createEmptyRow(colSpan, message) {
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = colSpan;
  td.style.cssText = 'text-align:center;color:var(--text-muted);padding:24px';
  td.textContent = message;
  tr.appendChild(td);
  return tr;
}

/* ── Animated Counter (P1) ───────────────────────────────────── */

function animateValue(el, from, to, duration) {
  if (!el || from === to) return;
  // Cancel previous animation on this element
  if (el._animFrame) cancelAnimationFrame(el._animFrame);
  duration = duration || 600;
  const start = performance.now();
  const fmt = el.dataset.format || 'tokens';
  function step(now) {
    const progress = Math.min((now - start) / duration, 1);
    const ease = 1 - Math.pow(1 - progress, 3); // easeOutCubic
    const current = from + (to - from) * ease;
    if (fmt === 'pct') el.textContent = fmtPct(current);
    else if (fmt === 'int') el.textContent = String(Math.round(current));
    else if (fmt === 'cost') el.textContent = fmtCost(current);
    else el.textContent = fmtTokens(current);
    if (progress < 1) el._animFrame = requestAnimationFrame(step);
    else el._animFrame = null;
  }
  el._animFrame = requestAnimationFrame(step);
}

function setKpiValue(sel, rawValue, formatType) {
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (!el) return;
  const oldRaw = parseFloat(el.dataset.rawValue) || 0;
  el.dataset.rawValue = String(rawValue);
  el.dataset.format = formatType || 'tokens';
  if (oldRaw !== rawValue) {
    animateValue(el, oldRaw, rawValue, 600);
    /* Sci-fi data-flicker on parent card */
    const card = el.closest('.kpi-card') || el.closest('.stat-card');
    if (card) {
      card.classList.remove('data-update');
      void card.offsetWidth; /* force reflow */
      card.classList.add('data-update');
      if (card._flickerTimer) clearTimeout(card._flickerTimer);
      card._flickerTimer = setTimeout(function() { card.classList.remove('data-update'); }, 500);
    }
  }
}

/* ── KPI Trend Badge ─────────────────────────────────────────── */

function fmtDelta(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(Math.round(n));
}

function updateKpiTrend(trendId, key, currentValue) {
  const el = document.getElementById(trendId);
  if (!el) return;
  if (!(key in state.prevKpi)) {
    // First render -- store value but do not show badge
    state.prevKpi[key] = currentValue;
    el.className = 'kpi-trend neutral';
    el.textContent = '';
    return;
  }
  const prev = state.prevKpi[key];
  const delta = currentValue - prev;
  state.prevKpi[key] = currentValue;
  if (delta === 0) {
    el.className = 'kpi-trend neutral';
    el.textContent = '';
    return;
  }
  const sign = delta > 0 ? '+' : '';
  const arrow = delta > 0 ? '\u2191' : '\u2193';
  el.className = 'kpi-trend ' + (delta > 0 ? 'up' : 'down');
  el.textContent = arrow + ' ' + sign + fmtDelta(Math.abs(delta));
}

/* ── Time Range Helpers ───────────────────────────────────────── */

function getTimeRange() {
  const now = Math.floor(Date.now() / 1000);
  const seconds = TIME_RANGES[state.timeRange] || 86400;
  return { from: now - seconds, to: now };
}

function getInterval() {
  switch (state.timeRange) {
    case '1h':  return '5m';
    case '6h':  return '5m';
    case '1d':  return '15m';
    case '7d':  return '1h';
    case '30d': return '4h';
    default:    return '15m';
  }
}

/* ── Navigation ───────────────────────────────────────────────── */

function navigateTo(page) {
  state.currentPage = page;
  localStorage.setItem('sm_page', page);

  // P7: sync hash via replaceState (no pushState to avoid history pollution)
  history.replaceState(null, '', '#' + page);

  // Update nav active states
  $$('.sidebar-nav a').forEach(function(a) {
    a.classList.toggle('active', a.dataset.page === page);
  });

  // Show/hide page sections
  $$('.page-section').forEach(function(s) {
    s.classList.toggle('active', s.id === 'page-' + page);
  });

  // Update page title
  const titles = {
    overview: 'Overview',
    ratelimits: 'Rate Limits',
    context: 'Context Window',
    global: 'Global Statistics',
  };
  setText('#page-title', titles[page] || 'Overview');

  // 3.7: Page subtitle
  updateSubtitle();

  // Hide time filter on Global Stats (lifetime data, not time-filtered)
  const filterBar = $('.time-filter-bar');
  if (filterBar) filterBar.style.display = (page === 'global') ? 'none' : '';

  // Load page data
  refreshData();
}

function updateSubtitle() {
  const subtitles = {
    overview: 'Real-time token usage and session activity',
    ratelimits: state.currentProject ? 'Account-wide data (project filter not applicable)' : 'API rate limit consumption and predictions',
    context: 'Context window utilization across sessions',
    global: 'Lifetime aggregated statistics',
  };
  setText('#page-subtitle', subtitles[state.currentPage] || '');
}

function selectProject(projectId) {
  state.currentProject = projectId;
  state.prevKpi = {};
  state.sessionsPage = 0;
  state.barChartPage = 0;

  // Update sidebar active
  $$('.sidebar-projects a').forEach(function(a) {
    const isAll = a.dataset.pid === '';
    const isMatch = projectId === null ? isAll : a.dataset.pid === projectId;
    a.classList.toggle('active', isMatch);
    if (isAll) {
      a.style.fontWeight = projectId === null ? '600' : '';
      a.style.fontStyle = projectId === null ? '' : 'italic';
      a.style.opacity = projectId === null ? '' : '0.7';
    }
  });

  updateSubtitle();
  refreshData();
}

/* ── Sidebar Project List ─────────────────────────────────────── */

async function loadProjects() {
  try {
    const projects = await API.projects();
    state.projects = projects;
    renderProjectList(projects);
  } catch (e) {
    console.error('Failed to load projects:', e);
    showError('project-list', e.message);
  }
}

function renderProjectList(projects) {
  const container = $('#project-list');
  if (!container) return;

  // Clear existing children
  clearChildren(container);

  // "All Projects" item always first
  const allLink = document.createElement('a');
  allLink.dataset.pid = '';
  if (state.currentProject === null) {
    allLink.className = 'active';
    allLink.style.fontWeight = '600';
  } else {
    allLink.style.opacity = '0.7';
    allLink.style.fontStyle = 'italic';
  }
  allLink.textContent = 'All Projects';
  allLink.addEventListener('click', function(e) {
    e.preventDefault();
    selectProject(null);
  });
  container.appendChild(allLink);

  if (!projects || projects.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.style.padding = '16px';
    const desc = document.createElement('div');
    desc.className = 'empty-desc';
    desc.textContent = 'No projects yet';
    empty.appendChild(desc);
    container.appendChild(empty);
    return;
  }

  projects.sort(function(a, b) { return (a.project_name || '').localeCompare(b.project_name || ''); });

  projects.forEach(function(p) {
    const a = document.createElement('a');
    a.dataset.pid = p.project_id;
    a.title = p.project_name || '';
    if (p.project_id === state.currentProject) a.className = 'active';
    a.textContent = truncate(p.project_name, 20) + ' ';
    const span = document.createElement('span');
    span.className = 'project-sessions';
    span.textContent = plural(p.sessions_count || 0, 'sess', 'sess');
    a.appendChild(span);
    a.addEventListener('click', function(e) {
      e.preventDefault();
      const pid = p.project_id;
      selectProject(pid === state.currentProject ? null : pid);
    });
    container.appendChild(a);
  });
}

/* ── Overview Page ────────────────────────────────────────────── */

async function loadOverview() {
  const tr = getTimeRange();

  // Build sessions query with optional project filter (C2) + time range
  const sessionsParams = { limit: 500, from: tr.from, to: tr.to };
  if (state.currentProject !== null) {
    sessionsParams.project_id = state.currentProject;
  }

  // Activity params
  const activityParams = { from: tr.from, to: tr.to, interval: getInterval() };
  if (state.currentProject !== null) {
    activityParams.project_id = state.currentProject;
  }

  // Load multiple endpoints in parallel
  const results = await Promise.all([
    API.rateLimitsCurrent().catch(function() { return null; }),
    API.sessions(sessionsParams).catch(function() { return []; }),
    API.health().catch(function() { return null; }),
    API.burnRate().catch(function() { return null; }),
    API.activity(activityParams).catch(function() { return []; }),
    API.rateGrowth().catch(function() { return null; }),
  ]);
  const rateLimits = results[0];
  const sessions = results[1];
  const health = results[2];
  const burn = results[3];
  const activity = results[4];
  const rateGrowth = results[5];

  // If a project is selected, load project-specific data
  let projectSummary = null;
  let allSummaries = [];
  const pid = state.currentProject || (state.projects.length > 0 ? state.projects[0].project_id : null);

  if (state.currentProject !== null && pid) {
    // Single project selected
    const pResults = await Promise.all([
      API.projectSummary(pid, { from: tr.from, to: tr.to }).catch(function() { return null; }),
    ]);
    projectSummary = pResults[0];
    allSummaries = [projectSummary];
  } else if (state.projects.length > 0) {
    // All Projects: single aggregated summary query for KPIs
    const summaryResult = await API.allProjectsSummary({ from: tr.from, to: tr.to }).catch(function() { return null; });
    projectSummary = summaryResult || {
      tokens_in: 0, tokens_out: 0, cache_write: 0, cache_read: 0,
      total_tokens: 0, cost_usd: 0, duration_ms: 0, sessions: 0, avg_ctx_pct: 0,
    };
    // Per-project breakdown still needed for bar chart
    allSummaries = await Promise.all(
      state.projects.map(function(p) {
        return API.projectSummary(p.project_id, { from: tr.from, to: tr.to }).catch(function() { return null; });
      })
    );
  }

  // KPI Cards
  updateKpiCards(projectSummary, rateLimits, health, burn);

  // Rate growth per active hour
  if (rateGrowth) {
    const g5 = rateGrowth.five_hour || {};
    const g7 = rateGrowth.seven_day || {};
    setText('#kpi-growth5h-value', g5.pct_per_hour ? '+' + g5.pct_per_hour.toFixed(1) + '%/hr' : 'idle');
    setText('#kpi-growth5h-detail', g5.active_hours ? g5.active_hours + ' active hrs (48h)' : 'no activity');
    setText('#kpi-growth7d-value', g7.pct_per_hour ? '+' + g7.pct_per_hour.toFixed(1) + '%/hr' : 'idle');
    setText('#kpi-growth7d-detail', g7.active_hours ? g7.active_hours + ' active hrs (48h)' : 'no activity');
  }

  setText('#tokens-chart-title', 'Activity');

  // Charts
  updateTokensTimeline(activity);
  const barProjects = state.currentProject !== null
    ? [{ project_name: (state.projects.find(function(p) { return p.project_id === state.currentProject; }) || {}).project_name || state.currentProject }]
    : state.projects;
  updateProjectsBarChart(allSummaries, barProjects);

  // Sessions table
  renderSessionsTable(sessions);
  setText('#sessions-title', 'Sessions');

  // Update timestamp
  state.lastUpdate = Date.now();
  setText('.last-update', 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
}

function updateKpiCards(summary, rateLimits, health, burn) {
  if (summary) {
    const costVal = summary.cost_usd || 0;
    setKpiValue('#kpi-cost-value', costVal, 'cost');
    setText('#kpi-cost-detail', costVal > 0 ? 'across ' + (summary.sessions || 0) + ' sessions' : 'subscription (no cost data)');

    const tokOut = summary.tokens_out || 0;
    setKpiValue('#kpi-tokout-value', tokOut, 'tokens');
    setText('#kpi-tokout-detail', 'In: ' + fmtTokens(summary.tokens_in || 0));
  }

  if (burn) {
    setText('#kpi-burnmin-value', fmtTokens(burn.tokens_per_min));
    setText('#kpi-burnmin-detail', burn.active_minutes + ' active min last hour');
    setText('#kpi-burnhour-value', fmtTokens(burn.tokens_per_hour));
    setText('#kpi-burnhour-detail', '~' + fmtTokens(burn.total_tokens_out) + ' last hour');
  }

  if (rateLimits) {
    const r5 = rateLimits.five_hour || {};
    const r7 = rateLimits.seven_day || {};
    const pct5 = r5.pct || 0;
    const pct7 = r7.pct || 0;

    setKpiValue('#kpi-rate5h-value', pct5, 'pct');
    const el5 = $('#kpi-rate5h-value');
    if (el5) el5.className = 'kpi-value ' + (pct5 > 70 ? 'accent-red' : pct5 > 30 ? 'accent-yellow' : 'accent-green');
    setText('#kpi-rate5h-detail', 'resets in ' + fmtTimeUntil(r5.resets_at));

    setKpiValue('#kpi-rate7d-value', pct7, 'pct');
    const el7 = $('#kpi-rate7d-value');
    if (el7) el7.className = 'kpi-value ' + (pct7 > 70 ? 'accent-red' : pct7 > 30 ? 'accent-yellow' : 'accent-green');
    setText('#kpi-rate7d-detail', 'resets in ' + fmtTimeUntil(r7.resets_at));
  }

  if (summary) {
    const ctxPct = summary.avg_ctx_pct || 0;
    setKpiValue('#kpi-context-value', ctxPct, 'pct');
    const elCtx = $('#kpi-context-value');
    if (elCtx) elCtx.className = 'kpi-value ' + (ctxPct > 80 ? 'accent-red' : ctxPct > 50 ? 'accent-yellow' : 'accent-green');
    const sessCount = summary.sessions || 0;
    setText('#kpi-context-detail', plural(sessCount, 'session tracked', 'sessions tracked'));
  }

  if (health) {
    setKpiValue('#kpi-active-value', health.active_sessions || 0, 'int');
    const elActive = $('#kpi-active-value');
    if (elActive) elActive.className = 'kpi-value accent-purple';
    const recCount = health.total_records || 0;
    setText('#kpi-active-detail', plural(recCount, 'total record', 'total records'));

  }

  // 3.1: KPI Trend badges
  if (summary) {
    updateKpiTrend('kpi-cost-trend', 'cost', summary.cost_usd || 0);
    updateKpiTrend('kpi-tokout-trend', 'tokout', summary.tokens_out || 0);
    updateKpiTrend('kpi-context-trend', 'context', summary.avg_ctx_pct || 0);
  }
  if (rateLimits) {
    updateKpiTrend('kpi-rate5h-trend', 'rate5h', (rateLimits.five_hour || {}).pct || 0);
    updateKpiTrend('kpi-rate7d-trend', 'rate7d', (rateLimits.seven_day || {}).pct || 0);
  }
  if (health) {
    updateKpiTrend('kpi-active-trend', 'active', health.active_sessions || 0);
  }
}

function showError(containerId, msg) {
  const container = document.getElementById(containerId);
  if (!container) return;
  clearChildren(container);
  const div = document.createElement('div');
  div.className = 'error-state';
  div.textContent = 'Failed to load data. ';
  const retry = document.createElement('span');
  retry.className = 'retry-link';
  retry.textContent = 'Retry';
  retry.addEventListener('click', function() {
    clearChildren(container);
    refreshData();
  });
  div.appendChild(retry);
  container.appendChild(div);
}

function setChartEmpty(canvasId, empty) {
  let container = document.getElementById(canvasId);
  if (!container) return;
  container = container.closest('.chart-container');
  if (!container) return;
  const msg = container.querySelector('.chart-empty');
  if (empty && !msg) {
    const el = document.createElement('div');
    el.className = 'chart-empty';
    // C3: contextual empty message
    const hasFilter = state.currentProject !== null || state.timeRange !== '1d';
    el.textContent = hasFilter ? 'No data for this time range' : 'Collecting data\u2026';
    container.appendChild(el);
  } else if (empty && msg) {
    // Update text if already exists (range/filter may have changed)
    const hasFilter2 = state.currentProject !== null || state.timeRange !== '1d';
    msg.textContent = hasFilter2 ? 'No data for this time range' : 'Collecting data\u2026';
  } else if (!empty && msg) {
    msg.remove();
  }
  const canvas = container.querySelector('canvas');
  if (canvas) canvas.style.opacity = empty ? '0.15' : '1';
}

function updateTokensTimeline(activity) {
  if (!state.charts.tokens) {
    state.charts.tokens = createTokensChart('chart-tokens');
  }
  const empty = !activity || activity.length === 0;
  setChartEmpty('chart-tokens', empty);
  if (empty) {
    updateChart(state.charts.tokens, [], [[]]);
    return;
  }
  const labels = activity.map(function(r) { return fmtTimeLabel(r.bucket_ts); });
  const tokensOut = activity.map(function(r) { return r.tokens_out || 0; });
  updateChart(state.charts.tokens, labels, [tokensOut]);
}

function updateProjectsBarChart(summaries, projectsList) {
  if (!state.charts.breakdown) {
    state.charts.breakdown = createProjectsBarChart('chart-breakdown');
  }
  const chart = state.charts.breakdown;
  if (!chart) return;

  const projects = projectsList || state.projects || [];
  if (projects.length === 0) {
    chart.data.labels = [];
    chart.data.datasets[0].data = [];
    chart.update();
    setChartEmpty('chart-breakdown', true);
    return;
  }

  const labels = [];
  const data = [];
  projects.forEach(function(p, i) {
    const s = summaries ? summaries[i] : null;
    const tokens = s ? ((s.tokens_in || 0) + (s.tokens_out || 0)) : 0;
    if (tokens > 0) {
      labels.push(truncate(p.project_name, 18));
      data.push(tokens);
    }
  });

  // Sort by tokens descending
  const indices = data.map(function(_, i) { return i; });
  indices.sort(function(a, b) { return data[b] - data[a]; });
  const allLabels = indices.map(function(i) { return labels[i]; });
  const allData = indices.map(function(i) { return data[i]; });

  // Paginate: 10 projects per page
  const perPage = 10;
  const totalPages = Math.ceil(allLabels.length / perPage);
  if (state.barChartPage >= totalPages) state.barChartPage = 0;
  const start = state.barChartPage * perPage;
  const sortedLabels = allLabels.slice(start, start + perPage);
  const sortedData = allData.slice(start, start + perPage);

  // Store for re-render on page change
  state._barChartSummaries = summaries;
  state._barChartProjects = projectsList;

  const empty = sortedData.length === 0;
  setChartEmpty('chart-breakdown', empty);

  chart.data.labels = sortedLabels;
  chart.data.datasets[0].data = sortedData;
  chart.update();

  // Pagination controls
  const container = document.getElementById('chart-breakdown');
  if (container) {
    const parent = container.closest('.chart-container');
    if (parent) {
      let pag = parent.querySelector('.bar-pagination');
      if (pag) pag.remove();
      if (totalPages > 1) {
        pag = document.createElement('div');
        pag.className = 'bar-pagination sessions-pagination';
        const prevBtn = document.createElement('button');
        prevBtn.textContent = '← Prev';
        prevBtn.disabled = state.barChartPage === 0;
        prevBtn.addEventListener('click', function() {
          state.barChartPage--;
          updateProjectsBarChart(state._barChartSummaries, state._barChartProjects);
        });
        const info = document.createElement('span');
        info.textContent = (state.barChartPage + 1) + ' / ' + totalPages;
        const nextBtn = document.createElement('button');
        nextBtn.textContent = 'Next →';
        nextBtn.disabled = state.barChartPage >= totalPages - 1;
        nextBtn.addEventListener('click', function() {
          state.barChartPage++;
          updateProjectsBarChart(state._barChartSummaries, state._barChartProjects);
        });
        pag.appendChild(prevBtn);
        pag.appendChild(info);
        pag.appendChild(nextBtn);
        parent.appendChild(pag);
      }
    }
  }
}

function getSessionMetrics(s) {
  return {
    tokens: (s.max_tokens_in || 0) + (s.max_tokens_out || 0),
    cost: s.max_cost_usd || 0,
    duration: s.duration_seconds || 0,
  };
}

function renderSessionsTable(sessions) {
  const tbody = $('#sessions-tbody');
  if (!tbody) return;

  // Cache sessions for pagination re-render
  state._lastSessions = sessions;

  // Clear existing rows
  clearChildren(tbody);

  if (!sessions || sessions.length === 0) {
    tbody.appendChild(createEmptyRow(5, 'No sessions found'));
    return;
  }

  // Group sessions by project_name
  const nowTs = Math.floor(Date.now() / 1000);
  const grouped = {};
  sessions.forEach(function(s) {
    const name = s.project_name || 'unknown';
    if (!grouped[name]) {
      grouped[name] = { project_name: name, model: s.model, sessions: 0, duration: 0, tokens: 0, cost: 0, last_seen_at: 0, has_active: false };
    }
    const g = grouped[name];
    g.sessions++;
    const m = getSessionMetrics(s);
    g.duration += m.duration;
    g.tokens += m.tokens;
    g.cost += m.cost;
    if (s.last_seen_at > g.last_seen_at) { g.last_seen_at = s.last_seen_at; g.model = s.model; }
    const seenDiff = s.last_seen_at ? (nowTs - s.last_seen_at) : Infinity;
    if (seenDiff < 300) g.has_active = true;
  });

  // Sort ALL projects by cost descending
  const projects = Object.values(grouped);
  projects.sort(function(a, b) { return b.cost - a.cost; });

  // Pagination: slice projects for current page
  const perPage = state.sessionsPerPage;
  const totalPages = Math.ceil(projects.length / perPage);
  if (state.sessionsPage >= totalPages) state.sessionsPage = Math.max(0, totalPages - 1);
  const pageStart = state.sessionsPage * perPage;
  const pageProjects = projects.slice(pageStart, pageStart + perPage);

  // Render only current page of projects
  pageProjects.forEach(function(p) {
    const tr = document.createElement('tr');

    const tdProj = document.createElement('td');
    const dot = document.createElement('span');
    dot.className = 'status-dot ' + (p.has_active ? 'active' : 'idle');
    tdProj.appendChild(dot);
    let label = truncate(p.project_name, 20);
    if (p.sessions > 1) label += ' (' + p.sessions + ')';
    tdProj.appendChild(document.createTextNode(label));
    tr.appendChild(tdProj);

    const tdModel = document.createElement('td');
    tdModel.textContent = p.model || '--';
    tr.appendChild(tdModel);

    const tdDur = document.createElement('td');
    tdDur.className = 'cell-right';
    tdDur.textContent = fmtDur(p.duration, 's');
    tr.appendChild(tdDur);

    const tdTok = document.createElement('td');
    tdTok.className = 'cell-right';
    tdTok.textContent = fmtTokens(p.tokens);
    tr.appendChild(tdTok);

    const tdCost = document.createElement('td');
    tdCost.className = 'cell-right';
    tdCost.textContent = fmtCost(p.cost);
    tr.appendChild(tdCost);

    tbody.appendChild(tr);
  });

  // TOTAL row -- always calculated from ALL sessions/projects
  let totalTokens = 0, totalCost = 0, totalDur = 0;
  sessions.forEach(function(s) {
    const m = getSessionMetrics(s);
    totalTokens += m.tokens;
    totalCost += m.cost;
    totalDur += m.duration;
  });
  const tfoot = document.createElement('tr');
  tfoot.className = 'sessions-total';
  const tfLabel = document.createElement('td');
  tfLabel.colSpan = 2;
  tfLabel.textContent = 'TOTAL (' + plural(sessions.length, 'session', 'sessions') + ', ' + projects.length + ' projects)';
  tfoot.appendChild(tfLabel);
  const tfDur = document.createElement('td');
  tfDur.className = 'cell-right';
  tfDur.textContent = fmtDur(totalDur, 's');
  tfoot.appendChild(tfDur);
  const tfTok = document.createElement('td');
  tfTok.className = 'cell-right';
  tfTok.textContent = fmtTokens(totalTokens);
  tfoot.appendChild(tfTok);
  const tfCost = document.createElement('td');
  tfCost.className = 'cell-right';
  tfCost.textContent = fmtCost(totalCost);
  tfoot.appendChild(tfCost);
  tbody.appendChild(tfoot);

  // Pagination controls (only if more than 1 page)
  if (totalPages > 1) {
    const paginationRow = document.createElement('tr');
    const paginationTd = document.createElement('td');
    paginationTd.colSpan = 5;
    paginationTd.className = 'sessions-pagination';

    const prevBtn = document.createElement('button');
    prevBtn.textContent = '\u2190 Prev';
    prevBtn.disabled = state.sessionsPage === 0;
    prevBtn.addEventListener('click', function() {
      state.sessionsPage--;
      renderSessionsTable(state._lastSessions);
    });

    const info = document.createElement('span');
    info.textContent = 'Page ' + (state.sessionsPage + 1) + ' of ' + totalPages;

    const nextBtn = document.createElement('button');
    nextBtn.textContent = 'Next \u2192';
    nextBtn.disabled = state.sessionsPage >= totalPages - 1;
    nextBtn.addEventListener('click', function() {
      state.sessionsPage++;
      renderSessionsTable(state._lastSessions);
    });

    paginationTd.appendChild(prevBtn);
    paginationTd.appendChild(info);
    paginationTd.appendChild(nextBtn);
    paginationRow.appendChild(paginationTd);
    tbody.appendChild(paginationRow);
  }
}

/* ── Rate Limits Page ─────────────────────────────────────────── */

async function loadRateLimits() {
  const tr = getTimeRange();

  const results = await Promise.all([
    API.rateLimitsCurrent().catch(function() { return null; }),
    API.rateLimitsHistory({ from: tr.from, to: tr.to }).catch(function() { return []; }),
  ]);
  const current = results[0];
  const history = results[1];

  // Current status
  if (current) {
    const r5 = current.five_hour || {};
    const r7 = current.seven_day || {};

    // 5-hour
    setText('#rl-5h-value', fmtPct(r5.pct || 0));
    const fill5 = $('#rl-5h-fill');
    if (fill5) {
      fill5.style.width = Math.min(r5.pct || 0, 100).toFixed(1) + '%';
      fill5.className = 'progress-fill' + (r5.pct > 80 ? ' danger' : r5.pct > 50 ? ' warn' : '');
    }
    setText('#rl-5h-reset', 'Resets in ' + fmtTimeUntil(r5.resets_at));

    // 7-day
    setText('#rl-7d-value', fmtPct(r7.pct || 0));
    const fill7 = $('#rl-7d-fill');
    if (fill7) {
      fill7.style.width = Math.min(r7.pct || 0, 100).toFixed(1) + '%';
      fill7.className = 'progress-fill' + (r7.pct > 80 ? ' danger' : r7.pct > 50 ? ' warn' : '');
    }
    setText('#rl-7d-reset', 'Resets in ' + fmtTimeUntil(r7.resets_at));

    // Store current pcts for token estimation (used after estimates load)
    state._rl5hPct = r5.pct || 0;
    state._rl7dPct = r7.pct || 0;
  }

  // Token budget estimates & exhaustion prediction
  const estResults = await Promise.all([
    API.rateLimitsEstimates({ window: '5h' }).catch(function() { return null; }),
    API.rateLimitsEstimates({ window: '7d' }).catch(function() { return null; }),
    API.rateLimitsPrediction().catch(function() { return null; }),
  ]);
  const estimates5h = estResults[0];
  const estimates7d = estResults[1];
  const prediction = estResults[2];

  const section = document.getElementById('rl-estimates-section');
  if (section) {
    const hasData = (estimates5h && estimates5h.samples > 0) ||
                  (estimates7d && estimates7d.samples > 0) ||
                  prediction;
    section.style.display = hasData ? '' : 'none';

    // Store caps for chart tooltip use (accessible from charts.js)
    window._rlCap5h = (estimates5h && estimates5h.avg > 0) ? estimates5h.avg : 0;
    window._rlCap7d = (estimates7d && estimates7d.avg > 0) ? estimates7d.avg : 0;

    // Show token usage estimation
    if (estimates5h && estimates5h.avg > 0) {
      const used5h = Math.round((state._rl5hPct || 0) * estimates5h.avg / 100);
      const rem5h = Math.round(estimates5h.avg - used5h);
      setText('#rl-5h-tokens', '~' + fmtTokens(used5h) + ' of ~' + fmtTokens(estimates5h.avg));
      setText('#rl-5h-remaining', '~' + fmtTokens(rem5h) + ' remaining');
    }
    if (estimates7d && estimates7d.avg > 0) {
      const used7d = Math.round((state._rl7dPct || 0) * estimates7d.avg / 100);
      const rem7d = Math.round(estimates7d.avg - used7d);
      setText('#rl-7d-tokens', '~' + fmtTokens(used7d) + ' of ~' + fmtTokens(estimates7d.avg));
      setText('#rl-7d-remaining', '~' + fmtTokens(rem7d) + ' remaining');
    }

    if (estimates5h && estimates5h.samples > 0) {
      setText('#rl-est-5h-avg', fmtTokens(estimates5h.avg));
      setText('#rl-est-5h-range', 'Peak: ' + fmtTokens(estimates5h.max));
      setText('#rl-est-5h-samples', estimates5h.samples + ' windows');
    }

    if (estimates7d && estimates7d.samples > 0) {
      setText('#rl-est-7d-avg', fmtTokens(estimates7d.avg));
      setText('#rl-est-7d-range', 'Peak: ' + fmtTokens(estimates7d.max));
      setText('#rl-est-7d-samples', estimates7d.samples + ' windows');
    }

    if (prediction) {
      const p5 = prediction.five_hour || {};
      const p7 = prediction.seven_day || {};
      const pred5text = p5.minutes_to_100 != null ? fmtDur(p5.minutes_to_100, 'm') : 'Not growing';
      const pred7text = p7.minutes_to_100 != null ? fmtDur(p7.minutes_to_100, 'm') : 'Not growing';
      setText('#rl-pred-5h', pred5text);
      setText('#rl-pred-5h-rate', p5.rate_per_min != null ? p5.rate_per_min.toFixed(3) + '%/min' : 'Rate limit stable');
      setText('#rl-pred-7d', pred7text);
      setText('#rl-pred-7d-rate', p7.rate_per_min != null ? p7.rate_per_min.toFixed(3) + '%/min' : 'Rate limit stable');
    }
  }

  // History chart
  if (!state.charts.rateLimits) {
    state.charts.rateLimits = createRateLimitsChart('chart-ratelimits');
  }
  const rlEmpty = !history || history.length === 0;
  setChartEmpty('chart-ratelimits', rlEmpty);
  if (history && history.length > 0) {
    const labels = history.map(function(r) { return fmtTimeLabel(r.ts); });
    const h5 = history.map(function(r) { return r.rate_5h_pct || 0; });
    const h7 = history.map(function(r) { return r.rate_7d_pct || 0; });
    updateChart(state.charts.rateLimits, labels, [h5, h7]);
  } else {
    updateChart(state.charts.rateLimits, [], [[], []]);
  }
}

/* ── Context Window Page ──────────────────────────────────────── */

function ctxColor(pct) {
  if (pct >= 80) return 'var(--red, #ef6461)';
  if (pct >= 50) return 'var(--amber, #ffaa33)';
  return 'var(--green, #4ade80)';
}

function ctxAccentClass(pct) {
  if (pct >= 80) return 'accent-red';
  if (pct >= 50) return 'accent-yellow';
  return 'accent-green';
}

async function loadContext() {
  const periodMap = { '1h': '1h', '6h': '6h', '1d': '1d', '7d': '7d', '30d': '30d' };
  const period = periodMap[state.timeRange] || '7d';
  const tr = getTimeRange();

  const contextParams = { period: period };
  if (state.currentProject) contextParams.project_id = state.currentProject;
  const sessParams = { limit: 30, from: tr.from, to: tr.to };
  if (state.currentProject) sessParams.project_id = state.currentProject;

  const results = await Promise.all([
    API.contextAnalysis(contextParams).catch(function() { return null; }),
    API.sessions(sessParams).catch(function() { return []; }),
  ]);
  const analysis = results[0];
  const sessions = results[1];

  // (chart removed — table with progress bars is more informative)

  // KPI: Compressions
  const compCount = (analysis && analysis.compressions_count) || 0;
  setText('#ctx-compressions', String(compCount));
  const compDetail = $('#ctx-compressions-detail');
  if (compDetail) {
    compDetail.textContent = compCount === 0
      ? 'No compressions detected'
      : compCount + ' compression' + (compCount > 1 ? 's' : '') + ' in period';
  }

  // KPI: Avg Context Usage (computed from current sessions with ctx data)
  const sessionsWithCtx = (sessions || []).filter(function(s) {
    return s.last_ctx_pct != null && s.last_ctx_pct > 0;
  });
  let avgPct = 0;
  if (sessionsWithCtx.length > 0) {
    let sum = 0;
    sessionsWithCtx.forEach(function(s) { sum += s.last_ctx_pct; });
    avgPct = sum / sessionsWithCtx.length;
  } else if (analysis && analysis.avg_pct) {
    avgPct = analysis.avg_pct;
  }
  setText('#ctx-avg-pct', fmtPct(avgPct));
  const avgEl = $('#ctx-avg-pct');
  if (avgEl) avgEl.className = 'kpi-value ' + ctxAccentClass(avgPct);
  const avgDetail = $('#ctx-avg-detail');
  if (avgDetail) {
    avgDetail.textContent = sessionsWithCtx.length > 0
      ? 'across ' + sessionsWithCtx.length + ' active session' + (sessionsWithCtx.length > 1 ? 's' : '')
      : 'no active sessions';
  }

  // Session table
  renderContextSessions(sessions);
}

function renderContextSessions(sessions) {
  const tbody = $('#ctx-sessions-tbody');
  if (!tbody) return;

  clearChildren(tbody);

  if (!sessions || sessions.length === 0) {
    tbody.appendChild(createEmptyRow(10, 'No sessions in selected period'));
    return;
  }

  // Group by project: keep the session with highest ctx% per project, sum metrics
  // Use separate _total* accumulators to avoid double-counting via Object.assign
  const projMap = {};
  sessions.forEach(function(s) {
    const name = s.project_name || 'unknown';
    const existing = projMap[name];
    if (!existing || (s.last_ctx_pct || 0) > (existing.last_ctx_pct || 0)) {
      // Keep the session with highest context as the "representative"
      projMap[name] = Object.assign({}, s, {
        _session_count: (existing ? existing._session_count : 0) + 1,
        _totalTokensIn: ((existing ? existing._totalTokensIn : 0) || 0) + (s.max_tokens_in || 0),
        _totalTokensOut: ((existing ? existing._totalTokensOut : 0) || 0) + (s.max_tokens_out || 0),
        _totalCost: ((existing ? existing._totalCost : 0) || 0) + (s.max_cost_usd || 0),
        _totalDuration: ((existing ? existing._totalDuration : 0) || 0) + (s.duration_seconds || 0),
        _totalCompressions: ((existing ? existing._totalCompressions : 0) || 0) + (s.compressions || 0),
      });
    } else {
      projMap[name]._session_count = (projMap[name]._session_count || 1) + 1;
      projMap[name]._totalTokensIn = (projMap[name]._totalTokensIn || 0) + (s.max_tokens_in || 0);
      projMap[name]._totalTokensOut = (projMap[name]._totalTokensOut || 0) + (s.max_tokens_out || 0);
      projMap[name]._totalCost = (projMap[name]._totalCost || 0) + (s.max_cost_usd || 0);
      projMap[name]._totalDuration = (projMap[name]._totalDuration || 0) + (s.duration_seconds || 0);
      projMap[name]._totalCompressions = (projMap[name]._totalCompressions || 0) + (s.compressions || 0);
      // Keep higher last_seen_at
      if ((s.last_seen_at || 0) > (projMap[name].last_seen_at || 0)) {
        projMap[name].last_seen_at = s.last_seen_at;
      }
    }
  });
  const grouped = Object.values(projMap);

  // Sort by used% descending — hottest projects first
  grouped.sort(function(a, b) { return (b.last_ctx_pct || 0) - (a.last_ctx_pct || 0); });

  grouped.forEach(function(s) {
    const ctxPct = s.last_ctx_pct || 0;
    const ctxSize = s.last_ctx_size || 0;
    const remaining = ctxSize > 0 ? Math.round(ctxSize * (100 - ctxPct) / 100) : 0;
    const usedTokens = ctxSize > 0 ? Math.round(ctxSize * ctxPct / 100) : 0;
    const color = ctxColor(ctxPct);
    const isActive = s.last_seen_at && (Math.floor(Date.now() / 1000) - s.last_seen_at < 600);

    const tr = document.createElement('tr');

    // Project column: status dot + name
    const tdProj = document.createElement('td');
    const dotSpan = document.createElement('span');
    dotSpan.style.cssText = 'display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:6px;vertical-align:middle;background:' + (isActive ? 'var(--green, #4ade80)' : 'var(--text-muted, #666)');
    tdProj.appendChild(dotSpan);
    const nameSpan = document.createElement('span');
    let projLabel = truncate(s.project_name, 20);
    if (s._session_count > 1) projLabel += ' (' + s._session_count + ')';
    nameSpan.textContent = projLabel;
    nameSpan.title = s.project_name || '';
    tdProj.appendChild(nameSpan);
    tr.appendChild(tdProj);

    // Model column
    const tdModel = document.createElement('td');
    tdModel.style.cssText = 'font-size:0.7rem;color:var(--text-secondary)';
    const modelName = s.model || '--';
    // Shorten model name: "Opus 4.6 (1M context)" → "Opus 4.6"
    tdModel.textContent = modelName.replace(/\s*\(.*\)/, '');
    tr.appendChild(tdModel);

    // Window column
    const tdWin = document.createElement('td');
    tdWin.className = 'cell-mono';
    if (ctxSize > 0) {
      tdWin.textContent = fmtTokens(ctxSize);
    } else {
      tdWin.textContent = '--';
      tdWin.style.color = 'var(--text-muted)';
    }
    tr.appendChild(tdWin);

    // Used column: percentage + inline progress bar + used/total
    const tdUsed = document.createElement('td');
    if (ctxSize > 0) {
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:220px';

      const pctSpan = document.createElement('span');
      pctSpan.style.cssText = 'color:' + color + ';min-width:42px;font-family:var(--font-mono);font-size:0.75rem';
      pctSpan.textContent = fmtPct(ctxPct);
      wrapper.appendChild(pctSpan);

      const barOuter = document.createElement('div');
      barOuter.style.cssText = 'flex:1;height:4px;background:var(--border, #1e293b);border-radius:2px;overflow:hidden;min-width:60px';
      const barInner = document.createElement('div');
      barInner.style.cssText = 'width:' + Math.min(ctxPct, 100) + '%;height:100%;background:' + color + ';border-radius:2px;transition:width 0.5s ease';
      barOuter.appendChild(barInner);
      wrapper.appendChild(barOuter);

      const detailSpan = document.createElement('span');
      detailSpan.style.cssText = 'color:var(--text-muted);font-size:0.65rem;font-family:var(--font-mono);white-space:nowrap';
      detailSpan.textContent = '(' + fmtTokens(usedTokens) + ' / ' + fmtTokens(ctxSize) + ')';
      wrapper.appendChild(detailSpan);

      if (ctxPct >= 80) {
        const warn = document.createElement('span');
        warn.style.cssText = 'font-size:0.6rem;color:var(--red, #ef6461);font-weight:600;white-space:nowrap';
        warn.textContent = 'HIGH';
        wrapper.appendChild(warn);
      }
      tdUsed.appendChild(wrapper);
    } else {
      tdUsed.textContent = '--';
      tdUsed.style.color = 'var(--text-muted)';
    }
    tr.appendChild(tdUsed);

    // Trend column: compare last_ctx_pct vs max_ctx_pct
    const tdTrend = document.createElement('td');
    tdTrend.style.cssText = 'font-size:0.75rem;font-family:var(--font-mono);white-space:nowrap';
    if (ctxPct <= 0) {
      tdTrend.textContent = '--';
      tdTrend.style.color = 'var(--text-muted)';
    } else if (ctxPct >= 80) {
      tdTrend.textContent = '↑ filling';
      tdTrend.style.color = 'var(--red)';
    } else if (ctxPct >= 50) {
      tdTrend.textContent = '→ moderate';
      tdTrend.style.color = 'var(--primary)';
    } else {
      tdTrend.textContent = '→ low';
      tdTrend.style.color = 'var(--green)';
    }
    // Append compression count if any
    const comp = s._totalCompressions || 0;
    if (comp > 0) {
      const compSpan = document.createElement('span');
      compSpan.style.cssText = 'margin-left:6px;font-size:0.6rem;color:var(--amber);opacity:0.8';
      compSpan.textContent = comp + '×↓';
      tdTrend.appendChild(compSpan);
    }
    tr.appendChild(tdTrend);

    // Remaining column
    const tdRem = document.createElement('td');
    tdRem.className = 'cell-right cell-mono';
    if (ctxSize > 0) {
      tdRem.textContent = fmtTokens(remaining);
      if (ctxPct >= 80) tdRem.style.color = 'var(--red, #ef6461)';
    } else {
      tdRem.textContent = '--';
      tdRem.style.color = 'var(--text-muted)';
    }
    tr.appendChild(tdRem);

    // Tokens column (total in+out for session)
    const tdTok = document.createElement('td');
    tdTok.className = 'cell-right cell-mono';
    tdTok.textContent = fmtTokens((s._totalTokensIn || 0) + (s._totalTokensOut || 0));
    tr.appendChild(tdTok);

    // Cost column
    const tdCost = document.createElement('td');
    tdCost.className = 'cell-right cell-mono';
    tdCost.textContent = fmtCost(s._totalCost);
    tr.appendChild(tdCost);

    // Duration column
    const tdDur = document.createElement('td');
    tdDur.className = 'cell-right cell-mono';
    tdDur.textContent = fmtDur(s._totalDuration, 's');
    tr.appendChild(tdDur);

    // Last Seen column
    const tdSeen = document.createElement('td');
    tdSeen.className = 'cell-right';
    tdSeen.textContent = fmtTimeAgo(s.last_seen_at);
    tr.appendChild(tdSeen);

    tbody.appendChild(tr);
  });

  // Total row
  let totalTokens = 0, totalCost = 0, totalDur = 0, totalRemaining = 0;
  sessions.forEach(function(s) {
    totalTokens += (s.max_tokens_in || 0) + (s.max_tokens_out || 0);
    totalCost += s.max_cost_usd || 0;
    totalDur += s.duration_seconds || 0;
    const sz = s.last_ctx_size || 0;
    const pct = s.last_ctx_pct || 0;
    totalRemaining += sz > 0 ? Math.round(sz * (100 - pct) / 100) : 0;
  });
  const tfoot = document.createElement('tr');
  tfoot.className = 'sessions-total';
  // Project
  const tfLabel = document.createElement('td');
  tfLabel.colSpan = 4;
  tfLabel.textContent = 'TOTAL (' + plural(sessions.length, 'session', 'sessions') + ', ' + grouped.length + ' projects)';
  tfoot.appendChild(tfLabel);
  // Trend (skip)
  const tfTrend = document.createElement('td');
  tfTrend.textContent = '';
  tfoot.appendChild(tfTrend);
  // Remaining
  const tfRem = document.createElement('td');
  tfRem.className = 'cell-right';
  tfRem.textContent = fmtTokens(totalRemaining);
  tfoot.appendChild(tfRem);
  // Tokens
  const tfTok = document.createElement('td');
  tfTok.className = 'cell-right';
  tfTok.textContent = fmtTokens(totalTokens);
  tfoot.appendChild(tfTok);
  // Cost
  const tfCost = document.createElement('td');
  tfCost.className = 'cell-right';
  tfCost.textContent = fmtCost(totalCost);
  tfoot.appendChild(tfCost);
  // Duration
  const tfDur = document.createElement('td');
  tfDur.className = 'cell-right';
  tfDur.textContent = fmtDur(totalDur, 's');
  tfoot.appendChild(tfDur);
  // Last Seen (skip)
  const tfSeen = document.createElement('td');
  tfSeen.textContent = '';
  tfoot.appendChild(tfSeen);
  tbody.appendChild(tfoot);
}

/* ── Global Stats Page ────────────────────────────────────────── */

async function loadGlobalStats() {
  const stats = await API.globalStats().catch(function() { return null; });
  if (!stats) return;

  const totalTokens = (stats.total_tokens_in || 0) + (stats.total_tokens_out || 0);
  const totalCache = (stats.total_cache_write || 0) + (stats.total_cache_read || 0);

  // P6: accent-colored stat values
  const elTotalTokens = $('#gs-total-tokens');
  if (elTotalTokens) { elTotalTokens.className = 'stat-value accent-blue'; }
  setText('#gs-total-tokens', fmtTokens(totalTokens));
  setText('#gs-tokens-in', fmtTokens(stats.total_tokens_in));
  setText('#gs-tokens-out', fmtTokens(stats.total_tokens_out));

  const elCacheTotal = $('#gs-cache-total');
  if (elCacheTotal) { elCacheTotal.className = 'stat-value accent-green'; }
  setText('#gs-cache-total', fmtTokens(totalCache));

  const elTotalCost = $('#gs-total-cost');
  if (elTotalCost) { elTotalCost.className = 'stat-value accent-yellow'; }
  setText('#gs-total-cost', fmtCost(stats.total_cost_usd));

  const elDur = $('#gs-total-duration');
  if (elDur) elDur.className = 'stat-value accent-blue';
  setText('#gs-total-duration', fmtDur(stats.total_duration_ms));

  const elTotalSessions = $('#gs-total-sessions');
  if (elTotalSessions) { elTotalSessions.className = 'stat-value accent-purple'; }
  setText('#gs-total-sessions', String(stats.total_sessions || 0));

  setText('#gs-lines-added', '+' + fmtTokens(stats.total_lines_added));
  setText('#gs-lines-removed', '-' + fmtTokens(stats.total_lines_removed));
  const linesCard = document.getElementById('gs-lines-added');
  if (linesCard) { const card = linesCard.closest('.stat-card'); if (card) card.style.borderLeft = '2px solid rgba(255,140,0,0.3)'; }

  const elFirst = $('#gs-first-seen');
  if (elFirst) elFirst.className = 'stat-value accent-green';
  setText('#gs-first-seen', fmtDateTime(stats.first_seen));

  // Last Active: from API response
  const elLast = $('#gs-last-seen');
  if (elLast) elLast.className = 'stat-value accent-blue';
  setText('#gs-last-seen', stats.last_seen ? fmtTimeAgo(stats.last_seen) : '--');

  // Per-project table
  const tbody = $('#global-projects-tbody');
  if (!tbody) return;

  clearChildren(tbody);

  // Use stats.projects if available, otherwise aggregate from sessions API (no N+1)
  let projects = stats.projects || [];
  if (projects.length === 0) {
    const sessions = await API.sessions({ limit: 500 }).catch(function() { return []; });
    const byProject = {};
    sessions.forEach(function(s) {
      const name = s.project_name || 'unknown';
      if (!byProject[name]) byProject[name] = { tokens: 0, cost: 0, sessions: 0, last_active: 0 };
      const p = byProject[name];
      p.tokens += (s.max_tokens_in || 0) + (s.max_tokens_out || 0);
      p.cost += s.max_cost_usd || 0;
      p.sessions++;
      if (s.last_seen_at > p.last_active) p.last_active = s.last_seen_at;
    });
    projects = Object.entries(byProject).map(function(entry) {
      const name = entry[0], d = entry[1];
      return {
        project_name: name,
        total_tokens_in: d.tokens,
        total_cost_usd: d.cost,
        total_sessions: d.sessions,
        last_seen: d.last_active
      };
    });
  }

  if (projects.length === 0) {
    tbody.appendChild(createEmptyRow(5, 'No project data yet'));
    return;
  }

  projects.forEach(function(p) {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.textContent = truncate(p.project_name, 22);
    tr.appendChild(tdName);

    const tdTok = document.createElement('td');
    tdTok.className = 'cell-right';
    tdTok.textContent = fmtTokens((p.total_tokens_in || 0) + (p.total_tokens_out || 0));
    tr.appendChild(tdTok);

    const tdCost = document.createElement('td');
    tdCost.className = 'cell-right';
    tdCost.textContent = fmtCost(p.total_cost_usd);
    tr.appendChild(tdCost);

    const tdSess = document.createElement('td');
    tdSess.className = 'cell-right';
    tdSess.textContent = String(p.total_sessions || 0);
    tr.appendChild(tdSess);

    const tdSeen = document.createElement('td');
    tdSeen.className = 'cell-right';
    tdSeen.textContent = fmtDateTime(p.last_seen);
    tr.appendChild(tdSeen);

    tbody.appendChild(tr);
  });
}

/* ── Data Refresh Router ──────────────────────────────────────── */

async function refreshData() {
  if (state.isRefreshing) {
    state.pendingRefresh = true;
    return;
  }
  state.isRefreshing = true;
  state.pendingRefresh = false;
  resetRefreshRing();
  // Clear error banners from all pages on retry / auto-refresh
  document.querySelectorAll('.error-state').forEach(function(el) { el.remove(); });
  const mainArea = $('.main-area');
  if (mainArea) mainArea.classList.add('loading');
  try {
    switch (state.currentPage) {
      case 'overview':    await loadOverview(); break;
      case 'ratelimits':  await loadRateLimits(); break;
      case 'context':     await loadContext(); break;
      case 'global':      await loadGlobalStats(); break;
    }
  } catch (e) {
    console.error('Refresh failed:', e);
    const pageEl = document.getElementById('page-' + state.currentPage);
    if (pageEl) {
      const existing = pageEl.querySelector('.error-state');
      if (!existing) {
        const errDiv = document.createElement('div');
        errDiv.className = 'error-state';
        errDiv.textContent = 'Failed to load data. ';
        const retrySpan = document.createElement('span');
        retrySpan.className = 'retry-link';
        retrySpan.textContent = 'Retry';
        retrySpan.addEventListener('click', function() {
          errDiv.remove();
          refreshData();
        });
        errDiv.appendChild(retrySpan);
        pageEl.insertBefore(errDiv, pageEl.firstChild);
      }
    }
  } finally {
    state.isRefreshing = false;
    if (mainArea) mainArea.classList.remove('loading');
    startRefreshRing();
    if (state.pendingRefresh) {
      state.pendingRefresh = false;
      refreshData();
    }
  }
}

/* ── Sidebar Toggle (mobile) ──────────────────────────────────── */

function setupSidebar() {
  const toggle = $('.nav-toggle');
  const sidebar = $('.sidebar');
  const overlay = $('.sidebar-overlay');

  if (toggle) {
    toggle.addEventListener('click', function() {
      sidebar.classList.toggle('open');
      overlay.classList.toggle('visible');
    });
  }

  if (overlay) {
    overlay.addEventListener('click', function() {
      sidebar.classList.remove('open');
      overlay.classList.remove('visible');
    });
  }
}

/* ── Time Filter Binding ──────────────────────────────────────── */

function setupTimeFilter() {
  // Restore from localStorage
  const saved = localStorage.getItem('sm_timeRange');
  if (saved && TIME_RANGES[saved]) {
    state.timeRange = saved;
    $$('.time-filter-bar button[data-range]').forEach(function(b) {
      b.classList.toggle('active', b.dataset.range === saved);
    });
  }

  $$('.time-filter-bar button[data-range]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      state.timeRange = btn.dataset.range;
      state.prevKpi = {};
      state.sessionsPage = 0;
      state.barChartPage = 0;
      localStorage.setItem('sm_timeRange', btn.dataset.range);
      $$('.time-filter-bar button[data-range]').forEach(function(b) {
        b.classList.toggle('active', b === btn);
      });
      refreshData();
    });
  });
}

/* ── Nav Binding ──────────────────────────────────────────────── */

function setupNav() {
  $$('.sidebar-nav a[data-page]').forEach(function(a) {
    a.addEventListener('click', function(e) {
      e.preventDefault();
      navigateTo(a.dataset.page);
      // Close sidebar on mobile
      $('.sidebar').classList.remove('open');
      $('.sidebar-overlay').classList.remove('visible');
    });
  });
}

/* ── Polling ──────────────────────────────────────────────────── */

function startPolling() {
  if (state.pollTimer) clearTimeout(state.pollTimer);
  async function poll() {
    if (state.isRefreshing) {
      state.pollTimer = setTimeout(poll, 30000);
      return;
    }
    try {
      await loadProjects();
      await refreshData();
    } catch(e) { /* silent */ }
    state.pollTimer = setTimeout(poll, 30000);
  }
  state.pollTimer = setTimeout(poll, 30000);
}

/* ── 3.5 Keyboard Shortcuts ───────────────────────────────────── */

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', function(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
    if (e.key === '1') navigateTo('overview');
    if (e.key === '2') navigateTo('ratelimits');
    if (e.key === '3') navigateTo('context');
    if (e.key === '4') navigateTo('global');
    if (e.key === 'r' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); refreshData(); }
  });
}

/* ── 3.6 Auto-refresh Progress Ring ──────────────────────────── */

function startRefreshRing() {
  const progress = document.querySelector('.refresh-progress');
  if (!progress) return;
  const totalDash = 50.27;
  let elapsed = 0;
  const intervalMs = 1000;
  const cycleSec = 30;

  if (state.refreshProgressTimer) clearInterval(state.refreshProgressTimer);
  progress.style.strokeDashoffset = String(totalDash);
  elapsed = 0;

  state.refreshProgressTimer = setInterval(function() {
    elapsed++;
    let offset = totalDash - (totalDash * elapsed / cycleSec);
    if (offset < 0) offset = 0;
    progress.style.strokeDashoffset = String(offset);
    if (elapsed >= cycleSec) elapsed = 0;
  }, intervalMs);
}

function resetRefreshRing() {
  const progress = document.querySelector('.refresh-progress');
  if (progress) progress.style.strokeDashoffset = '50.27';
}

/* ── Init ─────────────────────────────────────────────────────── */

async function init() {
  setupSidebar();
  setupTimeFilter();
  setupNav();
  setupKeyboardShortcuts();

  // P7: hashchange listener for manual URL entry only
  window.addEventListener('hashchange', function() {
    const hash = window.location.hash.slice(1);
    const validPages = ['overview', 'ratelimits', 'context', 'global'];
    if (hash && validPages.indexOf(hash) !== -1 && hash !== state.currentPage) {
      navigateTo(hash);
    }
  });

  // ── Account selector ─────────────────────────────────────────
  const accounts = await API.accounts().catch(function() { return []; });
  const current = await API.accountCurrent().catch(function() { return {account: 'default'}; });
  const acctSelect = document.getElementById('account-select');

  function populateAccountSelect(accts, selectedId) {
    clearChildren(acctSelect);
    accts.forEach(function(a) {
      const opt = document.createElement('option');
      opt.value = a.id || a;
      opt.textContent = a.name || a.id || a;
      if ((a.id || a) === selectedId) opt.selected = true;
      acctSelect.appendChild(opt);
    });
  }

  if (acctSelect) {
    populateAccountSelect(accounts, current.account);
    acctSelect.addEventListener('change', async function() {
      try {
        await API.accountSwitch(this.value);
      } catch (e) {
        alert('Failed to switch account: ' + e.message);
        return;
      }
      state.prevKpi = {};
      state.sessionsPage = 0;
      state.barChartPage = 0;
      await loadProjects();
      await refreshData();
    });
  }

  const createBtn = document.getElementById('account-create-btn');
  const createForm = document.getElementById('account-create-form');
  const nameInput = document.getElementById('account-name-input');
  const confirmBtn = document.getElementById('account-confirm-btn');
  const cancelBtn = document.getElementById('account-cancel-btn');

  if (createBtn && createForm && nameInput && confirmBtn && cancelBtn) {
    createBtn.addEventListener('click', function() {
      const visible = createForm.style.display !== 'none';
      createForm.style.display = visible ? 'none' : 'flex';
      if (!visible) { nameInput.value = ''; nameInput.focus(); }
    });

    cancelBtn.addEventListener('click', function() {
      createForm.style.display = 'none';
      nameInput.value = '';
    });

    async function doCreate() {
      const name = nameInput.value.trim().toLowerCase();
      if (!name || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
        nameInput.style.borderColor = 'var(--red)';
        setTimeout(function() { nameInput.style.borderColor = ''; }, 1500);
        return;
      }
      try {
        await API.accountCreate(name);
      } catch (e) {
        nameInput.style.borderColor = 'var(--red)';
        setTimeout(function() { nameInput.style.borderColor = ''; }, 1500);
        return;
      }
      createForm.style.display = 'none';
      nameInput.value = '';
      const accts = await API.accounts().catch(function() { return []; });
      populateAccountSelect(accts, name);
      state.prevKpi = {};
      state.sessionsPage = 0;
      state.barChartPage = 0;
      await loadProjects();
      await refreshData();
    }

    confirmBtn.addEventListener('click', doCreate);
    nameInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') doCreate();
      if (e.key === 'Escape') { createForm.style.display = 'none'; nameInput.value = ''; }
    });
  }

  // ── Rename account ───────────────────────────────────────
  const renameBtn = document.getElementById('account-rename-btn');
  const renameForm = document.getElementById('account-rename-form');
  const renameInput = document.getElementById('account-rename-input');
  const renameConfirm = document.getElementById('account-rename-confirm');
  const renameCancel = document.getElementById('account-rename-cancel');

  if (renameBtn && renameForm && renameInput) {
    renameBtn.addEventListener('click', function() {
      const visible = renameForm.style.display !== 'none';
      renameForm.style.display = visible ? 'none' : 'flex';
      createForm.style.display = 'none';
      if (!visible) {
        const sel = acctSelect.options[acctSelect.selectedIndex];
        renameInput.value = sel ? sel.textContent : '';
        renameInput.focus();
        renameInput.select();
      }
    });

    renameCancel.addEventListener('click', function() {
      renameForm.style.display = 'none';
    });

    async function doRename() {
      const newName = renameInput.value.trim();
      if (!newName || newName.length > 64) {
        renameInput.style.borderColor = 'var(--red)';
        setTimeout(function() { renameInput.style.borderColor = ''; }, 1500);
        return;
      }
      try {
        await API.accountRename(acctSelect.value, newName);
      } catch (e) {
        renameInput.style.borderColor = 'var(--red)';
        setTimeout(function() { renameInput.style.borderColor = ''; }, 1500);
        return;
      }
      renameForm.style.display = 'none';
      const accts = await API.accounts().catch(function() { return []; });
      populateAccountSelect(accts, acctSelect.value);
    }

    renameConfirm.addEventListener('click', doRename);
    renameInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') doRename();
      if (e.key === 'Escape') renameForm.style.display = 'none';
    });
  }

  // Initial load
  await loadProjects();

  // P7: read initial page from hash first, then localStorage
  const hashPage = window.location.hash.replace('#', '');
  const validPages = ['overview', 'ratelimits', 'context', 'global'];
  let startPage;
  if (hashPage && validPages.indexOf(hashPage) !== -1) {
    startPage = hashPage;
  } else {
    startPage = localStorage.getItem('sm_page') || 'overview';
  }
  navigateTo(startPage);

  // Start polling
  startPolling();

  // 3.6: Start refresh ring animation
  startRefreshRing();

  // Fetch version from server
  API.health().then(function(h) {
    if (h && h.version) {
      const el = document.getElementById('sidebar-version');
      if (el) el.textContent = 'v' + h.version;
    }
  }).catch(function() {});

  // Fetch GitHub stars (non-blocking, best-effort, 5-min localStorage cache)
  const cached = localStorage.getItem('sm_gh_stars');
  const cacheTs = parseInt(localStorage.getItem('sm_gh_stars_ts') || '0', 10);
  if (cached && Date.now() - cacheTs < 300000) {
    const starsEl = document.getElementById('github-stars-count');
    if (starsEl) starsEl.textContent = cached;
  } else {
    const ctrl = new AbortController();
    const tid = setTimeout(function() { ctrl.abort(); }, 5000);
    fetch('https://api.github.com/repos/' + GITHUB_REPO, { signal: ctrl.signal })
      .then(function(r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function(d) {
        if (d && typeof d.stargazers_count === 'number') {
          const starsEl = document.getElementById('github-stars-count');
          const formatted = fmtCount(d.stargazers_count);
          if (starsEl) starsEl.textContent = formatted;
          localStorage.setItem('sm_gh_stars', formatted);
          localStorage.setItem('sm_gh_stars_ts', String(Date.now()));
        }
      })
      .catch(function() {})
      .finally(function() { clearTimeout(tid); });
  }
}

// Wait for DOM and Chart.js (with retry for CDN fallback race)
document.addEventListener('DOMContentLoaded', function() {
  let initRetries = 0;
  function tryInit() {
    if (typeof Chart !== 'undefined') {
      init();
    } else if (initRetries++ < 20) {
      setTimeout(tryInit, 500);
    }
  }
  tryInit();
});
