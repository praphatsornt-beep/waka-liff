#!/usr/bin/env python3
"""One-time fix: historical orders/walkin_sales items_json still hold the
OLD product name from before a catalog rename (renaming only ever updated
catalog + stock_branch, not historical line items — see the "Product code +
safe product rename" plan). This rewrites items_json.name in place for the
known old->new pairs below, so cost/profit reporting (action=report's
costMap[it.name] join, which matches against the CURRENT catalog name)
works again for these historical rows.

Only touches names confirmed to be a genuine rename (current catalog still
has a product under the new name) - NOT product names that were deleted
outright, since those have no safe target and should keep showing cost=0.

Run once: uv run tools/backfill_renamed_product_names.py
Safe to re-run - a second pass finds nothing left to rename (idempotent).
"""

import os

from dotenv import load_dotenv

load_dotenv()

RENAMES = {
    "[Preorder] BOT BT11 - Journey to นคร Z": "[พร้อมส่ง] BOT BT11 - Journey to นคร Z",
    "[Preorder] POKEMON TCG TACTICS DECK เมก้าเซอไนท์ex": "POKEMON TCG TACTICS DECK เมก้าเซอไนท์ex",
    "[Preorder] POKEMON TCG TACTICS DECK เมก้าลิซาร์ดอนex": "POKEMON TCG TACTICS DECK เมก้าลิซาร์ดอนex",
    "[Preorder] POKEMON TCG TACTICS DECK เมก้าซาเมฮาเดอร์ex": "POKEMON TCG TACTICS DECK เมก้าซาเมฮาเดอร์ex",
}


def _fix_table(sb, table: str, id_col: str) -> int:
    rows = sb.table(table).select(f"{id_col},items_json").execute().data
    fixed = 0
    for row in rows:
        items = row.get("items_json") or []
        changed = False
        for it in items:
            old = it.get("name")
            if old in RENAMES:
                it["name"] = RENAMES[old]
                changed = True
        if changed:
            sb.table(table).update({"items_json": items}).eq(id_col, row[id_col]).execute()
            fixed += 1
            print(f"  {table}.{id_col}={row[id_col]}: renamed item(s)")
    return fixed


def main():
    from supabase import create_client

    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not url or not key:
        print("SUPABASE_URL / SUPABASE_SERVICE_KEY not set in .env", file=__import__("sys").stderr)
        raise SystemExit(1)
    sb = create_client(url, key)

    print("Fixing orders.items_json ...")
    n1 = _fix_table(sb, "orders", "order_id")
    print("Fixing walkin_sales.items_json ...")
    n2 = _fix_table(sb, "walkin_sales", "sale_id")

    print(f"Done. orders rows fixed: {n1}, walkin_sales rows fixed: {n2}")


if __name__ == "__main__":
    main()
