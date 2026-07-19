#!/usr/bin/env python3
"""Stock Dashboard — central warehouse stock, per-branch stock, transfer history"""

import json
import os
import sys
from pathlib import Path

import streamlit as st
import pandas as pd
import requests
from dotenv import load_dotenv

load_dotenv()

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from theme import (
    apply_theme, page_header, kpi_card,
    TEXT2, DANGER_TEXT,
)

try:
    import gspread
    from google.oauth2.service_account import Credentials
except ImportError as e:
    st.error(f"ติดตั้ง packages ก่อน: `pip install -r requirements.txt`\n\n{e}")
    st.stop()

SCOPES   = ["https://www.googleapis.com/auth/spreadsheets"]
SA_PATH  = Path("service_account.json")
SHEET_ID = "1aUHbSt3qlQ4uMIzlCGbF-iFm0AqSeqx12nxk5ny1JoY"
GAS_URL  = "https://script.google.com/macros/s/AKfycbz52wvADM7O1zMjqKlT2G4HPkq8gwAon_fUCuKgbmUMkDPQkaYKUWnv598U3EkFN1AByQ/exec"

BRANCHES = ["ต้นสักคอร์เนอร์", "เมืองทองธานี", "ศรีนครินทร์"]


# ── Auth — shipment history isn't dual-written to Supabase, read the Sheet directly ──
def _build_creds():
    try:
        if "GOOGLE_SERVICE_ACCOUNT" in st.secrets:
            info = json.loads(st.secrets["GOOGLE_SERVICE_ACCOUNT"])
            return Credentials.from_service_account_info(info, scopes=SCOPES)
    except Exception:
        pass
    return Credentials.from_service_account_file(str(SA_PATH), scopes=SCOPES)

_gc_client = None

def get_gc():
    global _gc_client
    if _gc_client is not None:
        try:
            _gc_client.open_by_key(SHEET_ID)
            return _gc_client
        except Exception:
            _gc_client = None
    _gc_client = gspread.authorize(_build_creds())
    return _gc_client


@st.cache_resource
def get_supabase():
    from supabase import create_client
    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not url or not key:
        try:
            url = url or st.secrets["SUPABASE_URL"]
            key = key or st.secrets["SUPABASE_SERVICE_KEY"]
        except Exception:
            pass
    return create_client(url, key)


def gas_post(payload: dict) -> dict:
    resp = requests.post(GAS_URL, json=payload, timeout=30)
    result = resp.json()
    if result.get("error"):
        raise Exception(result["error"])
    return result


@st.cache_data(ttl=30)
def load_catalog() -> pd.DataFrame:
    rows = get_supabase().table("catalog").select("*").order("name").execute().data
    return pd.DataFrame(rows)


@st.cache_data(ttl=30)
def load_stock_branch() -> pd.DataFrame:
    rows = get_supabase().table("stock_branch").select("*").execute().data
    return pd.DataFrame(rows)


@st.cache_data(ttl=60)
def load_shipments() -> pd.DataFrame:
    try:
        ws = get_gc().open_by_key(SHEET_ID).worksheet("shipments")
        rows = ws.get_all_values()
        if len(rows) < 2:
            return pd.DataFrame()
        df = pd.DataFrame(rows[1:], columns=rows[0])
        return df.iloc[::-1].reset_index(drop=True)  # newest first
    except Exception:
        return pd.DataFrame()


def parse_items(items_json: str) -> list:
    try:
        return json.loads(items_json) if items_json else []
    except Exception:
        return []


def item_summary(i: dict) -> str:
    box = (i.get("qty_box") or 0) + (i.get("qty_box_extra") or 0)
    pack = (i.get("qty_pack") or 0) + (i.get("qty_pack_extra") or 0)
    parts = []
    if box:
        parts.append(f"{box} กล่อง")
    if pack:
        parts.append(f"{pack} ซอง")
    return f"{i.get('name', '')} ({', '.join(parts)})" if parts else i.get("name", "")


# ── Page ──────────────────────────────────────────────────────────────────────
apply_theme()
page_header("สต็อกสินค้า", "คลังกลาง สต็อกสาขา และประวัติการโอน")

catalog = load_catalog()
stock_branch = load_stock_branch()

low_stock = pd.DataFrame()
if not catalog.empty:
    low_stock = catalog[
        (pd.to_numeric(catalog["limit_box"], errors="coerce").fillna(0) > 0)
        & (pd.to_numeric(catalog["qty_box"], errors="coerce").fillna(0)
           <= pd.to_numeric(catalog["limit_box"], errors="coerce").fillna(0))
    ]

k1, k2, k3 = st.columns(3)
with k1:
    st.markdown(kpi_card("สินค้าทั้งหมด", len(catalog)), unsafe_allow_html=True)
with k2:
    st.markdown(
        kpi_card("ใกล้หมด (คลังกลาง)", len(low_stock), DANGER_TEXT if len(low_stock) else TEXT2),
        unsafe_allow_html=True,
    )
with k3:
    total_branch_box = int(pd.to_numeric(stock_branch["qty_box"], errors="coerce").fillna(0).sum()) if not stock_branch.empty else 0
    st.markdown(kpi_card("สต็อกสาขารวม (กล่อง)", f"{total_branch_box:,}"), unsafe_allow_html=True)

st.markdown("<div style='height:16px'></div>", unsafe_allow_html=True)

tab_central, tab_branch, tab_history = st.tabs(["คลังกลาง", "สต็อกสาขา", "ประวัติการโอน"])

with tab_central:
    if catalog.empty:
        st.caption("ยังไม่มีข้อมูลสินค้า")
    else:
        show = catalog[["name", "category", "qty_box", "qty_pack", "limit_box", "limit_pack"]].copy()
        show["สถานะ"] = show.apply(
            lambda r: "⚠️ ใกล้หมด" if (pd.to_numeric(r["limit_box"], errors="coerce") or 0) > 0
            and (pd.to_numeric(r["qty_box"], errors="coerce") or 0) <= (pd.to_numeric(r["limit_box"], errors="coerce") or 0)
            else "ปกติ",
            axis=1,
        )
        show = show.rename(columns={
            "name": "สินค้า", "category": "หมวดหมู่", "qty_box": "กล่อง", "qty_pack": "ซอง",
            "limit_box": "ขั้นต่ำ (กล่อง)", "limit_pack": "ขั้นต่ำ (ซอง)",
        })
        st.dataframe(show, use_container_width=True, hide_index=True)

    with st.expander("➕ เพิ่มสต็อกคลังกลาง"):
        names = catalog["name"].tolist() if not catalog.empty else []
        with st.form("add_stock_form"):
            sel_name = st.selectbox("สินค้า", names)
            c1, c2 = st.columns(2)
            add_box = c1.number_input("เพิ่มกล่อง", min_value=0, value=0, step=1)
            add_pack = c2.number_input("เพิ่มซอง", min_value=0, value=0, step=1)
            submitted = st.form_submit_button("บันทึก")
            if submitted:
                if add_box <= 0 and add_pack <= 0:
                    st.warning("ใส่จำนวนที่จะเพิ่มก่อน")
                else:
                    try:
                        gas_post({"_action": "addStock", "name": sel_name, "add_box": add_box, "add_pack": add_pack})
                        st.success("เพิ่มสต็อกแล้ว")
                        st.cache_data.clear()
                        st.rerun()
                    except Exception as e:
                        st.error(f"บันทึกไม่ได้: {e}")

with tab_branch:
    if stock_branch.empty:
        st.caption("ยังไม่มีข้อมูลสต็อกสาขา")
    else:
        branch_sel = st.selectbox("เลือกสาขา", ["ทุกสาขา"] + BRANCHES, key="stock_branch_sel")
        show_b = stock_branch if branch_sel == "ทุกสาขา" else stock_branch[stock_branch["branch"] == branch_sel]
        show_b = show_b[["name", "branch", "qty_box", "qty_pack"]].sort_values(["branch", "name"]).rename(
            columns={"name": "สินค้า", "branch": "สาขา", "qty_box": "กล่อง", "qty_pack": "ซอง"}
        )
        st.dataframe(show_b, use_container_width=True, hide_index=True)

    with st.expander("➖ เบิก / ปรับสต็อกสาขา"):
        names_b = sorted(stock_branch["name"].unique().tolist()) if not stock_branch.empty else []
        with st.form("withdraw_stock_form"):
            wb1, wb2 = st.columns(2)
            w_branch = wb1.selectbox("สาขา", BRANCHES)
            w_name = wb2.selectbox("สินค้า", names_b)
            wb3, wb4 = st.columns(2)
            w_type = wb3.radio("หน่วย", ["box", "pack"], format_func=lambda t: "กล่อง" if t == "box" else "ซอง", horizontal=True)
            w_qty = wb4.number_input("จำนวน", min_value=1, value=1, step=1)
            w_reason = st.text_input("เหตุผล", placeholder="เช่น สินค้าเสียหาย, ปรับยอดนับสต็อก")
            submitted_w = st.form_submit_button("บันทึก")
            if submitted_w:
                try:
                    gas_post({
                        "_action": "withdrawStock", "branch": w_branch, "name": w_name,
                        "type": w_type, "qty": w_qty, "reason": w_reason,
                    })
                    st.success("บันทึกแล้ว")
                    st.cache_data.clear()
                    st.rerun()
                except Exception as e:
                    st.error(f"บันทึกไม่ได้: {e}")

with tab_history:
    ships = load_shipments()
    if ships.empty:
        st.caption("ยังไม่มีประวัติการโอนสต็อก")
    else:
        rows_out = []
        for _, r in ships.iterrows():
            items = parse_items(r.get("items_json", ""))
            summary = "; ".join(item_summary(i) for i in items)
            rows_out.append({
                "เลขล็อต": r.get("shipment_id", ""),
                "วันที่ส่ง": r.get("timestamp", ""),
                "ปลายทาง": r.get("to_branch", ""),
                "สถานะ": r.get("status", ""),
                "สินค้า": summary,
                "รับแล้วเมื่อ": r.get("received_at", "") or "—",
            })
        st.dataframe(pd.DataFrame(rows_out), use_container_width=True, hide_index=True)
