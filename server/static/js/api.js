/* ================================================================
   Statusline Metrics -- API Layer
   Fetch wrappers for all dashboard endpoints.
   ================================================================ */

'use strict';

/**
 * Generic fetch wrapper that appends query params and returns JSON.
 * @param {string} path  - API endpoint path
 * @param {Object} [params] - query parameters (nulls are omitted)
 * @returns {Promise<any>}
 */
async function fetchJSON(path, params = {}) {
  const url = new URL(path, window.location.origin);
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== null && val !== '') {
      url.searchParams.set(key, String(val));
    }
  }
  var controller = new AbortController();
  var timeoutId = setTimeout(function() { controller.abort(); }, 10000);
  try {
    const resp = await fetch(url.toString(), { signal: controller.signal });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`API ${resp.status}: ${body}`);
    }
    return resp.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

const API = {
  /** Health check */
  health: () => fetchJSON('/api/health'),

  /** List all projects */
  projects: (account) => fetchJSON('/api/projects', { account }),

  /** Single project summary (supports optional {from, to, account} params) */
  projectSummary: (id, params) => {
    if (typeof params === 'string') {
      // Legacy: second arg was account string
      params = { account: params };
    }
    return fetchJSON(`/api/projects/${encodeURIComponent(id)}/summary`, params || {});
  },

  /** Time-series metrics for a project */
  metrics: (params) => fetchJSON('/api/metrics', params),

  /** Current rate limits */
  rateLimitsCurrent: (account) =>
    fetchJSON('/api/rate-limits/current', { account }),

  /** Rate limits history */
  rateLimitsHistory: (params) =>
    fetchJSON('/api/rate-limits/history', params),

  /** Rate limits token budget estimates */
  rateLimitsEstimates: (params) =>
    fetchJSON('/api/rate-limits/estimates', params),

  /** Rate limits exhaustion prediction */
  rateLimitsPrediction: (params) =>
    fetchJSON('/api/rate-limits/prediction', params),

  /** Context window analysis */
  contextAnalysis: (params) =>
    fetchJSON('/api/context-window/analysis', params),

  /** Global statistics */
  globalStats: (account) =>
    fetchJSON('/api/global-stats', { account }),

  /** Sessions list */
  sessions: (params) =>
    fetchJSON('/api/sessions', params),

  /** Response time data */
  responseTime: (params) =>
    fetchJSON('/api/response-time', params),
};
