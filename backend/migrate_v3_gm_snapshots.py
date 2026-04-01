"""
migrate_v3_gm_snapshots.py — Add cost snapshot columns for split GM% calculations.

New columns:
  fulfillment_boxes.shipping_cost_snapshot  (REAL, nullable)
  fulfillment_boxes.packaging_cost_snapshot (REAL, nullable)
  box_line_items.cost_per_lb_snapshot       (REAL, nullable)
  box_line_items.weight_lb_snapshot         (REAL, nullable)

Safe to re-run: uses IF NOT EXISTS / column-existence guards.

Run:  cd backend && python migrate_v3_gm_snapshots.py
"""
import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(__file__), "fulfillment.db")


def _has_column(cursor, table, column):
    cols = {row[1] for row in cursor.execute(f"PRAGMA table_info({table})")}
    return column in cols


def run():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("PRAGMA journal_mode=WAL")

    # ── FulfillmentBox snapshot columns ──────────────────────────────────────
    for col in ("shipping_cost_snapshot", "packaging_cost_snapshot"):
        if not _has_column(c, "fulfillment_boxes", col):
            print(f"Adding fulfillment_boxes.{col}...")
            c.execute(f"ALTER TABLE fulfillment_boxes ADD COLUMN {col} REAL")
        else:
            print(f"fulfillment_boxes.{col} already exists — skipping")

    # ── BoxLineItem snapshot columns ─────────────────────────────────────────
    for col in ("cost_per_lb_snapshot", "weight_lb_snapshot"):
        if not _has_column(c, "box_line_items", col):
            print(f"Adding box_line_items.{col}...")
            c.execute(f"ALTER TABLE box_line_items ADD COLUMN {col} REAL")
        else:
            print(f"box_line_items.{col} already exists — skipping")

    conn.commit()
    conn.close()
    print("Migration complete.")


if __name__ == "__main__":
    run()
