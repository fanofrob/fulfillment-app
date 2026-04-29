"""
One-shot backfill: repair orders stuck on app_status='in_shipstation_not_shipped'
that no longer have any 'packed' boxes — all boxes already shipped, fulfilled,
or cancelled, but the order status never advanced.

Symptom: the Orders page sidebar "In ShipStation" count drifts above the
actual box count shown in the boxes table (e.g. 393 sidebar vs 269 boxes),
because the sidebar counts orders by app_status while the boxes table
counts FulfillmentBox rows with status='packed'.

Sister script to fix_stuck_packed_box_status.py, which handles the opposite
direction (orders with packed boxes whose app_status hasn't caught up).

Usage (from backend/ with the venv active):
    ./venv/bin/python -m scripts.fix_orphan_in_shipstation_orders          # dry-run
    ./venv/bin/python -m scripts.fix_orphan_in_shipstation_orders --apply  # writes
"""
import sys
import os
import argparse

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from database import SessionLocal
from services import shipstation_service


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Commit changes (default: dry-run)")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        result = shipstation_service.heal_orphan_in_shipstation_orders(
            db, dry_run=not args.apply
        )

        transitions = result["transitions"]
        skipped_legacy = result["skipped_legacy"]

        print(
            f"Found {len(transitions)} stuck order(s); "
            f"{skipped_legacy} skipped (no FulfillmentBox rows — legacy push_order).\n"
        )
        for t in transitions:
            b = t["boxes"]
            print(
                f"  {t['shopify_order_number']}  "
                f"{t['old_status']!r} → {t['new_status']!r}  "
                f"boxes: shipped={b['shipped']} fulfilled={b['fulfilled']} "
                f"pending={b['pending']} cancelled={b['cancelled']}"
            )

        if not transitions:
            return

        if not args.apply:
            print("\nDry-run only. Re-run with --apply to commit.")
        else:
            print(f"\nUpdated {len(transitions)} order(s).")
    finally:
        db.close()


if __name__ == "__main__":
    main()
