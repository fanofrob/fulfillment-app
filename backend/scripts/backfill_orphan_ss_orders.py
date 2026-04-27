"""
One-shot backfill: link FulfillmentBox records to ShipStation orders that
were created via the app but whose orderId never got saved to the DB.

Symptom: an SS order exists (awaiting_shipment) whose orderId is not
present in FulfillmentBox.shipstation_order_id. The box is still
status='pending' and the order/plan statuses haven't transitioned.

Cause: the bulk-push-stream background thread does the SS API call in
worker threads, then persists the orderId in the main thread inside a
single transaction that also does _auto_deduct_on_ship and
_recompute_committed. If that transaction raises, the SS order is already
created but the DB update rolls back, and the order is tallied as 'failed'.

Matching rule:
  - SS orderKey has the form '{shopify_order_id}-box{N}'
  - Find the FulfillmentBox by plan.shopify_order_id + box.box_number
  - Skip if the box already has a non-empty shipstation_order_id (double-safe)

Action per matched box:
  - box.shipstation_order_id = SS orderId
  - box.shipstation_order_key = SS orderKey
  - box.status = 'packed'
  - plan.status = 'active' if currently 'draft'
  - order.app_status = 'in_shipstation_not_shipped' if currently in
    ('staged', 'partially_fulfilled'). If it was 'staged' at repair time,
    run _auto_deduct_on_ship and _recompute_committed afterwards (one call
    per order / per warehouse).

Usage (from backend/ with the venv active):
    ./venv/bin/python -m scripts.backfill_orphan_ss_orders          # dry-run
    ./venv/bin/python -m scripts.backfill_orphan_ss_orders --apply  # writes
"""
import sys
import os
import argparse
import re

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv
from pathlib import Path
load_dotenv(Path(__file__).parent.parent / ".env")

from database import SessionLocal
import models
from services import shipstation_service
from routers.inventory import _auto_deduct_on_ship, _recompute_committed


ORDER_KEY_RE = re.compile(r"^(\d+)-box(\d+)$", re.IGNORECASE)


def parse_key(order_key: str):
    m = ORDER_KEY_RE.match(order_key or "")
    if not m:
        return None, None
    return m.group(1), int(m.group(2))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Commit changes (default: dry-run)")
    args = parser.parse_args()

    if not shipstation_service.is_configured():
        print("ShipStation is not configured.")
        return 1

    print("Fetching all unshipped SS orders…")
    ss_orders = shipstation_service.get_unshipped_orders()
    print(f"  → {len(ss_orders)} unshipped SS orders")

    db = SessionLocal()
    try:
        tracked = {
            str(row[0]) for row in db.query(models.FulfillmentBox.shipstation_order_id)
            .filter(models.FulfillmentBox.shipstation_order_id.isnot(None))
            .filter(models.FulfillmentBox.shipstation_order_id != "")
            .all()
        }
        print(f"  → {len(tracked)} shipstation_order_id values tracked in DB")

        untracked = [o for o in ss_orders if str(o.get("orderId")) not in tracked]
        print(f"  → {len(untracked)} SS orders NOT tracked in DB\n")

        to_repair = []    # list of dicts with {ss_order, box, plan, order, first_push}
        unmatched = []    # SS orders we couldn't match to a box

        for ss in untracked:
            order_key = ss.get("orderKey") or ""
            shopify_order_id_str, box_num = parse_key(order_key)
            if not shopify_order_id_str or box_num is None:
                unmatched.append({"ss": ss, "reason": f"orderKey {order_key!r} doesn't match pattern"})
                continue

            try:
                shopify_order_id = int(shopify_order_id_str)
            except ValueError:
                unmatched.append({"ss": ss, "reason": f"orderKey shopify_order_id not int: {shopify_order_id_str!r}"})
                continue

            plan = db.query(models.FulfillmentPlan).filter(
                models.FulfillmentPlan.shopify_order_id == shopify_order_id,
                models.FulfillmentPlan.status.notin_(["cancelled", "completed"]),
            ).first()
            if not plan:
                unmatched.append({"ss": ss, "reason": f"no active plan for shopify_order_id={shopify_order_id}"})
                continue

            box = db.query(models.FulfillmentBox).filter(
                models.FulfillmentBox.plan_id == plan.id,
                models.FulfillmentBox.box_number == box_num,
            ).first()
            if not box:
                unmatched.append({"ss": ss, "reason": f"no box {box_num} on plan {plan.id}"})
                continue

            if box.shipstation_order_id:
                unmatched.append({
                    "ss": ss,
                    "reason": f"box already has shipstation_order_id={box.shipstation_order_id}",
                })
                continue

            order = db.query(models.ShopifyOrder).filter(
                models.ShopifyOrder.shopify_order_id == shopify_order_id
            ).first()
            first_push = bool(order) and order.app_status == "staged"

            to_repair.append({
                "ss": ss,
                "box": box,
                "plan": plan,
                "order": order,
                "first_push": first_push,
            })

        print(f"Matched {len(to_repair)} orphan SS orders to boxes.")
        print(f"Unmatched: {len(unmatched)}")
        if unmatched:
            print("\nUnmatched detail:")
            for u in unmatched[:20]:
                ss = u["ss"]
                print(f"  orderId={ss.get('orderId')} orderNumber={ss.get('orderNumber')!r} — {u['reason']}")
            if len(unmatched) > 20:
                print(f"  (+{len(unmatched) - 20} more)")

        if not to_repair:
            print("\nNothing to backfill.")
            return 0

        print("\nRepair plan:")
        for r in to_repair:
            ss = r["ss"]
            order = r["order"]
            box = r["box"]
            print(f"  box_id={box.id} plan_id={r['plan'].id} order={order.shopify_order_number if order else '?'} "
                  f"→ orderId={ss.get('orderId')} orderKey={ss.get('orderKey')!r} first_push={r['first_push']}")

        if not args.apply:
            print("\n(dry-run — re-run with --apply to actually write)")
            return 0

        print("\nApplying repairs…")
        # Commit in two phases so an error in phase 2 (inventory) leaves the
        # box-level link saved — matching the fix we're applying to the live
        # push code.

        # Phase A: link boxes + flip plan/order status in a single transaction.
        warehouses_to_recompute: set[str] = set()
        first_push_orders: list[tuple[int, models.ShopifyOrder]] = []
        for r in to_repair:
            ss = r["ss"]
            box = r["box"]
            plan = r["plan"]
            order = r["order"]

            box.shipstation_order_id = str(ss.get("orderId", ""))
            box.shipstation_order_key = ss.get("orderKey", "") or ""
            box.status = "packed"

            if plan.status == "draft":
                plan.status = "active"

            if order and order.app_status in ("staged", "partially_fulfilled"):
                was_first_push = order.app_status == "staged"
                order.app_status = "in_shipstation_not_shipped"
                if was_first_push and order.assigned_warehouse:
                    first_push_orders.append((order.shopify_order_id, order))
                    warehouses_to_recompute.add(order.assigned_warehouse)

        db.commit()
        print(f"  Phase A: linked {len(to_repair)} boxes and flipped statuses.")

        # Phase B: inventory deduction per first-push order + one recompute
        # per warehouse. Any failure here is non-fatal for the links already
        # committed above; we just print and continue.
        if first_push_orders:
            print(f"  Phase B: auto-deducting inventory for {len(first_push_orders)} first-push orders…")
            for shopify_order_id, _ in first_push_orders:
                try:
                    fresh_order = db.query(models.ShopifyOrder).filter(
                        models.ShopifyOrder.shopify_order_id == shopify_order_id
                    ).first()
                    if fresh_order:
                        _auto_deduct_on_ship(fresh_order, db)
                except Exception as e:
                    print(f"    ✗ auto-deduct failed for order {shopify_order_id}: {e}")
            db.commit()

        if warehouses_to_recompute:
            print(f"  Phase B: recomputing committed qty for warehouses: {sorted(warehouses_to_recompute)}")
            for wh in warehouses_to_recompute:
                try:
                    _recompute_committed(wh, db)
                except Exception as e:
                    print(f"    ✗ recompute failed for warehouse {wh}: {e}")
            db.commit()

        print(f"\nDone. Backfilled {len(to_repair)} orphan SS orders.")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main() or 0)
