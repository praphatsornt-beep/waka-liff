#!/usr/bin/env python3
"""One-time backfill: assigns a sequential product code (P0001, P0002, ...)
to every catalog row currently missing `id`, ordered alphabetically by name
(there's no created_at column to order by originally — fine, the code is
opaque, not meant to reflect creation order).

Run AFTER the `alter table catalog add column id text unique;` migration and
BEFORE deploying the gas/Code.gs changes that generate ids for new products —
running it after risks colliding with an id the new GAS code already handed
out to a product created in between.

Run once: uv run tools/backfill_product_ids.py
"""
from dotenv import load_dotenv
import os
import sys

load_dotenv()


def main():
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        sys.exit("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env")

    from supabase import create_client
    sb = create_client(url, key)

    rows = sb.table("catalog").select("name,id").order("name").execute().data
    missing = [r for r in rows if not r.get("id")]
    if not missing:
        print("Nothing to backfill — every row already has an id.")
        return

    existing_nums = [int(r["id"][1:]) for r in rows if r.get("id") and r["id"][1:].isdigit()]
    next_n = (max(existing_nums) + 1) if existing_nums else 1

    print(f"Backfilling {len(missing)} row(s) starting at P{next_n:04d} ...")
    for r in missing:
        new_id = f"P{next_n:04d}"
        sb.table("catalog").update({"id": new_id}).eq("name", r["name"]).execute()
        print(f"  {r['name']!r} -> {new_id}")
        next_n += 1

    print("Done. Verify with: select count(*) from catalog where id is null; (expect 0)")


if __name__ == "__main__":
    main()
