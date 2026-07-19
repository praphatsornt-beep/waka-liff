#!/usr/bin/env python3
"""One-time/rerunnable backfill: copy every sheet in the master spreadsheet
into its mirrored Supabase table. Google Sheets stays the live system this
app writes to (gas/Code.gs is unchanged) — this just brings Supabase's
tables up to date with what's already there. Safe to re-run for tables with
a primary key (upsert, no duplicates); the two append-only log tables
(stock_returns, withdrawals) have no natural key so re-running duplicates
their rows — fine for a one-time historical load, not meant to be rerun
once GAS writes to Supabase directly."""
from dotenv import load_dotenv
import json
import os
import sys

load_dotenv()

SHEET_ID = "1aUHbSt3qlQ4uMIzlCGbF-iFm0AqSeqx12nxk5ny1JoY"
CHUNK_SIZE = 300

TABLES = [
    {
        "sheet_tab": "orders",
        "supabase_table": "orders",
        "pk": "order_id",
        "numeric": ["total", "slip_amount"],
        "json": ["items_json"],
        # Exact column order from gas/Code.gs writeOrder() — used instead of
        # the sheet's own header row, which can drift (see tournament_reg).
        "header": [
            "order_id", "timestamp", "line_user_id", "display_name",
            "items_json", "total", "branch", "real_name", "phone", "address", "email",
            "slip_status", "slip_url", "slip_amount", "slip_txn_id", "notes",
            "fulfillment", "fulfilled_at", "staff_confirmed_at", "customer_confirmed_at",
        ],
    },
    {
        "sheet_tab": "tournament_reg",
        "supabase_table": "tournament_registrations",
        "pk": "reg_id",
        "numeric": ["amount_paid"],
        "json": ["selected_categories"],
        "header": [
            "reg_id", "timestamp", "event_id", "sequence_no", "line_user_id", "display_name",
            "real_name", "player_name", "phone", "facebook", "slip_url", "slip_status",
            "payment_method", "bank", "amount_paid", "status", "checked_in_at", "note",
            "selected_categories",
        ],
    },
    {
        "sheet_tab": "wakagym_reg",
        "supabase_table": "wakagym_registrations",
        "pk": "reg_id",
        "numeric": ["wins_3match", "tokens_earned", "promo_packs"],
        "json": [],
        "header": [
            "reg_id", "timestamp", "event_date", "group_id", "event_id", "line_user_id", "display_name",
            "real_name", "player_name", "phone", "slip_url", "slip_status", "payment_method",
            "bank", "placement", "wins_3match", "tokens_earned", "promo_packs", "rewards_given", "note",
        ],
    },
    {
        "sheet_tab": "_config",
        "supabase_table": "config",
        "pk": "key",
        "numeric": [],
        "json": [],
        "header": ["key", "value"],
    },
    {
        "sheet_tab": "_catalog",
        "supabase_table": "catalog",
        "pk": "name",
        "numeric": ["cost_box", "cost_p", "price_box", "price_pack", "qty_box", "qty_pack", "limit_box", "limit_pack"],
        "json": [],
        "header": [
            "name", "category", "slug", "cost_box", "cost_p", "price_box", "price_pack",
            "qty_box", "qty_pack", "limit_box", "limit_pack", "active", "image_url", "barcode", "notice",
        ],
    },
    {
        "sheet_tab": "stock_branch",
        "supabase_table": "stock_branch",
        "pk": "name,branch",
        "numeric": ["qty_box", "qty_pack"],
        "json": [],
        "header": ["name", "category", "branch", "qty_box", "qty_pack"],
    },
    {
        "sheet_tab": "shipments",
        "supabase_table": "shipments",
        "pk": None,  # shipment_id isn't reliably unique in the live sheet — plain insert
        "numeric": [],
        "json": ["items_json"],
        "header": ["shipment_id", "timestamp", "to_branch", "status", "items_json", "received_at"],
    },
    {
        "sheet_tab": "stock_returns",
        "supabase_table": "stock_returns",
        "pk": None,  # pure append-only log, no natural key — plain insert
        "numeric": ["qty_box", "qty_pack"],
        "json": [],
        "header": ["timestamp", "branch", "name", "qty_box", "qty_pack"],
    },
    {
        "sheet_tab": "player_stats",
        "supabase_table": "player_stats",
        "pk": "player_name",
        "numeric": ["total_plays", "total_tokens", "boxes_earned", "boxes_given"],
        "json": [],
        "header": [
            "player_name", "display_name", "real_name", "line_user_id",
            "total_plays", "total_tokens", "boxes_earned", "boxes_given", "last_play_date",
        ],
    },
    {
        "sheet_tab": "wakagym_events",
        "supabase_table": "wakagym_events",
        "pk": "event_id",
        "numeric": ["entry_fee"],
        "json": [],
        "header": ["event_id", "date", "branch", "tier", "entry_fee", "status", "created_by"],
    },
    {
        "sheet_tab": "tournament_events",
        "supabase_table": "tournament_events",
        "pk": "event_id",
        "numeric": ["entry_fee", "max_players"],
        "json": [],
        "header": [
            "event_id", "name", "date", "entry_fee", "max_players",
            "rules_text", "registration_close", "status", "created_at",
        ],
    },
    {
        "sheet_tab": "tournament_categories",
        "supabase_table": "tournament_categories",
        "pk": "category_id",
        "numeric": ["entry_fee", "max_players", "sort_order"],
        "json": [],
        "header": ["category_id", "event_id", "name", "entry_fee", "max_players", "sort_order", "status"],
    },
    # withdrawals: no sheet_tab entry — the tab doesn't exist live yet
    # (GAS creates it lazily on first use, gas/Code.gs:3390). Nothing to backfill.
]


def get_gspread_client():
    import gspread
    from google.oauth2.service_account import Credentials

    scopes = ["https://www.googleapis.com/auth/spreadsheets"]
    creds = Credentials.from_service_account_file("service_account.json", scopes=scopes)
    return gspread.authorize(creds)


def coerce_row(header: list[str], raw_row: list[str], numeric: list[str], json_fields: list[str]) -> dict:
    row = dict(zip(header, raw_row))
    for key, value in list(row.items()):
        row[key] = value if value != "" else None
    for key in numeric:
        if row.get(key) is not None:
            try:
                row[key] = float(row[key])
            except ValueError:
                row[key] = None
    for key in json_fields:
        if row.get(key):
            try:
                row[key] = json.loads(row[key])
            except (json.JSONDecodeError, TypeError):
                row[key] = None
    return row


def main():
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        sys.exit("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env")

    try:
        from supabase import create_client
    except ImportError:
        sys.exit("supabase package not installed. Run: pip install -r requirements.txt")

    gc = get_gspread_client()
    sb = create_client(url, key)
    ss = gc.open_by_key(SHEET_ID)

    for cfg in TABLES:
        try:
            ws = ss.worksheet(cfg["sheet_tab"])
        except Exception:
            print(f"[skip] {cfg['sheet_tab']}: tab doesn't exist yet")
            continue

        values = ws.get_all_values()
        if len(values) < 2:
            print(f"[skip] {cfg['sheet_tab']}: no data rows")
            continue

        data_rows = values[1:]
        rows = [
            coerce_row(cfg["header"], r, cfg["numeric"], cfg["json"])
            for r in data_rows
            if r and r[0].strip()
        ]
        if not rows:
            print(f"[skip] {cfg['sheet_tab']}: no populated rows")
            continue

        total = 0
        for i in range(0, len(rows), CHUNK_SIZE):
            chunk = rows[i:i + CHUNK_SIZE]
            try:
                if cfg["pk"]:
                    sb.table(cfg["supabase_table"]).upsert(chunk, on_conflict=cfg["pk"]).execute()
                else:
                    sb.table(cfg["supabase_table"]).insert(chunk).execute()
            except Exception as e:
                sys.exit(f"[fail] {cfg['supabase_table']}: {e}")
            total += len(chunk)
        verb = "upserted" if cfg["pk"] else "inserted"
        print(f"[ok]   {cfg['sheet_tab']} -> {cfg['supabase_table']}: {total} rows {verb}")

    print("\nBackfill complete.")


if __name__ == "__main__":
    main()
