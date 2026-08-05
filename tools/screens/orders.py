#!/usr/bin/env python3
"""Card Game Order Dashboard — admin view"""

import json
import os
import sys
from pathlib import Path
from datetime import date, datetime, timedelta, timezone

import streamlit as st
import pandas as pd
from dotenv import load_dotenv

load_dotenv()

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from theme import (
    apply_theme, badge, flat, page_header, kpi_card,
    SURFACE, SURFACE_ALT, BORDER, TEXT2, TEXT3, ACCENT_TEXT, ACCENT_LIGHT, DIVIDER2,
    PENDING_TEXT, SUCCESS_TEXT, DANGER_TEXT,
)

BRANCHES     = ["ต้นสักคอร์เนอร์", "เมืองทองธานี", "ศรีนครินทร์", "จัดส่ง"]
ALL_STATUS   = ["รอตรวจ", "รอตรวจเพิ่ม", "ยืนยัน", "ยอดไม่ตรง", "สลิปซ้ำ", "บัญชีไม่ตรง", "สงสัยปลอม", "ยกเลิก", "ไม่มีสลิป"]
ALL_FULFILL  = ["", "กำลังจัดส่งไปสาขา", "พร้อมรับ", "รับบางส่วนแล้ว", "สาขายืนยัน", "จัดส่งแล้ว", "รับแล้ว"]

TH_TZ = timezone(timedelta(hours=7))


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


@st.cache_data(ttl=120)
def load_orders() -> pd.DataFrame:
    try:
        rows = get_supabase().table("orders").select("*").execute().data
        df = pd.DataFrame(rows)
        if df.empty:
            return df
        df["total"]        = pd.to_numeric(df.get("total", 0), errors="coerce").fillna(0)
        df["slip_amount"]  = pd.to_numeric(df.get("slip_amount", 0), errors="coerce").fillna(0)
        df["timestamp_dt"] = pd.to_datetime(df.get("timestamp", ""), errors="coerce", utc=True)
        df["date"]         = df["timestamp_dt"].dt.tz_convert("Asia/Bangkok").dt.date
        return df
    except Exception as e:
        st.error(f"โหลด orders ไม่ได้: {e}")
        return pd.DataFrame()



def update_slip_status(order_id: str, status: str, amount: str = "", note: str = ""):
    """orders is Supabase-primary now (gas/Code.gs no longer reads/writes the
    Sheet for orders) — patch Supabase directly instead of the old gspread
    Sheet write, otherwise this would silently no-op on any order created
    after the cutover (never found in the now-frozen Sheet)."""
    updates = {}
    if status:
        updates["slip_status"] = status
    if amount:
        updates["slip_amount"] = amount
    if note:
        updates["notes"] = note
    if not updates:
        return
    get_supabase().table("orders").update(updates).eq("order_id", order_id).execute()


def patch_order_silent(order_id: str, fields: dict):
    """Direct silent Supabase patch — no LINE push, no stock mutation, no GAS
    cache bust. For backfilling/correcting records (e.g. orders fulfilled
    before this admin tool tracked them) without triggering the live
    customer-facing flow. Live day-to-day actions should keep going through
    gas_post()/confirm_slip_via_gas()/reject_slip_via_gas() instead."""
    if not fields:
        return
    get_supabase().table("orders").update(fields).eq("order_id", order_id).execute()


def _now_th():
    return datetime.now(TH_TZ).strftime("%Y-%m-%d %H:%M")


GAS_URL = "https://script.google.com/macros/s/AKfycbz52wvADM7O1zMjqKlT2G4HPkq8gwAon_fUCuKgbmUMkDPQkaYKUWnv598U3EkFN1AByQ/exec"
WAKA_S  = "wk26xK9mPqRt"  # shared secret doPost/doGet require via ?_s= (same value as tournament.py's WAKA_S)
ADMIN_CODE = "waka99"  # branch-scoped actions (handoverOrder/partialReady/partialCancelItems) now also
                        # require this to prove branch ownership, same as liff/app.html's admin bypass —
                        # Streamlit is an admin-only tool so it always passes the admin code

def confirm_slip_via_gas(order_id: str, custom_message: str = ""):
    import requests
    payload = {"_action": "confirmSlip", "order_id": order_id}
    if custom_message.strip():
        payload["custom_message"] = custom_message.strip()
    resp = requests.post(f"{GAS_URL}?_s={WAKA_S}", json=payload, timeout=30)
    result = resp.json()
    if not result.get("ok"):
        raise Exception(result.get("error", "GAS ตอบผิดพลาด"))


def reject_slip_via_gas(order_id: str, reason: str = ""):
    import requests
    payload = {"_action": "rejectSlip", "order_id": order_id}
    if reason.strip():
        payload["reason"] = reason.strip()
    resp = requests.post(f"{GAS_URL}?_s={WAKA_S}", json=payload, timeout=30)
    result = resp.json()
    if not result.get("ok"):
        raise Exception(result.get("error", "GAS ตอบผิดพลาด"))


def gas_post(payload: dict) -> dict:
    import requests
    payload = {**payload, "code": ADMIN_CODE}
    resp = requests.post(f"{GAS_URL}?_s={WAKA_S}", json=payload, timeout=30)
    result = resp.json()
    if not result.get("ok"):
        raise Exception(result.get("error", "GAS ตอบผิดพลาด"))
    return result


def force_complete_order(order_id: str):
    """Backfill close — marks the order fully received ('รับแล้ว') without
    sending LINE messages or touching branch stock. For orders that were
    actually shipped/handed over before this admin tool existed."""
    gas_post({"_action": "forceCompleteOrder", "order_id": order_id})


def parse_items(items_json) -> list:
    # Supabase's items_json is native jsonb (already a list); the old
    # Sheet-based read gave a JSON string — accept either.
    if isinstance(items_json, list):
        return items_json
    try:
        return json.loads(items_json) if items_json else []
    except Exception:
        return []


def needs_attention(s: str) -> bool:
    return s in ("รอตรวจ", "ยอดไม่ตรง", "สลิปซ้ำ", "บัญชีไม่ตรง", "สงสัยปลอม")

def status_kind(s: str) -> str:
    if s == "ยืนยัน":
        return "success"
    if s in ("ยอดไม่ตรง", "สลิปซ้ำ", "บัญชีไม่ตรง", "สงสัยปลอม", "ยกเลิก"):
        return "danger"
    return "pending"

def fulfill_icon(s: str) -> str:
    if s == "รับแล้ว":            return "✅"
    if s == "สาขายืนยัน":        return "🤝"
    if s == "จัดส่งแล้ว":         return "📦"
    if s == "พร้อมรับ":           return "📍"
    if s == "กำลังจัดส่งไปสาขา":  return "🚚"
    return "⏳"


def item_state(it: dict):
    if it.get("cancelled_at"):
        return "ยกเลิกแล้ว", "danger"
    if it.get("handed_at"):
        return "ส่งมอบแล้ว", "success"
    if it.get("ready_at"):
        return "พร้อมรับ", "pending"
    return "รอดำเนินการ", "pending"


def handover_candidates(items: list) -> list:
    """Mirrors gas/Code.gs's handleHandoverOrder item-selection logic: items
    marked ready (or, for orders that never used the partial-ready flow,
    every still-active item) that haven't been handed over or cancelled."""
    has_ready = any(it.get("ready_at") for it in items)
    return [
        idx for idx, it in enumerate(items)
        if not it.get("cancelled_at") and not it.get("handed_at")
        and (bool(it.get("ready_at")) if has_ready else True)
    ]

def fulfill_kind(s: str) -> str:
    return "success" if s in ("รับแล้ว", "สาขายืนยัน", "จัดส่งแล้ว", "พร้อมรับ") else "pending"


def build_confirm_message(order_id: str, items: list, total, branch: str) -> str:
    """Mirrors gas/Code.gs's handleConfirmSlip default LINE message — used to
    pre-fill the editable textarea so admins start from the real template."""
    items_text = "\n".join(
        f"  - {i.get('name','')} ({'กล่อง' if i.get('type') == 'box' else 'ซอง'}) x{i.get('qty', 1)}"
        for i in items
    )
    is_delivery = branch == "จัดส่ง"
    loc = "จัดส่งพัสดุ" if is_delivery else f"รับที่สาขา: {branch}"
    return (
        f"ยืนยันการชำระเงินแล้ว ✅\n\n"
        f"ออเดอร์: #{order_id}\n\n"
        f"{items_text}\n\n"
        f"ยอดรวม: {int(float(total or 0))} บาท\n{loc}\n\n"
        f"ทีมงานจะแจ้งเมื่อสินค้าพร้อมรับครับ"
    )




def build_notify_message(order_id: str, items: list, total, branch: str, slip_status: str, fulfillment: str) -> str:
    """Mirrors gas/Code.gs's handleNotifyCustomer default LINE message."""
    items_text = "\n".join(
        f"  - {i.get('name','')} ({'กล่อง' if i.get('type') == 'box' else 'ซอง'}) x{i.get('qty', 1)}"
        for i in items
    )
    is_delivery = branch == "จัดส่ง"
    loc = "จัดส่งพัสดุ" if is_delivery else f"รับที่สาขา: {branch}"
    return (
        f"แจ้งเตือนสถานะออเดอร์ #{order_id}\n\n"
        f"{items_text}\n\n"
        f"ยอดรวม: {int(float(total or 0))} บาท\n{loc}\n\n"
        f"สถานะสลิป: {slip_status or 'รอตรวจ'}\n"
        f"สถานะจัดส่ง: {fulfillment or 'รอเตรียม'}"
    )


# ── Page header ───────────────────────────────────────────────────────────────
apply_theme()
page_header("จัดการออเดอร์", "ค้นหา ตรวจสลิป และติดตามสถานะออเดอร์การ์ด")

# ── Load ──────────────────────────────────────────────────────────────────────
df = load_orders()
if df.empty:
    st.info("ยังไม่มีออเดอร์")
    st.stop()

all_products = sorted({
    i.get("name", "")
    for items_json in df.get("items_json", [])
    for i in parse_items(items_json)
    if i.get("name")
})

phone_counts = df["phone"].value_counts().to_dict() if "phone" in df.columns else {}

# ── KPI row (today, independent of filters below) ────────────────────────────
today = datetime.now(TH_TZ).date()
today_df = df[df["date"] == today]
today_confirmed = today_df[today_df["slip_status"] == "ยืนยัน"]
pending_all = df[df["slip_status"].isin(["รอตรวจ", "รอตรวจเพิ่ม"])]
rejected_all = df[df["slip_status"] == "ยกเลิก"]

k1, k2, k3, k4 = st.columns(4)
with k1:
    st.markdown(kpi_card("ออเดอร์วันนี้", len(today_df)), unsafe_allow_html=True)
with k2:
    st.markdown(kpi_card("ยอดขายวันนี้", f"฿{today_confirmed['total'].sum():,.0f}", ACCENT_TEXT), unsafe_allow_html=True)
with k3:
    st.markdown(kpi_card("รอตรวจสลิป", len(pending_all), PENDING_TEXT), unsafe_allow_html=True)
with k4:
    st.markdown(kpi_card("ปฏิเสธ/ยกเลิก", len(rejected_all), DANGER_TEXT), unsafe_allow_html=True)

st.markdown("<div style='height:16px'></div>", unsafe_allow_html=True)

# ── Filter bar (shared by every tab below) ───────────────────────────────────
FILTER_KEYS = ["ord_search", "ord_branch", "ord_status", "ord_products", "ord_date_from", "ord_date_to"]

with st.container(border=True):
    f1, f2, f3, f4 = st.columns([2, 1.3, 1.3, 1.5])
    with f1:
        search = st.text_input("ค้นหา", placeholder="ค้นหาชื่อ / เบอร์โทร / เลขออเดอร์ / สินค้า", label_visibility="collapsed", key="ord_search")
    with f2:
        branch_sel = st.selectbox("สาขา", ["ทุกสาขา"] + BRANCHES, label_visibility="collapsed", key="ord_branch")
    with f3:
        status_sel = st.selectbox("สถานะสลิป", ["ทุกสถานะสลิป"] + ALL_STATUS, label_visibility="collapsed", key="ord_status")
    with f4:
        product_filter = st.multiselect("สินค้า", all_products, default=[], placeholder="ทุกสินค้า", label_visibility="collapsed", key="ord_products")

    f5, f6, f7, f8 = st.columns([1.3, 0.3, 1.3, 1.3])
    with f5:
        date_from = st.date_input("จากวันที่", value=date.today() - timedelta(days=7), label_visibility="collapsed", key="ord_date_from")
    with f6:
        st.markdown(f"<div style='text-align:center;padding-top:8px;color:{TEXT3};font-size:12px;white-space:nowrap'>ถึง</div>", unsafe_allow_html=True)
    with f7:
        date_to = st.date_input("ถึงวันที่", value=date.today(), label_visibility="collapsed", key="ord_date_to")
    with f8:
        if st.button("ล้างตัวกรอง", use_container_width=True):
            for k in FILTER_KEYS:
                st.session_state.pop(k, None)
            st.rerun()

# ── Filter ────────────────────────────────────────────────────────────────────
filtered = df.copy()
filtered = filtered[(filtered["date"] >= date_from) & (filtered["date"] <= date_to)]
if branch_sel != "ทุกสาขา":
    filtered = filtered[filtered["branch"] == branch_sel]
if status_sel != "ทุกสถานะสลิป":
    filtered = filtered[filtered["slip_status"] == status_sel]
if product_filter:
    wanted = set(product_filter)
    filtered = filtered[filtered["items_json"].apply(
        lambda ij: any(i.get("name") in wanted for i in parse_items(ij))
    )]
if search:
    s = search.lower()
    mask = (
        filtered.get("real_name", pd.Series(dtype=str)).str.lower().str.contains(s, na=False) |
        filtered.get("phone",     pd.Series(dtype=str)).str.lower().str.contains(s, na=False) |
        filtered.get("order_id",  pd.Series(dtype=str)).str.lower().str.contains(s, na=False) |
        filtered.get("display_name", pd.Series(dtype=str)).str.lower().str.contains(s, na=False)
    )
    filtered = filtered[mask]

if filtered.empty:
    st.info("ไม่มีออเดอร์ตามเงื่อนไขที่เลือก")
    st.stop()

st.markdown("<div style='height:8px'></div>", unsafe_allow_html=True)

tab_cards, tab_table, tab_customers = st.tabs(["🗂 การ์ดออเดอร์", "📊 ตารางรวม", "👥 ลูกค้าทั้งหมด"])

# ── Tab: การ์ดออเดอร์ (existing card-based workflow — live actions, sends LINE) ─
with tab_cards:
    # ── Sort + count + page-size row ─────────────────────────────────────────
    c1, c2, c3 = st.columns([2.2, 1, 1])
    with c1:
        st.markdown(
            f"<div style='font-size:13px;color:{TEXT2};padding-top:8px'>แสดง <strong style='color:inherit'>{len(filtered)}</strong> จาก {len(df)} ออเดอร์</div>",
            unsafe_allow_html=True,
        )
    with c2:
        sort_sel = st.selectbox("เรียงตาม", ["ใหม่สุดก่อน", "เก่าสุดก่อน", "ยอดสูงสุดก่อน"], label_visibility="collapsed")
    with c3:
        page_size_sel = st.selectbox("แสดงต่อหน้า", [20, 40, 60, 80, "ทั้งหมด"], label_visibility="collapsed", key="ord_page_size")

    if sort_sel == "ใหม่สุดก่อน":
        cards_sorted = filtered.sort_values("timestamp_dt", ascending=False)
    elif sort_sel == "เก่าสุดก่อน":
        cards_sorted = filtered.sort_values("timestamp_dt", ascending=True)
    else:
        cards_sorted = filtered.sort_values("total", ascending=False)
    cards_sorted = cards_sorted.reset_index(drop=True)

    # ── Pagination ─────────────────────────────────────────────────────────────
    if page_size_sel == "ทั้งหมด":
        page_df = cards_sorted
        total_pages = 1
    else:
        page_size = int(page_size_sel)
        total_pages = max((len(cards_sorted) + page_size - 1) // page_size, 1)
        st.session_state.ord_page_num = min(st.session_state.get("ord_page_num", 1), total_pages)
        if st.session_state.ord_page_num < 1:
            st.session_state.ord_page_num = 1
        start = (st.session_state.ord_page_num - 1) * page_size
        page_df = cards_sorted.iloc[start:start + page_size]

        if total_pages > 1:
            pn1, pn2, pn3 = st.columns([1, 2, 1])
            with pn1:
                if st.button("← ก่อนหน้า", disabled=st.session_state.ord_page_num <= 1, use_container_width=True):
                    st.session_state.ord_page_num -= 1
                    st.rerun()
            with pn2:
                st.markdown(
                    f"<div style='text-align:center;padding-top:8px;color:{TEXT2};font-size:13px'>หน้า {st.session_state.ord_page_num} / {total_pages}</div>",
                    unsafe_allow_html=True,
                )
            with pn3:
                if st.button("ถัดไป →", disabled=st.session_state.ord_page_num >= total_pages, use_container_width=True):
                    st.session_state.ord_page_num += 1
                    st.rerun()

    # ── Bulk selection state ──────────────────────────────────────────────────
    if "selected_orders" not in st.session_state:
        st.session_state.selected_orders = set()

    visible_ids = set(filtered["order_id"])
    st.session_state.selected_orders &= visible_ids  # drop selections that scrolled out of the current filter

    if st.session_state.selected_orders:
        sel_rows = filtered[filtered["order_id"].isin(st.session_state.selected_orders)]
        sel_pending = sel_rows[sel_rows["slip_status"].isin(["รอตรวจ", "รอตรวจเพิ่ม"])]
        sel_handover_ids = [
            r["order_id"] for _, r in sel_rows.iterrows()
            if r["slip_status"] == "ยืนยัน" and handover_candidates(parse_items(r.get("items_json", "")))
        ]
        sel_not_done = sel_rows[sel_rows["fulfillment"] != "รับแล้ว"]
        with st.container(border=True):
            b1, b2, b3, b4, b5, b6 = st.columns([1.4, 1.3, 1.2, 1.3, 1.0, 0.8])
            with b1:
                st.markdown(f"<div style='padding-top:8px;font-weight:600'>เลือกแล้ว {len(st.session_state.selected_orders)} ออเดอร์</div>", unsafe_allow_html=True)
            with b2:
                if st.button(f"✅ อนุมัติสลิปที่เลือก ({len(sel_pending)})", disabled=sel_pending.empty):
                    for _, r in sel_pending.iterrows():
                        try:
                            confirm_slip_via_gas(r["order_id"])
                        except Exception as e:
                            st.error(f"#{r['order_id']}: {e}")
                    st.session_state.selected_orders = set()
                    st.cache_data.clear()
                    st.rerun()
            with b3:
                if st.button(f"🤝 ส่งมอบที่เลือก ({len(sel_handover_ids)})", disabled=not sel_handover_ids):
                    for order_id in sel_handover_ids:
                        try:
                            gas_post({"_action": "handoverOrder", "order_id": order_id})
                        except Exception as e:
                            st.error(f"#{order_id}: {e}")
                    st.session_state.selected_orders = set()
                    st.cache_data.clear()
                    st.rerun()
            with b4:
                if st.button(f"🏁 ปิดงาน (เสร็จแล้ว) ({len(sel_not_done)})", disabled=sel_not_done.empty,
                             help="ปิดสถานะย้อนหลังเป็น 'รับแล้ว' แบบเงียบ — ไม่ส่ง LINE แจ้งลูกค้า ไม่ตัดสต็อกสาขา เหมาะกับออเดอร์ที่ส่งมอบจริงไปแล้วนอกระบบ"):
                    for _, r in sel_not_done.iterrows():
                        try:
                            force_complete_order(str(r["order_id"]))
                        except Exception as e:
                            st.error(f"#{r['order_id']}: {e}")
                    st.session_state.selected_orders = set()
                    st.cache_data.clear()
                    st.rerun()
            with b5:
                if st.button("❌ ยกเลิกสลิปที่เลือก"):
                    for _, r in sel_rows.iterrows():
                        try:
                            reject_slip_via_gas(str(r["order_id"]))
                        except Exception as e:
                            st.error(f"#{r['order_id']}: {e}")
                    st.session_state.selected_orders = set()
                    st.cache_data.clear()
                    st.rerun()
            with b6:
                if st.button("ยกเลิกการเลือก"):
                    st.session_state.selected_orders = set()
                    st.rerun()

    # ── Select all (current page) ───────────────────────────────────────────
    page_ids = set(page_df["order_id"])
    was_all_checked = bool(page_ids) and page_ids.issubset(st.session_state.selected_orders)
    all_checked = st.checkbox(f"เลือกทั้งหมดในหน้านี้ ({len(page_ids)} ออเดอร์)", value=was_all_checked, key="select_all_page")
    if all_checked != was_all_checked:
        if all_checked:
            st.session_state.selected_orders |= page_ids
        else:
            st.session_state.selected_orders -= page_ids
        for oid in page_ids:
            st.session_state[f"sel_{oid}"] = all_checked
        st.rerun()

    # ── Order cards ───────────────────────────────────────────────────────────
    for _, row in page_df.iterrows():
        order_id = row.get("order_id", "")
        items = parse_items(row.get("items_json", ""))
        is_del = row.get("branch", "") == "จัดส่ง"
        cur_status = row.get("slip_status", "รอตรวจ")
        ff_status = row.get("fulfillment", "") or "รอเตรียม"
        ff_icon = fulfill_icon(ff_status)
        total_str = f"฿{int(row.get('total', 0)):,}"
        branch_str = "จัดส่ง" if is_del else row.get("branch", "—")
        is_repeat = phone_counts.get(row.get("phone", ""), 0) > 1
        items_summary = ", ".join(f"{i.get('name','')} x{i.get('qty',1)}" for i in items)
        avatar = (row.get("real_name", "?") or "?").strip()[:1]
        notified_at = row.get("notified_at", "") or ""

        row_html = flat(f"""
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <div style="width:28px;height:28px;border-radius:50%;background:{ACCENT_LIGHT};color:{ACCENT_TEXT};
                      font-weight:700;font-size:13px;display:flex;align-items:center;justify-content:center;flex:none">{avatar}</div>
          <div style="font-size:12px;color:{TEXT3};font-weight:600;flex:none">#{order_id}</div>
          <div style="font-size:14px;font-weight:600;min-width:0">{row.get('real_name', '?')}</div>
          {badge(cur_status, status_kind(cur_status))}
          <div style="margin-left:auto;flex:none;font-weight:700;font-size:15px">{total_str}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12.5px;color:{TEXT3};margin-top:6px">
          <span>{row.get('phone', '—')}</span>
          {badge('ลูกค้าประจำ' if is_repeat else 'ลูกค้าใหม่', 'success' if is_repeat else 'pending')}
          <span>· {branch_str}</span>
          <span style="padding:1px 8px;border-radius:20px;background:{SURFACE_ALT};color:{TEXT2};font-size:11px">LIFF App</span>
          <span style="padding:1px 8px;border-radius:20px;background:{SURFACE_ALT};color:{TEXT2};font-size:11px">โอนเงิน</span>
          {badge((f'จัดส่ง · {ff_status}' if is_del else f'{ff_icon} {ff_status}'), fulfill_kind(ff_status)) if cur_status == "ยืนยัน" else ''}
          {badge(f'📣 แจ้งแล้ว {notified_at}', 'success') if notified_at else ''}
          <span style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:{TEXT3}">{items_summary}</span>
        </div>
        """)

        cb_col, body_col = st.columns([0.04, 0.96])
        with cb_col:
            was_checked = order_id in st.session_state.selected_orders
            checked = st.checkbox(
                "เลือก", key=f"sel_{order_id}",
                value=was_checked,
                label_visibility="collapsed",
            )
            if checked != was_checked:
                if checked:
                    st.session_state.selected_orders.add(order_id)
                else:
                    st.session_state.selected_orders.discard(order_id)
                st.rerun()
        with body_col:
            with st.container(border=True):
                st.markdown(row_html, unsafe_allow_html=True)

                with st.expander("รายละเอียด & จัดการออเดอร์", expanded=needs_attention(cur_status), key=f"exp_{order_id}"):
                    if is_del and row.get("address"):
                        st.caption(f"📍 {row.get('address')}")
                    for i in items:
                        unit = "กล่อง" if i.get("type") == "box" else "ซอง"
                        label, kind = item_state(i)
                        st.markdown(
                            f"&nbsp;&nbsp;• {i.get('name','')} ({unit}) ×{i.get('qty',1)} = ฿{i.get('price',0)*i.get('qty',1):,} "
                            f"&nbsp; {badge(label, kind)}",
                            unsafe_allow_html=True,
                        )
                    if row.get("notes"):
                        st.caption(f"📝 {row.get('notes')}")

                    if cur_status == "ยืนยัน" and items:
                        handover_idx = handover_candidates(items)
                        pending_idx = [
                            idx for idx, it in enumerate(items)
                            if not it.get("ready_at") and not it.get("handed_at") and not it.get("cancelled_at")
                        ]
                        cancelable_idx = [
                            idx for idx, it in enumerate(items)
                            if not it.get("handed_at") and not it.get("cancelled_at")
                        ]

                        if handover_idx or pending_idx or cancelable_idx:
                            st.markdown("<div style='height:6px'></div>", unsafe_allow_html=True)
                            fc1, fc2, fc3 = st.columns(3)
                            with fc1:
                                if handover_idx and st.button(
                                    "🤝 ส่งมอบสินค้า", key=f"handover_{order_id}", use_container_width=True,
                                ):
                                    try:
                                        gas_post({"_action": "handoverOrder", "order_id": order_id})
                                        st.success("ส่งมอบแล้ว + แจ้ง LINE ลูกค้าแล้ว")
                                        st.cache_data.clear()
                                        st.rerun()
                                    except Exception as e:
                                        st.error(f"ทำรายการไม่ได้: {e}")
                            with fc2:
                                if pending_idx:
                                    with st.popover("📣 แจ้งพร้อมรับ", use_container_width=True):
                                        st.caption("เลือกสินค้าที่พร้อมรับ")
                                        sel_ready = [
                                            idx for idx in pending_idx
                                            if st.checkbox(
                                                f"{items[idx].get('name','')} x{items[idx].get('qty',1)}",
                                                key=f"ready_chk_{order_id}_{idx}",
                                            )
                                        ]
                                        if st.button("📣 ยืนยันแจ้งพร้อมรับ", key=f"ready_submit_{order_id}"):
                                            if not sel_ready:
                                                st.warning("เลือกสินค้าอย่างน้อย 1 รายการ")
                                            else:
                                                try:
                                                    gas_post({"_action": "partialReady", "order_id": order_id, "indices": sel_ready})
                                                    st.success("แจ้งพร้อมรับแล้ว + แจ้ง LINE ลูกค้าแล้ว")
                                                    st.cache_data.clear()
                                                    st.rerun()
                                                except Exception as e:
                                                    st.error(f"ทำรายการไม่ได้: {e}")
                            with fc3:
                                if cancelable_idx:
                                    with st.popover("❌ ยกเลิกบางรายการ", use_container_width=True):
                                        st.caption("เลือกสินค้าที่ต้องการยกเลิก")
                                        sel_cancel = [
                                            idx for idx in cancelable_idx
                                            if st.checkbox(
                                                f"{items[idx].get('name','')} x{items[idx].get('qty',1)}",
                                                key=f"cancel_chk_{order_id}_{idx}",
                                            )
                                        ]
                                        cancel_reason = st.text_input(
                                            "เหตุผล", key=f"cancel_reason_{order_id}",
                                            placeholder="ลูกค้าขอยกเลิก / ของหมด...",
                                        )
                                        if st.button("❌ ยืนยันยกเลิก", key=f"cancel_submit_{order_id}"):
                                            if not sel_cancel:
                                                st.warning("เลือกสินค้าที่ต้องการยกเลิกก่อน")
                                            else:
                                                try:
                                                    gas_post({
                                                        "_action": "partialCancelItems", "order_id": order_id,
                                                        "indices": sel_cancel, "reason": cancel_reason,
                                                    })
                                                    st.success("ยกเลิกรายการที่เลือกแล้ว")
                                                    st.cache_data.clear()
                                                    st.rerun()
                                                except Exception as e:
                                                    st.error(f"ทำรายการไม่ได้: {e}")

                    col_slip, col_act = st.columns([1, 2])
                    with col_slip:
                        slip_url = row.get("slip_url", "")
                        if slip_url and slip_url.startswith("http"):
                            st.image(slip_url, width=150)
                        slip_amt = float(row.get("slip_amount", 0) or 0)
                        order_total = float(row.get("total", 0) or 0)
                        if slip_amt:
                            if abs(slip_amt - order_total) < 0.5:
                                st.markdown(badge(f"✅ ยอดตรง ฿{slip_amt:,.0f}", "success"), unsafe_allow_html=True)
                            else:
                                diff = abs(slip_amt - order_total)
                                st.markdown(badge(f"⚠️ สลิป ฿{slip_amt:,.0f} (ต่าง ฿{diff:,.0f})", "danger"), unsafe_allow_html=True)
                        else:
                            st.caption("— ไม่พบยอดจากสลิป")
                    with col_act:
                        if cur_status != "ยืนยัน":
                            with st.popover("✅ อนุมัติสลิป", use_container_width=True):
                                st.caption("แก้ไขข้อความแจ้งลูกค้าได้ก่อนส่ง (รายสินค้า/ทั่วไป)")
                                default_msg = build_confirm_message(order_id, items, row.get("total", 0), row.get("branch", ""))
                                edited_msg = st.text_area(
                                    "ข้อความแจ้งลูกค้า", value=default_msg,
                                    key=f"confirm_msg_{order_id}", height=220, label_visibility="collapsed",
                                )
                                if st.button("✅ ยืนยัน + ส่งข้อความนี้", key=f"approve_{order_id}", type="primary", use_container_width=True):
                                    try:
                                        confirm_slip_via_gas(order_id, custom_message=edited_msg)
                                        st.success("อนุมัติแล้ว + แจ้ง LINE ลูกค้าแล้ว")
                                        st.cache_data.clear()
                                        st.rerun()
                                    except Exception as e:
                                        st.error(f"บันทึกไม่ได้: {e}")
                        if cur_status != "ยกเลิก" and st.button("❌ ปฏิเสธ", key=f"reject_{order_id}", use_container_width=True):
                            try:
                                reject_slip_via_gas(order_id)
                                st.success("ปฏิเสธแล้ว + แจ้ง LINE ลูกค้าแล้ว")
                                st.cache_data.clear()
                                st.rerun()
                            except Exception as e:
                                st.error(f"บันทึกไม่ได้: {e}")
                        if row.get("line_user_id"):
                            with st.popover("📣 แจ้งเตือนลูกค้า", use_container_width=True):
                                st.caption("แก้ไขข้อความที่จะส่งได้ก่อนส่ง")
                                default_notify_msg = build_notify_message(
                                    order_id, items, row.get("total", 0), row.get("branch", ""), cur_status, ff_status,
                                )
                                edited_notify_msg = st.text_area(
                                    "ข้อความแจ้งลูกค้า", value=default_notify_msg,
                                    key=f"notify_msg_{order_id}", height=180, label_visibility="collapsed",
                                )
                                if st.button("📣 ส่งข้อความนี้", key=f"notify_{order_id}", type="primary", use_container_width=True):
                                    try:
                                        gas_post({"_action": "notifyCustomer", "order_id": order_id, "custom_message": edited_notify_msg})
                                        st.success("แจ้งเตือนลูกค้าทาง LINE แล้ว")
                                        st.cache_data.clear()
                                        st.rerun()
                                    except Exception as e:
                                        st.error(f"แจ้งเตือนไม่ได้: {e}")

                        with st.popover("เปลี่ยนสถานะอื่น ๆ"):
                            new_status = st.selectbox(
                                "เปลี่ยนสถานะ", ALL_STATUS,
                                index=ALL_STATUS.index(cur_status) if cur_status in ALL_STATUS else 0,
                                key=f"status_{order_id}",
                            )
                            new_note = st.text_input("หมายเหตุ", key=f"note_{order_id}", placeholder="เช่น โอนไม่ครบ")
                            if st.button("💾 บันทึก", key=f"save_{order_id}"):
                                try:
                                    if new_status == "ยืนยัน" and cur_status != "ยืนยัน":
                                        confirm_slip_via_gas(order_id)
                                        if new_note:
                                            update_slip_status(order_id, "", "", new_note)
                                        st.success("บันทึกแล้ว + แจ้ง LINE ลูกค้าแล้ว")
                                    else:
                                        update_slip_status(order_id, new_status, "", new_note)
                                        st.success("บันทึกแล้ว")
                                    st.cache_data.clear()
                                    st.rerun()
                                except Exception as e:
                                    st.error(f"บันทึกไม่ได้: {e}")

                        st.caption(f"📦 จัดส่ง: {ff_icon} {ff_status}")

# ── Tab: ตารางรวม (Google-Sheet-style overview + inline bulk edit) ────────────
with tab_table:
    st.caption(
        "ตารางรวมทุกออเดอร์ตามตัวกรองด้านบน — แก้ไข \"สถานะสลิป\" / \"สถานะจัดส่ง\" / \"หมายเหตุ\" ได้โดยตรงในตาราง "
        "แล้วกดบันทึกครั้งเดียว (บันทึกแบบเงียบ ไม่ส่ง LINE หาลูกค้า ไม่ตัดสต็อก) เหมาะกับการไล่แก้ข้อมูลย้อนหลังทีละหลาย ๆ ออเดอร์ "
        "— งานที่ต้องแจ้งลูกค้าจริง (อนุมัติสลิป/ส่งมอบ/ปฏิเสธ) ให้ใช้แท็บ 🗂 การ์ดออเดอร์"
    )

    table_src = filtered.sort_values("timestamp_dt", ascending=False).reset_index(drop=True)
    table_src = table_src.assign(
        รายการสินค้า=table_src["items_json"].apply(
            lambda ij: ", ".join(f"{i.get('name','')} x{i.get('qty',1)}" for i in parse_items(ij))
        ),
    )
    edit_df = table_src[[
        "order_id", "real_name", "phone", "branch", "date", "total",
        "slip_status", "fulfillment", "notes", "รายการสินค้า",
    ]].rename(columns={
        "order_id": "เลขออเดอร์", "real_name": "ลูกค้า", "phone": "เบอร์โทร", "branch": "สาขา",
        "date": "วันที่", "total": "ยอดรวม", "slip_status": "สถานะสลิป",
        "fulfillment": "สถานะจัดส่ง", "notes": "หมายเหตุ",
    })

    edited_df = st.data_editor(
        edit_df,
        use_container_width=True,
        hide_index=True,
        height=600,
        key="orders_sheet_editor",
        disabled=["เลขออเดอร์", "ลูกค้า", "เบอร์โทร", "สาขา", "วันที่", "ยอดรวม", "รายการสินค้า"],
        column_config={
            "สถานะสลิป": st.column_config.SelectboxColumn(options=ALL_STATUS, required=True),
            "สถานะจัดส่ง": st.column_config.SelectboxColumn(options=ALL_FULFILL),
            "ยอดรวม": st.column_config.NumberColumn(format="฿%d"),
        },
    )

    if st.button("💾 บันทึกการแก้ไขในตาราง", type="primary"):
        edited_rows = st.session_state.get("orders_sheet_editor", {}).get("edited_rows", {})
        if not edited_rows:
            st.info("ไม่มีการแก้ไข")
        else:
            errors = []
            col_map = {"สถานะสลิป": "slip_status", "สถานะจัดส่ง": "fulfillment", "หมายเหตุ": "notes"}
            for row_idx, changes in edited_rows.items():
                order_id = str(edit_df.iloc[int(row_idx)]["เลขออเดอร์"])
                fields = {col_map[c]: v for c, v in changes.items() if c in col_map}
                if not fields:
                    continue
                try:
                    patch_order_silent(order_id, fields)
                except Exception as e:
                    errors.append(f"#{order_id}: {e}")
            if errors:
                st.error("บันทึกไม่สำเร็จบางรายการ:\n" + "\n".join(errors))
            else:
                st.success(f"บันทึกแล้ว {len(edited_rows)} ออเดอร์")
            st.cache_data.clear()
            st.rerun()

# ── Tab: ลูกค้าทั้งหมด (customer roll-up, ignores the date/branch filters above) ─
with tab_customers:
    st.caption("สรุปลูกค้าทั้งหมดจากทุกออเดอร์ในระบบ (ไม่ผูกกับตัวกรองด้านบน)")

    cust_search = st.text_input("ค้นหาลูกค้า", placeholder="ชื่อ หรือ เบอร์โทร", key="cust_search")

    cust_base = df.copy()
    cust_base["phone"] = cust_base["phone"].fillna("").astype(str)
    cust_base["confirmed_total"] = cust_base["total"].where(cust_base["slip_status"] == "ยืนยัน", 0)

    cust = (
        cust_base.groupby("phone")
        .agg(
            ลูกค้า=("real_name", "last"),
            จำนวนออเดอร์=("order_id", "count"),
            ยืนยันแล้ว=("slip_status", lambda s: int((s == "ยืนยัน").sum())),
            ยอดซื้อสะสม=("confirmed_total", "sum"),
            ออเดอร์ล่าสุด=("timestamp_dt", "max"),
        )
        .reset_index()
        .rename(columns={"phone": "เบอร์โทร"})
        .sort_values("ยอดซื้อสะสม", ascending=False)
    )
    cust["ออเดอร์ล่าสุด"] = cust["ออเดอร์ล่าสุด"].dt.tz_convert("Asia/Bangkok").dt.strftime("%Y-%m-%d %H:%M")

    if cust_search:
        s = cust_search.lower()
        cust = cust[
            cust["ลูกค้า"].astype(str).str.lower().str.contains(s, na=False)
            | cust["เบอร์โทร"].astype(str).str.lower().str.contains(s, na=False)
        ]

    kc1, kc2, kc3 = st.columns(3)
    with kc1:
        st.markdown(kpi_card("ลูกค้าทั้งหมด", len(cust)), unsafe_allow_html=True)
    with kc2:
        st.markdown(kpi_card("ลูกค้าซื้อซ้ำ", int((cust["จำนวนออเดอร์"] > 1).sum()), ACCENT_TEXT), unsafe_allow_html=True)
    with kc3:
        st.markdown(kpi_card("ยอดซื้อสะสมรวม (฿)", f"฿{cust['ยอดซื้อสะสม'].sum():,.0f}"), unsafe_allow_html=True)

    st.markdown("<div style='height:8px'></div>", unsafe_allow_html=True)

    st.dataframe(
        cust[["ลูกค้า", "เบอร์โทร", "จำนวนออเดอร์", "ยืนยันแล้ว", "ยอดซื้อสะสม", "ออเดอร์ล่าสุด"]],
        use_container_width=True,
        hide_index=True,
        height=600,
        column_config={"ยอดซื้อสะสม": st.column_config.NumberColumn(format="฿%d")},
    )
