/* ================================================================
   Statusline Metrics -- Chart.js Helpers
   Sci-Fi Command Center: primary/secondary lines, holographic fills,
   grid overlays, glow effects.
   ================================================================ */

'use strict';

/* ── Colour Constants (Rebel Alliance Palette) ──────────────── */

const C = {
  tokenIn:      '#ff8c00',
  tokenOut:     '#4ade80',
  cacheWrite:   '#ffaa33',
  cacheRead:    '#60a5fa',
  primary:      '#ff8c00',
  secondary:    '#4ade80',
  green:        '#4ade80',
  amber:        '#ffaa33',
  red:          '#ef6461',
  textData:     '#ffcc80',
  textSec:      '#8b9bb0',
  textMuted:    '#4a5568',
  border:       '#2a3545',
  borderDim:    '#1e2a3a',
  bgCard:       '#141c28',
  bgPanel:      '#111923',
};

/* ── Shared Defaults ─────────────────────────────────────────── */

const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 500, easing: 'easeOutQuart' },
  interaction: {
    mode: 'index',
    intersect: false,
  },
  plugins: {
    legend: {
      display: false,
    },
    tooltip: {
      backgroundColor: 'rgba(10, 14, 23, 0.95)',
      titleColor: '#ffaa33',
      bodyColor: '#ffcc80',
      borderColor: 'rgba(255, 140, 0, 0.3)',
      borderWidth: 1,
      cornerRadius: 2,
      padding: { top: 10, bottom: 10, left: 14, right: 14 },
      bodyFont: { size: 11, family: "'JetBrains Mono', monospace" },
      titleFont: { size: 11, weight: '600', family: "'JetBrains Mono', monospace" },
      displayColors: true,
      usePointStyle: true,
      pointStyle: 'circle',
      boxWidth: 6,
      boxHeight: 6,
      boxPadding: 6,
      callbacks: {},
    },
  },
};

const SCALE_DEFAULTS = {
  x: {
    type: 'category',
    grid: {
      display: true,
      color: 'rgba(255, 140, 0, 0.04)',
      lineWidth: 1,
    },
    ticks: {
      color: C.textMuted,
      font: { size: 9, family: "'JetBrains Mono', monospace" },
      maxRotation: 0,
      maxTicksLimit: 10,
    },
    border: { color: 'rgba(255, 140, 0, 0.1)' },
  },
  y: {
    grid: {
      color: 'rgba(255, 140, 0, 0.04)',
      drawTicks: false,
      lineWidth: 1,
    },
    ticks: {
      color: C.textMuted,
      font: { size: 9, family: "'JetBrains Mono', monospace" },
      padding: 8,
    },
    border: { display: false },
    beginAtZero: false,
  },
};

/* ── Crosshair Plugin (targeting reticle style) ──────────────── */

const crosshairPlugin = {
  id: 'crosshair',
  afterDraw(chart) {
    const active = chart.tooltip?.getActiveElements?.();
    if (!active || active.length === 0) return;
    const { ctx, chartArea } = chart;
    const x = active[0].element.x;

    ctx.save();

    /* Vertical line */
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 140, 0, 0.25)';
    ctx.setLineDash([3, 3]);
    ctx.stroke();

    /* Small targeting marks at top and bottom */
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255, 140, 0, 0.5)';
    ctx.lineWidth = 1;

    /* Top mark */
    ctx.beginPath();
    ctx.moveTo(x - 4, chartArea.top);
    ctx.lineTo(x + 4, chartArea.top);
    ctx.stroke();

    /* Bottom mark */
    ctx.beginPath();
    ctx.moveTo(x - 4, chartArea.bottom);
    ctx.lineTo(x + 4, chartArea.bottom);
    ctx.stroke();

    ctx.restore();
  },
};

/* Register the plugin globally once Chart.js is loaded */
function registerPlugins() {
  if (typeof Chart !== 'undefined' && !Chart._crosshairRegistered) {
    Chart.register(crosshairPlugin);
    Chart._crosshairRegistered = true;
  }
}

/* ── Helper: format token values for Y axis ──────────────────── */

function fmtTokenAxis(val) {
  if (val >= 1_000_000) return (val / 1_000_000).toFixed(1) + 'M';
  if (val >= 1_000) return (val / 1_000).toFixed(0) + 'k';
  return String(val);
}

/* ── Helper: format timestamps ───────────────────────────────── */

function fmtTimeLabel(ts) {
  const d = new Date(ts * 1000);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 86400_000) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/* ── Create: Tokens Timeline (stacked area) ──────────────────── */

function createTokensChart(canvasId) {
  registerPlugins();
  const ctx = document.getElementById(canvasId);
  if (!ctx) return null;

  return new Chart(ctx.getContext('2d'), {
    type: 'bar',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Tokens Out',
          data: [],
          backgroundColor: C.primary + 'cc',
          borderColor: C.primary,
          borderWidth: 1,
          borderRadius: 3,
          barPercentage: 0.8,
        },
      ],
    },
    options: {
      ...CHART_DEFAULTS,
      scales: {
        x: { ...SCALE_DEFAULTS.x, offset: true },
        y: {
          ...SCALE_DEFAULTS.y,
          beginAtZero: true,
          grace: '5%',
          ticks: {
            ...SCALE_DEFAULTS.y.ticks,
            callback: fmtTokenAxis,
          },
        },
      },
      plugins: {
        ...CHART_DEFAULTS.plugins,
        legend: { display: false },
        tooltip: {
          ...CHART_DEFAULTS.plugins.tooltip,
          callbacks: {
            label(ctx) {
              return fmtTokenAxis(ctx.parsed.y) + ' tokens out';
            },
          },
        },
      },
    },
  });
}

/* ── Create: Tokens per Project (horizontal bar) ─────────────── */

function createProjectsBarChart(canvasId) {
  registerPlugins();
  const ctx = document.getElementById(canvasId);
  if (!ctx) return null;

  return new Chart(ctx.getContext('2d'), {
    type: 'bar',
    data: {
      labels: [],
      datasets: [{
        label: 'Tokens',
        data: [],
        backgroundColor: C.tokenIn + '99',
        borderColor: C.tokenIn,
        borderWidth: 1,
        borderRadius: 3,
        barPercentage: 0.7,
      }],
    },
    options: {
      ...CHART_DEFAULTS,
      indexAxis: 'y',
      scales: {
        x: {
          ...SCALE_DEFAULTS.y,
          ticks: {
            ...SCALE_DEFAULTS.y.ticks,
            callback: fmtTokenAxis,
          },
        },
        y: {
          ...SCALE_DEFAULTS.x,
          grid: { display: false },
          ticks: {
            ...SCALE_DEFAULTS.x.ticks,
            font: { size: 10, family: "'JetBrains Mono', monospace" },
          },
        },
      },
      plugins: {
        ...CHART_DEFAULTS.plugins,
        tooltip: {
          ...CHART_DEFAULTS.plugins.tooltip,
          callbacks: {
            label(ctx) {
              return 'Tokens: ' + fmtTokenAxis(ctx.parsed.x);
            },
          },
        },
      },
    },
  });
}

/* ── Create: Rate Limits Chart (dual line) ───────────────────── */

function createRateLimitsChart(canvasId) {
  registerPlugins();
  const ctx = document.getElementById(canvasId);
  if (!ctx) return null;

  return new Chart(ctx.getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: '5-Hour Limit',
          data: [],
          borderColor: C.primary,
          backgroundColor: C.primary,
          borderWidth: 2,
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: C.primary,
          pointHoverBorderColor: '#fff',
          pointHoverBorderWidth: 1,
        },
        {
          label: '7-Day Limit',
          data: [],
          borderColor: C.secondary,
          backgroundColor: C.secondary,
          borderWidth: 2,
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: C.secondary,
          pointHoverBorderColor: '#fff',
          pointHoverBorderWidth: 1,
        },
      ],
    },
    options: {
      ...CHART_DEFAULTS,
      scales: {
        x: { ...SCALE_DEFAULTS.x },
        y: {
          ...SCALE_DEFAULTS.y,
          beginAtZero: true,
          max: 100,
          ticks: {
            ...SCALE_DEFAULTS.y.ticks,
            callback: (v) => v + '%',
          },
        },
      },
      plugins: {
        ...CHART_DEFAULTS.plugins,
        tooltip: {
          ...CHART_DEFAULTS.plugins.tooltip,
          callbacks: {
            label(ctx) {
              const val = ctx.parsed ? ctx.parsed.y : 0;
              const pct = val != null ? val.toFixed(1) : '0';
              // Estimate tokens from % using stored caps
              const cap = ctx.datasetIndex === 0 ? (window._rlCap5h || 0) : (window._rlCap7d || 0);
              const tokens = cap > 0 ? Math.round(val * cap / 100) : 0;
              const tokenStr = cap > 0 ? ' (~' + fmtTokenAxis(tokens) + ' tokens)' : '';
              return ctx.dataset.label + ': ' + pct + '%' + tokenStr;
            },
          },
        },
      },
    },
  });
}

/* ── Create: Context Window Chart (area) ─────────────────────── */

function createContextChart(canvasId) {
  registerPlugins();
  const ctx = document.getElementById(canvasId);
  if (!ctx) return null;

  return new Chart(ctx.getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Context Usage',
        data: [],
        borderColor: C.green,
        backgroundColor: C.green,
        borderWidth: 2,
        fill: false,
        tension: 0.35,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: C.green,
        pointHoverBorderColor: '#fff',
        pointHoverBorderWidth: 1,
      }],
    },
    options: {
      ...CHART_DEFAULTS,
      scales: {
        x: { ...SCALE_DEFAULTS.x },
        y: {
          ...SCALE_DEFAULTS.y,
          beginAtZero: true,
          max: 100,
          ticks: {
            ...SCALE_DEFAULTS.y.ticks,
            callback: (v) => v + '%',
          },
        },
      },
      plugins: {
        ...CHART_DEFAULTS.plugins,
        tooltip: {
          ...CHART_DEFAULTS.plugins.tooltip,
          callbacks: {
            label(ctx) {
              const val = ctx.parsed ? ctx.parsed.y : 0;
              return 'Context: ' + (val != null ? val.toFixed(1) : '0') + '%';
            },
          },
        },
      },
    },
  });
}

/* ── Update Chart Data ───────────────────────────────────────── */

function updateChart(chart, labels, datasets, animate) {
  if (!chart) return;
  chart.data.labels = labels;
  datasets.forEach((ds, i) => {
    if (chart.data.datasets[i]) {
      chart.data.datasets[i].data = ds;
    }
  });
  chart.update(animate === false ? 'none' : undefined);
}

