"""
Identify and cancel ShipStation unshipped orders that aren't tracked in our DB.

Rule: for every unshipped SS order, its `orderId` must match a
FulfillmentBox.shipstation_order_id in our DB. Any SS order whose orderId
isn't referenced in the DB is an orphan (created by a duplicate push) and
can be safely cancelled.

Usage:
    python -m scripts.cleanup_ss_duplicates            # dry-run (default)
    python -m scripts.cleanup_ss_duplicates --execute  # actually cancel
"""

import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, ".")  # run from backend/ so imports work

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env")

from database import SessionLocal
import models
from services import shipstation_service


def main(execute: bool) -> int:
    if not shipstation_service.is_configured():
        print("ShipStation is not configured.")
        return 1

    print("Fetching all unshipped orders from ShipStation…")
    ss_orders = shipstation_service.get_unshipped_orders()
    print(f"  → {len(ss_orders)} unshipped SS orders")

    db = SessionLocal()
    try:
        tracked_ids = {
            str(row[0]) for row in db.query(models.FulfillmentBox.shipstation_order_id)
            .filter(models.FulfillmentBox.shipstation_order_id.isnot(None))
            .filter(models.FulfillmentBox.shipstation_order_id != "")
            .all()
        }
    finally:
        db.close()
    print(f"  → {len(tracked_ids)} shipstation_order_id values tracked in DB")

    # Group SS orders by orderNumber so we can show the duplicate clusters.
    by_number: dict[str, list[dict]] = defaultdict(list)
    for o in ss_orders:
        by_number[o.get("orderNumber") or ""].append(o)

    orphans: list[dict] = []
    dup_clusters_with_orphan: list[tuple[str, list[dict]]] = []

    for order_number, group in by_number.items():
        if len(group) <= 1:
            # Not a duplicate cluster. Still orphan if the single order isn't tracked,
            # but that would typically be an SS order created outside the app — skip.
            continue
        # This cluster has duplicates. Keep the one(s) whose orderId is in DB; flag the rest.
        cluster_orphans = [o for o in group if str(o.get("orderId")) not in tracked_ids]
        tracked_in_cluster = [o for o in group if str(o.get("orderId")) in tracked_ids]
        if cluster_orphans and tracked_in_cluster:
            # Safe case: there's a DB-tracked copy to keep; the rest are orphans.
            orphans.extend(cluster_orphans)
            dup_clusters_with_orphan.append((order_number, group))
        elif cluster_orphans and not tracked_in_cluster:
            # Scary case: NONE of the duplicates are tracked in DB. Don't auto-cancel —
            # report these so a human decides which to keep.
            print(f"\n  ⚠ orderNumber={order_number!r} has {len(group)} duplicates but NONE are tracked in DB — skipping, needs manual review")
            for o in group:
                print(f"      orderId={o.get('orderId')} orderKey={o.get('orderKey')!r} status={o.get('orderStatus')}")

    print(f"\nFound {len(dup_clusters_with_orphan)} duplicate clusters with a DB-tracked copy.")
    print(f"Orphan count (would cancel): {len(orphans)}")

    if not orphans:
        print("\nNothing to cancel.")
        return 0

    print("\nPer-cluster plan:")
    for order_number, group in dup_clusters_with_orphan:
        print(f"\n  {order_number}:")
        for o in group:
            oid = str(o.get("orderId"))
            mark = "  KEEP" if oid in tracked_ids else "CANCEL"
            print(f"    [{mark}] orderId={oid} orderKey={o.get('orderKey')!r} status={o.get('orderStatus')}")

    if not execute:
        print("\n(dry-run — re-run with --execute to actually cancel)")
        return 0

    print("\nCancelling orphans…")
    cancelled, failed = 0, 0
    for o in orphans:
        oid = str(o.get("orderId"))
        try:
            shipstation_service.cancel_order(oid)
            print(f"  ✓ cancelled orderId={oid} ({o.get('orderNumber')})")
            cancelled += 1
        except Exception as e:
            print(f"  ✗ FAILED orderId={oid}: {e}")
            failed += 1
    print(f"\nDone. Cancelled {cancelled}, failed {failed}.")
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    main(execute="--execute" in sys.argv)
