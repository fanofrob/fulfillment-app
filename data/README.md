# Data Import Files

Place the following CSV exports here before running the import script:

| File | Source | Tab |
|------|--------|-----|
| walnut_sku_mapping.csv | GHF Inventory | INPUT_bundles_cvr_walnut |
| northlake_sku_mapping.csv | GHF Inventory | INPUT_bundles_cvr_northlake |
| cogs_fruit_cost.csv | GHF: FRUIT DASHBOARD | Fruit cost |
| usps_rates.csv | GHF COGS and Shipping | 2026 USPS |
| package_table.csv | GHF COGS and Shipping | Package Table |

To export from Google Sheets: File → Download → Comma Separated Values (.csv)

Then run:
    cd backend
    source venv/bin/activate
    python scripts/import_data.py --clear --what all
