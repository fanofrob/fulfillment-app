"""
One-shot data migration from a local SQLite DB to a target database (Postgres
on Railway, in our case).

Usage (from backend/):
  # Dry-run — just count rows per table in the source
  venv/bin/python scripts/migrate_sqlite_to_postgres.py --count

  # Actual copy
  SOURCE_DATABASE_URL="sqlite:///./fulfillment.db" \
  TARGET_DATABASE_URL="postgresql://user:pass@host:5432/dbname" \
  venv/bin/python scripts/migrate_sqlite_to_postgres.py

Behavior:
  - Creates all tables on the target from SQLAlchemy models (idempotent).
  - Copies every table in FK dependency order using SQLAlchemy Core so type
    coercions (bool, datetime, JSON) are handled automatically.
  - Refuses to copy into a non-empty target table unless --overwrite is passed
    (safer default — avoids accidental duplicate inserts).
  - After copy, resets Postgres sequences for any `id` column so future inserts
    don't collide with migrated rows.

Requires: psycopg2-binary (already in requirements.txt).
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

# Make `backend/` importable when this is run as `python scripts/…`
HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent
sys.path.insert(0, str(BACKEND))

from sqlalchemy import create_engine, event, text  # noqa: E402
import models  # noqa: E402


def _normalize_url(url: str) -> str:
    if url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql://", 1)
    return url


def _make_engine(url: str):
    if url.startswith("sqlite"):
        return create_engine(url, connect_args={"check_same_thread": False})
    engine = create_engine(url, pool_pre_ping=True)
    # SQLite tolerates orphan FKs; Postgres doesn't. Disable constraint checks
    # per session during the bulk load so historical orphan rows still migrate.
    # `session_replication_role = replica` is the standard Postgres trick for
    # bulk data loads (requires superuser; Railway's default user qualifies).
    @event.listens_for(engine, "connect")
    def _pg_disable_fks(dbapi_conn, _record):
        with dbapi_conn.cursor() as cur:
            cur.execute("SET session_replication_role = 'replica'")
    return engine


def _count_rows(engine, tables):
    with engine.connect() as conn:
        for t in tables:
            n = conn.execute(text(f"SELECT COUNT(*) FROM {t.name}")).scalar()
            print(f"  {t.name:<40s} {n:>8d}")


def _copy_table(src_engine, tgt_engine, table, overwrite: bool) -> int:
    """Copy one table from src to tgt. Returns number of rows inserted."""
    with src_engine.connect() as src_conn:
        rows = [dict(r._mapping) for r in src_conn.execute(table.select())]

    if not rows:
        print(f"  {table.name}: source empty, nothing to copy")
        return 0

    with tgt_engine.begin() as tgt_conn:
        existing = tgt_conn.execute(text(f"SELECT COUNT(*) FROM {table.name}")).scalar() or 0
        if existing > 0:
            if not overwrite:
                print(f"  {table.name}: target already has {existing} rows — skipping (use --overwrite)")
                return 0
            tgt_conn.execute(text(f"DELETE FROM {table.name}"))

        tgt_conn.execute(table.insert(), rows)

    print(f"  {table.name}: copied {len(rows)} rows")
    return len(rows)


def _reset_postgres_sequences(tgt_engine, tables):
    """After bulk insert, PG sequences still point at 1 — bump them to MAX(id)+1
    so the next auto-assigned ID doesn't collide with a migrated row."""
    with tgt_engine.begin() as conn:
        for t in tables:
            if "id" not in t.c:
                continue
            try:
                conn.execute(
                    text(
                        f"""
                        SELECT setval(
                          pg_get_serial_sequence(:tname, 'id'),
                          COALESCE((SELECT MAX(id) FROM {t.name}), 1),
                          (SELECT MAX(id) FROM {t.name}) IS NOT NULL
                        )
                        """
                    ),
                    {"tname": t.name},
                )
            except Exception as e:
                print(f"  (warn) couldn't reset sequence for {t.name}: {e}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--count", action="store_true",
        help="Just print row counts from the source DB and exit.",
    )
    parser.add_argument(
        "--overwrite", action="store_true",
        help="If a target table already has rows, DELETE them first (dangerous).",
    )
    args = parser.parse_args()

    source_url = _normalize_url(os.getenv("SOURCE_DATABASE_URL", "sqlite:///./fulfillment.db"))
    src_engine = _make_engine(source_url)

    tables = list(models.Base.metadata.sorted_tables)

    if args.count:
        print(f"Source: {source_url}")
        print("Row counts:")
        _count_rows(src_engine, tables)
        return

    target_url = os.getenv("TARGET_DATABASE_URL") or os.getenv("DATABASE_URL")
    if not target_url:
        print("ERROR: set TARGET_DATABASE_URL (or DATABASE_URL) to the Postgres connection string.")
        sys.exit(1)
    target_url = _normalize_url(target_url)

    if target_url.startswith("sqlite"):
        print("ERROR: target looks like SQLite — this script is meant for SQLite → Postgres.")
        sys.exit(1)

    tgt_engine = _make_engine(target_url)

    print(f"Source: {source_url}")
    print(f"Target: {target_url.split('@')[-1] if '@' in target_url else target_url}")
    print("Creating target schema (if missing)...")
    models.Base.metadata.create_all(bind=tgt_engine)

    print("Copying tables in dependency order:")
    total = 0
    for t in tables:
        total += _copy_table(src_engine, tgt_engine, t, overwrite=args.overwrite)

    print("Resetting Postgres sequences...")
    _reset_postgres_sequences(tgt_engine, tables)

    print(f"Done. Copied {total} rows across {len(tables)} tables.")


if __name__ == "__main__":
    main()
