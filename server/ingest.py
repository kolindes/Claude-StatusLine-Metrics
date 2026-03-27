"""Ingest pending metrics from the JSONL fallback file.

When the metrics server is unreachable, the statusline client appends
JSON records to ~/.claude/metrics/pending.jsonl.  This module reads
the file, inserts each record into SQLite, then removes the file.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from pathlib import Path

from server import config
from server.database import insert_metric

logger = logging.getLogger("metrics.ingest")


def ingest_pending(conn: sqlite3.Connection) -> int:
    """Read pending.jsonl, insert valid records, delete the file.

    Returns the number of successfully ingested records.
    """
    path = Path(config.PENDING_JSONL).expanduser()

    if not path.exists():
        return 0

    try:
        size = path.stat().st_size
    except OSError:
        return 0

    if size == 0:
        try:
            path.unlink()
        except OSError:
            pass
        return 0

    ingested: int = 0
    errors: int = 0

    # Atomically rename before reading to avoid TOCTOU race with the writer
    processing_path = path.with_suffix('.jsonl.processing')
    try:
        path.rename(processing_path)
    except OSError as exc:
        logger.error("Failed to rename pending.jsonl for processing: %s", exc)
        return 0

    try:
        with open(processing_path, encoding="utf-8") as fh:
            for line_num, line in enumerate(fh, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                    insert_metric(conn, record, commit=False)
                    ingested += 1
                except (json.JSONDecodeError, KeyError, sqlite3.Error) as exc:
                    logger.warning("pending.jsonl line %d: %s", line_num, exc)
                    errors += 1
        # Single commit for the entire batch
        if ingested:
            conn.commit()
    except OSError as exc:
        logger.error("Failed to read pending.jsonl: %s", exc)
        return 0

    # Remove the processing file after successful ingestion
    try:
        processing_path.unlink()
    except OSError as exc:
        logger.warning("Could not remove pending.jsonl.processing: %s", exc)

    if ingested or errors:
        logger.info(
            "Ingested %d pending records (%d errors)", ingested, errors
        )

    return ingested
