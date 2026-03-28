"""Statusline Metrics Server -- entry point.

Flask application that receives metrics from statusline.sh clients,
stores them in SQLite, and serves the dashboard.

Usage::

    python -m server.metrics_server
    # or
    python server/metrics_server.py
"""

from __future__ import annotations

import hmac
import logging
import sqlite3
import sys
import threading
import time
from pathlib import Path
from typing import Any

from flask import Flask, Response, g, jsonify, request, send_from_directory

# ---------------------------------------------------------------------------
# Ensure the project root is on sys.path so ``from server import ...`` works
# when this file is executed directly as ``python server/metrics_server.py``.
# ---------------------------------------------------------------------------
_THIS_DIR = Path(__file__).resolve().parent
_PROJECT_ROOT = _THIS_DIR.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from server import config  # noqa: E402
from server.database import (  # noqa: E402
    INTERVAL_MAP,
    PERIOD_MAP,
    cleanup,
    compute_rate_windows,
    get_active_sessions,
    get_activity_per_bucket,
    get_all_projects_summary,
    get_burn_rate,
    get_connection,
    get_context_window_analysis,
    get_db_size,
    get_global_stats,
    get_metrics_timeseries,
    get_metrics_timeseries_all,
    get_projects,
    get_project_summary,
    get_rate_estimates,
    get_rate_limits_current,
    get_rate_limits_history,
    get_response_time,
    get_sessions,
    get_total_records,
    init_db,
    insert_metric,
    map_keys,
    predict_exhaustion,
)
from server.ingest import ingest_pending  # noqa: E402

# ── Logging ──────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)-5s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("metrics.server")

# ── Flask app ────────────────────────────────────────────────────────

app = Flask(
    __name__,
    static_folder=str(_THIS_DIR / "static"),
    static_url_path="/static",
)

_START_TIME: float = time.time()
_last_rate_window_ts: float = 0

# Required fields for POST /api/metrics
_REQUIRED_FIELDS: list[str] = ["ts", "sid", "pid", "pname", "ppath", "host", "model"]

# ── Rate limiting ────────────────────────────────────────────────

_rate_lock = threading.Lock()
_rate_limit_store: dict[str, tuple[int, float]] = {}  # session_id -> (count, window_start)
RATE_LIMIT_MAX = 120  # max 120 writes per minute per session


def _check_rate_limit(session_id: str) -> bool:
    """Return True if the request is within rate limits, False otherwise."""
    now = time.time()
    with _rate_lock:
        # Evict expired instead of nuking the entire store
        if len(_rate_limit_store) > 10000:
            expired = [k for k, (_, t) in _rate_limit_store.items() if now - t > 120]
            for k in expired:
                del _rate_limit_store[k]
            # If still over limit after eviction, allow (don't nuke)
            if len(_rate_limit_store) > 10000:
                return True
        entry = _rate_limit_store.get(session_id)
        if entry is None or now - entry[1] > 60:
            _rate_limit_store[session_id] = (1, now)
            return True
        if entry[0] >= RATE_LIMIT_MAX:
            return False
        _rate_limit_store[session_id] = (entry[0] + 1, entry[1])
        return True


def _cleanup_rate_limit_store() -> None:
    """Remove expired entries from the rate-limit store."""
    now = time.time()
    with _rate_lock:
        expired = [sid for sid, (_, start) in _rate_limit_store.items() if now - start > 120]
        for sid in expired:
            del _rate_limit_store[sid]

# ── Per-request database connection ──────────────────────────────────


def get_db() -> sqlite3.Connection:
    """Return a thread-local database connection (stored in Flask ``g``)."""
    if "db" not in g:
        g.db = get_connection()
    return g.db


@app.teardown_appcontext
def _close_db(exc: BaseException | None) -> None:
    db: sqlite3.Connection | None = g.pop("db", None)
    if db is not None:
        db.close()


# ── Auth middleware ──────────────────────────────────────────────────


def _is_localhost(addr: str | None) -> bool:
    """Check whether the remote address is a loopback address."""
    if addr is None:
        return False
    return addr in ("127.0.0.1", "::1", "::ffff:127.0.0.1")


@app.before_request
def _check_auth() -> Response | None:
    """Enforce API-key authentication for remote POST requests.

    - GET requests are always allowed (read-only, no sensitive data).
    - POST from localhost is always allowed.
    - POST from remote IPs requires a valid ``Authorization: Bearer <key>``.
    """
    if request.method != "POST":
        return None
    if _is_localhost(request.remote_addr):
        return None

    if not config.API_KEY:
        return None  # No API_KEY configured -> open mode (LAN)

    auth_header = request.headers.get("Authorization", "")
    token = auth_header.replace("Bearer ", "", 1) if auth_header.startswith("Bearer ") else ""
    if not hmac.compare_digest(token, config.API_KEY):
        return jsonify({"error": "unauthorized"}), 401  # type: ignore[return-value]

    return None


# ── Routes ───────────────────────────────────────────────────────────


@app.route("/")
def index() -> Response:
    """Serve the dashboard."""
    return send_from_directory(app.static_folder, "index.html")  # type: ignore[arg-type]


@app.route("/api/health", methods=["GET"])
def health() -> tuple[Response, int]:
    """Health-check endpoint with runtime stats."""
    db = get_db()
    pending_path = Path(config.PENDING_JSONL).expanduser()

    payload: dict[str, Any] = {
        "status": "ok",
        "uptime_seconds": int(time.time() - _START_TIME),
        "db_size_bytes": get_db_size(),
        "total_records": get_total_records(db),
        "active_sessions": get_active_sessions(db),
        "pending_jsonl_exists": pending_path.exists(),
        "version": config.VERSION,
    }
    return jsonify(payload), 200


@app.route("/api/metrics", methods=["GET", "POST"])
def api_metrics() -> tuple[Response, int]:
    """POST: accept a metric record. GET: return time-series data."""
    if request.method == "POST":
        return _handle_receive_metric()
    return _handle_metrics_timeseries()


def _handle_receive_metric() -> tuple[Response, int]:
    """Accept a metric record from a statusline client."""
    data = request.get_json(silent=True)
    if data is None:
        return jsonify({"error": "invalid JSON body"}), 400

    # Validate required short-key fields
    missing = [f for f in _REQUIRED_FIELDS if f not in data]
    if missing:
        return jsonify({"error": f"missing required fields: {', '.join(missing)}"}), 400

    # Basic sanity checks
    ts = data.get("ts")
    if not isinstance(ts, (int, float)) or ts <= 0:
        return jsonify({"error": "ts must be a positive number"}), 400

    # Rate limiting per session
    session_id = data.get("sid", "")
    if not _check_rate_limit(session_id):
        return jsonify({"error": "rate limit exceeded (120 writes/min)"}), 429

    try:
        db = get_db()
        insert_metric(db, data)
    except sqlite3.Error as exc:
        logger.error("DB insert failed: %s", exc)
        return jsonify({"error": "database error"}), 500

    return jsonify({"status": "ok"}), 200


# ── Dashboard GET endpoints ─────────────────────────────────────────


def _parse_ts_range() -> tuple[int, int]:
    """Parse from/to query parameters, defaulting to the last 24 hours."""
    now = int(time.time())
    from_ts = request.args.get("from", type=int, default=now - 86400)
    to_ts = request.args.get("to", type=int, default=now)
    return from_ts, to_ts


@app.route("/api/projects", methods=["GET"])
def api_projects() -> tuple[Response, int]:
    """List all projects with last_active and sessions_count."""
    account = request.args.get("account")
    db = get_db()
    data = get_projects(db, account=account)
    return jsonify(data), 200


@app.route("/api/projects/summary-all", methods=["GET"])
def api_all_projects_summary() -> tuple[Response, int]:
    """Aggregate summary across all projects in one query."""
    db = get_db()
    from_ts = request.args.get("from", type=int)
    to_ts = request.args.get("to", type=int)
    account = request.args.get("account")
    data = get_all_projects_summary(db, from_ts, to_ts, account=account)
    return jsonify(data), 200


@app.route("/api/projects/<project_id>/summary", methods=["GET"])
def api_project_summary(project_id: str) -> tuple[Response, int]:
    """Project summary: tokens, cost, duration, sessions, models."""
    account = request.args.get("account")
    from_ts = request.args.get("from", type=int, default=None)
    to_ts = request.args.get("to", type=int, default=None)
    db = get_db()
    data = get_project_summary(db, project_id, account=account, from_ts=from_ts, to_ts=to_ts)
    return jsonify(data), 200


def _handle_metrics_timeseries() -> tuple[Response, int]:
    """Time-series metrics aggregated by interval."""
    project_id = request.args.get("project_id")

    interval_str = request.args.get("interval", "1m")
    interval_seconds = INTERVAL_MAP.get(interval_str)
    if interval_seconds is None:
        valid = ", ".join(INTERVAL_MAP.keys())
        return jsonify({"error": f"invalid interval, use one of: {valid}"}), 400

    from_ts, to_ts = _parse_ts_range()
    account = request.args.get("account")
    db = get_db()

    if project_id:
        data = get_metrics_timeseries(
            db, project_id, from_ts, to_ts, interval_seconds, account=account
        )
    else:
        data = get_metrics_timeseries_all(
            db, from_ts, to_ts, interval_seconds, account=account
        )
    return jsonify(data), 200


@app.route("/api/rate-limits/current", methods=["GET"])
def api_rate_limits_current() -> tuple[Response, int]:
    """Current rate limit values from the latest record."""
    account = request.args.get("account")
    db = get_db()
    data = get_rate_limits_current(db, account=account)
    return jsonify(data), 200


@app.route("/api/rate-limits/history", methods=["GET"])
def api_rate_limits_history() -> tuple[Response, int]:
    """Rate limits history within the given time range."""
    from_ts, to_ts = _parse_ts_range()
    account = request.args.get("account")
    db = get_db()
    data = get_rate_limits_history(db, from_ts, to_ts, account=account)
    return jsonify(data), 200


@app.route("/api/rate-limits/prediction", methods=["GET"])
def api_rate_limits_prediction() -> tuple[Response, int]:
    """Predict when rate limits will reach 100%."""
    account = request.args.get("account")
    db = get_db()
    data = predict_exhaustion(db, account=account)
    return jsonify(data), 200


@app.route("/api/rate-limits/estimates", methods=["GET"])
def api_rate_limits_estimates() -> tuple[Response, int]:
    """Aggregated token budget estimates from rate-limit window observations."""
    global _last_rate_window_ts
    window = request.args.get("window", "5h")
    db = get_db()
    # Recompute windows at most once every 5 minutes
    now = time.time()
    if now - _last_rate_window_ts > 300:
        try:
            compute_rate_windows(db)
            _last_rate_window_ts = now
        except Exception:
            logger.exception("On-demand compute_rate_windows failed")
    data = get_rate_estimates(db, window_type=window)
    return jsonify(data), 200


@app.route("/api/context-window/analysis", methods=["GET"])
def api_context_window_analysis() -> tuple[Response, int]:
    """Context window analysis for a given period."""
    period_str = request.args.get("period", "7d")
    period_seconds = PERIOD_MAP.get(period_str)
    if period_seconds is None:
        valid = ", ".join(PERIOD_MAP.keys())
        return jsonify({"error": f"invalid period, use one of: {valid}"}), 400

    account = request.args.get("account")
    project_id = request.args.get("project_id")
    db = get_db()
    data = get_context_window_analysis(db, period_seconds, account=account, project_id=project_id)
    return jsonify(data), 200


@app.route("/api/global-stats", methods=["GET"])
def api_global_stats() -> tuple[Response, int]:
    """Global statistics combining historical and live data."""
    account = request.args.get("account")
    db = get_db()
    data = get_global_stats(db, account=account)
    return jsonify(data), 200


@app.route("/api/sessions", methods=["GET"])
def api_sessions() -> tuple[Response, int]:
    """List sessions, optionally filtered by project, account, and time range."""
    project_id = request.args.get("project_id")
    account = request.args.get("account")
    limit = min(request.args.get("limit", 50, type=int), 500)
    from_ts = request.args.get("from", type=int, default=None)
    to_ts = request.args.get("to", type=int, default=None)
    db = get_db()
    data = get_sessions(db, project_id=project_id, account=account, limit=limit,
                        from_ts=from_ts, to_ts=to_ts)
    return jsonify(data), 200


@app.route("/api/response-time", methods=["GET"])
def api_response_time() -> tuple[Response, int]:
    """API response time deltas for a project within a time range."""
    project_id = request.args.get("project_id")
    if not project_id:
        return jsonify({"error": "project_id is required"}), 400

    from_ts, to_ts = _parse_ts_range()
    account = request.args.get("account")
    db = get_db()
    data = get_response_time(db, project_id, from_ts, to_ts, account=account)
    return jsonify(data), 200


@app.route("/api/activity", methods=["GET"])
def api_activity() -> tuple[Response, int]:
    """Tokens OUT delta per time bucket (activity chart)."""
    from_ts, to_ts = _parse_ts_range()
    interval_str = request.args.get("interval", "5m")
    interval_seconds = INTERVAL_MAP.get(interval_str)
    if interval_seconds is None:
        valid = ", ".join(INTERVAL_MAP.keys())
        return jsonify({"error": f"invalid interval, use one of: {valid}"}), 400

    project_id = request.args.get("project_id")
    account = request.args.get("account")
    db = get_db()
    data = get_activity_per_bucket(
        db, from_ts, to_ts, interval_seconds,
        project_id=project_id, account=account,
    )
    return jsonify(data), 200


@app.route("/api/burn-rate", methods=["GET"])
def api_burn_rate() -> tuple[Response, int]:
    """Tokens OUT burn rate: per active minute and per hour."""
    account = request.args.get("account")
    db = get_db()
    data = get_burn_rate(db, account=account)
    return jsonify(data), 200


# ── Background scheduler ────────────────────────────────────────────


class _BackgroundScheduler(threading.Thread):
    """Lightweight periodic task runner.

    Runs cleanup (hourly) and ingest_pending (every 5 min) in a daemon
    thread so the main server thread is never blocked.
    """

    def __init__(self) -> None:
        super().__init__(daemon=True, name="metrics-scheduler")
        self._stop_event = threading.Event()

    def run(self) -> None:
        cleanup_interval = 3600  # 1 hour
        ingest_interval = 300    # 5 minutes

        last_cleanup = time.time()
        last_ingest = time.time()

        while not self._stop_event.is_set():
            self._stop_event.wait(timeout=30)  # wake every 30s to check
            now = time.time()

            if now - last_ingest >= ingest_interval:
                try:
                    conn = get_connection()
                    try:
                        ingest_pending(conn)
                    finally:
                        conn.close()
                except Exception:
                    logger.exception("Scheduled ingest_pending failed")
                # Cleanup expired rate-limit entries alongside ingest
                _cleanup_rate_limit_store()
                last_ingest = now

            if now - last_cleanup >= cleanup_interval:
                try:
                    conn = get_connection()
                    try:
                        cleanup(conn)
                        compute_rate_windows(conn)
                    finally:
                        conn.close()
                except Exception:
                    logger.exception("Scheduled cleanup / rate windows failed")
                last_cleanup = now

    def stop(self) -> None:
        self._stop_event.set()


# ── Main ─────────────────────────────────────────────────────────────


def main() -> None:
    """Initialise the database and start the server."""
    # Ensure DB directory exists and schema is up to date
    conn = init_db()

    # Report current DB stats
    total = get_total_records(conn)
    size_mb = get_db_size() / (1024 * 1024)
    logger.info("DB: %d records, %.1f MB", total, size_mb)

    # Ingest any pending records from fallback file
    ingest_pending(conn)
    conn.close()

    # Start background scheduler
    scheduler = _BackgroundScheduler()
    scheduler.start()

    logger.info(
        "Server started on http://%s:%d", config.HOST, config.PORT
    )

    # Serve with waitress (production) or Flask dev server (fallback)
    try:
        from waitress import serve  # type: ignore[import-untyped]

        serve(app, host=config.HOST, port=config.PORT, threads=4)
    except ImportError:
        logger.warning(
            "waitress not installed -- falling back to Flask dev server"
        )
        app.run(host=config.HOST, port=config.PORT, threaded=True)


if __name__ == "__main__":
    main()
