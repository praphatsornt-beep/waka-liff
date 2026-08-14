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
from theme import (
    apply_theme, flat, page_header, kpi_card,
    SURFACE, BORDER, TEXT2, DIVIDER, ACCENT_TEXT, PRIMARY_BTN, SUCCESS_TEXT, DANGER_TEXT,
)

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
def load_walkin_df() -> pd.DataFrame:
    rows = get_supabase().table("walkin_sales").select("*").execute().data
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df["total"] = pd.to_numeric(df.get("total", 0), errors="coerce").fillna(0)
    df["timestamp_dt"] = pd.to_datetime(df.get("timestamp", ""), errors="coerce", utc=True)
    df["date"] = df["timestamp_dt"].dt.tz_convert("Asia/Bangkok").dt.date
    return df


@st.cache_data(ttl=60)
def load_wakagym_data():
    sb = get_supabase()
    events = sb.table("wakagym_events").select("*").execute().data
    regs = sb.table("wakagym_registrations").select("*").execute().data
    return events, regs


def revenue_share_card(shares: list) -> str:
    total = sum(v for _, v, _ in shares) or 1
    segments_html = "".join(
        f'<div style="height:100%;width:{v / total * 100:.2f}%;background:{color}"></div>'
        for _, v, color in shares
    )
    rows_html = "".join(f"""
        <div style="display:flex;align-items:center;gap:10px;padding:8px 0">
          <span style="width:9px;height:9px;border-radius:2px;background:{color};flex:none"></span>
          <span style="flex:1;font-size:13.5px">{label}</span>
          <span style="font-size:13px;color:{TEXT2};width:50px;text-align:right">{v / total * 100:.0f}%</span>
          <span style="font-size:13px;font-weight:700;width:100px;text-align:right">฿{v:,.0f}</span>
        </div>
        """ for label, v, color in shares)
    return flat(f"""<div style="background:{SURFACE};border:1px solid {BORDER};border-radius:14px;padding:18px 20px">
    <div style="font-weight:600;font-size:14.5px;margin-bottom:14px">สัดส่วนรายได้ตามช่องทาง</div>
    <div style="height:10px;border-radius:5px;overflow:hidden;display:flex;background:{DIVIDER}">{segments_html}</div>
    <div style="margin-top:12px">{flat(rows_html)}</div>
    </div>""")


def order_cost(items_json, cost_map: dict) -> float:
    total = 0
    for i in parse_items(items_json):
        c = cost_map.get(i.get("name", ""), {})
        qty = i.get("qty", 1) or 1
        total += qty * (c.get("cost_box", 0) if i.get("type") == "box" else c.get("cost_p", 0))
    return total


def df_to_csv_bytes(df: pd.DataFrame) -> bytes:
    """utf-8-sig so Thai text opens correctly in Excel instead of mojibake."""
    return df.to_csv(index=False).encode("utf-8-sig")


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
    in_range = orders[orders["slip_status"] == CONFIRMED_ORDER_STATUS]
    in_range = in_range[(in_range["date"] >= date_from) & (in_range["date"] <= date_to)]
else:
    in_range = orders

cost_map = load_catalog_cost()
if not in_range.empty:
    in_range = in_range.assign(cost=in_range["items_json"].apply(lambda ij: order_cost(ij, cost_map)))

# `in_range` stays every branch (date-filtered only) so the "แยกสาขา" tab can
# always compare all branches side by side; `confirmed` applies the top
# branch_sel filter on top of that for the KPI cards and other tabs.
confirmed = in_range[in_range["branch"] == branch_sel] if branch_sel != "ทุกสาขา" else in_range
if not confirmed.empty:
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

st.markdown("<div style='height:10px'></div>", unsafe_allow_html=True)
export_cols = ["order_id", "date", "branch", "real_name", "phone", "total", "cost"]
export_df = confirmed[[c for c in export_cols if c in confirmed.columns]] if not confirmed.empty else pd.DataFrame(columns=export_cols)
st.download_button(
    "⬇️ ดาวน์โหลดออเดอร์ (CSV)", df_to_csv_bytes(export_df),
    file_name=f"waka_orders_{date_from}_{date_to}.csv", mime="text/csv",
)

st.markdown("<div style='height:16px'></div>", unsafe_allow_html=True)

tab_sales, tab_branch, tab_reimburse, tab_products, tab_compare = st.tabs(
    ["ยอดขาย", "แยกสาขา", "สรุปคืนต้นทุน", "สินค้าขายดี", "ทัวร์นาเมนต์ vs WAKA GYM"]
)

with tab_sales:
    t_events_s, t_regs_s = load_tournament_data()
    g_events_s, g_regs_s = load_wakagym_data()

    def _in_range(ts: str) -> bool:
        try:
            d = pd.to_datetime(ts, utc=True).tz_convert("Asia/Bangkok").date()
        except Exception:
            return False
        return date_from <= d <= date_to

    tourney_revenue = sum(
        int(r.get("amount_paid") or 0) for r in t_regs_s
        if r.get("slip_status") in CONFIRMED_REG_STATUS and _in_range(r.get("timestamp", ""))
    )
    gym_revenue = sum(
        int(r.get("note") or 0) or 200 for r in g_regs_s
        if r.get("slip_status") in CONFIRMED_REG_STATUS and _in_range(r.get("timestamp", ""))
    )
    st.markdown(revenue_share_card([
        ("ออเดอร์การ์ด", total_revenue, ACCENT_TEXT),
        ("ค่าสมัครทัวร์นาเมนต์", tourney_revenue, PRIMARY_BTN),
        ("WAKA GYM", gym_revenue, SUCCESS_TEXT),
    ]), unsafe_allow_html=True)
    st.markdown("<div style='height:16px'></div>", unsafe_allow_html=True)

    if confirmed.empty:
        st.caption("ไม่มีข้อมูลยอดขายในช่วงที่เลือก")
    else:
        by_date = confirmed.groupby("date")["total"].sum()
        st.bar_chart(by_date)

with tab_branch:
    if in_range.empty:
        st.caption("ไม่มีข้อมูลยอดขายในช่วงที่เลือก")
    else:
        by_branch = (
            in_range.groupby("branch")
            .agg(ออเดอร์=("order_id", "count"), ยอดขาย=("total", "sum"), ต้นทุน=("cost", "sum"))
            .assign(กำไร=lambda d: d["ยอดขาย"] - d["ต้นทุน"])
            .reset_index()
            .rename(columns={"branch": "สาขา"})
            .sort_values("ยอดขาย", ascending=False)
        )
        st.bar_chart(by_branch.set_index("สาขา")["ยอดขาย"])
        st.dataframe(by_branch, use_container_width=True, hide_index=True)
        st.download_button(
            "⬇️ ดาวน์โหลดยอดขายแยกสาขา (CSV)", df_to_csv_bytes(by_branch),
            file_name=f"waka_sales_by_branch_{date_from}_{date_to}.csv", mime="text/csv",
            key="dl_by_branch",
        )

        st.markdown("<div style='height:12px'></div>", unsafe_allow_html=True)
        for b in by_branch["สาขา"]:
            branch_orders = in_range[in_range["branch"] == b]
            with st.expander(f"สินค้าขายดี — {b}"):
                agg_b = {}
                for _, row in branch_orders.iterrows():
                    for i in parse_items(row.get("items_json")):
                        key = (i.get("name", ""), i.get("type", ""))
                        a = agg_b.setdefault(key, {"qty": 0, "revenue": 0})
                        qty = i.get("qty", 1) or 1
                        a["qty"] += qty
                        a["revenue"] += qty * (i.get("price", 0) or 0)
                if not agg_b:
                    st.caption("ไม่มีข้อมูล")
                else:
                    prod_df_b = pd.DataFrame([
                        {"สินค้า": name, "ประเภท": "กล่อง" if t == "box" else "ซอง", "จำนวนขาย": v["qty"], "ยอดขาย": v["revenue"]}
                        for (name, t), v in agg_b.items()
                    ]).sort_values("ยอดขาย", ascending=False)
                    st.dataframe(prod_df_b.head(10), use_container_width=True, hide_index=True)

with tab_reimburse:
    # "แยกสาขา" ข้างบนนับเฉพาะออเดอร์ออนไลน์ (orders) — ยอดขายหน้าร้าน
    # (walkin_sales) ถูกกันออกจากทุกรายงานโดยตั้งใจตอนแยกตารางออกมา (ไม่มี LINE
    # user/สลิปให้ตรวจ) แต่พอจะสรุปยอดเพื่อคืนต้นทุนให้แต่ละสาขา ต้องรวมทั้งสอง
    # ช่องทางเข้าด้วยกัน ไม่งั้นยอดขายหน้าร้านทั้งหมดจะหายไปจากยอดที่ใช้เคลียร์บัญชี
    st.caption("รวมยอดขายออนไลน์ (orders) + ขายหน้าร้าน (walkin) ต่อสาขา ตามช่วงวันที่ที่เลือกด้านบน — ใช้คำนวณยอดคืนต้นทุนให้แต่ละสาขา")

    walkin_df = load_walkin_df()
    if not walkin_df.empty:
        walkin_range = walkin_df[(walkin_df["date"] >= date_from) & (walkin_df["date"] <= date_to)]
        walkin_range = walkin_range.assign(cost=walkin_range["items_json"].apply(lambda ij: order_cost(ij, cost_map)))
    else:
        walkin_range = walkin_df

    online_by_branch = (
        in_range.groupby("branch").agg(
            ออเดอร์ออนไลน์=("order_id", "count"),
            ยอดขายออนไลน์=("total", "sum"),
            ต้นทุนออนไลน์=("cost", "sum"),
        ) if not in_range.empty else pd.DataFrame(columns=["ออเดอร์ออนไลน์", "ยอดขายออนไลน์", "ต้นทุนออนไลน์"])
    )
    walkin_by_branch = (
        walkin_range.groupby("branch").agg(
            รายการหน้าร้าน=("sale_id", "count"),
            ยอดขายหน้าร้าน=("total", "sum"),
            ต้นทุนหน้าร้าน=("cost", "sum"),
        ) if not walkin_range.empty else pd.DataFrame(columns=["รายการหน้าร้าน", "ยอดขายหน้าร้าน", "ต้นทุนหน้าร้าน"])
    )

    reimburse = online_by_branch.join(walkin_by_branch, how="outer").fillna(0)
    if reimburse.empty:
        st.caption("ไม่มีข้อมูลยอดขายในช่วงที่เลือก")
    else:
        for c in ["ออเดอร์ออนไลน์", "ยอดขายออนไลน์", "ต้นทุนออนไลน์", "รายการหน้าร้าน", "ยอดขายหน้าร้าน", "ต้นทุนหน้าร้าน"]:
            reimburse[c] = pd.to_numeric(reimburse[c], errors="coerce").fillna(0)
        reimburse["ยอดขายรวม"] = reimburse["ยอดขายออนไลน์"] + reimburse["ยอดขายหน้าร้าน"]
        reimburse["ต้นทุนรวม"] = reimburse["ต้นทุนออนไลน์"] + reimburse["ต้นทุนหน้าร้าน"]
        reimburse["กำไรรวม"] = reimburse["ยอดขายรวม"] - reimburse["ต้นทุนรวม"]
        reimburse = reimburse.reset_index().rename(columns={"branch": "สาขา"}).sort_values("ยอดขายรวม", ascending=False)
        # จำนวนรายการ (count) แสดงเป็นจำนวนเต็ม ไม่ใช่ 12.0
        for c in ["ออเดอร์ออนไลน์", "รายการหน้าร้าน"]:
            reimburse[c] = reimburse[c].astype(int)

        total_row = pd.DataFrame([{
            "สาขา": "รวมทุกสาขา",
            "ออเดอร์ออนไลน์": int(reimburse["ออเดอร์ออนไลน์"].sum()),
            "ยอดขายออนไลน์": reimburse["ยอดขายออนไลน์"].sum(),
            "ต้นทุนออนไลน์": reimburse["ต้นทุนออนไลน์"].sum(),
            "รายการหน้าร้าน": int(reimburse["รายการหน้าร้าน"].sum()),
            "ยอดขายหน้าร้าน": reimburse["ยอดขายหน้าร้าน"].sum(),
            "ต้นทุนหน้าร้าน": reimburse["ต้นทุนหน้าร้าน"].sum(),
            "ยอดขายรวม": reimburse["ยอดขายรวม"].sum(),
            "ต้นทุนรวม": reimburse["ต้นทุนรวม"].sum(),
            "กำไรรวม": reimburse["กำไรรวม"].sum(),
        }])

        rk1, rk2, rk3 = st.columns(3)
        with rk1:
            st.markdown(kpi_card("ยอดขายรวมทุกช่องทาง", f"฿{reimburse['ยอดขายรวม'].sum():,.0f}", ACCENT_TEXT), unsafe_allow_html=True)
        with rk2:
            st.markdown(kpi_card("ต้นทุนรวมที่ต้องคืน", f"฿{reimburse['ต้นทุนรวม'].sum():,.0f}"), unsafe_allow_html=True)
        with rk3:
            st.markdown(kpi_card("กำไรรวม", f"฿{reimburse['กำไรรวม'].sum():,.0f}", SUCCESS_TEXT if reimburse["กำไรรวม"].sum() >= 0 else DANGER_TEXT), unsafe_allow_html=True)

        st.markdown("<div style='height:10px'></div>", unsafe_allow_html=True)
        display_cols = ["สาขา", "ออเดอร์ออนไลน์", "ยอดขายออนไลน์", "ต้นทุนออนไลน์", "รายการหน้าร้าน", "ยอดขายหน้าร้าน", "ต้นทุนหน้าร้าน", "ยอดขายรวม", "ต้นทุนรวม", "กำไรรวม"]
        st.dataframe(pd.concat([reimburse[display_cols], total_row[display_cols]], ignore_index=True), use_container_width=True, hide_index=True)
        st.download_button(
            "⬇️ ดาวน์โหลดสรุปคืนต้นทุนแยกสาขา (CSV)", df_to_csv_bytes(reimburse[display_cols]),
            file_name=f"waka_reimburse_by_branch_{date_from}_{date_to}.csv", mime="text/csv",
            key="dl_reimburse",
        )

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
        st.download_button(
            "⬇️ ดาวน์โหลดสินค้าขายดี (CSV)", df_to_csv_bytes(prod_df),
            file_name=f"waka_top_products_{date_from}_{date_to}.csv", mime="text/csv",
            key="dl_prod",
        )

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
    st.download_button(
        "⬇️ ดาวน์โหลดตารางเปรียบเทียบ (CSV)", df_to_csv_bytes(compare_df),
        file_name=f"waka_tournament_vs_gym_{date_from}_{date_to}.csv", mime="text/csv",
        key="dl_compare",
    )
    st.bar_chart(compare_df.set_index("ประเภท")[["ผู้สมัครทั้งหมด", "ยืนยันแล้ว"]])
