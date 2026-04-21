"""
One-shot backfill: repair orders that have an active ShipStation box but
whose app_status doesn't reflect that (stuck on not_processed, staged,
partially_fulfilled, or fulfilled).

Caused by the per-box push paths (fulfillment.py) only updating app_status
when the prior status was 'staged'. When the order's status was something
else at push time — e.g. because earlier boxes had already shipped and
Shopify sync moved the order to partially_fulfilled, or the order was
reset to not_processed — the status transition to in_shipstation_not_shipped
was silently skipped. The order then appears in Ship All and other pre-SS
queues even though its remaining items are already in flight.

Selection criteria:
  - app_status NOT IN ('in_shipstation_not_shipped', 'in_shipstation_shipped')
  - Has an active plan with at least one box that is
        status = 'packed'          (pushed to SS, not yet shipped)
        AND shipstation_order_id IS NOT NULL

Action:
  - Set order.app_status = 'in_shipstation_not_shipped'
  - DOES NOT touch inventory (deduction already happened at the earlier
    push, or will happen via sync_boxes when the last box ships).

Usage (from backend/ with the venv active):
    ./venv/bin/python -m scripts.fix_stuck_packed_box_status          # dry-run
    ./venv/bin/python -m scripts.fix_stuck_packed_box_status --apply  # writes
"""
import sys
import os
import argparse

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from database import SessionLocal
import models


SHIPSTATION_STATUSES = ("in_shipstation_not_shipped", "in_shipstation_shipped")


def find_affected(db):
    rows = (
        db.query(models.ShopifyOrder, models.FulfillmentBox)
        .join(
            models.FulfillmentPlan,
            models.FulfillmentPlan.shopify_order_id == models.ShopifyOrder.shopify_order_id,
        )
        .join(
            models.FulfillmentBox,
            models.FulfillmentBox.plan_id == models.FulfillmentPlan.id,
        )
        .filter(
            models.ShopifyOrder.app_status.notin_(SHIPSTATION_STATUSES),
            models.FulfillmentPlan.status.notin_(["cancelled"]),
            models.FulfillmentBox.status == "packed",
            models.FulfillmentBox.shipstation_order_id.isnot(None),
        )
        .all()
    )
    # Collapse to one row per order (multiple packed boxes per order is possible).
    seen = {}
    for order, box in rows:
        if order.shopify_order_id in seen:
            seen[order.shopify_order_id]["packed_box_numbers"].append(box.box_number)
        else:
            seen[order.shopify_order_id] = {
                "order": order,
                "old_status": order.app_status,
                "packed_box_numbers": [box.box_number],
            }
    return list(seen.values())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Commit changes (default: dry-run)")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        affected = find_affected(db)
        print(f"Found {len(affected)} order(s) with a packed ShipStation box but non-SS status:\n")
        for entry in affected:
            o = entry["order"]
            boxes = sorted(entry["packed_box_numbers"])
            print(f"  {o.shopify_order_number}  app_status={entry['old_status']!r}  "
                  f"({o.customer_name or '—'})  packed boxes: {boxes}")

        if not affected:
            return

        if not args.apply:
            print("\nDry-run only. Re-run with --apply to commit.")
            return

        for entry in affected:
            entry["order"].app_status = "in_shipstation_not_shipped"
        db.commit()
        print(f"\nUpdated {len(affected)} order(s) to 'in_shipstation_not_shipped'.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
