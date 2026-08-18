#!/usr/bin/env python3
"""ซื้อสินค้าเข้า — บันทึกการสั่งซื้อสต็อกเข้าคลังกลาง (ผู้ขาย/เอกสาร/ต้นทุน),
ติดตามยอดค้างชำระ (มัดจำ), และรายงานยอดซื้อ/ต้นทุนรายวัน-รายเดือน.

บันทึกการซื้อ (ค่าใช้จ่าย/ใบสั่งซื้อ) กับของเข้าคลังจริงเป็นคนละขั้นตอนกัน
โดยตั้งใจ — สั่งซื้อ/จ่ายมัดจำไว้ก่อน ของค่อยตามมาทีหลังก็มี: บันทึกการซื้อ
(recordPurchase) แค่เก็บรายการ+ยอดเงินไว้ก่อน ไม่แตะสต็อก ต้องกด "รับของเข้า
คลัง" (receivePurchase) อีกทีตอนของมาถึงจริง ค่อยเพิ่ม catalog.qty_box/qty_pack.

เขียนผ่าน GAS (handleRecordPurchase/handleReceivePurchase/
handleRecordPurchasePayment) เหมือนหน้าอื่นๆ — หน้านี้อ่าน Supabase ตรงเพื่อ
แสดงผล/รายงานเท่านั้น"""

import json
import os
import sys
from datetime import date, timedelta
from pathlib import Path

import streamlit as st
import pandas as pd
import requests
from dotenv import load_dotenv

load_dotenv()

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from theme import apply_theme, page_header, kpi_card, badge, admin_name, TEXT2, DANGER_TEXT

GAS_URL  = "https://script.google.com/macros/s/AKfycbz52wvADM7O1zMjqKlT2G4HPkq8gwAon_fUCuKgbmUMkDPQkaYKUWnv598U3EkFN1AByQ/exec"
WAKA_S   = "wk26xK9mPqRt"  # shared secret doPost/doGet require via ?_s= (same value as stock.py's WAKA_S)
ADMIN_CODE = "waka99"


def gas_post(payload: dict) -> dict:
    payload = {**payload, "code": ADMIN_CODE, "staff_name": admin_name()}
    resp = requests.post(f"{GAS_URL}?_s={WAKA_S}", json=payload, timeout=30)
    result = resp.json()
    if result.get("error"):
        raise Exception(result["error"])
    return result


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
def load_catalog() -> pd.DataFrame:
    rows = get_supabase().table("catalog").select("*").order("name").execute().data
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    text_cols = [c for c in ["category", "id"] if c in df.columns]
    df[text_cols] = df[text_cols].fillna("")
    return df


@st.cache_data(ttl=30)
def load_purchases() -> pd.DataFrame:
    try:
        rows = get_supabase().table("purchases").select("*").order("timestamp", desc=True).execute().data
    except Exception as e:
        # Table doesn't exist yet if the schema.sql migration hasn't been run
        # in Supabase — surface a clear message instead of a raw stack trace.
        st.error(
            "ยังอ่านตาราง `purchases` ไม่ได้ — ถ้าเพิ่งเปิดฟีเจอร์นี้ครั้งแรก "
            "ต้องรัน SQL migration ใน `supabase/schema.sql` (หัวข้อ 2026-08-18) "
            "ผ่าน Supabase SQL editor ก่อนใช้งานครับ\n\n" + str(e)
        )
        return pd.DataFrame()
    return pd.DataFrame(rows)


def parse_items(items_json) -> list:
    if isinstance(items_json, list):
        return items_json
    try:
        return json.loads(items_json) if items_json else []
    except Exception:
        return []


def _flash(msg: str) -> None:
    st.session_state["_flash_msg"] = msg


def df_to_csv_bytes(df: pd.DataFrame) -> bytes:
    return df.to_csv(index=False).encode("utf-8-sig")


@st.dialog("🧾 บันทึกการซื้อสินค้าเข้า", width="large")
def _record_purchase_dialog(catalog: pd.DataFrame):
    supplier = st.text_input("ผู้ขาย/ร้านค้า", key="rp_supplier")
    doc_no = st.text_input("เลขที่เอกสาร/ใบกำกับภาษี", key="rp_doc_no")
    notes = st.text_input("หมายเหตุ (ถ้ามี)", key="rp_notes")

    all_names = catalog["name"].tolist() if not catalog.empty else []
    name_to_row = {r["name"]: r for r in catalog.to_dict("records")} if not catalog.empty else {}
    sel_names = st.multiselect("เลือกสินค้าที่ซื้อเข้า", all_names, key="rp_products")

    st.caption("ทุน/หน่วย เว้นว่างไม่ต้องแก้ก็ได้ — ระบบใช้ต้นทุนปัจจุบันของสินค้านั้นให้อัตโนมัติ ถ้าแก้ จะอัปเดตต้นทุนสินค้าตัวนั้นให้เป็นราคาล่าสุดด้วย")
    st.caption("⚠️ บันทึกนี้เป็นการบันทึกค่าใช้จ่าย/ใบสั่งซื้อเท่านั้น — สต็อกคลังกลางจะยังไม่เพิ่มจนกว่าจะกด \"รับของเข้าคลัง\" ในแท็บประวัติการซื้อตอนของมาถึงจริง")

    items_payload = []
    running_total = 0.0
    for name in sel_names:
        row = name_to_row.get(name, {})
        cur_cost_box = float(row.get("cost_box") or 0)
        cur_cost_pack = float(row.get("cost_p") or 0)
        st.markdown(f"**{name}**")
        c1, c2, c3, c4 = st.columns(4)
        qb = c1.number_input("กล่อง", min_value=0, value=0, step=1, key=f"rp_qb_{name}")
        qp = c2.number_input("ซอง", min_value=0, value=0, step=1, key=f"rp_qp_{name}")
        cb = c3.number_input("ทุน/กล่อง", min_value=0.0, value=cur_cost_box, step=1.0, key=f"rp_cb_{name}")
        cp = c4.number_input("ทุน/ซอง", min_value=0.0, value=cur_cost_pack, step=1.0, key=f"rp_cp_{name}")
        if qb > 0 or qp > 0:
            running_total += qb * cb + qp * cp
            items_payload.append({
                "name": name, "id": row.get("id") or None,
                "qty_box": qb, "qty_pack": qp, "cost_box": cb, "cost_pack": cp,
            })

    st.markdown(f"**ยอดรวมประมาณการ: ฿{running_total:,.0f}**")

    paid_in_full = st.checkbox("จ่ายเต็มจำนวนแล้ว", value=True, key="rp_paid_full")
    deposit = None
    if not paid_in_full:
        deposit = st.number_input(
            "จ่ายมัดจำ/จ่ายแล้วจริง (บาท)", min_value=0.0, value=0.0, step=1.0, key="rp_deposit",
        )
        st.caption(f"ยอดค้างชำระโดยประมาณ: ฿{max(0.0, running_total - deposit):,.0f}")

    if st.button("💾 บันทึกการซื้อ", type="primary", key="rp_submit"):
        if not items_payload:
            st.warning("เลือกสินค้าและใส่จำนวนอย่างน้อย 1 รายการก่อน")
        else:
            try:
                payload = {
                    "_action": "recordPurchase",
                    "supplier": supplier.strip(), "doc_no": doc_no.strip(), "notes": notes.strip(),
                    "items": items_payload,
                }
                if not paid_in_full:
                    payload["amount_paid"] = deposit
                gas_post(payload)
                _flash("บันทึกการซื้อเรียบร้อย")
                st.cache_data.clear()
                st.rerun()
            except Exception as e:
                st.error(f"บันทึกไม่ได้: {e}")


# ── Page ──────────────────────────────────────────────────────────────────────
apply_theme()

if "_flash_msg" in st.session_state:
    st.toast(st.session_state.pop("_flash_msg"), icon="✅")

page_header("ซื้อสินค้าเข้า", "บันทึกการสั่งซื้อสต็อกเข้าคลังกลาง พร้อมผู้ขาย/เอกสาร/ต้นทุน และติดตามยอดค้างชำระ")

catalog = load_catalog()
purchases = load_purchases()

today = date.today()
this_month = today.strftime("%Y-%m")

if not purchases.empty:
    purchases["total_cost"] = pd.to_numeric(purchases.get("total_cost", 0), errors="coerce").fillna(0)
    purchases["amount_paid"] = pd.to_numeric(purchases.get("amount_paid", 0), errors="coerce").fillna(0)
    purchases["outstanding"] = (purchases["total_cost"] - purchases["amount_paid"]).clip(lower=0)
    purchases["timestamp_dt"] = pd.to_datetime(purchases.get("timestamp", ""), errors="coerce", utc=True)
    purchases["date"] = purchases["timestamp_dt"].dt.tz_convert("Asia/Bangkok").dt.date
    purchases["month"] = purchases["timestamp_dt"].dt.tz_convert("Asia/Bangkok").dt.strftime("%Y-%m")

today_cost = purchases.loc[purchases["date"] == today, "total_cost"].sum() if not purchases.empty else 0
month_cost = purchases.loc[purchases["month"] == this_month, "total_cost"].sum() if not purchases.empty else 0
month_count = int((purchases["month"] == this_month).sum()) if not purchases.empty else 0
outstanding_total = purchases["outstanding"].sum() if not purchases.empty else 0
pending_receipt = int((purchases["status"] == "รอสินค้า").sum()) if not purchases.empty and "status" in purchases.columns else 0

k1, k2, k3, k4, k5 = st.columns(5)
with k1:
    st.markdown(kpi_card("ซื้อเข้าวันนี้ (฿)", f"฿{today_cost:,.0f}"), unsafe_allow_html=True)
with k2:
    st.markdown(kpi_card("ซื้อเข้าเดือนนี้ (฿)", f"฿{month_cost:,.0f}"), unsafe_allow_html=True)
with k3:
    st.markdown(kpi_card("จำนวนครั้งเดือนนี้", month_count), unsafe_allow_html=True)
with k4:
    st.markdown(
        kpi_card("ยอดค้างชำระรวม (฿)", f"฿{outstanding_total:,.0f}", DANGER_TEXT if outstanding_total > 0 else TEXT2),
        unsafe_allow_html=True,
    )
with k5:
    st.markdown(
        kpi_card("รอรับของเข้าคลัง", pending_receipt, DANGER_TEXT if pending_receipt > 0 else TEXT2),
        unsafe_allow_html=True,
    )

st.markdown("<div style='height:12px'></div>", unsafe_allow_html=True)
if st.button("🧾 บันทึกการซื้อเข้าใหม่", type="primary"):
    _record_purchase_dialog(catalog)

st.markdown("<div style='height:16px'></div>", unsafe_allow_html=True)

tab_history, tab_report = st.tabs(["ประวัติการซื้อ", "รายงานซื้อเข้า"])

with tab_history:
    f1, f2, f3 = st.columns(3)
    with f1:
        h_from = st.date_input("จากวันที่", value=today - timedelta(days=30), key="ph_from")
    with f2:
        h_to = st.date_input("ถึงวันที่", value=today, key="ph_to")
    with f3:
        suppliers = sorted(s for s in purchases.get("supplier", pd.Series(dtype=str)).dropna().unique().tolist() if s) if not purchases.empty else []
        supplier_filter = st.selectbox("ผู้ขาย", ["ทั้งหมด"] + suppliers, key="ph_supplier")

    hist = purchases
    if not hist.empty:
        hist = hist[(hist["date"] >= h_from) & (hist["date"] <= h_to)]
        if supplier_filter != "ทั้งหมด":
            hist = hist[hist["supplier"] == supplier_filter]

    if hist.empty:
        st.caption("ไม่มีรายการซื้อในช่วงที่เลือก")
    else:
        hist = hist.sort_values("timestamp_dt", ascending=False)

        def _status(r):
            if r["outstanding"] <= 0:
                return "จ่ายครบ"
            if r["amount_paid"] > 0:
                return "มัดจำ"
            return "ค้างชำระทั้งหมด"

        def _items_text(ij):
            parts = []
            for it in parse_items(ij):
                qb, qp = it.get("qty_box") or 0, it.get("qty_pack") or 0
                unit = (f"{qb} กล่อง" if qb else "") + (f" {qp} ซอง" if qp else "")
                parts.append(f"{it.get('name','')} x{unit.strip()}")
            return ", ".join(parts)

        display = pd.DataFrame({
            "เลขที่": hist["purchase_id"],
            "วันที่": hist["date"],
            "ผู้ขาย": hist.get("supplier", ""),
            "เอกสาร": hist.get("doc_no", ""),
            "รายการสินค้า": hist["items_json"].apply(_items_text),
            "ยอดรวม": hist["total_cost"],
            "จ่ายแล้ว": hist["amount_paid"],
            "ค้างชำระ": hist["outstanding"],
            "สถานะจ่ายเงิน": hist.apply(_status, axis=1),
            "สถานะรับของ": hist.get("status", "รอสินค้า"),
            "พนักงาน": hist.get("staff_name", ""),
        })
        st.dataframe(display, use_container_width=True, hide_index=True)
        st.download_button(
            "⬇️ ดาวน์โหลดประวัติการซื้อ (CSV)", df_to_csv_bytes(display),
            file_name=f"waka_purchases_{h_from}_{h_to}.csv", mime="text/csv",
        )

        pending = hist[hist.get("status", "รอสินค้า") == "รอสินค้า"]
        if not pending.empty:
            st.markdown("<div style='height:12px'></div>", unsafe_allow_html=True)
            with st.expander(f"📥 รับของเข้าคลัง ({len(pending)} ใบรอของ)", expanded=True):
                for _, r in pending.iterrows():
                    rc1, rc2 = st.columns([4, 1])
                    with rc1:
                        st.markdown(
                            f"**{r['purchase_id']}** — {r.get('supplier') or 'ไม่ระบุผู้ขาย'} — "
                            + _items_text(r["items_json"]) + " — "
                            + badge(f"฿{r['total_cost']:,.0f}", "pending"),
                            unsafe_allow_html=True,
                        )
                    with rc2:
                        if st.button("📥 รับของแล้ว", key=f"recv_btn_{r['purchase_id']}", use_container_width=True):
                            try:
                                gas_post({"_action": "receivePurchase", "purchase_id": r["purchase_id"]})
                                _flash(f"รับของเข้าคลังแล้ว — {r['purchase_id']}")
                                st.cache_data.clear()
                                st.rerun()
                            except Exception as e:
                                st.error(f"บันทึกไม่ได้: {e}")
                    st.markdown("<hr style='margin:8px 0'>", unsafe_allow_html=True)

        unpaid = hist[hist["outstanding"] > 0]
        if not unpaid.empty:
            st.markdown("<div style='height:12px'></div>", unsafe_allow_html=True)
            with st.expander(f"💳 บันทึกจ่ายเงินเพิ่ม ({len(unpaid)} รายการค้างชำระ)"):
                for _, r in unpaid.iterrows():
                    st.markdown(
                        f"**{r['purchase_id']}** — {r.get('supplier') or 'ไม่ระบุผู้ขาย'} — "
                        + badge(f"ค้างชำระ ฿{r['outstanding']:,.0f}", "danger"),
                        unsafe_allow_html=True,
                    )
                    pc1, pc2 = st.columns([3, 1])
                    add_amt = pc1.number_input(
                        "จำนวนที่จ่ายเพิ่ม (บาท)", min_value=0.0, max_value=float(r["outstanding"]),
                        value=0.0, step=1.0, key=f"pay_add_{r['purchase_id']}",
                    )
                    if pc2.button("บันทึก", key=f"pay_btn_{r['purchase_id']}"):
                        if add_amt <= 0:
                            st.warning("ใส่จำนวนเงินก่อน")
                        else:
                            try:
                                gas_post({
                                    "_action": "recordPurchasePayment",
                                    "purchase_id": r["purchase_id"], "add_amount": add_amt,
                                })
                                _flash("บันทึกการจ่ายเงินแล้ว")
                                st.cache_data.clear()
                                st.rerun()
                            except Exception as e:
                                st.error(f"บันทึกไม่ได้: {e}")
                    st.markdown("<hr style='margin:8px 0'>", unsafe_allow_html=True)

with tab_report:
    r1, r2 = st.columns(2)
    with r1:
        r_from = st.date_input("จากวันที่", value=today.replace(day=1), key="pr_from")
    with r2:
        r_to = st.date_input("ถึงวันที่", value=today, key="pr_to")

    rep = purchases
    if not rep.empty:
        rep = rep[(rep["date"] >= r_from) & (rep["date"] <= r_to)]

    if rep.empty:
        st.caption("ไม่มีข้อมูลในช่วงที่เลือก")
    else:
        st.markdown("**รายงานรายวัน**")
        by_day = rep.groupby("date")["total_cost"].sum()
        st.bar_chart(by_day)
        daily_tbl = (
            rep.groupby("date").agg(ยอดซื้อ=("total_cost", "sum"), จำนวนครั้ง=("purchase_id", "count"))
            .reset_index().rename(columns={"date": "วันที่"})
        )
        st.dataframe(daily_tbl, use_container_width=True, hide_index=True)
        st.download_button(
            "⬇️ ดาวน์โหลดรายงานรายวัน (CSV)", df_to_csv_bytes(daily_tbl),
            file_name=f"waka_purchases_daily_{r_from}_{r_to}.csv", mime="text/csv", key="dl_daily",
        )

        st.markdown("<div style='height:16px'></div>", unsafe_allow_html=True)
        st.markdown("**รายงานรายเดือน**")
        by_month = rep.groupby("month")["total_cost"].sum()
        st.bar_chart(by_month)
        monthly_tbl = (
            rep.groupby("month").agg(ยอดซื้อ=("total_cost", "sum"), จำนวนครั้ง=("purchase_id", "count"))
            .reset_index().rename(columns={"month": "เดือน"})
        )
        st.dataframe(monthly_tbl, use_container_width=True, hide_index=True)
        st.download_button(
            "⬇️ ดาวน์โหลดรายงานรายเดือน (CSV)", df_to_csv_bytes(monthly_tbl),
            file_name=f"waka_purchases_monthly_{r_from}_{r_to}.csv", mime="text/csv", key="dl_monthly",
        )

        st.markdown("<div style='height:16px'></div>", unsafe_allow_html=True)
        st.markdown("**แยกตามผู้ขาย**")
        by_supplier = (
            rep.assign(ผู้ขาย=rep.get("supplier", pd.Series(dtype=str)).fillna("ไม่ระบุ").replace("", "ไม่ระบุ"))
            .groupby("ผู้ขาย").agg(ยอดซื้อ=("total_cost", "sum"), จำนวนครั้ง=("purchase_id", "count"))
            .reset_index().sort_values("ยอดซื้อ", ascending=False)
        )
        st.dataframe(by_supplier, use_container_width=True, hide_index=True)
