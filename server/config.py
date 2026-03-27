"""Configuration for statusline-metrics server.

All settings loaded from environment variables with sensible defaults.
"""

from __future__ import annotations

import os
from pathlib import Path


# ── Network ──────────────────────────────────────────────────────────
HOST: str = os.environ.get("METRICS_HOST", "127.0.0.1")
PORT: int = int(os.environ.get("METRICS_PORT", "9177"))

# ── Authentication ───────────────────────────────────────────────────
# If set, remote (non-localhost) POST requests must include
# Authorization: Bearer <key> header.  GET requests are always open.
API_KEY: str = os.environ.get("METRICS_API_KEY", "")

# ── Storage ──────────────────────────────────────────────────────────
DB_PATH: str = os.environ.get(
    "METRICS_DB_PATH",
    str(Path.home() / ".claude" / "metrics" / "statusline-metrics.db"),
)
RETENTION_DAYS: int = int(os.environ.get("METRICS_RETENTION_DAYS", "30"))

# ── Pending fallback ─────────────────────────────────────────────────
PENDING_JSONL: str = os.environ.get(
    "METRICS_PENDING_JSONL",
    str(Path.home() / ".claude" / "metrics" / "pending.jsonl"),
)

# ── Time constants ───────────────────────────────────────────────────
SECONDS_PER_DAY: int = 86400

# ── Misc ─────────────────────────────────────────────────────────────
VERSION: str = "1.0.0"
