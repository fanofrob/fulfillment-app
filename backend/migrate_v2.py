"""
migrate_v2.py — One-time migration: session-based → persistent inventory + new order statuses.

Run ONCE before deploying the new application code:
    cd backend && python migrate_v2.py

Safe to re-run: uses IF NOT EXISTS / existence guards throughout.
"""
import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(__file__), "fulfillment.db")


def run():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()

    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA foreign_keys=OFF")

    tables = {row[0] for row in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    print(f"Existing tables: {sorted(tables)}")

    # ── STEP 1: Create new inventory_items_v2 ────────────────────────────────
    print("Step 1: Creating inventory_items_v2...")
    c.execute("""
        CREATE TABLE IF NOT EXISTS inventory_items_v2 (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            pick_sku      TEXT    NOT NULL,
            warehouse     TEXT    NOT NULL,
            name          TEXT,
            on_hand_qty   REAL    NOT NULL DEFAULT 0.0,
            committed_qty REAL    NOT NULL DEFAULT 0.0,
            available_qty REAL    NOT NULL DEFAULT 0.0,
            shipped_qty   REAL    NOT NULL DEFAULT 0.0,
            days_on_hand  REAL,
            batch_code    TEXT,
            created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at    DATETIME,
            UNIQUE(pick_sku, warehouse)
        )
    """)

    # ── STEP 2: Create inventory_adjustments ─────────────────────────────────
    print("Step 2: Creating inventory_adjustments...")
    c.execute("""
        CREATE TABLE IF NOT EXISTS inventory_adjustments (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            pick_sku         TEXT    NOT NULL,
            warehouse        TEXT    NOT NULL,
            delta            REAL    NOT NULL,
            adjustment_type  TEXT    NOT NULL,
            note             TEXT,
            shopify_order_id TEXT,
            created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)
    c.execute("CREATE INDEX IF NOT EXISTS ix_inv_adj_pick_sku ON inventory_adjustments(pick_sku)")
    c.execute("CREATE INDEX IF NOT EXISTS ix_inv_adj_order ON inventory_adjustments(shopify_order_id)")

    # ── STEP 3: Add new columns to shopify_orders ─────────────────────────────
    print("Step 3: Adding new columns to shopify_orders...")
    if "shopify_orders" in tables:
        existing_cols = {row[1] for row in c.execute("PRAGMA table_info(shopify_orders)")}
        new_cols = {
            "app_status":             "TEXT NOT NULL DEFAULT 'not_processed'",
            "assigned_warehouse":     "TEXT NOT NULL DEFAULT 'walnut'",
            "shipstation_order_id":   "TEXT",
            "shipstation_order_key":  "TEXT",
            "tracking_number":        "TEXT",
            "last_synced_at":         "DATETIME",
        }
        for col, definition in new_cols.items():
            if col not in existing_cols:
                c.execute(f"ALTER TABLE shopify_orders ADD COLUMN {col} {definition}")
                print(f"  Added column: {col}")
            else:
                print(f"  Column already exists: {col}")

        # ── STEP 4: Derive app_status from fulfillment_status ─────────────────
        print("Step 4: Deriving app_status from fulfillment_status...")
        c.execute("""
            UPDATE shopify_orders
            SET app_status = CASE
                WHEN fulfillment_status = 'fulfilled' THEN 'fulfilled'
                WHEN fulfillment_status = 'partial'   THEN 'partially_fulfilled'
                ELSE 'not_processed'
            END
            WHERE app_status = 'not_processed'
        """)
        print(f"  Updated {c.rowcount} rows")

        # ── STEP 5: Remove session_id from shopify_orders ─────────────────────
        # SQLite can't DROP COLUMN — must recreate the table
        print("Step 5: Removing session_id from shopify_orders (table recreate)...")
        existing_cols = {row[1] for row in c.execute("PRAGMA table_info(shopify_orders)")}
        if "session_id" in existing_cols:
            c.execute("""
                CREATE TABLE IF NOT EXISTS shopify_orders_new (
                    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
                    shopify_order_id      TEXT    NOT NULL UNIQUE,
                    shopify_order_number  TEXT,
                    customer_name         TEXT,
                    customer_email        TEXT,
                    shipping_name         TEXT,
                    shipping_address1     TEXT,
                    shipping_address2     TEXT,
                    shipping_city         TEXT,
                    shipping_province     TEXT,
                    shipping_zip          TEXT,
                    shipping_country      TEXT,
                    tags                  TEXT,
                    financial_status      TEXT,
                    fulfillment_status    TEXT,
                    total_price           REAL,
                    subtotal_price        REAL,
                    total_discounts       REAL,
                    total_weight_g        INTEGER,
                    note                  TEXT,
                    created_at_shopify    DATETIME,
                    pulled_at             DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at            DATETIME,
                    app_status            TEXT NOT NULL DEFAULT 'not_processed',
                    assigned_warehouse    TEXT NOT NULL DEFAULT 'walnut',
                    shipstation_order_id  TEXT,
                    shipstation_order_key TEXT,
                    tracking_number       TEXT,
                    last_synced_at        DATETIME
                )
            """)
            c.execute("""
                INSERT INTO shopify_orders_new (
                    id, shopify_order_id, shopify_order_number,
                    customer_name, customer_email,
                    shipping_name, shipping_address1, shipping_address2,
                    shipping_city, shipping_province, shipping_zip, shipping_country,
                    tags, financial_status, fulfillment_status,
                    total_price, subtotal_price, total_discounts, total_weight_g,
                    note, created_at_shopify, pulled_at, updated_at,
                    app_status, assigned_warehouse,
                    shipstation_order_id, shipstation_order_key,
                    tracking_number, last_synced_at
                )
                SELECT
                    id, shopify_order_id, shopify_order_number,
                    customer_name, customer_email,
                    shipping_name, shipping_address1, shipping_address2,
                    shipping_city, shipping_province, shipping_zip, shipping_country,
                    tags, financial_status, fulfillment_status,
                    total_price, subtotal_price, total_discounts, total_weight_g,
                    note, created_at_shopify, pulled_at, updated_at,
                    app_status, assigned_warehouse,
                    shipstation_order_id, shipstation_order_key,
                    tracking_number, last_synced_at
                FROM shopify_orders
            """)
            c.execute("DROP TABLE shopify_orders")
            c.execute("ALTER TABLE shopify_orders_new RENAME TO shopify_orders")
            c.execute("CREATE INDEX IF NOT EXISTS ix_shopify_orders_shopify_order_id ON shopify_orders(shopify_order_id)")
            c.execute("CREATE INDEX IF NOT EXISTS ix_shopify_orders_app_status ON shopify_orders(app_status)")
            print("  Recreated shopify_orders without session_id")
        else:
            print("  session_id already removed from shopify_orders")
    else:
        print("  shopify_orders table does not exist yet — will be created by SQLAlchemy")

    # ── STEP 6: Add new columns to shopify_line_items ────────────────────────
    print("Step 6: Adding new columns to shopify_line_items...")
    if "shopify_line_items" in tables:
        li_cols = {row[1] for row in c.execute("PRAGMA table_info(shopify_line_items)")}
        line_item_new_cols = {
            "app_line_status":          "TEXT",
            "shipstation_line_item_id": "TEXT",
        }
        for col, definition in line_item_new_cols.items():
            if col not in li_cols:
                c.execute(f"ALTER TABLE shopify_line_items ADD COLUMN {col} {definition}")
                print(f"  Added column: {col}")
            else:
                print(f"  Column already exists: {col}")
    else:
        print("  shopify_line_items does not exist yet — will be created by SQLAlchemy")

    # ── STEP 7: Archive old inventory tables ─────────────────────────────────
    print("Step 7: Archiving old inventory tables...")
    # Refresh table list after all changes
    tables = {row[0] for row in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}

    if "inventory_items" in tables and "inventory_items_legacy" not in tables:
        c.execute("ALTER TABLE inventory_items RENAME TO inventory_items_legacy")
        print("  Renamed inventory_items → inventory_items_legacy")
    elif "inventory_items_legacy" in tables:
        print("  inventory_items_legacy already exists, skipping rename")

    if "inventory_restocks" in tables and "inventory_restocks_legacy" not in tables:
        c.execute("ALTER TABLE inventory_restocks RENAME TO inventory_restocks_legacy")
        print("  Renamed inventory_restocks → inventory_restocks_legacy")
    elif "inventory_restocks_legacy" in tables:
        print("  inventory_restocks_legacy already exists, skipping rename")

    # ── STEP 8: Activate new inventory_items_v2 as inventory_items ───────────
    print("Step 8: Activating new inventory_items table...")
    tables = {row[0] for row in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "inventory_items_v2" in tables:
        if "inventory_items" not in tables:
            c.execute("ALTER TABLE inventory_items_v2 RENAME TO inventory_items")
            print("  Renamed inventory_items_v2 → inventory_items")
        else:
            print("  inventory_items already exists, dropping inventory_items_v2")
            c.execute("DROP TABLE inventory_items_v2")
    elif "inventory_items" in tables:
        print("  inventory_items already active")
    else:
        print("  WARNING: No inventory_items or inventory_items_v2 found — will be created by SQLAlchemy")

    # ── STEP 9: Drop inventory_sessions (safe now that session_id is removed) ─
    print("Step 9: Dropping inventory_sessions...")
    tables = {row[0] for row in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "inventory_sessions" in tables:
        c.execute("DROP TABLE inventory_sessions")
        print("  Dropped inventory_sessions")
    else:
        print("  inventory_sessions already gone")

    # ── STEP 10: Keep order_decisions for now ────────────────────────────────
    # Will be dropped in a future migration once orders router is fully migrated
    print("Step 10: order_decisions table kept for safe rollback (will be cleaned up later)")

    c.execute("PRAGMA foreign_keys=ON")
    conn.commit()
    conn.close()

    tables_after = set()
    conn2 = sqlite3.connect(DB_PATH)
    tables_after = {row[0] for row in conn2.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    conn2.close()
    print(f"\nTables after migration: {sorted(tables_after)}")
    print("\n✅ Migration complete.")


if __name__ == "__main__":
    run()
