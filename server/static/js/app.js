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
};

/* ── Time Range Definitions (seconds) ─────────────────────────── */

const TIME_RANGES = {
  '1h':  3600,
  '6h':  21600,
  '1d':  86400,
  '7d':  604800,
  '30d': 2592000,
};

/* ── Formatting Helpers ───────────────────────────────────────── */

function fmtTokens(n) {
  if (n == null || isNaN(n) || n <= 0) return '0';
  n = Math.round(n);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 100) return (n / 1_000).toFixed(1) + 'k';
  return '<0.1k';
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return '0%';
  return n.toFixed(1) + '%';
}

function fmtDuration(ms) {
  if (!ms || ms <= 0) return '0m';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + 'm';
  return totalSec + 's';
}

function fmtMin(minutes) {
  if (minutes == null || minutes <= 0) return '0m';
  minutes = Math.round(minutes);
  var d = Math.floor(minutes / 1440);
  var h = Math.floor((minutes % 1440) / 60);
  var m = minutes % 60;
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

function fmtDurationSec(sec) {
  if (!sec || sec <= 0) return '0m';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + 'm';
  return sec + 's';
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

/**
 * Escape HTML special characters to prevent XSS when inserting
 * into the DOM via innerHTML (data comes from our own local API,
 * but defense-in-depth is always good practice).
 */
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ── DOM Helpers ──────────────────────────────────────────────── */

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }
function setText(sel, text) {
  var el = typeof sel === 'string' ? $(sel) : sel;
  if (el) el.textContent = text;
}

/* ── Animated Counter (P1) ───────────────────────────────────── */

function animateValue(el, from, to, duration) {
  if (!el || from === to) return;
  duration = duration || 600;
  var start = performance.now();
  var fmt = el.dataset.format || 'tokens';
  function step(now) {
    var progress = Math.min((now - start) / duration, 1);
    var ease = 1 - Math.pow(1 - progress, 3); // easeOutCubic
    var current = from + (to - from) * ease;
    if (fmt === 'pct') el.textContent = fmtPct(current);
    else if (fmt === 'int') el.textContent = String(Math.round(current));
    else el.textContent = fmtTokens(current);
    if (progress < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function setKpiValue(sel, rawValue, formatType) {
  var el = typeof sel === 'string' ? $(sel) : sel;
  if (!el) return;
  var oldRaw = parseFloat(el.dataset.rawValue) || 0;
  el.dataset.rawValue = String(rawValue);
  el.dataset.format = formatType || 'tokens';
  if (oldRaw !== rawValue) {
    animateValue(el, oldRaw, rawValue, 600);
    /* Sci-fi data-flicker on parent card */
    var card = el.closest('.kpi-card') || el.closest('.stat-card');
    if (card) {
      card.classList.remove('data-update');
      void card.offsetWidth; /* force reflow */
      card.classList.add('data-update');
      setTimeout(function() { card.classList.remove('data-update'); }, 500);
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
  var el = document.getElementById(trendId);
  if (!el) return;
  if (!(key in state.prevKpi)) {
    // First render -- store value but do not show badge
    state.prevKpi[key] = currentValue;
    el.className = 'kpi-trend neutral';
    el.textContent = '';
    return;
  }
  var prev = state.prevKpi[key];
  var delta = currentValue - prev;
  state.prevKpi[key] = currentValue;
  if (delta === 0) {
    el.className = 'kpi-trend neutral';
    el.textContent = '';
    return;
  }
  var sign = delta > 0 ? '+' : '';
  var arrow = delta > 0 ? '\u2191' : '\u2193';
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
  var titles = {
    overview: 'Overview',
    ratelimits: 'Rate Limits',
    context: 'Context Window',
    global: 'Global Statistics',
  };
  setText('#page-title', titles[page] || 'Overview');

  // 3.7: Page subtitle
  updateSubtitle();

  // Show time filter on all pages
  var filterBar = $('.time-filter-bar');
  if (filterBar) filterBar.style.display = '';

  // Load page data
  refreshData();
}

function updateSubtitle() {
  var subtitles = {
    overview: 'Real-time token usage and session activity',
    ratelimits: state.currentProject ? 'Account-wide data (project filter not applicable)' : 'API rate limit consumption and predictions',
    context: 'Context window utilization across sessions',
    global: 'Lifetime aggregated statistics',
  };
  setText('#page-subtitle', subtitles[state.currentPage] || '');
}

function selectProject(projectId) {
  state.currentProject = projectId;

  // Update sidebar active
  $$('.sidebar-projects a').forEach(function(a) {
    var isAll = a.dataset.pid === '';
    var isMatch = projectId === null ? isAll : a.dataset.pid === projectId;
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
    var projects = await API.projects();
    state.projects = projects;
    renderProjectList(projects);
  } catch (e) {
    console.error('Failed to load projects:', e);
    showError('project-list', e.message);
  }
}

function renderProjectList(projects) {
  var container = $('#project-list');
  if (!container) return;

  // Clear existing children
  while (container.firstChild) container.removeChild(container.firstChild);

  // "All Projects" item always first
  var allLink = document.createElement('a');
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
    var empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.style.padding = '16px';
    var desc = document.createElement('div');
    desc.className = 'empty-desc';
    desc.textContent = 'No projects yet';
    empty.appendChild(desc);
    container.appendChild(empty);
    return;
  }

  projects.sort(function(a, b) { return (a.project_name || '').localeCompare(b.project_name || ''); });

  projects.forEach(function(p) {
    var a = document.createElement('a');
    a.dataset.pid = p.project_id;
    a.title = p.project_name || '';
    if (p.project_id === state.currentProject) a.className = 'active';
    a.textContent = truncate(p.project_name, 20) + ' ';
    var span = document.createElement('span');
    span.className = 'project-sessions';
    span.textContent = plural(p.sessions_count || 0, 'sess', 'sess');
    a.appendChild(span);
    a.addEventListener('click', function(e) {
      e.preventDefault();
      var pid = p.project_id;
      selectProject(pid === state.currentProject ? null : pid);
    });
    container.appendChild(a);
  });
}

/* ── Overview Page ────────────────────────────────────────────── */

async function loadOverview() {
  var tr = getTimeRange();

  // Build sessions query with optional project filter (C2) + time range
  var sessionsParams = { limit: 20, from: tr.from, to: tr.to };
  if (state.currentProject !== null) {
    sessionsParams.project_id = state.currentProject;
  }

  // Load multiple endpoints in parallel
  var results = await Promise.all([
    API.rateLimitsCurrent().catch(function() { return null; }),
    API.sessions(sessionsParams).catch(function() { return []; }),
    API.health().catch(function() { return null; }),
  ]);
  var rateLimits = results[0];
  var sessions = results[1];
  var health = results[2];

  // If a project is selected, load project-specific data
  var projectSummary = null;
  var timeseries = [];
  var allSummaries = [];
  var pid = state.currentProject || (state.projects.length > 0 ? state.projects[0].project_id : null);

  if (state.currentProject !== null && pid) {
    // Single project selected
    var pResults = await Promise.all([
      API.projectSummary(pid, { from: tr.from, to: tr.to }).catch(function() { return null; }),
      API.metrics({ project_id: pid, from: tr.from, to: tr.to, interval: getInterval() }).catch(function() { return []; }),
    ]);
    projectSummary = pResults[0];
    timeseries = pResults[1];
    allSummaries = [projectSummary];
  } else if (state.projects.length > 0) {
    // All Projects: aggregate summaries from every project
    allSummaries = await Promise.all(
      state.projects.map(function(p) {
        return API.projectSummary(p.project_id, { from: tr.from, to: tr.to }).catch(function() { return null; });
      })
    );
    projectSummary = {
      tokens_in: 0, tokens_out: 0, cache_write: 0, cache_read: 0,
      total_tokens: 0, cost_usd: 0, duration_ms: 0, sessions: 0, avg_ctx_pct: 0,
    };
    var ctxCount = 0;
    allSummaries.forEach(function(s) {
      if (!s) return;
      projectSummary.tokens_in += s.tokens_in || 0;
      projectSummary.tokens_out += s.tokens_out || 0;
      projectSummary.cache_write += s.cache_write || 0;
      projectSummary.cache_read += s.cache_read || 0;
      projectSummary.total_tokens += s.total_tokens || 0;
      projectSummary.cost_usd += s.cost_usd || 0;
      projectSummary.duration_ms += s.duration_ms || 0;
      projectSummary.sessions += s.sessions || 0;
      if (s.avg_ctx_pct > 0) { projectSummary.avg_ctx_pct += s.avg_ctx_pct; ctxCount++; }
    });
    if (ctxCount > 0) projectSummary.avg_ctx_pct /= ctxCount;

    // Timeseries: use first project as representative for chart
    timeseries = await API.metrics({
      project_id: state.projects[0].project_id,
      from: tr.from, to: tr.to, interval: getInterval(),
    }).catch(function() { return []; });
  }

  // KPI Cards
  updateKpiCards(projectSummary, rateLimits, health);

  setText('#tokens-chart-title', 'Tokens Timeline');

  // Charts
  updateTokensTimeline(timeseries);
  var barProjects = state.currentProject !== null
    ? [{ project_name: (state.projects.find(function(p) { return p.project_id === state.currentProject; }) || {}).project_name || state.currentProject }]
    : state.projects;
  updateProjectsBarChart(allSummaries, barProjects);

  // Sessions table
  renderSessionsTable(sessions);
  setText('#sessions-title', state.timeRange === '30d' || !state.timeRange ? 'Sessions' : 'Sessions (lifetime per session)');

  // Update timestamp
  state.lastUpdate = Date.now();
  setText('.last-update', 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
}

function updateKpiCards(summary, rateLimits, health) {
  if (summary) {
    var totalTokens = (summary.tokens_in || 0) + (summary.tokens_out || 0);
    var totalCache = (summary.cache_write || 0) + (summary.cache_read || 0);
    var cacheHit = totalCache > 0
      ? ((summary.cache_read || 0) / totalCache * 100).toFixed(0)
      : 0;

    setKpiValue('#kpi-tokens-value', totalTokens, 'tokens');
    setText('#kpi-tokens-detail', 'In: ' + fmtTokens(summary.tokens_in) + ' / Out: ' + fmtTokens(summary.tokens_out));

    setKpiValue('#kpi-cache-value', totalCache, 'tokens');
    setText('#kpi-cache-detail', 'W:' + fmtTokens(summary.cache_write) + ' R:' + fmtTokens(summary.cache_read) + ' ' + cacheHit + '%hit');
  }

  if (rateLimits) {
    var r5 = rateLimits.five_hour || {};
    var r7 = rateLimits.seven_day || {};
    var pct5 = r5.pct || 0;
    var pct7 = r7.pct || 0;

    setKpiValue('#kpi-rate5h-value', pct5, 'pct');
    var el5 = $('#kpi-rate5h-value');
    if (el5) el5.className = 'kpi-value ' + (pct5 > 70 ? 'accent-red' : pct5 > 30 ? 'accent-yellow' : 'accent-green');
    setText('#kpi-rate5h-detail', 'resets in ' + fmtTimeUntil(r5.resets_at));

    setKpiValue('#kpi-rate7d-value', pct7, 'pct');
    var el7 = $('#kpi-rate7d-value');
    if (el7) el7.className = 'kpi-value ' + (pct7 > 70 ? 'accent-red' : pct7 > 30 ? 'accent-yellow' : 'accent-green');
    setText('#kpi-rate7d-detail', 'resets in ' + fmtTimeUntil(r7.resets_at));
  }

  if (summary) {
    var ctxPct = summary.avg_ctx_pct || 0;
    setKpiValue('#kpi-context-value', ctxPct, 'pct');
    var elCtx = $('#kpi-context-value');
    if (elCtx) elCtx.className = 'kpi-value ' + (ctxPct > 80 ? 'accent-red' : ctxPct > 50 ? 'accent-yellow' : 'accent-green');
    var sessCount = summary.sessions || 0;
    setText('#kpi-context-detail', plural(sessCount, 'session tracked', 'sessions tracked'));
  }

  if (health) {
    setKpiValue('#kpi-active-value', health.active_sessions || 0, 'int');
    var elActive = $('#kpi-active-value');
    if (elActive) elActive.className = 'kpi-value accent-purple';
    var recCount = health.total_records || 0;
    setText('#kpi-active-detail', plural(recCount, 'total record', 'total records'));

    // P3: Live pulse indicator
    var pulseLive = $('#pulse-live');
    if (pulseLive) {
      pulseLive.classList.toggle('visible', (health.active_sessions || 0) > 0);
    }
  }

  // 3.1: KPI Trend badges
  if (summary) {
    var totalTokensTrend = (summary.tokens_in || 0) + (summary.tokens_out || 0);
    var totalCacheTrend = (summary.cache_write || 0) + (summary.cache_read || 0);
    updateKpiTrend('kpi-tokens-trend', 'tokens', totalTokensTrend);
    updateKpiTrend('kpi-cache-trend', 'cache', totalCacheTrend);
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
  var container = document.getElementById(containerId);
  if (!container) return;
  while (container.firstChild) container.removeChild(container.firstChild);
  var div = document.createElement('div');
  div.className = 'error-state';
  div.textContent = 'Failed to load data. ';
  var retry = document.createElement('span');
  retry.className = 'retry-link';
  retry.textContent = 'Retry';
  retry.addEventListener('click', function() {
    while (container.firstChild) container.removeChild(container.firstChild);
    refreshData();
  });
  div.appendChild(retry);
  container.appendChild(div);
}

function setChartEmpty(canvasId, empty) {
  var container = document.getElementById(canvasId);
  if (!container) return;
  container = container.closest('.chart-container');
  if (!container) return;
  var msg = container.querySelector('.chart-empty');
  if (empty && !msg) {
    var el = document.createElement('div');
    el.className = 'chart-empty';
    // C3: contextual empty message
    var hasFilter = state.currentProject !== null || state.timeRange !== '1d';
    el.textContent = hasFilter ? 'No data for this time range' : 'Collecting data\u2026';
    container.appendChild(el);
  } else if (empty && msg) {
    // Update text if already exists (range/filter may have changed)
    var hasFilter2 = state.currentProject !== null || state.timeRange !== '1d';
    msg.textContent = hasFilter2 ? 'No data for this time range' : 'Collecting data\u2026';
  } else if (!empty && msg) {
    msg.remove();
  }
  var canvas = container.querySelector('canvas');
  if (canvas) canvas.style.opacity = empty ? '0.15' : '1';
}

function updateTokensTimeline(timeseries) {
  if (!state.charts.tokens) {
    state.charts.tokens = createTokensChart('chart-tokens');
  }
  var empty = !timeseries || timeseries.length === 0;
  setChartEmpty('chart-tokens', empty);
  if (empty) {
    updateChart(state.charts.tokens, [], [[], []]);
    return;
  }
  var labels = timeseries.map(function(r) { return fmtTimeLabel(r.bucket_ts); });
  var tokensIn = timeseries.map(function(r) { return r.tokens_in || 0; });
  var tokensOut = timeseries.map(function(r) { return r.tokens_out || 0; });
  updateChart(state.charts.tokens, labels, [tokensIn, tokensOut]);
}

function updateProjectsBarChart(summaries, projectsList) {
  if (!state.charts.breakdown) {
    state.charts.breakdown = createProjectsBarChart('chart-breakdown');
  }
  var chart = state.charts.breakdown;
  if (!chart) return;

  var projects = projectsList || state.projects || [];
  if (projects.length === 0) {
    chart.data.labels = [];
    chart.data.datasets[0].data = [];
    chart.update();
    setChartEmpty('chart-breakdown', true);
    return;
  }

  var labels = [];
  var data = [];
  projects.forEach(function(p, i) {
    var s = summaries ? summaries[i] : null;
    var tokens = s ? ((s.tokens_in || 0) + (s.tokens_out || 0)) : 0;
    if (tokens > 0) {
      labels.push(truncate(p.project_name, 18));
      data.push(tokens);
    }
  });

  // Sort by tokens descending
  var indices = data.map(function(_, i) { return i; });
  indices.sort(function(a, b) { return data[b] - data[a]; });
  var sortedLabels = indices.map(function(i) { return labels[i]; });
  var sortedData = indices.map(function(i) { return data[i]; });

  var empty = sortedData.length === 0;
  setChartEmpty('chart-breakdown', empty);

  chart.data.labels = sortedLabels;
  chart.data.datasets[0].data = sortedData;
  chart.update();
}

function renderSessionsTable(sessions) {
  var tbody = $('#sessions-tbody');
  if (!tbody) return;

  // Clear existing rows
  while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

  if (!sessions || sessions.length === 0) {
    var tr = document.createElement('tr');
    var td = document.createElement('td');
    td.colSpan = 5;
    td.style.textAlign = 'center';
    td.style.color = 'var(--text-muted)';
    td.style.padding = '24px';
    td.textContent = 'No sessions found';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  var nowTs = Math.floor(Date.now() / 1000);
  sessions.forEach(function(s) {
    var tr = document.createElement('tr');

    var tdProj = document.createElement('td');
    var dot = document.createElement('span');
    var seenDiff = s.last_seen_at ? (nowTs - s.last_seen_at) : Infinity;
    dot.className = 'status-dot ' + (seenDiff < 300 ? 'active' : 'idle');
    tdProj.appendChild(dot);
    tdProj.appendChild(document.createTextNode(truncate(s.project_name, 20)));
    tr.appendChild(tdProj);

    var tdModel = document.createElement('td');
    tdModel.textContent = s.model || '--';
    tr.appendChild(tdModel);

    var tdDur = document.createElement('td');
    tdDur.className = 'cell-right';
    tdDur.textContent = fmtDurationSec(s.duration_seconds);
    tr.appendChild(tdDur);

    var tdTok = document.createElement('td');
    tdTok.className = 'cell-right';
    tdTok.textContent = fmtTokens((s.max_tokens_in || 0) + (s.max_tokens_out || 0));
    tr.appendChild(tdTok);

    var tdCost = document.createElement('td');
    tdCost.className = 'cell-right';
    tdCost.textContent = fmtCost(s.max_cost_usd);
    tr.appendChild(tdCost);

    tbody.appendChild(tr);
  });

  // Total row
  var totalTokens = 0, totalCost = 0, totalDur = 0;
  sessions.forEach(function(s) {
    totalTokens += (s.max_tokens_in || 0) + (s.max_tokens_out || 0);
    totalCost += s.max_cost_usd || 0;
    totalDur += s.duration_seconds || 0;
  });
  var tfoot = document.createElement('tr');
  tfoot.className = 'sessions-total';
  var tfLabel = document.createElement('td');
  tfLabel.colSpan = 2;
  tfLabel.textContent = 'TOTAL (' + plural(sessions.length, 'session', 'sessions') + ')';
  tfoot.appendChild(tfLabel);
  var tfDur = document.createElement('td');
  tfDur.className = 'cell-right';
  tfDur.textContent = fmtDurationSec(totalDur);
  tfoot.appendChild(tfDur);
  var tfTok = document.createElement('td');
  tfTok.className = 'cell-right';
  tfTok.textContent = fmtTokens(totalTokens);
  tfoot.appendChild(tfTok);
  var tfCost = document.createElement('td');
  tfCost.className = 'cell-right';
  tfCost.textContent = fmtCost(totalCost);
  tfoot.appendChild(tfCost);
  tbody.appendChild(tfoot);
}

/* ── Rate Limits Page ─────────────────────────────────────────── */

async function loadRateLimits() {
  var tr = getTimeRange();

  var results = await Promise.all([
    API.rateLimitsCurrent().catch(function() { return null; }),
    API.rateLimitsHistory({ from: tr.from, to: tr.to }).catch(function() { return []; }),
  ]);
  var current = results[0];
  var history = results[1];

  // Current status
  if (current) {
    var r5 = current.five_hour || {};
    var r7 = current.seven_day || {};

    // 5-hour
    setText('#rl-5h-value', fmtPct(r5.pct || 0));
    var fill5 = $('#rl-5h-fill');
    if (fill5) {
      fill5.style.width = Math.min(r5.pct || 0, 100).toFixed(1) + '%';
      fill5.className = 'progress-fill' + (r5.pct > 80 ? ' danger' : r5.pct > 50 ? ' warn' : '');
    }
    setText('#rl-5h-reset', 'Resets in ' + fmtTimeUntil(r5.resets_at));

    // 7-day
    setText('#rl-7d-value', fmtPct(r7.pct || 0));
    var fill7 = $('#rl-7d-fill');
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
  var estResults = await Promise.all([
    API.rateLimitsEstimates({ window: '5h' }).catch(function() { return null; }),
    API.rateLimitsEstimates({ window: '7d' }).catch(function() { return null; }),
    API.rateLimitsPrediction().catch(function() { return null; }),
  ]);
  var estimates5h = estResults[0];
  var estimates7d = estResults[1];
  var prediction = estResults[2];

  var section = document.getElementById('rl-estimates-section');
  if (section) {
    var hasData = (estimates5h && estimates5h.samples > 0) ||
                  (estimates7d && estimates7d.samples > 0) ||
                  prediction;
    section.style.display = hasData ? '' : 'none';

    // Show token usage estimation
    if (estimates5h && estimates5h.avg > 0) {
      var used5h = Math.round((state._rl5hPct || 0) * estimates5h.avg / 100);
      var rem5h = Math.round(estimates5h.avg - used5h);
      setText('#rl-5h-tokens', '~' + fmtTokens(used5h) + ' of ~' + fmtTokens(estimates5h.avg));
      setText('#rl-5h-remaining', '~' + fmtTokens(rem5h) + ' remaining');
    }
    if (estimates7d && estimates7d.avg > 0) {
      var used7d = Math.round((state._rl7dPct || 0) * estimates7d.avg / 100);
      var rem7d = Math.round(estimates7d.avg - used7d);
      setText('#rl-7d-tokens', '~' + fmtTokens(used7d) + ' of ~' + fmtTokens(estimates7d.avg));
      setText('#rl-7d-remaining', '~' + fmtTokens(rem7d) + ' remaining');
    }

    if (estimates5h && estimates5h.samples > 0) {
      setText('#rl-est-5h-avg', fmtTokens(estimates5h.avg));
      setText('#rl-est-5h-range', 'Min: ' + fmtTokens(estimates5h.min) + ' / Max: ' + fmtTokens(estimates5h.max));
      setText('#rl-est-5h-samples', estimates5h.samples + ' samples');
    }

    if (estimates7d && estimates7d.samples > 0) {
      setText('#rl-est-7d-avg', fmtTokens(estimates7d.avg));
      setText('#rl-est-7d-range', 'Min: ' + fmtTokens(estimates7d.min) + ' / Max: ' + fmtTokens(estimates7d.max));
      setText('#rl-est-7d-samples', estimates7d.samples + ' samples');
    }

    if (prediction) {
      var p5 = prediction.five_hour || {};
      var p7 = prediction.seven_day || {};
      var pred5text = p5.minutes_to_100 != null ? fmtMin(p5.minutes_to_100) : 'Not growing';
      var pred7text = p7.minutes_to_100 != null ? fmtMin(p7.minutes_to_100) : 'Not growing';
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
  var rlEmpty = !history || history.length === 0;
  setChartEmpty('chart-ratelimits', rlEmpty);
  if (history && history.length > 0) {
    var labels = history.map(function(r) { return fmtTimeLabel(r.ts); });
    var h5 = history.map(function(r) { return r.rate_5h_pct || 0; });
    var h7 = history.map(function(r) { return r.rate_7d_pct || 0; });
    updateChart(state.charts.rateLimits, labels, [h5, h7]);
  } else {
    updateChart(state.charts.rateLimits, [], [[], []]);
  }
}

/* ── Context Window Page ──────────────────────────────────────── */

function ctxColor(pct) {
  if (pct >= 80) return 'var(--red, #ef6461)';
  if (pct >= 50) return 'var(--yellow, #ff8c00)';
  return 'var(--green, #4ade80)';
}

function ctxAccentClass(pct) {
  if (pct >= 80) return 'accent-red';
  if (pct >= 50) return 'accent-yellow';
  return 'accent-green';
}

async function loadContext() {
  var periodMap = { '1h': '1h', '6h': '6h', '1d': '1d', '7d': '7d', '30d': '30d' };
  var period = periodMap[state.timeRange] || '7d';
  var tr = getTimeRange();

  var contextParams = { period: period };
  if (state.currentProject) contextParams.project_id = state.currentProject;
  var sessParams = { limit: 30, from: tr.from, to: tr.to };
  if (state.currentProject) sessParams.project_id = state.currentProject;

  var results = await Promise.all([
    API.contextAnalysis(contextParams).catch(function() { return null; }),
    API.sessions(sessParams).catch(function() { return []; }),
  ]);
  var analysis = results[0];
  var sessions = results[1];

  // (chart removed — table with progress bars is more informative)

  // KPI: Compressions
  var compCount = (analysis && analysis.compressions_count) || 0;
  setText('#ctx-compressions', String(compCount));
  var compDetail = $('#ctx-compressions-detail');
  if (compDetail) {
    compDetail.textContent = compCount === 0
      ? 'No compressions detected'
      : compCount + ' compression' + (compCount > 1 ? 's' : '') + ' in period';
  }

  // KPI: Avg Context Usage (computed from current sessions with ctx data)
  var sessionsWithCtx = (sessions || []).filter(function(s) {
    return s.last_ctx_pct != null && s.last_ctx_pct > 0;
  });
  var avgPct = 0;
  if (sessionsWithCtx.length > 0) {
    var sum = 0;
    sessionsWithCtx.forEach(function(s) { sum += s.last_ctx_pct; });
    avgPct = sum / sessionsWithCtx.length;
  } else if (analysis && analysis.avg_pct) {
    avgPct = analysis.avg_pct;
  }
  setText('#ctx-avg-pct', fmtPct(avgPct));
  var avgEl = $('#ctx-avg-pct');
  if (avgEl) avgEl.className = 'kpi-value ' + ctxAccentClass(avgPct);
  var avgDetail = $('#ctx-avg-detail');
  if (avgDetail) {
    avgDetail.textContent = sessionsWithCtx.length > 0
      ? 'across ' + sessionsWithCtx.length + ' active session' + (sessionsWithCtx.length > 1 ? 's' : '')
      : 'no active sessions';
  }

  // Session table
  renderContextSessions(sessions);
}

function renderContextSessions(sessions) {
  var tbody = $('#ctx-sessions-tbody');
  if (!tbody) return;

  while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

  if (!sessions || sessions.length === 0) {
    var row = document.createElement('tr');
    var td = document.createElement('td');
    td.colSpan = 10;
    td.style.textAlign = 'center';
    td.style.color = 'var(--text-muted)';
    td.style.padding = '24px';
    td.textContent = 'No sessions in selected period';
    row.appendChild(td);
    tbody.appendChild(row);
    return;
  }

  // Sort by used% descending — hottest sessions first
  sessions.sort(function(a, b) { return (b.last_ctx_pct || 0) - (a.last_ctx_pct || 0); });

  sessions.forEach(function(s) {
    var ctxPct = s.last_ctx_pct || 0;
    var ctxSize = s.last_ctx_size || 0;
    var remaining = ctxSize > 0 ? Math.round(ctxSize * (100 - ctxPct) / 100) : 0;
    var usedTokens = ctxSize > 0 ? Math.round(ctxSize * ctxPct / 100) : 0;
    var color = ctxColor(ctxPct);
    var isActive = s.last_seen_at && (Math.floor(Date.now() / 1000) - s.last_seen_at < 600);

    var tr = document.createElement('tr');

    // Project column: status dot + name
    var tdProj = document.createElement('td');
    var dotSpan = document.createElement('span');
    dotSpan.style.cssText = 'display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:6px;vertical-align:middle;background:' + (isActive ? 'var(--green, #4ade80)' : 'var(--text-muted, #666)');
    tdProj.appendChild(dotSpan);
    var nameSpan = document.createElement('span');
    nameSpan.textContent = truncate(s.project_name, 20);
    nameSpan.title = s.project_name || '';
    tdProj.appendChild(nameSpan);
    tr.appendChild(tdProj);

    // Model column
    var tdModel = document.createElement('td');
    tdModel.style.cssText = 'font-size:0.7rem;color:var(--text-secondary)';
    var modelName = s.model || '--';
    // Shorten model name: "Opus 4.6 (1M context)" → "Opus 4.6"
    tdModel.textContent = modelName.replace(/\s*\(.*\)/, '');
    tr.appendChild(tdModel);

    // Window column
    var tdWin = document.createElement('td');
    tdWin.className = 'cell-mono';
    if (ctxSize > 0) {
      tdWin.textContent = fmtTokens(ctxSize);
    } else {
      tdWin.textContent = '--';
      tdWin.style.color = 'var(--text-muted)';
    }
    tr.appendChild(tdWin);

    // Used column: percentage + inline progress bar + used/total
    var tdUsed = document.createElement('td');
    if (ctxSize > 0) {
      var wrapper = document.createElement('div');
      wrapper.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:220px';

      var pctSpan = document.createElement('span');
      pctSpan.style.cssText = 'color:' + color + ';min-width:42px;font-family:var(--font-mono);font-size:0.75rem';
      pctSpan.textContent = fmtPct(ctxPct);
      wrapper.appendChild(pctSpan);

      var barOuter = document.createElement('div');
      barOuter.style.cssText = 'flex:1;height:4px;background:var(--border, #1e293b);border-radius:2px;overflow:hidden;min-width:60px';
      var barInner = document.createElement('div');
      barInner.style.cssText = 'width:' + Math.min(ctxPct, 100) + '%;height:100%;background:' + color + ';border-radius:2px;transition:width 0.5s ease';
      barOuter.appendChild(barInner);
      wrapper.appendChild(barOuter);

      var detailSpan = document.createElement('span');
      detailSpan.style.cssText = 'color:var(--text-muted);font-size:0.65rem;font-family:var(--font-mono);white-space:nowrap';
      detailSpan.textContent = '(' + fmtTokens(usedTokens) + ' / ' + fmtTokens(ctxSize) + ')';
      wrapper.appendChild(detailSpan);

      if (ctxPct >= 80) {
        var warn = document.createElement('span');
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
    var tdTrend = document.createElement('td');
    tdTrend.style.cssText = 'font-size:0.75rem;font-family:var(--font-mono);white-space:nowrap';
    var maxPct = s.max_ctx_pct || 0;
    if (ctxPct <= 0) {
      tdTrend.textContent = '--';
      tdTrend.style.color = 'var(--text-muted)';
    } else if (ctxPct < maxPct - 15) {
      // ctx dropped significantly from max → compression happened
      tdTrend.textContent = '↓ compressed';
      tdTrend.style.color = 'var(--yellow)';
    } else if (ctxPct >= 70) {
      tdTrend.textContent = '↑ filling';
      tdTrend.style.color = 'var(--red)';
    } else if (ctxPct >= 40) {
      tdTrend.textContent = '→ moderate';
      tdTrend.style.color = 'var(--cyan)';
    } else {
      tdTrend.textContent = '→ low';
      tdTrend.style.color = 'var(--green)';
    }
    tr.appendChild(tdTrend);

    // Remaining column
    var tdRem = document.createElement('td');
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
    var tdTok = document.createElement('td');
    tdTok.className = 'cell-right cell-mono';
    tdTok.textContent = fmtTokens((s.max_tokens_in || 0) + (s.max_tokens_out || 0));
    tr.appendChild(tdTok);

    // Cost column
    var tdCost = document.createElement('td');
    tdCost.className = 'cell-right cell-mono';
    tdCost.textContent = fmtCost(s.max_cost_usd);
    tr.appendChild(tdCost);

    // Duration column
    var tdDur = document.createElement('td');
    tdDur.className = 'cell-right cell-mono';
    tdDur.textContent = fmtDurationSec(s.duration_seconds);
    tr.appendChild(tdDur);

    // Last Seen column
    var tdSeen = document.createElement('td');
    tdSeen.className = 'cell-right';
    tdSeen.textContent = fmtTimeAgo(s.last_seen_at);
    tr.appendChild(tdSeen);

    tbody.appendChild(tr);
  });

  // Total row
  var totalTokens = 0, totalCost = 0, totalDur = 0, totalRemaining = 0;
  sessions.forEach(function(s) {
    totalTokens += (s.max_tokens_in || 0) + (s.max_tokens_out || 0);
    totalCost += s.max_cost_usd || 0;
    totalDur += s.duration_seconds || 0;
    var sz = s.last_ctx_size || 0;
    var pct = s.last_ctx_pct || 0;
    totalRemaining += sz > 0 ? Math.round(sz * (100 - pct) / 100) : 0;
  });
  var tfoot = document.createElement('tr');
  tfoot.className = 'sessions-total';
  // Project
  var tfLabel = document.createElement('td');
  tfLabel.colSpan = 4;
  tfLabel.textContent = 'TOTAL (' + plural(sessions.length, 'session', 'sessions') + ')';
  tfoot.appendChild(tfLabel);
  // Trend (skip)
  var tfTrend = document.createElement('td');
  tfTrend.textContent = '';
  tfoot.appendChild(tfTrend);
  // Remaining
  var tfRem = document.createElement('td');
  tfRem.className = 'cell-right';
  tfRem.textContent = fmtTokens(totalRemaining);
  tfoot.appendChild(tfRem);
  // Tokens
  var tfTok = document.createElement('td');
  tfTok.className = 'cell-right';
  tfTok.textContent = fmtTokens(totalTokens);
  tfoot.appendChild(tfTok);
  // Cost
  var tfCost = document.createElement('td');
  tfCost.className = 'cell-right';
  tfCost.textContent = fmtCost(totalCost);
  tfoot.appendChild(tfCost);
  // Duration
  var tfDur = document.createElement('td');
  tfDur.className = 'cell-right';
  tfDur.textContent = fmtDurationSec(totalDur);
  tfoot.appendChild(tfDur);
  // Last Seen (skip)
  var tfSeen = document.createElement('td');
  tfSeen.textContent = '';
  tfoot.appendChild(tfSeen);
  tbody.appendChild(tfoot);
}

/* ── Global Stats Page ────────────────────────────────────────── */

async function loadGlobalStats() {
  var stats = await API.globalStats().catch(function() { return null; });
  if (!stats) return;

  var totalTokens = (stats.total_tokens_in || 0) + (stats.total_tokens_out || 0);
  var totalCache = (stats.total_cache_write || 0) + (stats.total_cache_read || 0);

  // P6: accent-colored stat values
  var elTotalTokens = $('#gs-total-tokens');
  if (elTotalTokens) { elTotalTokens.className = 'stat-value accent-blue'; }
  setText('#gs-total-tokens', fmtTokens(totalTokens));
  setText('#gs-tokens-in', fmtTokens(stats.total_tokens_in));
  setText('#gs-tokens-out', fmtTokens(stats.total_tokens_out));

  var elCacheTotal = $('#gs-cache-total');
  if (elCacheTotal) { elCacheTotal.className = 'stat-value accent-green'; }
  setText('#gs-cache-total', fmtTokens(totalCache));

  var elTotalCost = $('#gs-total-cost');
  if (elTotalCost) { elTotalCost.className = 'stat-value accent-yellow'; }
  setText('#gs-total-cost', fmtCost(stats.total_cost_usd));

  var elDur = $('#gs-total-duration');
  if (elDur) elDur.className = 'stat-value accent-blue';
  setText('#gs-total-duration', fmtDuration(stats.total_duration_ms));

  var elTotalSessions = $('#gs-total-sessions');
  if (elTotalSessions) { elTotalSessions.className = 'stat-value accent-purple'; }
  setText('#gs-total-sessions', String(stats.total_sessions || 0));

  setText('#gs-lines-added', '+' + fmtTokens(stats.total_lines_added));
  setText('#gs-lines-removed', '-' + fmtTokens(stats.total_lines_removed));
  var linesCard = document.getElementById('gs-lines-added');
  if (linesCard) { var card = linesCard.closest('.stat-card'); if (card) card.style.borderLeft = '2px solid rgba(255,140,0,0.3)'; }

  var elFirst = $('#gs-first-seen');
  if (elFirst) elFirst.className = 'stat-value accent-green';
  setText('#gs-first-seen', fmtDateTime(stats.first_seen));

  // Last Active: max last_seen_at from current sessions
  var lastSeen = 0;
  if (state.projects && state.projects.length > 0) {
    state.projects.forEach(function(p) { if (p.last_active > lastSeen) lastSeen = p.last_active; });
  }
  var elLast = $('#gs-last-seen');
  if (elLast) elLast.className = 'stat-value accent-blue';
  setText('#gs-last-seen', lastSeen > 0 ? fmtTimeAgo(lastSeen) : '--');

  // Per-project table
  var tbody = $('#global-projects-tbody');
  if (!tbody) return;

  while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

  // Use stats.projects if available, otherwise fall back to live project data
  var projects = stats.projects || [];
  if (projects.length === 0 && state.projects && state.projects.length > 0) {
    // Build from live sessions data + per-project summaries (parallel)
    var summaries = await Promise.all(
      state.projects.map(function(p) {
        return API.projectSummary(p.project_id).catch(function() { return null; });
      })
    );
    projects = state.projects.map(function(p, i) {
      var s = summaries[i];
      return {
        project_name: p.project_name,
        total_tokens_in: s ? s.tokens_in : 0,
        total_tokens_out: s ? s.tokens_out : 0,
        total_cost_usd: s ? s.cost_usd : 0,
        total_sessions: s ? s.sessions : p.sessions_count || 0,
        last_seen: p.last_active
      };
    });
  }

  if (projects.length === 0) {
    var tr = document.createElement('tr');
    var td = document.createElement('td');
    td.colSpan = 5;
    td.style.textAlign = 'center';
    td.style.color = 'var(--text-muted)';
    td.style.padding = '24px';
    td.textContent = 'No project data yet';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  projects.forEach(function(p) {
    var tr = document.createElement('tr');

    var tdName = document.createElement('td');
    tdName.textContent = truncate(p.project_name, 22);
    tr.appendChild(tdName);

    var tdTok = document.createElement('td');
    tdTok.className = 'cell-right';
    tdTok.textContent = fmtTokens((p.total_tokens_in || 0) + (p.total_tokens_out || 0));
    tr.appendChild(tdTok);

    var tdCost = document.createElement('td');
    tdCost.className = 'cell-right';
    tdCost.textContent = fmtCost(p.total_cost_usd);
    tr.appendChild(tdCost);

    var tdSess = document.createElement('td');
    tdSess.className = 'cell-right';
    tdSess.textContent = String(p.total_sessions || 0);
    tr.appendChild(tdSess);

    var tdSeen = document.createElement('td');
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
  var mainArea = $('.main-area');
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
    var pageEl = document.getElementById('page-' + state.currentPage);
    if (pageEl) {
      var existing = pageEl.querySelector('.error-state');
      if (!existing) {
        var errDiv = document.createElement('div');
        errDiv.className = 'error-state';
        errDiv.textContent = 'Failed to load data. ';
        var retrySpan = document.createElement('span');
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
  var toggle = $('.nav-toggle');
  var sidebar = $('.sidebar');
  var overlay = $('.sidebar-overlay');

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
  var saved = localStorage.getItem('sm_timeRange');
  if (saved && TIME_RANGES[saved]) {
    state.timeRange = saved;
    $$('.time-filter-bar button[data-range]').forEach(function(b) {
      b.classList.toggle('active', b.dataset.range === saved);
    });
  }

  $$('.time-filter-bar button[data-range]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      state.timeRange = btn.dataset.range;
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
    if (e.target.tagName === 'INPUT') return;
    if (e.key === '1') navigateTo('overview');
    if (e.key === '2') navigateTo('ratelimits');
    if (e.key === '3') navigateTo('context');
    if (e.key === '4') navigateTo('global');
    if (e.key === 'r' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); refreshData(); }
  });
}

/* ── 3.6 Auto-refresh Progress Ring ──────────────────────────── */

function startRefreshRing() {
  var progress = document.querySelector('.refresh-progress');
  if (!progress) return;
  var totalDash = 50.27;
  var elapsed = 0;
  var intervalMs = 1000;
  var cycleSec = 30;

  if (state.refreshProgressTimer) clearInterval(state.refreshProgressTimer);
  progress.style.strokeDashoffset = String(totalDash);
  elapsed = 0;

  state.refreshProgressTimer = setInterval(function() {
    elapsed++;
    var offset = totalDash - (totalDash * elapsed / cycleSec);
    if (offset < 0) offset = 0;
    progress.style.strokeDashoffset = String(offset);
    if (elapsed >= cycleSec) elapsed = 0;
  }, intervalMs);
}

function resetRefreshRing() {
  var progress = document.querySelector('.refresh-progress');
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
    var hash = window.location.hash.slice(1);
    var validPages = ['overview', 'ratelimits', 'context', 'global'];
    if (hash && validPages.indexOf(hash) !== -1 && hash !== state.currentPage) {
      navigateTo(hash);
    }
  });

  // Initial load
  await loadProjects();

  // P7: read initial page from hash first, then localStorage
  var hashPage = window.location.hash.replace('#', '');
  var validPages = ['overview', 'ratelimits', 'context', 'global'];
  var startPage;
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
}

// Wait for DOM and Chart.js
document.addEventListener('DOMContentLoaded', function() {
  if (typeof Chart !== 'undefined') {
    init();
  } else {
    window.addEventListener('load', init);
  }
});
