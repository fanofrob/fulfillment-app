"""
Seed script to import data from Google Sheets CSV exports.
Run after placing CSV files in the data/ directory.
"""
import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from database import SessionLocal, engine
import models

models.Base.metadata.create_all(bind=engine)

def seed_order_rules():
    db = SessionLocal()
    default_rules = [
        {"tag": "hold", "action": "hold", "description": "Do not ship this order under any circumstances", "priority": 100},
        {"tag": "VIP", "action": "prioritize", "description": "Prioritize this order. No partial unless margin collapses", "priority": 90},
        {"tag": "replacement", "action": "ship_always", "description": "Ship regardless of margin", "priority": 80},
    ]
    for rule_data in default_rules:
        existing = db.query(models.OrderRule).filter(models.OrderRule.tag == rule_data["tag"]).first()
        if not existing:
            db.add(models.OrderRule(**rule_data))
    db.commit()
    db.close()
    print("Order rules seeded.")

if __name__ == "__main__":
    seed_order_rules()
    print("Seeding complete.")
