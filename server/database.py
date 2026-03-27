"""SQLite database layer for statusline-metrics.

Handles initialisation, schema migrations, inserts, cleanup,
and thread-safe connection management for Flask.
"""

from __future__ import annotations

import logging
import os
import sqlite3
import time
from pathlib import Path
from typing import Any

from server import config

logger = logging.getLogger("metrics.database")

# ── Short-key to full-column mapping ────────────────────────────────

KEY_MAP: dict[str, str] = {
    "ts": "ts",
    "sid": "session_id",
    "pid": "project_id",
    "pname": "project_name",
    "ppath": "project_path",
    "host": "host",
    "acct": "account",
    "model": "model",
    "ctx": "ctx_pct",
    "ctxsz": "ctx_size",
    "r5h": "rate_5h_pct",
    "r5hr": "rate_5h_resets",
    "r7d": "rate_7d_pct",
    "r7dr": "rate_7d_resets",
    "tin": "tokens_in",
    "tout": "tokens_out",
    "cw": "cache_write",
    "cr": "cache_read",
    "cost": "cost_usd",
    "dur": "duration_ms",
    "apid": "api_duration_ms",
    "la": "lines_added",
    "lr": "lines_removed",
}

# ── Schema DDL ───────────────────────────────────────────────────────

_SCHEMA_SQL = """\
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -8000;
PRAGMA auto_vacuum = INCREMENTAL;

CREATE TABLE IF NOT EXISTS schema_version (
    version     INTEGER PRIMARY KEY,
    applied_at  INTEGER NOT NULL,
    description TEXT
);

CREATE TABLE IF NOT EXISTS metrics (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              INTEGER NOT NULL,
    session_id      TEXT    NOT NULL,
    project_id      TEXT    NOT NULL,
    project_name    TEXT    NOT NULL,
    project_path    TEXT    NOT NULL,
    host            TEXT    NOT NULL,
    account         TEXT    NOT NULL DEFAULT 'auto',
    model           TEXT    NOT NULL,

    ctx_pct         REAL,
    ctx_size        INTEGER,

    rate_5h_pct     REAL,
    rate_5h_resets  INTEGER,
    rate_7d_pct     REAL,
    rate_7d_resets  INTEGER,

    tokens_in       INTEGER,
    tokens_out      INTEGER,
    cache_write     INTEGER,
    cache_read      INTEGER,

    cost_usd        REAL,
    duration_ms     INTEGER,
    api_duration_ms INTEGER,

    lines_added     INTEGER,
    lines_removed   INTEGER
);

CREATE TABLE IF NOT EXISTS global_stats (
    project_id          TEXT PRIMARY KEY,
    project_name        TEXT,
    project_path        TEXT,

    total_tokens_in     INTEGER DEFAULT 0,
    total_tokens_out    INTEGER DEFAULT 0,
    total_cache_write   INTEGER DEFAULT 0,
    total_cache_read    INTEGER DEFAULT 0,
    total_cost_usd      REAL    DEFAULT 0,
    total_duration_ms   INTEGER DEFAULT 0,
    total_sessions      INTEGER DEFAULT 0,
    total_lines_added   INTEGER DEFAULT 0,
    total_lines_removed INTEGER DEFAULT 0,

    first_seen              INTEGER,
    last_seen               INTEGER,

    estimated_5h_tokens     INTEGER,
    estimated_7d_tokens     INTEGER,
    est_5h_samples          INTEGER DEFAULT 0,
    est_7d_samples          INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
    session_id      TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL,
    project_name    TEXT,
    host            TEXT,
    account         TEXT    DEFAULT 'auto',
    model           TEXT,

    started_at      INTEGER,
    last_seen_at    INTEGER,

    max_ctx_pct     REAL    DEFAULT 0,
    max_tokens_in   INTEGER DEFAULT 0,
    max_tokens_out  INTEGER DEFAULT 0,
    max_cost_usd    REAL    DEFAULT 0,
    max_duration_ms INTEGER DEFAULT 0,

    last_tokens_in   INTEGER DEFAULT 0,
    last_tokens_out  INTEGER DEFAULT 0,
    last_cache_write INTEGER DEFAULT 0,
    last_cache_read  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rate_estimates (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              INTEGER NOT NULL,
    session_id      TEXT    NOT NULL,
    window_type     TEXT    NOT NULL,

    delta_pct       REAL    NOT NULL,
    delta_tokens    INTEGER NOT NULL,
    estimated_total INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_metrics_project_ts
    ON metrics (project_id, ts);

CREATE INDEX IF NOT EXISTS idx_metrics_ts
    ON metrics (ts);

CREATE INDEX IF NOT EXISTS idx_metrics_session
    ON metrics (session_id, ts);

CREATE INDEX IF NOT EXISTS idx_rate_est_window_ts
    ON rate_estimates (window_type, ts);
"""

# ── Migrations ───────────────────────────────────────────────────────

MIGRATIONS: list[tuple[int, str, str]] = [
    (1, "Initial schema", _SCHEMA_SQL),
    (2, "Add rate_windows table and resets indexes", """
        CREATE TABLE IF NOT EXISTS rate_windows (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            window_type TEXT NOT NULL,
            resets_at INTEGER NOT NULL,
            window_start_ts INTEGER,
            window_end_ts INTEGER,
            final_rate_pct REAL,
            total_output INTEGER DEFAULT 0,
            total_input INTEGER DEFAULT 0,
            total_in_out INTEGER DEFAULT 0,
            estimated_cap_output INTEGER,
            estimated_cap_input INTEGER,
            estimated_cap_all INTEGER,
            is_complete INTEGER DEFAULT 0,
            UNIQUE(window_type, resets_at)
        );
        CREATE INDEX IF NOT EXISTS idx_rate_windows_type_complete
            ON rate_windows(window_type, is_complete);
        CREATE INDEX IF NOT EXISTS idx_metrics_rate5h_resets
            ON metrics(rate_5h_resets);
        CREATE INDEX IF NOT EXISTS idx_metrics_rate7d_resets
            ON metrics(rate_7d_resets);
    """),
]

# ── Connection helpers ───────────────────────────────────────────────


def _ensure_dir(db_path: str) -> None:
    """Create parent directories for the database file."""
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)


def get_connection(db_path: str | None = None) -> sqlite3.Connection:
    """Open a new SQLite connection with recommended pragmas.

    Each connection should be used from a single thread only.
    """
    path = db_path or config.DB_PATH
    _ensure_dir(path)
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA cache_size = -8000")
    return conn


# ── Init & migrate ───────────────────────────────────────────────────


def init_db(conn: sqlite3.Connection | None = None) -> sqlite3.Connection:
    """Initialise the database: create tables, run migrations."""
    if conn is None:
        conn = get_connection()

    # Integrity check before migrations
    db_path = Path(config.DB_PATH)
    if db_path.exists() and db_path.stat().st_size > 0:
        result = conn.execute("PRAGMA integrity_check").fetchone()
        if result[0] != "ok":
            logger.error("Database integrity check failed: %s", result[0])
            conn.close()
            # Backup corrupted DB
            backup_path = db_path.with_suffix(".db.corrupted")
            import shutil

            shutil.move(str(db_path), str(backup_path))
            logger.warning(
                "Corrupted DB backed up to %s, creating fresh DB", backup_path
            )
            conn = get_connection()

    migrate(conn)
    logger.info("Database initialised at %s", config.DB_PATH)
    return conn


def migrate(conn: sqlite3.Connection) -> None:
    """Apply outstanding migrations (additive only)."""
    # Ensure schema_version exists first
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_version ("
        "  version INTEGER PRIMARY KEY,"
        "  applied_at INTEGER NOT NULL,"
        "  description TEXT"
        ")"
    )
    conn.commit()

    row = conn.execute(
        "SELECT COALESCE(MAX(version), 0) FROM schema_version"
    ).fetchone()
    current: int = row[0]

    for version, desc, sql in MIGRATIONS:
        if version > current:
            conn.executescript(sql)
            conn.execute(
                "INSERT INTO schema_version VALUES (?, ?, ?)",
                (version, int(time.time()), desc),
            )
            conn.commit()
            logger.info("Applied migration %d: %s", version, desc)


# ── Insert ───────────────────────────────────────────────────────────


def map_keys(record: dict[str, Any]) -> dict[str, Any]:
    """Map short client keys to full column names."""
    mapped: dict[str, Any] = {}
    for short, full in KEY_MAP.items():
        if short in record:
            mapped[full] = record[short]
        elif full in record:
            mapped[full] = record[full]
    return mapped


def insert_metric(
    conn: sqlite3.Connection, record: dict[str, Any], *, commit: bool = True
) -> None:
    """Insert a single metric record and upsert the session row.

    When *commit* is False the caller is responsible for committing the
    transaction (useful for batch inserts).
    """
    rec = map_keys(record)

    # Defaults for optional fields
    rec.setdefault("account", "auto")
    rec.setdefault("ctx_pct", 0)
    rec.setdefault("ctx_size", 0)
    rec.setdefault("rate_5h_pct", 0)
    rec.setdefault("rate_5h_resets", 0)
    rec.setdefault("rate_7d_pct", 0)
    rec.setdefault("rate_7d_resets", 0)
    rec.setdefault("tokens_in", 0)
    rec.setdefault("tokens_out", 0)
    rec.setdefault("cache_write", 0)
    rec.setdefault("cache_read", 0)
    rec.setdefault("cost_usd", 0)
    rec.setdefault("duration_ms", 0)
    rec.setdefault("api_duration_ms", 0)
    rec.setdefault("lines_added", 0)
    rec.setdefault("lines_removed", 0)

    # ── INSERT into metrics ──────────────────────────────────────
    conn.execute(
        """
        INSERT INTO metrics (
            ts, session_id, project_id, project_name, project_path,
            host, account, model,
            ctx_pct, ctx_size,
            rate_5h_pct, rate_5h_resets, rate_7d_pct, rate_7d_resets,
            tokens_in, tokens_out, cache_write, cache_read,
            cost_usd, duration_ms, api_duration_ms,
            lines_added, lines_removed
        ) VALUES (
            :ts, :session_id, :project_id, :project_name, :project_path,
            :host, :account, :model,
            :ctx_pct, :ctx_size,
            :rate_5h_pct, :rate_5h_resets, :rate_7d_pct, :rate_7d_resets,
            :tokens_in, :tokens_out, :cache_write, :cache_read,
            :cost_usd, :duration_ms, :api_duration_ms,
            :lines_added, :lines_removed
        )
        """,
        rec,
    )

    # ── UPSERT into sessions ────────────────────────────────────
    conn.execute(
        """
        INSERT INTO sessions (
            session_id, project_id, project_name, host, account, model,
            started_at, last_seen_at,
            max_ctx_pct, max_tokens_in, max_tokens_out,
            max_cost_usd, max_duration_ms,
            last_tokens_in, last_tokens_out,
            last_cache_write, last_cache_read
        ) VALUES (
            :session_id, :project_id, :project_name, :host, :account, :model,
            :ts, :ts,
            :ctx_pct, :tokens_in, :tokens_out,
            :cost_usd, :duration_ms,
            :tokens_in, :tokens_out,
            :cache_write, :cache_read
        )
        ON CONFLICT(session_id) DO UPDATE SET
            last_seen_at    = MAX(sessions.last_seen_at, excluded.last_seen_at),
            model           = excluded.model,
            account         = excluded.account,
            max_ctx_pct     = MAX(sessions.max_ctx_pct, excluded.max_ctx_pct),
            max_tokens_in   = MAX(sessions.max_tokens_in, excluded.max_tokens_in),
            max_tokens_out  = MAX(sessions.max_tokens_out, excluded.max_tokens_out),
            max_cost_usd    = MAX(sessions.max_cost_usd, excluded.max_cost_usd),
            max_duration_ms = MAX(sessions.max_duration_ms, excluded.max_duration_ms),
            last_tokens_in  = excluded.last_tokens_in,
            last_tokens_out = excluded.last_tokens_out,
            last_cache_write = excluded.last_cache_write,
            last_cache_read  = excluded.last_cache_read
        """,
        rec,
    )

    if commit:
        conn.commit()


# ── Cleanup ──────────────────────────────────────────────────────────


def cleanup(conn: sqlite3.Connection) -> int:
    """Delete metrics older than RETENTION_DAYS, aggregating deltas into global_stats.

    Returns the number of deleted rows.
    """
    threshold = int(time.time()) - config.RETENTION_DAYS * config.SECONDS_PER_DAY

    # Count rows to delete
    row = conn.execute(
        "SELECT COUNT(*) FROM metrics WHERE ts < ?", (threshold,)
    ).fetchone()
    count: int = row[0]
    if count == 0:
        return 0

    # Step 1: Compute session deltas from deletable rows and upsert into global_stats
    conn.execute(
        """
        WITH deletable AS (
            SELECT * FROM metrics WHERE ts < :threshold
        ),
        session_deltas AS (
            SELECT
                session_id,
                project_id,
                MAX(tokens_in)   - MIN(tokens_in)   AS delta_in,
                MAX(tokens_out)  - MIN(tokens_out)  AS delta_out,
                MAX(cache_write) - MIN(cache_write) AS delta_cw,
                MAX(cache_read)  - MIN(cache_read)  AS delta_cr,
                MAX(cost_usd)    - MIN(cost_usd)    AS delta_cost,
                MAX(duration_ms) - MIN(duration_ms) AS delta_dur,
                MAX(lines_added) - MIN(lines_added) AS delta_la,
                MAX(lines_removed) - MIN(lines_removed) AS delta_lr
            FROM deletable
            GROUP BY session_id
        ),
        project_agg AS (
            SELECT
                sd.project_id,
                MAX(d.project_name)  AS project_name,
                MAX(d.project_path)  AS project_path,
                MIN(d.ts)            AS first_seen,
                MAX(d.ts)            AS last_seen,
                COUNT(DISTINCT d.session_id) AS total_sessions,
                SUM(sd.delta_in)     AS total_tokens_in,
                SUM(sd.delta_out)    AS total_tokens_out,
                SUM(sd.delta_cw)     AS total_cache_write,
                SUM(sd.delta_cr)     AS total_cache_read,
                SUM(sd.delta_cost)   AS total_cost_usd,
                SUM(sd.delta_dur)    AS total_duration_ms,
                SUM(sd.delta_la)     AS total_lines_added,
                SUM(sd.delta_lr)     AS total_lines_removed
            FROM session_deltas sd
            JOIN deletable d USING (project_id, session_id)
            GROUP BY sd.project_id
        )
        INSERT INTO global_stats (
            project_id, project_name, project_path,
            first_seen, last_seen, total_sessions,
            total_tokens_in, total_tokens_out,
            total_cache_write, total_cache_read, total_cost_usd,
            total_duration_ms, total_lines_added, total_lines_removed
        )
        SELECT
            project_id, project_name, project_path,
            first_seen, last_seen, total_sessions,
            total_tokens_in, total_tokens_out,
            total_cache_write, total_cache_read, total_cost_usd,
            total_duration_ms, total_lines_added, total_lines_removed
        FROM project_agg
        ON CONFLICT(project_id) DO UPDATE SET
            project_name        = excluded.project_name,
            project_path        = excluded.project_path,
            first_seen          = MIN(COALESCE(global_stats.first_seen, excluded.first_seen), excluded.first_seen),
            last_seen           = MAX(COALESCE(global_stats.last_seen, excluded.last_seen), excluded.last_seen),
            total_sessions      = global_stats.total_sessions      + excluded.total_sessions,
            total_tokens_in     = global_stats.total_tokens_in     + excluded.total_tokens_in,
            total_tokens_out    = global_stats.total_tokens_out    + excluded.total_tokens_out,
            total_cache_write   = global_stats.total_cache_write   + excluded.total_cache_write,
            total_cache_read    = global_stats.total_cache_read    + excluded.total_cache_read,
            total_cost_usd      = global_stats.total_cost_usd      + excluded.total_cost_usd,
            total_duration_ms   = global_stats.total_duration_ms   + excluded.total_duration_ms,
            total_lines_added   = global_stats.total_lines_added   + excluded.total_lines_added,
            total_lines_removed = global_stats.total_lines_removed + excluded.total_lines_removed
        """,
        {"threshold": threshold},
    )

    # Step 2: Delete old rows
    conn.execute("DELETE FROM metrics WHERE ts < ?", (threshold,))

    # Step 3: Reclaim space
    conn.execute("PRAGMA incremental_vacuum")
    conn.commit()

    logger.info("Cleanup: deleted %d records older than %d days", count, config.RETENTION_DAYS)
    return count


# ── Query helpers ────────────────────────────────────────────────────


def get_total_records(conn: sqlite3.Connection) -> int:
    """Return total rows in the metrics table."""
    row = conn.execute("SELECT COUNT(*) FROM metrics").fetchone()
    return row[0]


def get_active_sessions(conn: sqlite3.Connection) -> int:
    """Return sessions active within the last 5 minutes."""
    cutoff = int(time.time()) - 300
    row = conn.execute(
        "SELECT COUNT(*) FROM sessions WHERE last_seen_at >= ?", (cutoff,)
    ).fetchone()
    return row[0]


def get_db_size() -> int:
    """Return database file size in bytes."""
    try:
        return os.path.getsize(config.DB_PATH)
    except OSError:
        return 0


# ── Interval / period helpers ────────────────────────────────────────

INTERVAL_MAP: dict[str, int] = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "1h": 3600,
    "4h": 14400,
    "1d": 86400,
}

PERIOD_MAP: dict[str, int] = {
    "1h": 3600,
    "6h": 21600,
    "1d": 86400,
    "7d": 604800,
    "30d": 2592000,
}


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    """Convert a sqlite3.Row to a plain dict."""
    return dict(row)


def _rows_to_list(rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    """Convert a list of sqlite3.Row to a list of dicts."""
    return [dict(r) for r in rows]


def _account_filter(account: str | None) -> tuple[str, list[Any]]:
    """Return a WHERE clause fragment and params for optional account filter."""
    if account is not None:
        return " AND account = ?", [account]
    return "", []


# ── Dashboard query functions ────────────────────────────────────────


def get_projects(
    conn: sqlite3.Connection, *, account: str | None = None
) -> list[dict[str, Any]]:
    """List projects with last_active timestamp and session count.

    Groups by project_id from the sessions table.
    """
    acct_clause, acct_params = _account_filter(account)
    sql = f"""
        SELECT
            s.project_id,
            s.project_name,
            MAX(s.last_seen_at) AS last_active,
            COUNT(DISTINCT s.session_id) AS sessions_count,
            s.account
        FROM sessions s
        WHERE 1=1 {acct_clause}
        GROUP BY s.project_id
        ORDER BY last_active DESC
    """
    rows = conn.execute(sql, acct_params).fetchall()
    return _rows_to_list(rows)


def get_project_summary(
    conn: sqlite3.Connection,
    project_id: str,
    *,
    account: str | None = None,
    from_ts: int | None = None,
    to_ts: int | None = None,
) -> dict[str, Any]:
    """Project summary: delta-based total tokens, cost, duration, sessions, avg_ctx, models.

    Tokens/cost/duration are computed as MAX-MIN per session (delta-based)
    to reflect actual consumption from cumulative counters.

    When *from_ts* / *to_ts* are provided, only metrics within that time
    range are considered.
    """
    acct_clause, acct_params = _account_filter(account)
    params: list[Any] = [project_id] + acct_params

    ts_clause = ""
    if from_ts is not None:
        ts_clause += " AND ts >= ?"
        params.append(from_ts)
    if to_ts is not None:
        ts_clause += " AND ts <= ?"
        params.append(to_ts)

    sql = f"""
        WITH session_deltas AS (
            SELECT
                session_id,
                MAX(tokens_in)   - MIN(tokens_in)   AS d_in,
                MAX(tokens_out)  - MIN(tokens_out)  AS d_out,
                MAX(cache_write) - MIN(cache_write) AS d_cw,
                MAX(cache_read)  - MIN(cache_read)  AS d_cr,
                MAX(cost_usd)    - MIN(cost_usd)    AS d_cost,
                MAX(duration_ms) - MIN(duration_ms) AS d_dur,
                AVG(ctx_pct)                         AS avg_ctx
            FROM metrics
            WHERE project_id = ? {acct_clause} {ts_clause}
            GROUP BY session_id
        )
        SELECT
            COALESCE(SUM(d_in), 0)   AS tokens_in,
            COALESCE(SUM(d_out), 0)  AS tokens_out,
            COALESCE(SUM(d_cw), 0)   AS cache_write,
            COALESCE(SUM(d_cr), 0)   AS cache_read,
            COALESCE(SUM(d_in) + SUM(d_out), 0) AS total_tokens,
            COALESCE(SUM(d_cost), 0) AS cost_usd,
            COALESCE(SUM(d_dur), 0)  AS duration_ms,
            COUNT(*)                  AS sessions,
            COALESCE(AVG(avg_ctx), 0) AS avg_ctx_pct
        FROM session_deltas
    """
    row = conn.execute(sql, params).fetchone()
    result = _row_to_dict(row) if row else {
        "tokens_in": 0, "tokens_out": 0, "cache_write": 0, "cache_read": 0,
        "total_tokens": 0, "cost_usd": 0, "duration_ms": 0, "sessions": 0,
        "avg_ctx_pct": 0,
    }

    # Models used (same time filter)
    models_params: list[Any] = [project_id] + acct_params
    models_ts_clause = ""
    if from_ts is not None:
        models_ts_clause += " AND ts >= ?"
        models_params.append(from_ts)
    if to_ts is not None:
        models_ts_clause += " AND ts <= ?"
        models_params.append(to_ts)

    models_sql = f"""
        SELECT DISTINCT model FROM metrics
        WHERE project_id = ? {acct_clause} {models_ts_clause}
    """
    models_rows = conn.execute(models_sql, models_params).fetchall()
    result["models_used"] = [r["model"] for r in models_rows]

    return result


def get_all_projects_summary(
    conn: sqlite3.Connection,
    from_ts: int | None = None,
    to_ts: int | None = None,
    *,
    account: str | None = None,
) -> dict[str, Any]:
    """Aggregate summary across ALL projects in one query."""
    acct_clause, acct_params = _account_filter(account)
    ts_clause = ""
    ts_params: list[Any] = []
    if from_ts is not None and to_ts is not None:
        ts_clause = " AND ts >= ? AND ts <= ?"
        ts_params = [from_ts, to_ts]
    params = ts_params + acct_params
    sql = f"""
        WITH session_deltas AS (
            SELECT
                session_id,
                MAX(tokens_in) - MIN(tokens_in) AS d_in,
                MAX(tokens_out) - MIN(tokens_out) AS d_out,
                MAX(cache_write) - MIN(cache_write) AS d_cw,
                MAX(cache_read) - MIN(cache_read) AS d_cr,
                MAX(cost_usd) - MIN(cost_usd) AS d_cost,
                MAX(duration_ms) - MIN(duration_ms) AS d_dur,
                AVG(ctx_pct) AS avg_ctx
            FROM metrics
            WHERE 1=1 {ts_clause} {acct_clause}
            GROUP BY session_id
        )
        SELECT
            COALESCE(SUM(d_in), 0) AS tokens_in,
            COALESCE(SUM(d_out), 0) AS tokens_out,
            COALESCE(SUM(d_cw), 0) AS cache_write,
            COALESCE(SUM(d_cr), 0) AS cache_read,
            COALESCE(SUM(d_in) + SUM(d_out), 0) AS total_tokens,
            COALESCE(SUM(d_cost), 0) AS cost_usd,
            COALESCE(SUM(d_dur), 0) AS duration_ms,
            COUNT(DISTINCT session_id) AS sessions,
            COALESCE(AVG(avg_ctx), 0) AS avg_ctx_pct
        FROM session_deltas
    """
    row = conn.execute(sql, params).fetchone()
    result = _row_to_dict(row) if row else {}
    result["models_used"] = []
    return result


def get_metrics_timeseries(
    conn: sqlite3.Connection,
    project_id: str,
    from_ts: int,
    to_ts: int,
    interval_seconds: int,
    *,
    account: str | None = None,
) -> list[dict[str, Any]]:
    """Time-series aggregated by interval.

    Returns cumulative values: MAX per interval for counters,
    AVG for percentages.
    """
    acct_clause, acct_params = _account_filter(account)
    params: list[Any] = [interval_seconds, interval_seconds, project_id, from_ts, to_ts] + acct_params

    sql = f"""
        SELECT
            (ts / ? * ?) AS bucket_ts,
            AVG(ctx_pct)        AS ctx_pct,
            AVG(rate_5h_pct)    AS rate_5h_pct,
            AVG(rate_7d_pct)    AS rate_7d_pct,
            MAX(tokens_in)      AS tokens_in,
            MAX(tokens_out)     AS tokens_out,
            MAX(cache_write)    AS cache_write,
            MAX(cache_read)     AS cache_read,
            MAX(cost_usd)       AS cost_usd,
            MAX(duration_ms)    AS duration_ms,
            MAX(api_duration_ms) AS api_duration_ms,
            MAX(lines_added)    AS lines_added,
            MAX(lines_removed)  AS lines_removed,
            COUNT(*)            AS samples
        FROM metrics
        WHERE project_id = ? AND ts >= ? AND ts <= ? {acct_clause}
        GROUP BY bucket_ts
        ORDER BY bucket_ts ASC
    """
    rows = conn.execute(sql, params).fetchall()
    return _rows_to_list(rows)


def get_metrics_timeseries_all(
    conn: sqlite3.Connection,
    from_ts: int,
    to_ts: int,
    interval_seconds: int,
    *,
    account: str | None = None,
) -> list[dict[str, Any]]:
    """Aggregate timeseries across ALL projects (not per-project)."""
    acct_clause, acct_params = _account_filter(account)
    bucket = f"(ts / {int(interval_seconds)}) * {int(interval_seconds)}"
    params: list[Any] = [from_ts, to_ts] + acct_params
    sql = f"""
        SELECT
            {bucket} AS bucket_ts,
            AVG(ctx_pct) AS ctx_pct,
            AVG(rate_5h_pct) AS rate_5h_pct,
            AVG(rate_7d_pct) AS rate_7d_pct,
            MAX(tokens_in) AS tokens_in,
            MAX(tokens_out) AS tokens_out,
            MAX(cache_write) AS cache_write,
            MAX(cache_read) AS cache_read,
            MAX(cost_usd) AS cost_usd,
            MAX(duration_ms) AS duration_ms,
            MAX(api_duration_ms) AS api_duration_ms,
            MAX(lines_added) AS lines_added,
            MAX(lines_removed) AS lines_removed,
            COUNT(*) AS samples
        FROM metrics
        WHERE ts >= ? AND ts <= ? {acct_clause}
        GROUP BY {bucket}
        ORDER BY bucket_ts ASC
    """
    return _rows_to_list(conn.execute(sql, params).fetchall())


def get_rate_limits_current(
    conn: sqlite3.Connection, *, account: str | None = None
) -> dict[str, Any]:
    """Latest rate limit values from the most recent metrics record."""
    acct_clause, acct_params = _account_filter(account)
    sql = f"""
        SELECT
            rate_5h_pct,
            rate_5h_resets,
            rate_7d_pct,
            rate_7d_resets,
            ts
        FROM metrics
        WHERE 1=1 {acct_clause}
        ORDER BY ts DESC
        LIMIT 1
    """
    row = conn.execute(sql, acct_params).fetchone()
    if not row:
        return {
            "five_hour": {"pct": 0, "resets_at": 0},
            "seven_day": {"pct": 0, "resets_at": 0},
            "ts": 0,
        }
    r = _row_to_dict(row)
    return {
        "five_hour": {"pct": r["rate_5h_pct"], "resets_at": r["rate_5h_resets"]},
        "seven_day": {"pct": r["rate_7d_pct"], "resets_at": r["rate_7d_resets"]},
        "ts": r["ts"],
    }


def get_rate_limits_history(
    conn: sqlite3.Connection,
    from_ts: int,
    to_ts: int,
    *,
    account: str | None = None,
) -> list[dict[str, Any]]:
    """Rate limits history within the given time range."""
    acct_clause, acct_params = _account_filter(account)
    params: list[Any] = [from_ts, to_ts] + acct_params
    sql = f"""
        SELECT
            (ts / 300) * 300 AS ts,
            AVG(rate_5h_pct) AS rate_5h_pct,
            MAX(rate_5h_resets) AS rate_5h_resets,
            AVG(rate_7d_pct) AS rate_7d_pct,
            MAX(rate_7d_resets) AS rate_7d_resets
        FROM metrics
        WHERE ts >= ? AND ts <= ? {acct_clause}
          AND (rate_5h_pct > 0 OR rate_7d_pct > 0)
        GROUP BY ts / 300
        ORDER BY ts ASC
    """
    rows = conn.execute(sql, params).fetchall()
    return _rows_to_list(rows)


def get_context_window_analysis(
    conn: sqlite3.Connection,
    period_seconds: int,
    *,
    account: str | None = None,
    project_id: str | None = None,
) -> dict[str, Any]:
    """Context window analysis for a given period.

    Returns min/max/avg ctx_size, compressions count, and window size breakdown.
    Optionally filtered by *project_id*.
    """
    acct_clause, acct_params = _account_filter(account)
    proj_clause = ""
    proj_params: list[Any] = []
    if project_id is not None:
        proj_clause = " AND project_id = ?"
        proj_params = [project_id]
    cutoff = int(time.time()) - period_seconds
    params: list[Any] = [cutoff] + acct_params + proj_params

    # Basic stats
    stats_sql = f"""
        SELECT
            MIN(ctx_size) AS min_size,
            MAX(ctx_size) AS max_size,
            AVG(ctx_size) AS avg_size,
            AVG(ctx_pct)  AS avg_pct,
            COUNT(*)      AS total_records
        FROM metrics
        WHERE ts >= ? {acct_clause} {proj_clause}
    """
    row = conn.execute(stats_sql, params).fetchone()
    result = _row_to_dict(row) if row else {
        "min_size": 0, "max_size": 0, "avg_size": 0, "avg_pct": 0,
        "total_records": 0,
    }

    # Compression detection: ctx_pct drop > 20% within same session
    compress_sql = f"""
        WITH ordered AS (
            SELECT
                session_id,
                ctx_pct,
                LAG(ctx_pct) OVER (PARTITION BY session_id ORDER BY ts) AS prev_ctx
            FROM metrics
            WHERE ts >= ? {acct_clause} {proj_clause}
        )
        SELECT COUNT(*) AS compressions_count
        FROM ordered
        WHERE prev_ctx IS NOT NULL AND (prev_ctx - ctx_pct) > 20
    """
    crow = conn.execute(compress_sql, params).fetchone()
    result["compressions_count"] = crow["compressions_count"] if crow else 0

    return result


def get_global_stats(
    conn: sqlite3.Connection, *, account: str | None = None
) -> dict[str, Any]:
    """Global statistics combining global_stats table and current metrics data.

    Merges historical aggregates (from cleanup) with live session deltas.
    """
    # 1. Aggregated historical data from global_stats
    gs_sql = """
        SELECT
            COALESCE(SUM(total_tokens_in), 0)     AS hist_tokens_in,
            COALESCE(SUM(total_tokens_out), 0)    AS hist_tokens_out,
            COALESCE(SUM(total_cache_write), 0)   AS hist_cache_write,
            COALESCE(SUM(total_cache_read), 0)    AS hist_cache_read,
            COALESCE(SUM(total_cost_usd), 0)      AS hist_cost,
            COALESCE(SUM(total_duration_ms), 0)   AS hist_duration,
            COALESCE(SUM(total_sessions), 0)      AS hist_sessions,
            COALESCE(SUM(total_lines_added), 0)   AS hist_lines_added,
            COALESCE(SUM(total_lines_removed), 0) AS hist_lines_removed,
            MIN(first_seen)                        AS first_seen
        FROM global_stats
    """
    gs_row = conn.execute(gs_sql).fetchone()
    hist = _row_to_dict(gs_row) if gs_row else {}

    # 2. Live cumulative totals from sessions table (real lifetime values)
    acct_clause, acct_params = _account_filter(account)
    live_sql = f"""
        SELECT
            COALESCE(SUM(max_tokens_in), 0)    AS live_tokens_in,
            COALESCE(SUM(max_tokens_out), 0)   AS live_tokens_out,
            COALESCE(SUM(last_cache_write), 0) AS live_cache_write,
            COALESCE(SUM(last_cache_read), 0)  AS live_cache_read,
            COALESCE(SUM(max_cost_usd), 0)     AS live_cost,
            COALESCE(SUM(max_duration_ms), 0)  AS live_duration,
            COUNT(*)                             AS live_sessions,
            0 AS live_lines_added,
            0 AS live_lines_removed
        FROM sessions
        WHERE 1=1 {acct_clause}
    """
    live_row = conn.execute(live_sql, acct_params).fetchone()
    live = _row_to_dict(live_row) if live_row else {}

    # Lines added/removed: from metrics (sessions table doesn't track these)
    lines_sql = f"""
        SELECT
            COALESCE(SUM(d_la), 0) AS live_lines_added,
            COALESCE(SUM(d_lr), 0) AS live_lines_removed
        FROM (
            SELECT
                MAX(lines_added) - MIN(lines_added) AS d_la,
                MAX(lines_removed) - MIN(lines_removed) AS d_lr
            FROM metrics
            WHERE 1=1 {acct_clause}
            GROUP BY session_id
        )
    """
    lines_row = conn.execute(lines_sql, acct_params).fetchone()
    if lines_row:
        live["live_lines_added"] = lines_row["live_lines_added"]
        live["live_lines_removed"] = lines_row["live_lines_removed"]

    # 3. Per-project breakdown
    proj_sql = """
        SELECT project_id, project_name, project_path,
               total_tokens_in, total_tokens_out, total_cost_usd,
               total_sessions, first_seen, last_seen
        FROM global_stats
        ORDER BY last_seen DESC
    """
    proj_rows = conn.execute(proj_sql).fetchall()
    projects = _rows_to_list(proj_rows)

    # 4. First seen from metrics if global_stats is empty
    first_seen = hist.get("first_seen")
    if not first_seen:
        fs_row = conn.execute("SELECT MIN(ts) AS fs FROM metrics").fetchone()
        first_seen = fs_row["fs"] if fs_row and fs_row["fs"] else 0

    return {
        "total_tokens_in": hist.get("hist_tokens_in", 0) + live.get("live_tokens_in", 0),
        "total_tokens_out": hist.get("hist_tokens_out", 0) + live.get("live_tokens_out", 0),
        "total_cache_write": hist.get("hist_cache_write", 0) + live.get("live_cache_write", 0),
        "total_cache_read": hist.get("hist_cache_read", 0) + live.get("live_cache_read", 0),
        "total_cost_usd": hist.get("hist_cost", 0) + live.get("live_cost", 0),
        "total_duration_ms": hist.get("hist_duration", 0) + live.get("live_duration", 0),
        "total_sessions": hist.get("hist_sessions", 0) + live.get("live_sessions", 0),
        "total_lines_added": hist.get("hist_lines_added", 0) + live.get("live_lines_added", 0),
        "total_lines_removed": hist.get("hist_lines_removed", 0) + live.get("live_lines_removed", 0),
        "first_seen": first_seen,
        "last_seen": conn.execute(
            "SELECT MAX(last_seen_at) AS ls FROM sessions"
        ).fetchone()["ls"] or 0,
        "projects": projects,
    }


def get_sessions(
    conn: sqlite3.Connection,
    *,
    project_id: str | None = None,
    account: str | None = None,
    limit: int = 50,
    from_ts: int | None = None,
    to_ts: int | None = None,
) -> list[dict[str, Any]]:
    """List sessions, optionally filtered by project, account, and time range."""
    clauses: list[str] = []
    params: list[Any] = []

    if project_id is not None:
        clauses.append("s.project_id = ?")
        params.append(project_id)
    if account is not None:
        clauses.append("s.account = ?")
        params.append(account)
    if from_ts is not None:
        clauses.append("s.last_seen_at >= ?")
        params.append(from_ts)
    if to_ts is not None:
        clauses.append("s.last_seen_at <= ?")
        params.append(to_ts)

    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    params.append(limit)

    # Period-based delta subqueries (if from_ts/to_ts provided)
    period_cols = ""
    if from_ts is not None and to_ts is not None:
        period_cols = f""",
            (SELECT MAX(m.tokens_in) - MIN(m.tokens_in) FROM metrics m
             WHERE m.session_id = s.session_id AND m.ts >= {int(from_ts)} AND m.ts <= {int(to_ts)}) AS period_tokens_in,
            (SELECT MAX(m.tokens_out) - MIN(m.tokens_out) FROM metrics m
             WHERE m.session_id = s.session_id AND m.ts >= {int(from_ts)} AND m.ts <= {int(to_ts)}) AS period_tokens_out,
            (SELECT MAX(m.cost_usd) - MIN(m.cost_usd) FROM metrics m
             WHERE m.session_id = s.session_id AND m.ts >= {int(from_ts)} AND m.ts <= {int(to_ts)}) AS period_cost_usd,
            (SELECT MAX(m.duration_ms) - MIN(m.duration_ms) FROM metrics m
             WHERE m.session_id = s.session_id AND m.ts >= {int(from_ts)} AND m.ts <= {int(to_ts)}) AS period_duration_ms"""

    sql = f"""
        SELECT
            s.session_id,
            s.project_id,
            s.project_name,
            s.host,
            s.account,
            s.model,
            s.started_at,
            s.last_seen_at,
            s.last_seen_at - s.started_at AS duration_seconds,
            s.max_ctx_pct,
            s.max_tokens_in,
            s.max_tokens_out,
            s.max_cost_usd,
            s.max_duration_ms,
            (SELECT m.ctx_size FROM metrics m
             WHERE m.session_id = s.session_id
             ORDER BY m.ts DESC LIMIT 1) AS last_ctx_size,
            (SELECT m.ctx_pct FROM metrics m
             WHERE m.session_id = s.session_id
             ORDER BY m.ts DESC LIMIT 1) AS last_ctx_pct
            {period_cols}
        FROM sessions s
        {where}
        ORDER BY s.last_seen_at DESC
        LIMIT ?
    """
    rows = conn.execute(sql, params).fetchall()
    return _rows_to_list(rows)


def get_response_time(
    conn: sqlite3.Connection,
    project_id: str,
    from_ts: int,
    to_ts: int,
    *,
    account: str | None = None,
) -> list[dict[str, Any]]:
    """Compute api_duration deltas between consecutive records per session.

    Returns per-record delta of api_duration_ms and tokens_in where
    both deltas are positive (indicating a real API call happened).
    """
    acct_clause, acct_params = _account_filter(account)
    params: list[Any] = [project_id, from_ts, to_ts] + acct_params

    sql = f"""
        WITH ordered AS (
            SELECT
                ts,
                session_id,
                api_duration_ms,
                tokens_in,
                LAG(api_duration_ms) OVER (PARTITION BY session_id ORDER BY ts) AS prev_api_dur,
                LAG(tokens_in) OVER (PARTITION BY session_id ORDER BY ts) AS prev_tokens_in
            FROM metrics
            WHERE project_id = ? AND ts >= ? AND ts <= ? {acct_clause}
        )
        SELECT
            ts,
            session_id,
            (api_duration_ms - prev_api_dur) AS delta_api_ms,
            (tokens_in - prev_tokens_in)     AS delta_tokens_in
        FROM ordered
        WHERE prev_api_dur IS NOT NULL
          AND (api_duration_ms - prev_api_dur) > 0
          AND (tokens_in - prev_tokens_in) > 0
        ORDER BY ts ASC
    """
    rows = conn.execute(sql, params).fetchall()
    return _rows_to_list(rows)


# ── Analytics: rate estimation, prediction ───────────────────────────


def compute_rate_windows(conn: sqlite3.Connection) -> int:
    """Compute token budget estimates using complete rate-limit windows.

    Groups metrics by normalized resets_at (5-min buckets to absorb clock skew),
    aggregates token deltas per session then across sessions, and estimates the
    total token cap for each window.  Results are upserted into rate_windows.

    Returns the number of windows upserted.
    """
    inserted = 0

    for window_type, rate_col, resets_col in [
        ("5h", "rate_5h_pct", "rate_5h_resets"),
        ("7d", "rate_7d_pct", "rate_7d_resets"),
    ]:
        # Normalize resets_at to 5-min buckets to absorb clock skew
        norm = f"({resets_col} / 300) * 300"

        # Single query: aggregate per window (grouped by normalized resets_at)
        sql = f"""
            WITH session_deltas AS (
                SELECT
                    {norm} AS norm_resets,
                    session_id,
                    MAX(tokens_out) - MIN(tokens_out) AS d_out,
                    MAX(tokens_in) - MIN(tokens_in) AS d_in,
                    MIN(ts) AS first_ts,
                    MAX(ts) AS last_ts,
                    MAX({rate_col}) AS max_rate
                FROM metrics
                WHERE {resets_col} > 0 AND {rate_col} > 0
                GROUP BY {norm}, session_id
            ),
            window_agg AS (
                SELECT
                    norm_resets,
                    SUM(d_out) AS total_output,
                    SUM(d_in) AS total_input,
                    SUM(d_out + d_in) AS total_in_out,
                    MAX(max_rate) AS final_rate_pct,
                    MIN(first_ts) AS window_start_ts,
                    MAX(last_ts) AS window_end_ts
                FROM session_deltas
                GROUP BY norm_resets
            )
            SELECT * FROM window_agg
            WHERE total_in_out > 0
              AND final_rate_pct >= 3.0
            ORDER BY norm_resets ASC
        """
        rows = conn.execute(sql).fetchall()

        conn.execute("BEGIN IMMEDIATE")
        try:
            for i, row in enumerate(rows):
                # A window is complete if a later window exists
                is_complete = 1 if i < len(rows) - 1 else 0

                frp = row["final_rate_pct"]
                to = row["total_output"]
                ti = row["total_input"]
                tio = row["total_in_out"]

                # Estimate cap: tokens / rate% * 100
                cap_out = int(round(to / frp * 100)) if frp >= 3 and to > 0 else None
                cap_in = int(round(ti / frp * 100)) if frp >= 3 and ti > 0 else None
                cap_all = int(round(tio / frp * 100)) if frp >= 3 and tio > 0 else None

                # Filter unreasonable caps (must be 100k..50M)
                if cap_out is not None and not (100_000 <= cap_out <= 50_000_000):
                    cap_out = None
                if cap_in is not None and not (100_000 <= cap_in <= 50_000_000):
                    cap_in = None
                if cap_all is not None and not (100_000 <= cap_all <= 50_000_000):
                    cap_all = None

                conn.execute("""
                    INSERT INTO rate_windows
                        (window_type, resets_at, window_start_ts, window_end_ts,
                         final_rate_pct, total_output, total_input, total_in_out,
                         estimated_cap_output, estimated_cap_input, estimated_cap_all,
                         is_complete)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(window_type, resets_at) DO UPDATE SET
                        window_end_ts = excluded.window_end_ts,
                        final_rate_pct = excluded.final_rate_pct,
                        total_output = excluded.total_output,
                        total_input = excluded.total_input,
                        total_in_out = excluded.total_in_out,
                        estimated_cap_output = excluded.estimated_cap_output,
                        estimated_cap_input = excluded.estimated_cap_input,
                        estimated_cap_all = excluded.estimated_cap_all,
                        is_complete = excluded.is_complete
                """, (
                    window_type, row["norm_resets"],
                    row["window_start_ts"], row["window_end_ts"],
                    frp, to, ti, tio,
                    cap_out, cap_in, cap_all, is_complete,
                ))
                inserted += 1
            conn.commit()
        except Exception:
            conn.rollback()
            raise

    # Cleanup old windows (>90 days)
    cutoff = int(time.time()) - 90 * config.SECONDS_PER_DAY
    conn.execute("DELETE FROM rate_windows WHERE window_end_ts < ?", (cutoff,))
    conn.commit()

    logger.info("Rate windows: upserted %d windows", inserted)
    return inserted


def predict_exhaustion(
    conn: sqlite3.Connection, *, account: str | None = None
) -> dict[str, Any]:
    """Predict when rate limits will reach 100% based on recent trend.

    Algorithm (spec 7.3):
    - Fetch rate_5h_pct and rate_7d_pct history for the last hour.
    - Apply linear regression (simple two-point: first vs last).
    - Compute minutes until 100% exhaustion.

    Returns dict with five_hour and seven_day predictions.
    """
    acct_clause, acct_params = _account_filter(account)
    cutoff = int(time.time()) - 3600  # last hour

    result: dict[str, Any] = {}

    for key, rate_col in [("five_hour", "rate_5h_pct"), ("seven_day", "rate_7d_pct")]:
        params: list[Any] = [cutoff] + acct_params
        sql = f"""
            SELECT ts, {rate_col} AS rate_pct
            FROM metrics
            WHERE ts >= ? {acct_clause}
              AND {rate_col} IS NOT NULL
              AND {rate_col} > 0
            ORDER BY ts ASC
        """
        rows = conn.execute(sql, params).fetchall()

        if len(rows) < 2:
            result[key] = {
                "minutes_to_100": None,
                "rate_per_min": None,
                "current_pct": rows[-1]["rate_pct"] if rows else None,
                "estimated_at": None,
            }
            continue

        first = rows[0]
        last = rows[-1]
        dt_min = (last["ts"] - first["ts"]) / 60.0
        d_pct = last["rate_pct"] - first["rate_pct"]

        if dt_min <= 0 or d_pct <= 0:
            result[key] = {
                "minutes_to_100": None,
                "rate_per_min": None,
                "current_pct": round(last["rate_pct"], 2),
                "estimated_at": None,
            }
            continue

        rate_per_min = d_pct / dt_min
        remaining = 100.0 - last["rate_pct"]

        if remaining <= 0:
            minutes_to_100 = 0
        else:
            minutes_to_100 = remaining / rate_per_min

        result[key] = {
            "minutes_to_100": round(minutes_to_100),
            "rate_per_min": round(rate_per_min, 3),
            "current_pct": round(last["rate_pct"], 2),
            "estimated_at": last["ts"] + int(minutes_to_100 * 60),
        }

    return result


def get_rate_estimates(
    conn: sqlite3.Connection, window_type: str = "5h"
) -> dict[str, Any]:
    """Return aggregated rate budget estimates from rate_windows.

    Self-calibrates by picking the token type (output, input, all) with the
    lowest median absolute deviation across completed windows.

    Returns min, max, avg, median, sample count, and the auto-selected
    token_type for the given window type.
    """
    if window_type not in ("5h", "7d"):
        window_type = "5h"

    # Try completed windows first (last 90 days)
    rows = conn.execute("""
        SELECT estimated_cap_output, estimated_cap_input, estimated_cap_all
        FROM rate_windows
        WHERE window_type = ? AND is_complete = 1
        ORDER BY resets_at DESC
        LIMIT 100
    """, (window_type,)).fetchall()

    if len(rows) < 1:
        # Fallback: include current incomplete window if rate% is meaningful
        rows = conn.execute("""
            SELECT estimated_cap_output, estimated_cap_input, estimated_cap_all
            FROM rate_windows
            WHERE window_type = ? AND final_rate_pct >= 5
            ORDER BY resets_at DESC
            LIMIT 10
        """, (window_type,)).fetchall()

    if not rows:
        return {"window": window_type, "avg": None, "min": None, "max": None,
                "median": None, "samples": 0, "token_type": None}

    # Self-calibrate: pick token type with lowest MAD (median absolute deviation)
    best_type = "all"
    best_mad = float("inf")
    for ttype, col in [("output", "estimated_cap_output"),
                        ("input", "estimated_cap_input"),
                        ("all", "estimated_cap_all")]:
        vals = [r[col] for r in rows if r[col] is not None]
        if len(vals) >= 3:
            med = sorted(vals)[len(vals) // 2]
            mad = sum(abs(v - med) for v in vals) / len(vals)
            if mad < best_mad:
                best_mad = mad
                best_type = ttype
        elif len(vals) >= 1 and best_mad == float("inf"):
            best_type = ttype  # fallback to whatever has data

    col = f"estimated_cap_{best_type}"
    caps = [r[col] for r in rows if r[col] is not None]

    if not caps:
        return {"window": window_type, "avg": None, "min": None, "max": None,
                "median": None, "samples": 0, "token_type": best_type}

    caps_sorted = sorted(caps)
    return {
        "window": window_type,
        "avg": int(sum(caps) / len(caps)),
        "min": min(caps),
        "max": max(caps),
        "median": caps_sorted[len(caps_sorted) // 2],
        "samples": len(caps),
        "token_type": best_type,
    }
