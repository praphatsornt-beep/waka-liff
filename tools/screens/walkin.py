#!/usr/bin/env python3
"""หน้าร้าน — ประวัติการขายหน้าร้าน (walk-in), แยกออกมาจากหน้าสต็อกสินค้า"""

import json
import os
import sys
from pathlib import Path

import streamlit as st
import pandas as pd
from dotenv import load_dotenv

load_dotenv()

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from theme import apply_theme, page_header, kpi_card, TEXT2

BRANCHES = ["ต้นสักคอร์เนอร์", "เมืองทองธานี", "ศรีนครินทร์"]


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


@st.cache_data(ttl=30)
def load_walkin_sales() -> pd.DataFrame:
    rows = get_supabase().table("walkin_sales").select("*").order("timestamp", desc=True).execute().data
    return pd.DataFrame(rows)


def parse_items(items_json) -> list:
    if isinstance(items_json, list):
        return items_json
    try:
        return json.loads(items_json) if items_json else []
    except Exception:
        return []


# ── Page ──────────────────────────────────────────────────────────────────────
apply_theme()
page_header("หน้าร้าน", "ประวัติการขายหน้าร้าน (walk-in) แยกจากออเดอร์ออนไลน์")

sales = load_walkin_sales()
if sales.empty:
    st.caption("ยังไม่มีประวัติขายหน้าร้าน")
else:
    ws_branch_sel = st.selectbox("เลือกสาขา", ["ทุกสาขา"] + BRANCHES, key="walkin_branch_sel")
    sales_show = sales if ws_branch_sel == "ทุกสาขา" else sales[sales["branch"] == ws_branch_sel]

    total_sold = pd.to_numeric(sales_show["total"], errors="coerce").fillna(0).sum()
    st.markdown(kpi_card("ยอดขายหน้าร้านรวม", f"฿{total_sold:,.0f}", TEXT2), unsafe_allow_html=True)
    st.markdown("<div style='height:8px'></div>", unsafe_allow_html=True)

    if sales_show.empty:
        st.caption("ไม่มีรายการขายหน้าร้านของสาขานี้")
    for _, r in sales_show.iterrows():
        items = parse_items(r.get("items_json", ""))
        summary = ", ".join(f"{i.get('name', '')} x{i.get('qty', 1)}" for i in items)
        pay_method = r.get("payment_method", "")
        pay_label = "💵 เงินสด" if pay_method == "cash" else f"📱 โอน{(' ' + r['bank']) if r.get('bank') else ''}"
        with st.container(border=True):
            c1, c2 = st.columns([3, 1])
            with c1:
                total_val = pd.to_numeric(r.get("total"), errors="coerce") or 0
                st.markdown(f"**฿{total_val:,.0f}** — 🏬 {r.get('branch', '')} · {r.get('timestamp', '')}")
                staff_name = r.get("staff_name") or ""
                staff_line = f" · 👤 {staff_name}" if staff_name else ""
                st.caption(f"{summary or '—'} · {pay_label}{staff_line}")
            with c2:
                st.caption(r.get("sale_id", ""))
