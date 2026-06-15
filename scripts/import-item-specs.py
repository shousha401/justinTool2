#!/usr/bin/env python3
"""import-item-specs.py — turn the "Product Specs Data.xlsx" export into the
tracked reference table the app reads (reference/item-specs.json).

We only pull the columns the value/margin tool actually uses for customer
attribution: each item code's owning customer, plus species and production
channel (handy hints for toll-vs-own later). Shelf Life and Machine Settings
sheets are intentionally ignored — they're labeling / production-recipe data,
not pricing.

This is a DEV-TIME tool (needs Python + openpyxl); it does NOT run on the VM.
Re-run it whenever the spreadsheet is updated, then commit the regenerated JSON:

    python scripts/import-item-specs.py "C:/path/to/Product Specs Data.xlsx"

Customer names are stored RAW (as the sheet has them); the app canonicalizes
them at load (backend/itemSpecs.js), so the name-mapping lives in code where
it's easy to review and edit.
"""
import sys, json, os
from datetime import date

try:
    import openpyxl
except ImportError:
    sys.exit("openpyxl is required: pip install openpyxl")

DEFAULT_SRC = os.path.join(os.path.expanduser("~"), "OneDrive - jdfood.com",
                           "Desktop", "Product Specs Data.xlsx")
SRC = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..",
                   "reference", "item-specs.json")
OUT = os.path.normpath(OUT)

wb = openpyxl.load_workbook(SRC, read_only=True, data_only=True)
ws = wb["Item Details"]

hdr = None
items = {}
for i, row in enumerate(ws.iter_rows(values_only=True)):
    if i == 0:
        hdr = list(row)
        continue
    if not row or row[0] is None:
        continue
    d = dict(zip(hdr, row))
    code = str(d.get("reference") or "").strip()
    customer = str(d.get("customer") or "").strip()
    if not code or not customer:        # attribution needs a customer
        continue
    rec = {"customer": customer}
    species = str(d.get("species") or "").strip()
    channel = str(d.get("production_channel") or "").strip()
    if species:
        rec["species"] = species
    if channel:
        rec["channel"] = channel
    items[code] = rec

payload = {
    "generatedAt": date.today().isoformat(),
    "source": os.path.basename(SRC),
    "count": len(items),
    "items": dict(sorted(items.items())),
}

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(payload, f, ensure_ascii=False, indent=0)

print(f"wrote {OUT}: {len(items)} item codes with a customer "
      f"({len({v['customer'] for v in items.values()})} distinct customers)")
