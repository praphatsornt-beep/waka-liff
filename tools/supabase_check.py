#!/usr/bin/env python3
"""Verify the Supabase project is reachable and the schema.sql tables exist.

Run after creating the Supabase project, pasting supabase/schema.sql into
the SQL Editor, and filling SUPABASE_URL / SUPABASE_SERVICE_KEY in .env.
"""
from dotenv import load_dotenv
import os
import sys
import uuid

load_dotenv()

TABLES = [
    "orders", "tournament_registrations", "wakagym_registrations",
    "config", "catalog", "stock_branch", "shipments", "stock_returns",
    "player_stats", "wakagym_events", "tournament_events",
    "tournament_categories", "withdrawals",
]


def main():
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        sys.exit("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env")

    try:
        from supabase import create_client
    except ImportError:
        sys.exit("supabase package not installed. Run: pip install -r requirements.txt")

    client = create_client(url, key)

    for table in TABLES:
        try:
            resp = client.table(table).select("*", count="exact").limit(0).execute()
            print(f"[ok]   {table}: reachable ({resp.count} rows)")
        except Exception as e:
            sys.exit(f"[fail] {table}: {e}")

    test_id = f"_check_{uuid.uuid4().hex[:8]}"
    try:
        client.table("orders").insert({"order_id": test_id, "notes": "supabase_check.py test row"}).execute()
        client.table("orders").delete().eq("order_id", test_id).execute()
        print("[ok]   insert/delete round-trip on orders")
    except Exception as e:
        sys.exit(f"[fail] insert/delete round-trip: {e}")

    print("\nAll checks passed — Supabase is wired up correctly.")


if __name__ == "__main__":
    main()
