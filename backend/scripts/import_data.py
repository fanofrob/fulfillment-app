"""
Import CSV data into the fulfillment database.

Usage:
    python scripts/import_data.py [--clear] [--what sku|cogs|rates|packages|all]

Place CSV files in the data/ directory before running:
    - data/walnut_sku_mapping.csv
    - data/northlake_sku_mapping.csv
    - data/cogs_fruit_cost.csv
    - data/usps_rates.csv
    - data/package_table.csv
"""

import sys, os, csv, argparse
from datetime import datetime, date

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from database import SessionLocal, engine
import models

models.Base.metadata.create_all(bind=engine)

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '..', 'data')

def parse_float(val):
    if not val or str(val).strip() in ('', '#ERROR', '#VALUE!', '#REF!', '#N/A'):
        return None
    try:
        return float(str(val).replace('$','').replace(',','').replace('%','').strip())
    except:
        return None

def parse_date(val):
    if not val or str(val).strip() == '':
        return None
    for fmt in ('%m/%d/%Y', '%Y-%m-%d', '%m/%d/%y'):
        try:
            return datetime.strptime(str(val).strip(), fmt).date()
        except:
            pass
    return None

def import_sku_mappings(db, warehouse, filepath, clear=False):
    if clear:
        db.query(models.SkuMapping).filter(models.SkuMapping.warehouse == warehouse).delete()
        db.commit()
        print(f"  Cleared existing {warehouse} mappings.")

    if not os.path.exists(filepath):
        print(f"  SKIP: {filepath} not found.")
        return 0

    count = 0
    with open(filepath, newline='', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        for row in reader:
            shopify_sku = str(row.get('shopifysku2', '')).strip()
            if not shopify_sku or shopify_sku == 'shopifysku2':
                continue
            # Skip rows that are purely error/empty
            pick_sku = str(row.get('picklist sku', '')).strip() or None

            entry = models.SkuMapping(
                warehouse=warehouse,
                shopify_sku=shopify_sku,
                pick_sku=pick_sku,
                mix_quantity=parse_float(row.get('Mix Quantity')) or 1.0,
                product_type=str(row.get('Product Type', '')).strip() or None,
                pick_type=str(row.get('Pick Type', '')).strip() or None,
                pick_weight_lb=parse_float(row.get('Pick Weight LB')),
                lineitem_weight=parse_float(row.get('Lineitem Weight')),
                shop_status=str(row.get('Shop Status', '')).strip() or None,
                is_active=str(row.get('Shop Status', '')).strip() != 'Inactive',
            )
            db.add(entry)
            count += 1

    db.commit()
    print(f"  Imported {count} {warehouse} SKU mappings.")
    return count

def import_cogs(db, filepath, clear=False):
    if clear:
        db.query(models.CogsCost).delete()
        db.commit()
        print("  Cleared existing COGS data.")

    if not os.path.exists(filepath):
        print(f"  SKIP: {filepath} not found.")
        return 0

    count = 0
    seen = {}  # deduplicate by (product_type, date)
    with open(filepath, newline='', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        for row in reader:
            product_type = str(row.get('Product Type', '')).strip()
            price_str = row.get('Price per lb', '')
            price = parse_float(price_str)
            date_val = parse_date(row.get('Date Placed', ''))

            if not product_type or price is None or date_val is None:
                continue

            key = (product_type, date_val)
            if key in seen:
                continue
            seen[key] = True

            entry = models.CogsCost(
                product_type=product_type,
                price_per_lb=price,
                effective_date=date_val,
                vendor=str(row.get('Aggregator / Vendor', '')).strip() or None,
                invoice_number=str(row.get('Invoice #', '')).strip() or None,
            )
            db.add(entry)
            count += 1

    db.commit()
    print(f"  Imported {count} COGS entries.")
    return count

def import_usps_rates(db, filepath, clear=False):
    EFFECTIVE_DATE = date(2026, 1, 1)
    if clear:
        db.query(models.RateCard).filter(models.RateCard.carrier == 'USPS').delete()
        db.commit()
        print("  Cleared existing USPS rate cards.")

    if not os.path.exists(filepath):
        print(f"  SKIP: {filepath} not found.")
        return 0

    FLAT_RATE_SERVICES = {
        'Flat Rate Envelopes': 'USPS Flat Rate Envelope',
        'Legal Flat Rate Envelope': 'USPS Legal Flat Rate Envelope',
        'Padded Flat Rate Envelope': 'USPS Padded Flat Rate Envelope',
        'Small Flat Rate Box': 'USPS Small Flat Rate Box',
        'Medium Flat Rate Boxes': 'USPS Medium Flat Rate Box',
        'Large Flat Rate Boxes': 'USPS Large Flat Rate Box',
        'Military Large Flat Rate Boxes': 'USPS Military Large Flat Rate Box',
    }

    count = 0
    zones = [1,2,3,4,5,6,7,8,9]

    with open(filepath, newline='', encoding='utf-8-sig') as f:
        all_rows = list(csv.reader(f))

    # Row index 2 (0-indexed) has the zone headers
    # Row index 3 has "Zone 1", "Zone 2" etc
    # Find the row with "Zone 1"
    zone_col_map = {}
    for i, row in enumerate(all_rows[:10]):
        for j, cell in enumerate(row):
            cell = str(cell).strip()
            if cell == 'Zone 1':
                for z in range(1, 10):
                    # find column for Zone z
                    for jj, c in enumerate(row):
                        if str(c).strip() == f'Zone {z}':
                            zone_col_map[z] = jj
                break
        if zone_col_map:
            break

    if not zone_col_map:
        print("  ERROR: Could not find zone columns in USPS rate card.")
        return 0

    db_session = db
    for row in all_rows:
        if not row:
            continue
        service_raw = str(row[0]).strip()

        # Flat rate rows
        if service_raw in FLAT_RATE_SERVICES:
            service_name = FLAT_RATE_SERVICES[service_raw]
            rate = parse_float(row[zone_col_map[1]])
            if rate is not None:
                entry = models.RateCard(
                    carrier='USPS', service_name=service_name,
                    is_flat_rate=True, rate=rate, effective_date=EFFECTIVE_DATE
                )
                db_session.add(entry)
                count += 1
            continue

        # Weight-based rows: "1 lb", "2 lb", etc
        if service_raw.endswith(' lb') or service_raw.endswith(' lbs'):
            try:
                weight = float(service_raw.replace(' lb', '').replace(' lbs', '').strip())
            except:
                continue
            for zone, col_idx in zone_col_map.items():
                if col_idx < len(row):
                    rate = parse_float(row[col_idx])
                    if rate is not None:
                        entry = models.RateCard(
                            carrier='USPS', service_name='USPS Priority Mail',
                            weight_lb=weight, zone=zone, rate=rate,
                            is_flat_rate=False, effective_date=EFFECTIVE_DATE
                        )
                        db_session.add(entry)
                        count += 1

    db_session.commit()
    print(f"  Imported {count} USPS rate entries.")
    return count

def import_package_table(db, filepath, clear=False):
    if clear:
        db.query(models.PackageRule).delete()
        db.commit()
        print("  Cleared existing package rules.")

    if not os.path.exists(filepath):
        print(f"  SKIP: {filepath} not found.")
        return 0

    count = 0
    with open(filepath, newline='', encoding='utf-8-sig') as f:
        all_rows = list(csv.reader(f))

    # Row 0: empty + "Zone" header
    # Row 1: "Weight", "1", "2", ..., "8"
    header = all_rows[1]
    zone_cols = {}
    for j, cell in enumerate(header):
        try:
            z = int(str(cell).strip())
            zone_cols[z] = j
        except:
            pass

    for row in all_rows[2:]:
        if not row:
            continue
        weight_str = str(row[0]).strip()
        try:
            weight = int(weight_str)
        except:
            continue
        for zone, col_idx in zone_cols.items():
            if col_idx < len(row):
                pkg = str(row[col_idx]).strip()
                if pkg:
                    entry = models.PackageRule(weight_lb=weight, zone=zone, package_type=pkg)
                    db.add(entry)
                    count += 1

    db.commit()
    print(f"  Imported {count} package rules.")
    return count

def main():
    parser = argparse.ArgumentParser(description='Import CSV data into fulfillment DB')
    parser.add_argument('--clear', action='store_true', help='Clear existing data before import')
    parser.add_argument('--what', default='all', choices=['sku','cogs','rates','packages','all'])
    args = parser.parse_args()

    db = SessionLocal()
    data_dir = os.path.abspath(DATA_DIR)
    print(f"Looking for CSVs in: {data_dir}\n")

    try:
        if args.what in ('sku', 'all'):
            print("Importing Walnut SKU mappings...")
            import_sku_mappings(db, 'walnut', os.path.join(data_dir, 'walnut_sku_mapping.csv'), args.clear)
            print("Importing Northlake SKU mappings...")
            import_sku_mappings(db, 'northlake', os.path.join(data_dir, 'northlake_sku_mapping.csv'), args.clear)

        if args.what in ('cogs', 'all'):
            print("Importing COGS (Fruit cost)...")
            import_cogs(db, os.path.join(data_dir, 'cogs_fruit_cost.csv'), args.clear)

        if args.what in ('rates', 'all'):
            print("Importing USPS rates...")
            import_usps_rates(db, os.path.join(data_dir, 'usps_rates.csv'), args.clear)

        if args.what in ('packages', 'all'):
            print("Importing package table...")
            import_package_table(db, os.path.join(data_dir, 'package_table.csv'), args.clear)

        print("\nDone.")
    finally:
        db.close()

if __name__ == '__main__':
    main()
