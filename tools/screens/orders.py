#!/usr/bin/env python3
"""Card Game Order Dashboard — admin view"""

import json
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
    SURFACE, BORDER, TEXT2, TEXT3, ACCENT_TEXT, ACCENT_LIGHT, DIVIDER2,
    PENDING_TEXT, SUCCESS_TEXT, DANGER_TEXT,
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

BRANCHES   = ["ต้นสักคอร์เนอร์", "เมืองทองธานี", "ศรีนครินทร์", "จัดส่ง"]
ALL_STATUS = ["รอตรวจ", "รอตรวจเพิ่ม", "ยืนยัน", "ยอดไม่ตรง", "สลิปซ้ำ", "บัญชีไม่ตรง", "สงสัยปลอม", "ยกเลิก", "ไม่มีสลิป"]

TH_TZ = timezone(timedelta(hours=7))


# ── Auth ──────────────────────────────────────────────────────────────────────
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


@st.cache_data(ttl=120)
def load_orders() -> pd.DataFrame:
    try:
        ws   = get_gc().open_by_key(SHEET_ID).worksheet("orders")
        rows = ws.get_all_values()
        if len(rows) < 2:
            return pd.DataFrame()
        df = pd.DataFrame(rows[1:], columns=rows[0])
        df["total"]        = pd.to_numeric(df.get("total", 0), errors="coerce").fillna(0)
        df["slip_amount"]  = pd.to_numeric(df.get("slip_amount", 0), errors="coerce").fillna(0)
        df["timestamp_dt"] = pd.to_datetime(df.get("timestamp", ""), errors="coerce", utc=True)
        df["date"]         = df["timestamp_dt"].dt.tz_convert("Asia/Bangkok").dt.date
        df["row_num"]      = range(2, len(df) + 2)  # แถวจริงใน Sheet (1-indexed + header)
        return df
    except Exception as e:
        st.error(f"โหลด orders ไม่ได้: {e}")
        return pd.DataFrame()


def update_slip_status(row_num: int, status: str, amount: str = "", note: str = ""):
    ws = get_gc().open_by_key(SHEET_ID).worksheet("orders")
    rows = ws.get_all_values()
    hdr  = rows[0]
    status_col = hdr.index("slip_status") + 1 if "slip_status" in hdr else None
    amount_col = hdr.index("slip_amount") + 1 if "slip_amount" in hdr else None
    notes_col  = hdr.index("notes")       + 1 if "notes"       in hdr else None
    if status_col and status:
        ws.update_cell(row_num, status_col, status)
    if amount_col and amount:
        ws.update_cell(row_num, amount_col, amount)
    if notes_col and note:
        ws.update_cell(row_num, notes_col, note)


def _now_th():
    return datetime.now(TH_TZ).strftime("%Y-%m-%d %H:%M")

def update_fulfillment(row_num: int, status: str):
    ws = get_gc().open_by_key(SHEET_ID).worksheet("orders")
    hdr = ws.row_values(1)
    ff_col = hdr.index("fulfillment") + 1 if "fulfillment" in hdr else None
    at_col = hdr.index("fulfilled_at") + 1 if "fulfilled_at" in hdr else None
    if ff_col:
        ws.update_cell(row_num, ff_col, status)
    if at_col:
        ws.update_cell(row_num, at_col, _now_th())


def staff_confirm_handover(row_num: int):
    ws = get_gc().open_by_key(SHEET_ID).worksheet("orders")
    hdr = ws.row_values(1)
    col = hdr.index("staff_confirmed_at") + 1 if "staff_confirmed_at" in hdr else None
    ff_col = hdr.index("fulfillment") + 1 if "fulfillment" in hdr else None
    now = _now_th()
    if col:
        ws.update_cell(row_num, col, now)
    if ff_col:
        ws.update_cell(row_num, ff_col, "สาขายืนยัน")
    return now


GAS_URL = "https://script.google.com/macros/s/AKfycbz52wvADM7O1zMjqKlT2G4HPkq8gwAon_fUCuKgbmUMkDPQkaYKUWnv598U3EkFN1AByQ/exec"

def confirm_slip_via_gas(order_id: str):
    import requests
    resp = requests.post(GAS_URL, json={"_action": "confirmSlip", "order_id": order_id}, timeout=30)
    result = resp.json()
    if not result.get("ok"):
        raise Exception(result.get("error", "GAS ตอบผิดพลาด"))


def parse_items(items_json: str) -> list:
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

def fulfill_kind(s: str) -> str:
    return "success" if s in ("รับแล้ว", "สาขายืนยัน", "จัดส่งแล้ว", "พร้อมรับ") else "pending"


# ── Page header ───────────────────────────────────────────────────────────────
apply_theme()
page_header("จัดการออเดอร์", "ค้นหา ตรวจสลิป และติดตามสถานะออเดอร์การ์ด")

if st.button("🔄 โหลดใหม่"):
    st.cache_data.clear()
    st.rerun()

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

# ── Filter bar ────────────────────────────────────────────────────────────────
with st.container(border=True):
    f1, f2, f3, f4 = st.columns([2.4, 1, 1, 1.4])
    with f1:
        search = st.text_input("ค้นหา", placeholder="ค้นหาชื่อ / เบอร์โทร / เลขออเดอร์ / สินค้า", label_visibility="collapsed")
    with f2:
        branch_sel = st.selectbox("สาขา", ["ทุกสาขา"] + BRANCHES, label_visibility="collapsed")
    with f3:
        status_sel = st.selectbox("สถานะสลิป", ["ทุกสถานะสลิป"] + ALL_STATUS, label_visibility="collapsed")
    with f4:
        product_filter = st.multiselect("สินค้า", all_products, default=[], placeholder="ทุกสินค้า", label_visibility="collapsed")

    d1, d2, d3 = st.columns([1, 0.3, 1])
    with d1:
        date_from = st.date_input("จากวันที่", value=date.today() - timedelta(days=7), label_visibility="collapsed")
    with d2:
        st.markdown(f"<div style='text-align:center;padding-top:8px;color:{TEXT3}'>ถึง</div>", unsafe_allow_html=True)
    with d3:
        date_to = st.date_input("ถึงวันที่", value=date.today(), label_visibility="collapsed")

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

# ── Sort + count row ──────────────────────────────────────────────────────────
c1, c2 = st.columns([3, 1])
with c1:
    st.markdown(
        f"<div style='font-size:13px;color:{TEXT2};padding-top:8px'>แสดง <strong style='color:inherit'>{len(filtered)}</strong> จาก {len(df)} ออเดอร์</div>",
        unsafe_allow_html=True,
    )
with c2:
    sort_sel = st.selectbox("เรียงตาม", ["ใหม่สุดก่อน", "เก่าสุดก่อน", "ยอดสูงสุดก่อน"], label_visibility="collapsed")

if sort_sel == "ใหม่สุดก่อน":
    filtered = filtered.sort_values("timestamp_dt", ascending=False)
elif sort_sel == "เก่าสุดก่อน":
    filtered = filtered.sort_values("timestamp_dt", ascending=True)
else:
    filtered = filtered.sort_values("total", ascending=False)
filtered = filtered.reset_index(drop=True)

if filtered.empty:
    st.info("ไม่มีออเดอร์ตามเงื่อนไขที่เลือก")
    st.stop()

# ── Bulk selection state ──────────────────────────────────────────────────────
if "selected_orders" not in st.session_state:
    st.session_state.selected_orders = set()

visible_ids = set(filtered["order_id"])
st.session_state.selected_orders &= visible_ids  # drop selections that scrolled out of the current filter

if st.session_state.selected_orders:
    sel_rows = filtered[filtered["order_id"].isin(st.session_state.selected_orders)]
    sel_pending = sel_rows[sel_rows["slip_status"].isin(["รอตรวจ", "รอตรวจเพิ่ม"])]
    with st.container(border=True):
        b1, b2, b3, b4 = st.columns([2, 1.4, 1.2, 1])
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
            if st.button("❌ ยกเลิกสลิปที่เลือก"):
                for _, r in sel_rows.iterrows():
                    try:
                        update_slip_status(int(r["row_num"]), "ยกเลิก")
                    except Exception as e:
                        st.error(f"#{r['order_id']}: {e}")
                st.session_state.selected_orders = set()
                st.cache_data.clear()
                st.rerun()
        with b4:
            if st.button("ยกเลิกการเลือก"):
                st.session_state.selected_orders = set()
                st.rerun()

# ── Order cards ───────────────────────────────────────────────────────────────
for _, row in filtered.iterrows():
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
    exp_key = f"exp_{order_id}"
    if exp_key not in st.session_state:
        st.session_state[exp_key] = needs_attention(cur_status)

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
      <span style="padding:1px 8px;border-radius:20px;background:#ECE9E1;color:#57514A;font-size:11px">LIFF App</span>
      <span style="padding:1px 8px;border-radius:20px;background:#ECE9E1;color:#57514A;font-size:11px">โอนเงิน</span>
      {badge(f'จัดส่ง · {ff_status}', fulfill_kind(ff_status)) if is_del else ''}
      <span style="flex:1;min-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:{TEXT3}">{items_summary}</span>
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
            if st.button(row.get("real_name", order_id) or order_id, key=f"tog_{order_id}",
                         help="คลิกเพื่อดู/ซ่อนรายละเอียด", use_container_width=True, type="tertiary"):
                st.session_state[exp_key] = not st.session_state[exp_key]
                st.rerun()
            st.markdown(row_html, unsafe_allow_html=True)

            if st.session_state[exp_key]:
                st.markdown("<div style='height:8px'></div>", unsafe_allow_html=True)
                if is_del and row.get("address"):
                    st.caption(f"📍 {row.get('address')}")
                for i in items:
                    unit = "กล่อง" if i.get("type") == "box" else "ซอง"
                    st.markdown(f"&nbsp;&nbsp;• {i.get('name','')} ({unit}) ×{i.get('qty',1)} = ฿{i.get('price',0)*i.get('qty',1):,}")
                if row.get("notes"):
                    st.caption(f"📝 {row.get('notes')}")

                col_slip, col_act = st.columns([1, 2])
                with col_slip:
                    slip_url = row.get("slip_url", "")
                    if slip_url and slip_url.startswith("http"):
                        st.image(slip_url, width=150)
                with col_act:
                    qa1, qa2 = st.columns(2)
                    with qa1:
                        if cur_status != "ยืนยัน" and st.button("✅ อนุมัติสลิป", key=f"approve_{order_id}", type="primary", use_container_width=True):
                            try:
                                confirm_slip_via_gas(order_id)
                                st.success("อนุมัติแล้ว + แจ้ง LINE ลูกค้าแล้ว")
                                st.cache_data.clear()
                                st.rerun()
                            except Exception as e:
                                st.error(f"บันทึกไม่ได้: {e}")
                    with qa2:
                        if cur_status != "ยกเลิก" and st.button("❌ ปฏิเสธ", key=f"reject_{order_id}", use_container_width=True):
                            try:
                                update_slip_status(int(row["row_num"]), "ยกเลิก")
                                st.success("ปฏิเสธแล้ว")
                                st.cache_data.clear()
                                st.rerun()
                            except Exception as e:
                                st.error(f"บันทึกไม่ได้: {e}")

                    with st.expander("เปลี่ยนสถานะอื่น ๆ"):
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
                                        update_slip_status(int(row["row_num"]), "", "", new_note)
                                    st.success("บันทึกแล้ว + แจ้ง LINE ลูกค้าแล้ว")
                                else:
                                    update_slip_status(int(row["row_num"]), new_status, "", new_note)
                                    st.success("บันทึกแล้ว")
                                st.cache_data.clear()
                                st.rerun()
                            except Exception as e:
                                st.error(f"บันทึกไม่ได้: {e}")

                    st.caption(f"📦 จัดส่ง: {ff_icon} {ff_status}")
