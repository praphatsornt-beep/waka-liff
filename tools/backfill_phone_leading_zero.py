#!/usr/bin/env python3
"""One-time fix: Google Sheets auto-converted the 'phone' column to Number
type on write, silently dropping the leading 0 from every Thai mobile
number (e.g. 0813441085 -> 813441085). Formats the phone column as Plain
Text (prevents recurrence) then prepends '0' to any 9-digit phone value.

Run once: uv run tools/backfill_phone_leading_zero.py
"""
from dotenv import load_dotenv
import gspread
from google.oauth2.service_account import Credentials
from gspread.utils import rowcol_to_a1

load_dotenv()

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
SHEET_ID = "1aUHbSt3qlQ4uMIzlCGbF-iFm0AqSeqx12nxk5ny1JoY"

CONFIGS = [
    ("orders", "phone"),
    ("tournament_reg", "phone"),
    ("wakagym_reg", "phone"),
]


def main():
    creds = Credentials.from_service_account_file("service_account.json", scopes=SCOPES)
    gc = gspread.authorize(creds)
    sh = gc.open_by_key(SHEET_ID)

    print("Step 1/2: formatting phone columns as Plain Text (prevents recurrence)...")
    for tab, colname in CONFIGS:
        ws = sh.worksheet(tab)
        hdr = ws.row_values(1)
        col_idx = hdr.index(colname) + 1
        last_row = max(ws.row_count, 100)
        range_str = f"{rowcol_to_a1(2, col_idx)}:{rowcol_to_a1(last_row, col_idx)}"
        ws.format(range_str, {"numberFormat": {"type": "TEXT"}})
        print(f"  {tab}: formatted {range_str} as TEXT")

    print("\nStep 2/2: prepending '0' to existing 9-digit phone numbers...")
    for tab, colname in CONFIGS:
        ws = sh.worksheet(tab)
        rows = ws.get_all_values()
        if len(rows) < 2:
            print(f"  {tab}: no data rows, skipped")
            continue
        hdr = rows[0]
        idx = hdr.index(colname)
        updates = []
        for i, r in enumerate(rows[1:], start=2):
            v = r[idx] if idx < len(r) else ""
            if v.isdigit() and len(v) == 9:
                updates.append({"range": rowcol_to_a1(i, idx + 1), "values": [["0" + v]]})
        if updates:
            ws.batch_update(updates, value_input_option="RAW")
        print(f"  {tab}: fixed {len(updates)} row(s)")

    print("\nDone. Note: this only fixed the Google Sheets — if orders/tournament_reg\n"
          "rows already synced to Supabase, those mirrored phone numbers still need\n"
          "a matching fix there (ask Claude to run the Supabase-side sync after this).")


if __name__ == "__main__":
    main()
