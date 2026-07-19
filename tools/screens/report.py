#!/usr/bin/env python3
"""Reports — sales by date/branch, best-selling products, tournament vs WAKA GYM"""

import json
import os
import sys
from datetime import date, timedelta
from pathlib import Path

import streamlit as st
import pandas as pd
from dotenv import load_dotenv

load_dotenv()

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from theme import apply_theme, page_header, kpi_card, ACCENT_TEXT, SUCCESS_TEXT, DANGER_TEXT

BRANCHES = ["ต้นสักคอร์เนอร์", "เมืองทองธานี", "ศรีนครินทร์", "จัดส่ง"]
CONFIRMED_ORDER_STATUS = "ยืนยัน"
CONFIRMED_REG_STATUS = ("verified", "cash")


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


def parse_items(items_json) -> list:
    if isinstance(items_json, list):
        return items_json
    try:
        return json.loads(items_json) if items_json else []
    except Exception:
        return []


@st.cache_data(ttl=60)
def load_orders_df() -> pd.DataFrame:
    rows = get_supabase().table("orders").select("*").execute().data
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df["total"] = pd.to_numeric(df.get("total", 0), errors="coerce").fillna(0)
    df["timestamp_dt"] = pd.to_datetime(df.get("timestamp", ""), errors="coerce", utc=True)
    df["date"] = df["timestamp_dt"].dt.tz_convert("Asia/Bangkok").dt.date
    return df


@st.cache_data(ttl=120)
def load_catalog_cost() -> dict:
    rows = get_supabase().table("catalog").select("name,cost_box,cost_p").execute().data
    return {r["name"]: {"cost_box": r.get("cost_box") or 0, "cost_p": r.get("cost_p") or 0} for r in rows}


@st.cache_data(ttl=60)
def load_tournament_data():
    sb = get_supabase()
    events = sb.table("tournament_events").select("*").execute().data
    regs = sb.table("tournament_registrations").select("*").execute().data
    return events, regs


@st.cache_data(ttl=60)
def load_wakagym_data():
    sb = get_supabase()
    events = sb.table("wakagym_events").select("*").execute().data
    regs = sb.table("wakagym_registrations").select("*").execute().data
    return events, regs


def order_cost(items_json, cost_map: dict) -> float:
    total = 0
    for i in parse_items(items_json):
        c = cost_map.get(i.get("name", ""), {})
        qty = i.get("qty", 1) or 1
        total += qty * (c.get("cost_box", 0) if i.get("type") == "box" else c.get("cost_p", 0))
    return total


# ── Page ──────────────────────────────────────────────────────────────────────
apply_theme()
page_header("รายงาน", "ยอดขาย สินค้าขายดี และเปรียบเทียบทัวร์นาเมนต์ / WAKA GYM")

f1, f2, f3 = st.columns([1, 1, 1.2])
with f1:
    date_from = st.date_input("จากวันที่", value=date.today() - timedelta(days=30))
with f2:
    date_to = st.date_input("ถึงวันที่", value=date.today())
with f3:
    branch_sel = st.selectbox("สาขา", ["ทุกสาขา"] + BRANCHES)

orders = load_orders_df()
if not orders.empty:
    confirmed = orders[orders["slip_status"] == CONFIRMED_ORDER_STATUS]
    confirmed = confirmed[(confirmed["date"] >= date_from) & (confirmed["date"] <= date_to)]
    if branch_sel != "ทุกสาขา":
        confirmed = confirmed[confirmed["branch"] == branch_sel]
else:
    confirmed = orders

cost_map = load_catalog_cost()
if not confirmed.empty:
    confirmed = confirmed.assign(cost=confirmed["items_json"].apply(lambda ij: order_cost(ij, cost_map)))
    total_revenue = confirmed["total"].sum()
    total_cost = confirmed["cost"].sum()
else:
    total_revenue = total_cost = 0
total_profit = total_revenue - total_cost

k1, k2, k3, k4 = st.columns(4)
with k1:
    st.markdown(kpi_card("ยอดขายรวม", f"฿{total_revenue:,.0f}", ACCENT_TEXT), unsafe_allow_html=True)
with k2:
    st.markdown(kpi_card("ต้นทุนรวม", f"฿{total_cost:,.0f}"), unsafe_allow_html=True)
with k3:
    st.markdown(kpi_card("กำไร", f"฿{total_profit:,.0f}", SUCCESS_TEXT if total_profit >= 0 else DANGER_TEXT), unsafe_allow_html=True)
with k4:
    st.markdown(kpi_card("จำนวนออเดอร์", len(confirmed)), unsafe_allow_html=True)

st.markdown("<div style='height:16px'></div>", unsafe_allow_html=True)

tab_sales, tab_products, tab_compare = st.tabs(["ยอดขาย", "สินค้าขายดี", "ทัวร์นาเมนต์ vs WAKA GYM"])

with tab_sales:
    if confirmed.empty:
        st.caption("ไม่มีข้อมูลยอดขายในช่วงที่เลือก")
    else:
        by_date = confirmed.groupby("date")["total"].sum()
        st.bar_chart(by_date)
        by_branch = (
            confirmed.groupby("branch")
            .agg(ออเดอร์=("order_id", "count"), ยอดขาย=("total", "sum"))
            .reset_index()
            .rename(columns={"branch": "สาขา"})
            .sort_values("ยอดขาย", ascending=False)
        )
        st.dataframe(by_branch, use_container_width=True, hide_index=True)

with tab_products:
    if confirmed.empty:
        st.caption("ไม่มีข้อมูลสินค้าขายดีในช่วงที่เลือก")
    else:
        agg = {}
        for _, row in confirmed.iterrows():
            for i in parse_items(row.get("items_json")):
                key = (i.get("name", ""), i.get("type", ""))
                a = agg.setdefault(key, {"qty": 0, "revenue": 0})
                qty = i.get("qty", 1) or 1
                a["qty"] += qty
                a["revenue"] += qty * (i.get("price", 0) or 0)
        prod_df = pd.DataFrame([
            {"สินค้า": name, "ประเภท": "กล่อง" if t == "box" else "ซอง", "จำนวนขาย": v["qty"], "ยอดขาย": v["revenue"]}
            for (name, t), v in agg.items()
        ]).sort_values("ยอดขาย", ascending=False)
        st.dataframe(prod_df.head(20), use_container_width=True, hide_index=True)

with tab_compare:
    t_events, t_regs = load_tournament_data()
    g_events, g_regs = load_wakagym_data()
    t_confirmed = [r for r in t_regs if r.get("slip_status") in CONFIRMED_REG_STATUS]
    g_confirmed = [r for r in g_regs if r.get("slip_status") in CONFIRMED_REG_STATUS]

    c1, c2 = st.columns(2)
    with c1:
        st.markdown(kpi_card("ทัวร์นาเมนต์ — งานทั้งหมด", len(t_events)), unsafe_allow_html=True)
        st.markdown(kpi_card("ทัวร์นาเมนต์ — ผู้สมัคร (ยืนยันแล้ว/ทั้งหมด)", f"{len(t_confirmed)} / {len(t_regs)}"), unsafe_allow_html=True)
    with c2:
        st.markdown(kpi_card("WAKA GYM — งานทั้งหมด", len(g_events)), unsafe_allow_html=True)
        st.markdown(kpi_card("WAKA GYM — ผู้เล่น (ยืนยันแล้ว/ทั้งหมด)", f"{len(g_confirmed)} / {len(g_regs)}"), unsafe_allow_html=True)

    st.markdown("<div style='height:12px'></div>", unsafe_allow_html=True)

    compare_df = pd.DataFrame([
        {"ประเภท": "ทัวร์นาเมนต์", "จำนวนงาน": len(t_events), "ผู้สมัครทั้งหมด": len(t_regs), "ยืนยันแล้ว": len(t_confirmed)},
        {"ประเภท": "WAKA GYM", "จำนวนงาน": len(g_events), "ผู้สมัครทั้งหมด": len(g_regs), "ยืนยันแล้ว": len(g_confirmed)},
    ])
    st.dataframe(compare_df, use_container_width=True, hide_index=True)
    st.bar_chart(compare_df.set_index("ประเภท")[["ผู้สมัครทั้งหมด", "ยืนยันแล้ว"]])
