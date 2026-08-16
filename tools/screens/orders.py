#!/usr/bin/env python3
"""Card Game Order Dashboard — admin view"""

import json
import os
import re
import sys
from pathlib import Path
from datetime import date, datetime, timedelta, timezone

import streamlit as st
import pandas as pd
from dotenv import load_dotenv

load_dotenv()

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from theme import (
    apply_theme, badge, flat, page_header, kpi_card, admin_name,
    SURFACE, SURFACE_ALT, BORDER, TEXT2, TEXT3, ACCENT_TEXT, ACCENT_LIGHT, DIVIDER2,
    PENDING_TEXT, SUCCESS_TEXT, DANGER_TEXT,
)
import rocket8_client

# กล่องไปรษณีย์ตามขนาดมาตรฐาน (กว้าง, ยาว, สูง) ซม. — ใช้เติมค่าเริ่มต้นใน
# popup "จัดส่ง Rocket8" ตามรหัสกล่องที่ร้านใช้จริง ปรับตัวเลขเองได้เสมอ
BOX_SIZES = {
    "0": (11, 17, 6), "0+4": (11, 17, 10), "00": (14, 10, 6),
    "A": (14, 20, 6), "AA": (13, 17, 7), "AB": (14, 20, 9),
    "2A": (14, 20, 12), "2B": (17, 25, 18), "2C": (20, 30, 22), "2D": (22, 35, 28),
    "B": (17, 25, 9), "C": (20, 30, 11), "C+8": (20, 30, 19),
    "CD": (15, 15, 15), "D": (22, 35, 14),
}

BRANCHES     = ["ต้นสักคอร์เนอร์", "เมืองทองธานี", "ศรีนครินทร์", "จัดส่ง"]
ALL_STATUS   = ["รอตรวจ", "รอตรวจเพิ่ม", "ยืนยัน", "ยอดไม่ตรง", "สลิปซ้ำ", "บัญชีไม่ตรง", "สงสัยปลอม", "ยกเลิก", "ไม่มีสลิป"]
ALL_FULFILL  = ["", "กำลังจัดส่งไปสาขา", "พร้อมรับ", "รับบางส่วนแล้ว", "สาขายืนยัน", "จัดส่งบางส่วนแล้ว", "จัดส่งแล้ว", "รับแล้ว"]

TH_TZ = timezone(timedelta(hours=7))


@st.cache_data
def load_thai_address() -> list:
    """Same source liff/index.html uses for its province/amphoe/tambon dropdowns."""
    path = Path(__file__).resolve().parent.parent.parent / "liff" / "thai-address.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []


def parse_customer_address(address: str, thai_addr: list) -> dict:
    """Best-effort split of the customer-entered address back into Rocket8's
    fields. liff/index.html's getFullAddress() always joins as
    "{line} {tambon} {amphoe} {province} {zip}" (dropdown-picked components,
    not free text), so matching known province/amphoe/tambon names off the
    end is reliable for orders placed through that form. Falls back to
    leaving fields blank (just the raw string in "line") for anything it
    can't confidently resolve — staff fills in the rest by hand."""
    result = {"line": "", "prov": "", "amp": "", "dist": "", "zip": ""}
    s = str(address or "").strip()
    if not s:
        return result

    m = re.search(r"(\d{5})\s*$", s)
    if m:
        result["zip"] = m.group(1)
        s = s[:m.start()].strip()

    for p in thai_addr:
        prov_name = p["n"]
        if s != prov_name and not s.endswith(" " + prov_name):
            continue
        rest = s[: -len(prov_name)].strip()
        for a in p["a"]:
            amp_name = a["n"]
            if rest != amp_name and not rest.endswith(" " + amp_name):
                continue
            rest2 = rest[: -len(amp_name)].strip()
            for d in a["d"]:
                dist_name = d["n"]
                if rest2 != dist_name and not rest2.endswith(" " + dist_name):
                    continue
                result["prov"] = prov_name
                result["amp"] = amp_name
                result["dist"] = dist_name
                result["line"] = rest2[: -len(dist_name)].strip()
                if not result["zip"]:
                    result["zip"] = d["z"]
                return result

    result["line"] = s
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
        # Supabase nulls land as NaN once a column mixes None with real values —
        # NaN is truthy in Python, so `row.get(col) or default` silently keeps
        # the NaN (rendering as the literal text "nan") instead of falling back,
        # and string ops like .startswith() on it crash outright. `.where(...,
        # None)` doesn't help here — pandas' "str" dtype uses NaN as its own
        # missing-value sentinel and coerces None right back to NaN on
        # assignment — so fill with "" instead, which is falsy like a real
        # empty value should be.
        obj_cols = df.columns.difference(["total", "slip_amount", "timestamp_dt", "date"])
        df[obj_cols] = df[obj_cols].fillna("")
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

def _gas_request(payload: dict) -> dict:
    """POST to GAS with one retry. Apps Script web apps occasionally return a
    non-JSON error page (a Google Drive "file not found" HTML page) under
    lock contention or cold start instead of the real JSON response — seen
    live causing a bulk action to silently no-op with no visible error."""
    import time
    import requests
    last_err = None
    for attempt in range(2):
        try:
            resp = requests.post(f"{GAS_URL}?_s={WAKA_S}", json=payload, timeout=30)
            return resp.json()
        except (ValueError, requests.RequestException) as e:
            last_err = e
            if attempt == 0:
                time.sleep(1.5)
    raise Exception(f"GAS ไม่ตอบสนอง (ลองแล้ว 2 ครั้ง): {last_err}")


def confirm_slip_via_gas(order_id: str, custom_message: str = ""):
    payload = {"_action": "confirmSlip", "order_id": order_id, "staff_name": admin_name()}
    if custom_message.strip():
        payload["custom_message"] = custom_message.strip()
    result = _gas_request(payload)
    if not result.get("ok"):
        raise Exception(result.get("error", "GAS ตอบผิดพลาด"))


def reject_slip_via_gas(order_id: str, reason: str = ""):
    payload = {"_action": "rejectSlip", "order_id": order_id, "staff_name": admin_name()}
    if reason.strip():
        payload["reason"] = reason.strip()
    result = _gas_request(payload)
    if not result.get("ok"):
        raise Exception(result.get("error", "GAS ตอบผิดพลาด"))


def gas_post(payload: dict) -> dict:
    payload = {**payload, "code": ADMIN_CODE, "staff_name": admin_name()}
    result = _gas_request(payload)
    if not result.get("ok"):
        raise Exception(result.get("error", "GAS ตอบผิดพลาด"))
    return result


def force_complete_order(order_id: str):
    """Backfill close — marks the order fully received ('รับแล้ว') without
    sending LINE messages or touching branch stock. For orders that were
    actually shipped/handed over before this admin tool existed.

    Writes straight to Supabase instead of routing through GAS's
    forceCompleteOrder action (still present in gas/Code.gs, unused from
    here now): this action never touches the catalog_config cache that
    customer-facing LIFF depends on, sends no LINE message, and mutates no
    stock — there's nothing GAS's LockService/report-mirror step buys here,
    only its cold-start + lock-contention latency, which made bulk closes
    over many orders painfully slow.
    """
    now = datetime.now(TH_TZ).strftime("%Y-%m-%d %H:%M:%S")
    sb = get_supabase()
    rows = sb.table("orders").select("items_json,staff_confirmed_at").eq("order_id", order_id).limit(1).execute().data
    if not rows:
        raise Exception("ไม่พบออเดอร์")
    order = rows[0]
    items = order.get("items_json") or []
    for it in items:
        if not it.get("cancelled_at") and not it.get("handed_at"):
            it["handed_at"] = now
    updates = {"items_json": items, "fulfillment": "รับแล้ว", "customer_confirmed_at": now}
    if not order.get("staff_confirmed_at"):
        updates["staff_confirmed_at"] = now
    sb.table("orders").update(updates).eq("order_id", order_id).execute()


def run_bulk_action(label: str, order_ids, action_fn) -> None:
    """Runs action_fn(order_id) for each id and stashes a result summary in
    session_state instead of calling st.error() directly — the caller always
    follows this with st.rerun(), which would otherwise wipe a per-order
    error off the screen before the user ever sees it (confirmed live: a GAS
    call can transiently fail there with no visible error and silently
    no-op — see _gas_request's retry, which reduces but can't eliminate this)."""
    order_ids = list(order_ids)
    errors = []
    ok_count = 0
    with st.spinner(f"{label}: กำลังดำเนินการ..."):
        progress = st.progress(0.0, text=f"0 / {len(order_ids)}")
        for i, order_id in enumerate(order_ids):
            try:
                action_fn(str(order_id))
                ok_count += 1
            except Exception as e:
                errors.append(f"#{order_id}: {e}")
            progress.progress((i + 1) / len(order_ids), text=f"{i + 1} / {len(order_ids)}")
    st.session_state["bulk_result"] = {"label": label, "ok": ok_count, "errors": errors}


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


def line_notify_stage(slip_status: str, fulfillment: str) -> str:
    """Which customer-facing LINE message an order has reached, derived from
    slip_status/fulfillment — mirrors the actual _linePush() call sites in
    gas/Code.gs (order create, confirmSlip/instant-ready, handoverOrder) so
    staff can see notification progress without cross-checking those fields
    themselves."""
    ff = fulfillment or ""
    if ff in ("รับแล้ว", "สาขายืนยัน", "จัดส่งแล้ว"):
        return "ส่งมอบครบ"
    if ff == "รับบางส่วนแล้ว":
        return "ส่งมอบบางส่วน"
    if ff in ("พร้อมรับ", "บางส่วน"):
        return "พร้อมรับ"
    if slip_status == "ยืนยัน":
        return "ยืนยันชำระเงิน"
    return "รับออเดอร์"


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


# st.success() called right before st.rerun() never reaches the screen — the
# rerun wipes it before the browser paints. Stash the message in session_state
# instead and show it as a toast on the NEXT run. (Same pattern as stock.py.)
def _flash(msg: str) -> None:
    st.session_state["_flash_msg"] = msg


# ── Page header ───────────────────────────────────────────────────────────────
apply_theme()
page_header("จัดการออเดอร์", "ค้นหา ตรวจสลิป และติดตามสถานะออเดอร์การ์ด")

if "_flash_msg" in st.session_state:
    st.toast(st.session_state.pop("_flash_msg"), icon="✅")

# ── Load ──────────────────────────────────────────────────────────────────────
df = load_orders()
if df.empty:
    st.info("ยังไม่มีออเดอร์")
    st.stop()

@st.cache_data(ttl=60)
def load_all_catalog_names() -> set:
    rows = get_supabase().table("catalog").select("name").execute().data
    return {r["name"] for r in rows if r.get("name")}


@st.cache_data(ttl=60)
def load_name_to_category() -> dict:
    rows = get_supabase().table("catalog").select("name,category").execute().data
    return {r["name"]: (r.get("category") or "") for r in rows if r.get("name")}


# รวม 2 แหล่ง: ชื่อที่เคยปรากฏในออเดอร์ (กันสินค้าที่เปลี่ยนชื่อไปแล้วหลุดจาก
# ตัวกรอง — เจอกับ BT11, ดู commit ก่อนหน้า) + ชื่อสินค้าทั้งหมดใน catalog
# ตอนนี้ (กันสินค้าที่เพิ่งเพิ่มเข้าระบบแต่ยังไม่มีใครสั่งเลยสักออเดอร์เดียว หาย
# ไปจากตัวกรองเพราะไม่เคยปรากฏใน items_json ที่ไหนเลย — คนละสาเหตุ คนละบั๊ก
# กับเคส BT11 แต่ต้องแก้พร้อมกันเพราะทั้งคู่ทำให้ "สินค้าไม่ขึ้นในตัวกรอง")
all_products = sorted({
    i.get("name", "")
    for items_json in df.get("items_json", [])
    for i in parse_items(items_json)
    if i.get("name")
} | load_all_catalog_names())

name_to_category = load_name_to_category()
all_categories = sorted({c for c in name_to_category.values() if c})

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
FILTER_KEYS = ["ord_search", "ord_branch", "ord_status", "ord_categories"]

with st.container(border=True):
    f1, f2, f3, f4, f5, f6 = st.columns([2.2, 1, 1.3, 1.8, 1.5, 0.6])
    with f1:
        search = st.text_input("ค้นหา", placeholder="ค้นหาชื่อ / เบอร์โทร / เลขออเดอร์ / สินค้า", label_visibility="collapsed", key="ord_search")
    with f2:
        branch_sel = st.selectbox("สาขา", ["ทุกสาขา"] + BRANCHES, label_visibility="collapsed", key="ord_branch")
    with f3:
        status_sel = st.selectbox("สถานะสลิป", ["ทุกสถานะสลิป"] + ALL_STATUS, label_visibility="collapsed", key="ord_status")
    with f4:
        # st.multiselect เดิมตัดชื่อสินค้ายาวๆ ด้วย "..." ใน dropdown ของมันเอง —
        # ลองแก้ด้วย CSS (บังคับ overflow/white-space/width) 2 รอบแล้วไม่หาย เพราะ
        # เป็น dropdown แบบ virtualized ที่ตัดข้อความจริงตั้งแต่ตอน render (ไม่ใช่แค่
        # ซ่อนด้วย overflow:hidden ที่ CSS แก้ได้) เปลี่ยนมาใช้ popover + checkbox
        # ธรรมดาแทน ซึ่งไม่มีการตัดข้อความแบบนี้เลย
        _sel_products = st.session_state.get("ord_products_sel", [])
        prod_label = f"สินค้า ({len(_sel_products)})" if _sel_products else "ทุกสินค้า"
        with st.popover(prod_label, use_container_width=True):
            prod_search = st.text_input(
                "ค้นหาสินค้า", key="ord_products_search", placeholder="พิมพ์ค้นหาชื่อสินค้า...",
                label_visibility="collapsed",
            )
            # session_state["ord_categories"] อ่านได้ตั้งแต่ตรงนี้แม้ตัว multiselect
            # หมวดหมู่ (f5) จะ render ทีหลังในโค้ด — Streamlit เก็บค่า widget ไว้ใน
            # session_state ข้าม rerun อยู่แล้ว ไม่ต้องรอให้ widget ตัวนั้นถูกสร้างก่อน
            _sel_cats = st.session_state.get("ord_categories", [])
            prod_options = all_products
            if _sel_cats:
                prod_options = [p for p in prod_options if name_to_category.get(p, "") in _sel_cats]
            if prod_search:
                prod_options = [p for p in prod_options if prod_search.lower() in p.lower()]

            psel1, psel2 = st.columns(2)
            with psel1:
                if st.button("เลือกที่เห็นทั้งหมด", key="ord_prod_selall", use_container_width=True):
                    sel = set(st.session_state.get("ord_products_sel", [])) | set(prod_options)
                    st.session_state["ord_products_sel"] = sorted(sel)
                    for p in prod_options:
                        st.session_state[f"ord_prod_chk_{p}"] = True
                    st.rerun()
            with psel2:
                if st.button("ล้างที่เลือก", key="ord_prod_clearall", use_container_width=True):
                    for p in all_products:
                        st.session_state.pop(f"ord_prod_chk_{p}", None)
                    st.session_state["ord_products_sel"] = []
                    st.rerun()

            selected_set = set(st.session_state.get("ord_products_sel", []))
            if not prod_options:
                st.caption("ไม่พบสินค้าที่ค้นหา")
            with st.container(height=280 if len(prod_options) > 6 else "content"):
                for p in prod_options:
                    checked = st.checkbox(p, value=(p in selected_set), key=f"ord_prod_chk_{p}")
                    if checked:
                        selected_set.add(p)
                    else:
                        selected_set.discard(p)
            st.session_state["ord_products_sel"] = sorted(selected_set)
        product_filter = st.session_state.get("ord_products_sel", [])
    with f5:
        category_filter = st.multiselect(
            "หมวดหมู่", all_categories, default=[], placeholder="ทุกหมวดหมู่",
            label_visibility="collapsed", key="ord_categories",
        )
    with f6:
        if st.button("Clear"):
            for k in FILTER_KEYS:
                st.session_state.pop(k, None)
            for p in all_products:
                st.session_state.pop(f"ord_prod_chk_{p}", None)
            st.session_state.pop("ord_products_sel", None)
            st.session_state.pop("ord_products_search", None)
            st.rerun()

# ── Filter ────────────────────────────────────────────────────────────────────
filtered = df.copy()
if branch_sel != "ทุกสาขา":
    filtered = filtered[filtered["branch"] == branch_sel]
if status_sel != "ทุกสถานะสลิป":
    filtered = filtered[filtered["slip_status"] == status_sel]
if product_filter:
    wanted = set(product_filter)
    filtered = filtered[filtered["items_json"].apply(
        lambda ij: any(i.get("name") in wanted for i in parse_items(ij))
    )]
if category_filter:
    wanted_cats = set(category_filter)
    filtered = filtered[filtered["items_json"].apply(
        lambda ij: any(name_to_category.get(i.get("name"), "") in wanted_cats for i in parse_items(ij))
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
    if "bulk_result" in st.session_state:
        res = st.session_state.pop("bulk_result")
        if res["errors"]:
            st.error(
                f"{res['label']}: สำเร็จ {res['ok']} รายการ, ล้มเหลว {len(res['errors'])} รายการ — "
                "ลองกดซ้ำเฉพาะรายการที่ล้มเหลว (GAS ตอบช้า/หลุดเป็นครั้งคราว)\n" + "\n".join(res["errors"])
            )
        else:
            st.success(f"{res['label']}: สำเร็จทั้งหมด {res['ok']} รายการ ✅")

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
                    run_bulk_action("อนุมัติสลิปที่เลือก", sel_pending["order_id"], confirm_slip_via_gas)
                    st.session_state.selected_orders = set()
                    st.cache_data.clear()
                    st.rerun()
            with b3:
                if st.button(f"🤝 ส่งมอบ/จัดส่งที่เลือก ({len(sel_handover_ids)})", disabled=not sel_handover_ids):
                    # ออเดอร์จัดส่ง (branch == "จัดส่ง") ต้องผ่าน action=update&status=
                    # handover ไม่ใช่ handoverOrder — ดู comment ที่ปุ่มเดี่ยว "📤 จัดส่งแล้ว"
                    # ด้านล่างสำหรับเหตุผลเต็ม เลือก action ให้ตรงตามสาขาของแต่ละออเดอร์
                    sel_branch_map = dict(zip(sel_rows["order_id"], sel_rows["branch"]))

                    def _handover_or_deliver(oid):
                        if sel_branch_map.get(oid) == "จัดส่ง":
                            return gas_post({"action": "api", "do": "update", "order": oid, "status": "handover"})
                        return gas_post({"_action": "handoverOrder", "order_id": oid})

                    run_bulk_action("ส่งมอบ/จัดส่งที่เลือก", sel_handover_ids, _handover_or_deliver)
                    st.session_state.selected_orders = set()
                    st.cache_data.clear()
                    st.rerun()
            with b4:
                if st.button(f"🏁 ปิดงาน (เสร็จแล้ว) ({len(sel_not_done)})", disabled=sel_not_done.empty,
                             help="ปิดสถานะย้อนหลังเป็น 'รับแล้ว' แบบเงียบ — ไม่ส่ง LINE แจ้งลูกค้า ไม่ตัดสต็อกสาขา เหมาะกับออเดอร์ที่ส่งมอบจริงไปแล้วนอกระบบ"):
                    run_bulk_action("ปิดงาน (เสร็จแล้ว)", sel_not_done["order_id"], force_complete_order)
                    st.session_state.selected_orders = set()
                    st.cache_data.clear()
                    st.rerun()
            with b5:
                if st.button("❌ ยกเลิกสลิปที่เลือก"):
                    run_bulk_action("ยกเลิกสลิปที่เลือก", sel_rows["order_id"], reject_slip_via_gas)
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
          {badge(f'📨 แจ้งไลน์: {line_notify_stage(cur_status, row.get("fulfillment", ""))}', 'pending')}
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
                                # ออเดอร์จัดส่ง (is_del) ต้องใช้คนละ action กับรับที่สาขา —
                                # handoverOrder ตัดสต็อกสาขาและตั้งสถานะ "รับแล้ว" ซึ่งผิดทั้ง
                                # คู่สำหรับจัดส่ง (ไม่มี stock_branch แถวของ branch="จัดส่ง" ให้
                                # ตัด และสถานะที่ถูกต้องคือ "จัดส่งแล้ว") — action=api&do=update
                                # &status=handover คือตัวที่ liff/app.html เคยใช้ (markDelivered)
                                # ก่อนจะย้ายมาทำใน Streamlit อย่างเดียว
                                if handover_idx and is_del and st.button(
                                    "📤 จัดส่งแล้ว", key=f"delivered_{order_id}", use_container_width=True,
                                ):
                                    try:
                                        gas_post({"action": "api", "do": "update", "order": order_id, "status": "handover"})
                                        st.success("บันทึกจัดส่งแล้ว + แจ้ง LINE ลูกค้าแล้ว")
                                        st.cache_data.clear()
                                        st.rerun()
                                    except Exception as e:
                                        st.error(f"ทำรายการไม่ได้: {e}")
                                elif handover_idx and not is_del:
                                    ho_nonce = st.session_state.get(f"ho_nonce_{order_id}", 0)
                                    with st.popover("🤝 ส่งมอบสินค้า", use_container_width=True, key=f"ho_popover_{order_id}_{ho_nonce}"):
                                        st.caption("เลือกสินค้าที่จะส่งมอบรอบนี้")
                                        sel_handover = [
                                            idx for idx in handover_idx
                                            if st.checkbox(
                                                f"{items[idx].get('name','')} x{items[idx].get('qty',1)}",
                                                value=True, key=f"handover_chk_{order_id}_{idx}",
                                            )
                                        ]
                                        if st.button("🤝 ยืนยันส่งมอบ", key=f"handover_submit_{order_id}"):
                                            if not sel_handover:
                                                st.warning("เลือกสินค้าอย่างน้อย 1 รายการ")
                                            else:
                                                try:
                                                    gas_post({"_action": "handoverOrder", "order_id": order_id, "indices": sel_handover})
                                                    st.success("ส่งมอบแล้ว + แจ้ง LINE ลูกค้าแล้ว")
                                                    st.session_state[f"ho_nonce_{order_id}"] = ho_nonce + 1
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

                    if is_del and cur_status == "ยืนยัน":
                        # popover ปกติค้างเปิดอยู่ต่อแม้ st.rerun() หลังทำรายการสำเร็จ
                        # (Streamlit เก็บสถานะเปิด/ปิดของ popover ไว้ตาม key เดิม) —
                        # เปลี่ยน key ให้ต่างไปทุกครั้งที่สร้างเลขพัสดุสำเร็จ บังคับให้
                        # Streamlit มองเป็น widget ใหม่ ซึ่ง default ปิดอยู่เสมอ
                        r8_nonce = st.session_state.get(f"r8_nonce_{order_id}", 0)
                        with st.popover("🚚 จัดส่ง Rocket8", use_container_width=True, key=f"r8_popover_{order_id}_{r8_nonce}"):
                            st.caption("เลือกสินค้าที่จะจัดส่งรอบนี้ (ค่าเริ่มต้นเลือกทั้งหมด — ยกเลิกติ๊กได้ถ้าจะส่งบางส่วนก่อน แล้วสร้างเลขพัสดุรอบถัดไปทีหลังสำหรับที่เหลือ)")
                            sel_ship = [
                                idx for idx in cancelable_idx
                                if st.checkbox(
                                    f"{items[idx].get('name','')} x{items[idx].get('qty',1)}",
                                    value=True, key=f"r8_ship_chk_{order_id}_{idx}",
                                )
                            ]
                            ship_items = [items[idx] for idx in sel_ship]
                            st.caption("ยืนยันที่อยู่ปลายทางก่อนสร้างเลขพัสดุ — Rocket8 ต้องการ ตำบล/อำเภอ/จังหวัด/รหัสไปรษณีย์ แยกฟิลด์ ไม่ใช่ที่อยู่แบบข้อความเดียว")
                            st.text_input(
                                "ที่อยู่เดิม (อ้างอิง)", value=str(row.get("address", "")),
                                disabled=True, key=f"r8_addr_ref_{order_id}",
                            )
                            thai_addr = load_thai_address()
                            addr_guess = parse_customer_address(row.get("address", ""), thai_addr)
                            r8_line = st.text_input(
                                "บ้านเลขที่ / ถนน / ซอย", value=addr_guess["line"], key=f"r8_line_{order_id}",
                            )
                            prov_names = [p["n"] for p in thai_addr]
                            prov_opts = [""] + prov_names
                            prov_idx = prov_opts.index(addr_guess["prov"]) if addr_guess["prov"] in prov_opts else 0
                            r8_prov = st.selectbox(
                                "จังหวัด", prov_opts, index=prov_idx, key=f"r8_prov_{order_id}",
                            )
                            amp_names = []
                            if r8_prov:
                                amp_names = [a["n"] for a in next(p["a"] for p in thai_addr if p["n"] == r8_prov)]
                            amp_opts = [""] + amp_names
                            amp_idx = amp_opts.index(addr_guess["amp"]) if addr_guess["amp"] in amp_opts else 0
                            r8_amp = st.selectbox(
                                "อำเภอ/เขต", amp_opts, index=amp_idx, key=f"r8_amp_{order_id}",
                            )
                            dist_opts = []
                            if r8_prov and r8_amp:
                                amp_obj = next(a for a in next(p["a"] for p in thai_addr if p["n"] == r8_prov) if a["n"] == r8_amp)
                                dist_opts = amp_obj["d"]
                            dist_names_opts = [""] + [d["n"] for d in dist_opts]
                            dist_idx = dist_names_opts.index(addr_guess["dist"]) if addr_guess["dist"] in dist_names_opts else 0
                            r8_dist = st.selectbox(
                                "ตำบล/แขวง", dist_names_opts, index=dist_idx, key=f"r8_dist_{order_id}",
                            )
                            r8_zip_default = next((d["z"] for d in dist_opts if d["n"] == r8_dist), "") or addr_guess["zip"]
                            r8_zip = st.text_input(
                                "รหัสไปรษณีย์", value=r8_zip_default, key=f"r8_zip_{order_id}",
                            )
                            r8_name = st.text_input(
                                "ชื่อผู้รับ", value=str(row.get("real_name", "")), key=f"r8_name_{order_id}",
                            )
                            r8_phone = st.text_input(
                                "เบอร์ผู้รับ", value=str(row.get("phone", "")), key=f"r8_phone_{order_id}",
                            )
                            box_qty = sum(
                                int(i.get("qty", 1)) for i in ship_items if i.get("type") == "box"
                            ) or 1
                            r8_weight_kg = st.number_input(
                                "น้ำหนักรวม (kg)", min_value=0.1, value=0.5 * box_qty, step=0.1,
                                key=f"r8_weight_{order_id}",
                            )
                            box_opts = list(BOX_SIZES.keys())
                            box_code = st.selectbox(
                                "ขนาดกล่อง", box_opts, index=box_opts.index("B"), key=f"r8_boxcode_{order_id}",
                            )
                            box_prev_key = f"r8_boxcode_prev_{order_id}"
                            if st.session_state.get(box_prev_key) != box_code:
                                bw, bl, bh = BOX_SIZES[box_code]
                                st.session_state[f"r8_w_{order_id}"] = bw
                                st.session_state[f"r8_h_{order_id}"] = bh
                                st.session_state[f"r8_l_{order_id}"] = bl
                                st.session_state[box_prev_key] = box_code
                            r8c1, r8c2, r8c3 = st.columns(3)
                            with r8c1:
                                r8_w = st.number_input("กว้าง (ซม.)", min_value=1, key=f"r8_w_{order_id}")
                            with r8c2:
                                r8_h = st.number_input("สูง (ซม.)", min_value=1, key=f"r8_h_{order_id}")
                            with r8c3:
                                r8_l = st.number_input("ยาว (ซม.)", min_value=1, key=f"r8_l_{order_id}")
                            r8_partner = st.selectbox(
                                "ขนส่ง", rocket8_client.PARTNERS, key=f"r8_partner_{order_id}",
                            )

                            if st.button("🚚 ยืนยันสร้างเลขพัสดุ", key=f"r8_submit_{order_id}"):
                                if not sel_ship:
                                    st.warning("เลือกสินค้าที่จะจัดส่งอย่างน้อย 1 รายการ")
                                elif not (r8_line and r8_prov and r8_amp and r8_dist and r8_zip and r8_name and r8_phone):
                                    st.warning("กรอกที่อยู่/ชื่อ/เบอร์ผู้รับให้ครบก่อน")
                                else:
                                    try:
                                        r8_items = [
                                            {"name": i.get("name", ""), "qty": int(i.get("qty", 1)), "price": float(i.get("price", 0))}
                                            for i in ship_items
                                        ]
                                        result = rocket8_client.create_shipment_order(
                                            to_name=r8_name, to_phone=r8_phone, to_address=r8_line,
                                            to_district=r8_dist, to_city=r8_amp, to_province=r8_prov,
                                            to_postal_code=r8_zip, weight_g=int(round(r8_weight_kg * 1000)),
                                            width=int(r8_w), height=int(r8_h), length=int(r8_l),
                                            items=r8_items, partner=r8_partner, ref_number=str(order_id),
                                        )
                                        awb = result.get("partner_awb_no", "")
                                        partner_code = (result.get("partner") or {}).get("partner_code") or r8_partner
                                        partner_name = (result.get("partner") or {}).get("partner_name") or r8_partner
                                        new_note = f"{row.get('notes', '')}\nRocket8 AWB: {awb} ({partner_name})".strip()
                                        now_str = datetime.now(TH_TZ).strftime("%Y-%m-%d %H:%M")

                                        updated_items = [dict(it) for it in items]
                                        for idx in sel_ship:
                                            updated_items[idx]["handed_at"] = now_str
                                        all_done = all(it.get("handed_at") or it.get("cancelled_at") for it in updated_items)
                                        new_ff = "จัดส่งแล้ว" if all_done else "จัดส่งบางส่วนแล้ว"

                                        update_payload = {
                                            "notes": new_note,
                                            "items_json": updated_items,
                                            "fulfillment": new_ff,
                                        }
                                        if all_done:
                                            update_payload["staff_confirmed_at"] = now_str
                                            update_payload["customer_confirmed_at"] = now_str
                                        get_supabase().table("orders").update(update_payload).eq("order_id", order_id).execute()

                                        track_url = rocket8_client.tracking_url(partner_code, awb)
                                        track_block = f"ติดตามพัสดุ:\n{track_url}" if track_url else "ตรวจสอบสถานะพัสดุได้จากขนส่งโดยตรงด้วยเลขพัสดุด้านบนครับ"
                                        if all_done:
                                            line_msg = (
                                                "📦 คำสั่งซื้อของคุณจัดส่งแล้ว!\n\n"
                                                f"ออเดอร์: #{order_id}\n\n"
                                                f"ขนส่ง: {partner_name}\n"
                                                f"เลขพัสดุ: {awb}\n\n"
                                                f"{track_block}\n"
                                                "ขอบคุณที่อุดหนุน WAKA SPACE ครับ 🙏"
                                            )
                                        else:
                                            shipped_line = "\n".join(f"- {i.get('name','')} x{i.get('qty',1)}" for i in ship_items)
                                            pending_items = [
                                                it for i2, it in enumerate(updated_items)
                                                if i2 not in sel_ship and not it.get("handed_at") and not it.get("cancelled_at")
                                            ]
                                            pending_line = "\n".join(f"- {it.get('name','')} x{it.get('qty',1)}" for it in pending_items)
                                            line_msg = (
                                                "📦 คำสั่งซื้อของคุณจัดส่งบางส่วนแล้ว!\n\n"
                                                f"ออเดอร์: #{order_id}\n\n"
                                                f"ขนส่ง: {partner_name}\n"
                                                f"เลขพัสดุ: {awb}\n\n"
                                                f"✅ ส่งแล้ว:\n{shipped_line}\n\n"
                                                f"⏳ รอจัดส่งรอบถัดไป:\n{pending_line}\n\n"
                                                f"{track_block}\n"
                                                "ขอบคุณที่อุดหนุน WAKA SPACE ครับ 🙏"
                                            )
                                        try:
                                            gas_post({"_action": "notifyCustomer", "order_id": order_id, "custom_message": line_msg})
                                            _flash(f"ดำเนินการแล้ว — สร้างเลขพัสดุ {awb} และแจ้งลูกค้าทาง LINE แล้ว")
                                        except Exception as line_err:
                                            _flash(f"สร้างเลขพัสดุสำเร็จ ({awb}) แต่แจ้งลูกค้าทาง LINE ไม่ได้: {line_err}")

                                        st.session_state[f"r8_nonce_{order_id}"] = r8_nonce + 1
                                        st.cache_data.clear()
                                        st.rerun()
                                    except rocket8_client.Rocket8Error as e:
                                        st.error(f"Rocket8 สร้างเลขพัสดุไม่ได้: {e}")
                                    except Exception as e:
                                        st.error(f"ทำรายการไม่ได้: {e}")

                    col_slip, col_act = st.columns([1, 2])
                    with col_slip:
                        slip_url_raw = row.get("slip_url", "")
                        slip_url = "" if pd.isna(slip_url_raw) else str(slip_url_raw)
                        if slip_url.startswith("http"):
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

    try:
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
        edit_df.insert(0, "ลบ", False)

        edited_df = st.data_editor(
            edit_df,
            use_container_width=True,
            hide_index=True,
            height=600,
            key="orders_sheet_editor",
            disabled=["เลขออเดอร์", "ลูกค้า", "เบอร์โทร", "สาขา", "วันที่", "ยอดรวม", "รายการสินค้า"],
            column_config={
                "ลบ": st.column_config.CheckboxColumn("ลบ", width="small"),
                "สถานะสลิป": st.column_config.SelectboxColumn(options=ALL_STATUS, required=True),
                "สถานะจัดส่ง": st.column_config.SelectboxColumn(options=ALL_FULFILL),
                "ยอดรวม": st.column_config.NumberColumn(format="฿%d"),
            },
        )

        bcol1, bcol2 = st.columns(2)
        with bcol1:
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
                        _flash(f"บันทึกแล้ว {len(edited_rows)} ออเดอร์")
                    st.cache_data.clear()
                    st.rerun()

        to_delete = edited_df.loc[edited_df["ลบ"] == True, "เลขออเดอร์"].astype(str).tolist()  # noqa: E712
        with bcol2:
            if st.button(f"🗑 ลบออเดอร์ที่เลือก ({len(to_delete)})", disabled=not to_delete):
                st.session_state["_confirm_delete_orders"] = to_delete

        pending_delete = st.session_state.get("_confirm_delete_orders")
        if pending_delete:
            st.error(
                f"⚠️ ยืนยันลบถาวร {len(pending_delete)} ออเดอร์: {', '.join(pending_delete)} "
                "— ลบแล้วกู้คืนไม่ได้ และจะหายไปจากรายงานยอดขายด้วย"
            )
            cc1, cc2 = st.columns(2)
            with cc1:
                if st.button("⚠️ ยืนยันลบถาวร", type="primary", key="confirm_delete_orders_btn"):
                    errors = []
                    for oid in pending_delete:
                        try:
                            get_supabase().table("orders").delete().eq("order_id", oid).execute()
                        except Exception as e:
                            errors.append(f"#{oid}: {e}")
                    try:
                        get_supabase().table("staff_actions").insert({
                            "staff_name": admin_name() or "ไม่ระบุ",
                            "action": "delete_order",
                            "target_id": ", ".join(pending_delete),
                            "detail": f"ลบออเดอร์ {len(pending_delete)} รายการจากตารางรวม",
                        }).execute()
                    except Exception:
                        pass  # audit log ต้องไม่บล็อกการลบจริง เหมือน _logStaffAction_ ฝั่ง GAS
                    st.session_state.pop("_confirm_delete_orders", None)
                    if errors:
                        st.error("ลบไม่สำเร็จบางรายการ:\n" + "\n".join(errors))
                    else:
                        _flash(f"ลบออเดอร์แล้ว {len(pending_delete)} รายการ")
                    st.cache_data.clear()
                    st.rerun()
            with cc2:
                if st.button("ยกเลิก", key="cancel_delete_orders_btn"):
                    st.session_state.pop("_confirm_delete_orders", None)
                    st.rerun()
    except Exception as e:
        # Supplementary tab — a bug here shouldn't take down the card view
        # that staff actually depend on day-to-day.
        st.error(f"ตารางรวมโหลดไม่ได้: {e}")

# ── Tab: ลูกค้าทั้งหมด (customer roll-up, ignores the date/branch filters above) ─
with tab_customers:
    st.caption("สรุปลูกค้าทั้งหมดจากทุกออเดอร์ในระบบ (ไม่ผูกกับตัวกรองด้านบน)")

    try:
        cust_search = st.text_input("ค้นหาลูกค้า", placeholder="ชื่อ หรือ เบอร์โทร", key="cust_search")

        cust_base = df.copy()
        cust_base["phone"] = cust_base["phone"].fillna("").astype(str)
        cust_base["confirmed_total"] = cust_base["total"].where(cust_base["slip_status"] == "ยืนยัน", 0)

        # Built from a dict of per-column Series (each auto-aligned on the
        # "phone" group index) rather than one groupby().agg(**kwargs) call —
        # more standard/portable across pandas versions than mixing string
        # and lambda aggregators in a single named-aggregation call.
        grp = cust_base.groupby("phone")
        cust = pd.DataFrame({
            "ลูกค้า":        grp["real_name"].last(),
            "จำนวนออเดอร์":   grp["order_id"].count(),
            "ยืนยันแล้ว":     grp["slip_status"].apply(lambda s: int((s == "ยืนยัน").sum())),
            "ยอดซื้อสะสม":    grp["confirmed_total"].sum(),
            "ออเดอร์ล่าสุด":  grp["timestamp_dt"].max(),
        }).reset_index().rename(columns={"phone": "เบอร์โทร"}).sort_values("ยอดซื้อสะสม", ascending=False)
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
    except Exception as e:
        # Supplementary tab — a bug here shouldn't take down the card/table
        # tabs that staff actually depend on day-to-day.
        st.error(f"สรุปลูกค้าโหลดไม่ได้: {e}")
