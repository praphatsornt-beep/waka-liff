#!/usr/bin/env python3
"""จัดการสินค้าและหมวดหมู่ — เพิ่ม/แก้ไขสินค้า และจัดการหมวดหมู่สินค้า, แยกออกมาจากหน้าสต็อกสินค้า"""

import base64
import json
import os
import re
import sys
from pathlib import Path

import streamlit as st
import pandas as pd
import requests
from dotenv import load_dotenv

load_dotenv()

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from theme import apply_theme, page_header, admin_name, badge

GAS_URL  = "https://script.google.com/macros/s/AKfycbz52wvADM7O1zMjqKlT2G4HPkq8gwAon_fUCuKgbmUMkDPQkaYKUWnv598U3EkFN1AByQ/exec"
WAKA_S   = "wk26xK9mPqRt"  # shared secret doPost/doGet require via ?_s= (same value as stock.py's WAKA_S)
ADMIN_CODE = "waka99"  # updateProduct/addProduct still require this to prove admin, same as stock.py

# label สำหรับ action ที่ target_id ผูกกับสินค้าโดยตรง (ชื่อ/รหัสสินค้า) — ดึงมา
# แสดงตรงๆ ใน load_product_history() ด้านล่าง ส่วน action ที่ target_id ผูกกับ
# order_id/sale_id (คำสั่งซื้อออนไลน์, ขายหน้าร้าน) ดูรายละเอียดวิธีดึงมาแสดงที่
# docstring ของ load_product_history()
PRODUCT_ACTION_LABELS = {
    "add_product": "สร้างสินค้าใหม่",
    "rename_product": "เปลี่ยนชื่อสินค้า",
    "update_product": "แก้ไขข้อมูลสินค้า",
    "add_stock": "ปรับสต็อกคลังกลาง",
    "withdraw_central_stock": "เบิกจากคลังกลาง",
    "withdraw_stock": "เบิกจากสต็อกสาขา",
    "return_stock": "คืนจากสาขากลับคลังกลาง",
    "cancel_walkin_sale_item": "ยกเลิกยอดขายหน้าร้าน",
}


def drive_thumbnail_url(url: str) -> str:
    """catalog.image_url is stored as a Drive share link
    (.../file/d/{id}/view?usp=sharing), which an <img> tag can't render —
    convert to the thumbnail endpoint, same as gas/Code.gs's _driveUrl()
    does server-side for the LIFF customer catalog."""
    url = str(url or "")
    if not url:
        return ""
    m = re.search(r"/d/([a-zA-Z0-9_-]+)", url)
    if m:
        return f"https://drive.google.com/thumbnail?id={m.group(1)}&sz=w800"
    return url


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
    payload = {**payload, "code": ADMIN_CODE, "staff_name": admin_name()}
    resp = requests.post(f"{GAS_URL}?_s={WAKA_S}", json=payload, timeout=30)
    result = resp.json()
    if result.get("error"):
        raise Exception(result["error"])
    return result


@st.cache_data(ttl=30)
def load_catalog() -> pd.DataFrame:
    rows = get_supabase().table("catalog").select("*").order("name").execute().data
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    # Same class of bug as orders.py: a null text column mixed with real
    # values becomes NaN, which is truthy in Python — `x.get(col) or ""`
    # then keeps the NaN and renders it as the literal text "nan" in form
    # fields (category/barcode/image_url/notice are all nullable columns).
    text_cols = [c for c in ["category", "slug", "active", "image_url", "barcode", "notice", "id"] if c in df.columns]
    df[text_cols] = df[text_cols].fillna("")
    return df


@st.cache_data(ttl=30)
def load_config() -> dict:
    rows = get_supabase().table("config").select("key,value").execute().data
    return {r["key"]: (r.get("value") or "") for r in rows}


@st.cache_data(ttl=60)
def load_shipments() -> pd.DataFrame:
    rows = get_supabase().table("shipments").select("*").order("timestamp", desc=True).execute().data
    return pd.DataFrame(rows)


@st.cache_data(ttl=60)
def load_walkin_sales() -> pd.DataFrame:
    rows = get_supabase().table("walkin_sales").select("*").order("timestamp", desc=True).execute().data
    return pd.DataFrame(rows)


@st.cache_data(ttl=30)
def load_orders_light() -> pd.DataFrame:
    # เฉพาะคอลัมน์ที่ใช้จริงในหน้าประวัติสินค้า — ไม่ดึงสลิป/เบอร์/ที่อยู่ที่ไม่
    # เกี่ยวข้อง ตารางนี้โตเร็วกว่า shipments/walkin_sales มาก
    rows = (
        get_supabase().table("orders")
        .select("order_id,timestamp,items_json,fulfillment,slip_status,branch,real_name,display_name")
        .order("timestamp", desc=True).execute().data
    )
    return pd.DataFrame(rows)


def parse_items(items_json) -> list:
    if isinstance(items_json, list):
        return items_json
    try:
        return json.loads(items_json) if items_json else []
    except Exception:
        return []


def _parse_ts(ts):
    # ต้อง parse ทีละค่า ไม่ใช่ทั้งคอลัมน์พร้อมกัน — staff_actions.created_at,
    # shipments.timestamp, และ shipments.received_at คนละ format กัน (เช่น
    # "...+07:00" vs "yyyy-MM-dd HH:mm" ไม่มี offset) ถ้าโยนทั้ง Series ที่มี
    # format ปนกันเข้า pd.to_datetime() รวดเดียว, pandas จะเดา format จากค่า
    # แรกแล้วค่าที่ format ไม่ตรงกลายเป็น NaT ทั้งหมด (พังแบบเงียบๆ, เจอจริงว่า
    # แถวล็อตส่งสาขาหล่นไปท้ายตารางเสมอไม่ว่าจะเวลาไหนก็ตาม)
    return pd.to_datetime(ts, errors="coerce", utc=True)


def _fmt_ts(ts) -> str:
    dt = _parse_ts(ts)
    if pd.isna(dt):
        return ""
    return dt.tz_convert("Asia/Bangkok").strftime("%Y-%m-%d %H:%M")


def _shipment_item_qty_text(it: dict) -> str:
    box = (it.get("qty_box") or 0) + (it.get("qty_box_extra") or 0)
    pack = (it.get("qty_pack") or 0) + (it.get("qty_pack_extra") or 0)
    parts = []
    if box:
        parts.append(f"{box} กล่อง")
    if pack:
        parts.append(f"{pack} ซอง")
    return " ".join(parts) or "—"


@st.cache_data(ttl=30)
def load_product_history(name: str, product_id: str = ""):
    """คืน (created_text, history_df) สำหรับสินค้า — created_text มาจาก
    staff_actions ที่ action='add_product' (ถ้ามี), history_df รวมทั้งการเบิก/
    ปรับสต็อกคลังกลาง/สาขา/เปลี่ยนชื่อ (staff_actions), ล็อตส่งสาขา (shipments
    ที่ items_json มีสินค้านี้อยู่), ยอดขายหน้าร้าน (walkin_sales) และคำสั่งซื้อ
    ออนไลน์ (orders) ที่ items_json มีสินค้านี้อยู่ เรียงจากล่าสุดไปเก่าสุด.

    ตั้งแต่ gas/Code.gs เวอร์ชันที่บันทึก target_id เป็น "รหัสสินค้า" (product_id,
    คงที่แม้เปลี่ยนชื่อ) แทนชื่อสินค้า (เปลี่ยนได้) — คิวรี่ทั้งสองแบบพร้อมกัน
    (target_id = product_id หรือ = name) เพื่อให้ประวัติเก่าที่ยังผูกกับชื่อ (ก่อน
    ปรับ) กับประวัติใหม่ที่ผูกกับรหัส (หลังปรับ) รวมกันมาแสดงครบ. ส่วนล็อตส่งสาขา/
    ยอดขายหน้าร้าน/ออเดอร์ออนไลน์ยังจับคู่ด้วยชื่อเท่านั้น (items_json เก็บ snapshot
    ชื่อ ไม่มีรหัส) — ถ้าเคยเปลี่ยนชื่อ รายการเก่าก่อนเปลี่ยนชื่อจะไม่โผล่ในนี้.

    ออเดอร์ออนไลน์: ข้าม order ที่ fulfillment='ยกเลิก' ทั้งใบ (คืนสต็อกครบแล้ว
    ตอนยกเลิก, gas/Code.gs's handleApi's action=cancel_order) และข้าม item ที่มี
    cancelled_at (ยกเลิกบางรายการผ่าน handlePartialCancelItems, คืนสต็อกแล้ว
    เหมือนกัน) — กันไม่ให้แสดงว่า "ขายแล้ว" ทั้งที่จริงคืนของกลับสต็อกไปแล้ว.

    ยอดขายหน้าร้านที่ถูกยกเลิก: แถวใน walkin_sales ถูกลบทิ้งไปแล้วตอนยกเลิก
    (nothing left to scan) แต่ handleCancelWalkinSale (gas/Code.gs) log แยก
    เป็น action="cancel_walkin_sale_item" หนึ่งแถวต่อสินค้าหนึ่งชิ้นในใบขายนั้น
    โดยตรง (target_id = รหัสสินค้า) จึงถูกดึงมาแสดงผ่าน staff_actions query
    ก้อนแรกด้านบนอัตโนมัติ ไม่ต้อง query เพิ่ม — ต้อง deploy gas/Code.gs เวอร์ชัน
    ที่มีการ log นี้ก่อนถึงจะเห็นผล (ยอดยกเลิกที่เกิดก่อน deploy จะไม่มีแถวนี้)"""
    target_ids = [t for t in {name, product_id} if t]
    actions_rows = (
        get_supabase().table("staff_actions").select("*")
        .in_("target_id", target_ids).order("created_at", desc=True).execute().data
    )
    entries = []
    created_text = ""
    for r in actions_rows:
        action = r.get("action", "")
        if action == "add_product" and not created_text:
            created_text = _fmt_ts(r.get("created_at"))
        entries.append({
            "เวลา": _fmt_ts(r.get("created_at")),
            "_ts": _parse_ts(r.get("created_at")),
            "การกระทำ": PRODUCT_ACTION_LABELS.get(action, action),
            "สาขา": r.get("branch") or "",
            "พนักงาน": r.get("staff_name") or "ไม่ระบุ",
            "รายละเอียด": r.get("detail") or "",
        })

    ships = load_shipments()
    shipment_hits = []
    matching_shipment_ids = []
    if not ships.empty:
        for _, sr in ships.iterrows():
            hit = next((it for it in parse_items(sr.get("items_json")) if it.get("name") == name), None)
            if not hit:
                continue
            shipment_hits.append((sr, hit))
            sid = sr.get("shipment_id", "")
            if sid:
                matching_shipment_ids.append(sid)

    ship_staff = {}
    if matching_shipment_ids:
        ship_action_rows = (
            get_supabase().table("staff_actions").select("*")
            .in_("target_id", matching_shipment_ids)
            .in_("action", ["create_shipment", "receive_shipment"])
            .execute().data
        )
        for r in ship_action_rows:
            ship_staff.setdefault(r.get("target_id", ""), {})[r.get("action", "")] = r.get("staff_name") or "ไม่ระบุ"

    for sr, hit in shipment_hits:
        sid = sr.get("shipment_id", "")
        qty_text = _shipment_item_qty_text(hit)
        entries.append({
            "เวลา": _fmt_ts(sr.get("timestamp")),
            "_ts": _parse_ts(sr.get("timestamp")),
            "การกระทำ": "ส่งล็อตไปสาขา",
            "สาขา": sr.get("to_branch") or "",
            "พนักงาน": ship_staff.get(sid, {}).get("create_shipment", "ไม่ระบุ"),
            "รายละเอียด": f"{qty_text} — ล็อต {sid} ({sr.get('status', '')})",
        })
        if sr.get("status") == "รับแล้ว" and sr.get("received_at"):
            entries.append({
                "เวลา": _fmt_ts(sr.get("received_at")),
                "_ts": _parse_ts(sr.get("received_at")),
                "การกระทำ": "สาขารับของแล้ว",
                "สาขา": sr.get("to_branch") or "",
                "พนักงาน": ship_staff.get(sid, {}).get("receive_shipment", "ไม่ระบุ"),
                "รายละเอียด": f"{qty_text} — ล็อต {sid}",
            })

    # ยอดขายหน้าร้าน — สแกน items_json เหมือนล็อตส่งสาขาข้างบน แทนการหา target_id
    # ตรงๆ เพราะ staff_actions บันทึก target_id ของ action="walkin_sale" เป็น
    # sale_id ไม่ใช่ชื่อ/รหัสสินค้า. walkin_sales มีคอลัมน์ staff_name ของตัวเอง
    # อยู่แล้ว (ไม่เหมือน shipments) จึงไม่ต้อง query staff_actions ซ้อนอีกชั้น
    sales = load_walkin_sales()
    if not sales.empty:
        for _, sale_row in sales.iterrows():
            hit = next((it for it in parse_items(sale_row.get("items_json")) if it.get("name") == name), None)
            if not hit:
                continue
            qty = hit.get("qty") or 0
            unit = "กล่อง" if hit.get("type") == "box" else "ซอง"
            price = hit.get("price") or 0
            entries.append({
                "เวลา": _fmt_ts(sale_row.get("timestamp")),
                "_ts": _parse_ts(sale_row.get("timestamp")),
                "การกระทำ": "ขายหน้าร้าน",
                "สาขา": sale_row.get("branch") or "",
                "พนักงาน": sale_row.get("staff_name") or "ไม่ระบุ",
                "รายละเอียด": f"{qty} {unit} x ฿{price:,.0f} = ฿{qty * price:,.0f} — เลขที่ {sale_row.get('sale_id', '')}",
            })

    # ออเดอร์ออนไลน์ — สแกน items_json เหมือนสองก้อนบน. ไม่มี staff ที่ "ทำ"
    # การขายโดยตรง (ลูกค้าสั่งเอง) เลยแสดงชื่อลูกค้าไว้ในคอลัมน์พนักงานแทน — เป็น
    # ข้อมูลที่มีประโยชน์กว่าคำว่า "ไม่ระบุ" เฉยๆ
    orders = load_orders_light()
    if not orders.empty:
        for _, o in orders.iterrows():
            if str(o.get("fulfillment") or "") == "ยกเลิก":
                continue
            hit = next(
                (it for it in parse_items(o.get("items_json")) if it.get("name") == name and not it.get("cancelled_at")),
                None,
            )
            if not hit:
                continue
            qty = hit.get("qty") or 0
            unit = "กล่อง" if hit.get("type") == "box" else "ซอง"
            price = hit.get("price") or 0
            cust = o.get("real_name") or o.get("display_name") or "ไม่ระบุ"
            entries.append({
                "เวลา": _fmt_ts(o.get("timestamp")),
                "_ts": _parse_ts(o.get("timestamp")),
                "การกระทำ": "สั่งซื้อออนไลน์",
                "สาขา": o.get("branch") or "",
                "พนักงาน": f"ลูกค้า: {cust}",
                "รายละเอียด": f"{qty} {unit} x ฿{price:,.0f} = ฿{qty * price:,.0f} — ออเดอร์ {o.get('order_id', '')} ({o.get('slip_status', '')})",
            })

    if not entries:
        return created_text, pd.DataFrame()

    hist_df = pd.DataFrame(entries)
    hist_df = hist_df.sort_values("_ts", ascending=False, na_position="last")
    return created_text, hist_df[["เวลา", "การกระทำ", "สาขา", "พนักงาน", "รายละเอียด"]]


# st.success() called right before st.rerun() never reaches the screen — the
# rerun wipes it before the browser paints, so the person clicking "บันทึก"
# sees nothing happen and clicks again. Stash the message in session_state
# instead and show it as a toast on the NEXT run, after the state that
# already changed. (Same pattern as stock.py.)
def _flash(msg: str) -> None:
    st.session_state["_flash_msg"] = msg


def _num(v, default=0.0):
    n = pd.to_numeric(v, errors="coerce")
    return float(n) if pd.notna(n) else default


def _is_active(row) -> bool:
    # Supabase stores active as the string "TRUE"/"FALSE", not a real bool —
    # bool("FALSE") is truthy in Python, so compare the string explicitly.
    return str(row.get("active") or "").strip().upper() != "FALSE"


# ── Page ──────────────────────────────────────────────────────────────────────
apply_theme()
page_header("จัดการสินค้าและหมวดหมู่", "ดูสถานะเปิด/ปิดขาย เพิ่ม/แก้ไขสินค้า และจัดการหมวดหมู่สินค้า")

if "_flash_msg" in st.session_state:
    st.toast(st.session_state.pop("_flash_msg"), icon="✅")

catalog = load_catalog()

CAT_DESC_PREFIX = "category_desc_"
_cat_cfg = load_config()
_product_cats = sorted(set(catalog["category"].dropna().tolist())) if not catalog.empty else []
_product_cats = [c for c in _product_cats if c]
ALL_CATEGORIES = sorted(set(_product_cats) | {k[len(CAT_DESC_PREFIX):] for k in _cat_cfg if k.startswith(CAT_DESC_PREFIX)})

tab_browse, tab_edit, tab_categories = st.tabs(
    ["📋 สินค้า", "✏️ แก้ไขสินค้า", "🏷️ หมวดหมู่สินค้า"]
)


@st.dialog("📜 รายละเอียดสินค้า", width="large")
def _product_detail_dialog(name: str):
    row_df = catalog[catalog["name"] == name]
    if row_df.empty:
        st.caption("ไม่พบสินค้านี้แล้ว")
        return
    row = row_df.iloc[0]
    row_active = _is_active(row)

    dc1, dc2 = st.columns([1, 3])
    with dc1:
        thumb_url = drive_thumbnail_url(str(row.get("image_url") or ""))
        if thumb_url:
            st.image(thumb_url, width=120)
    with dc2:
        st.markdown(f"### {name}")
        meta_bits = [str(b) for b in [row.get("category"), row.get("id")] if b]
        st.caption(" · ".join(meta_bits) or "—")
        st.markdown(
            badge("เปิดขาย" if row_active else "ปิดขาย", "success" if row_active else "danger"),
            unsafe_allow_html=True,
        )

    st.markdown("<div style='height:8px'></div>", unsafe_allow_html=True)
    m1, m2, m3, m4 = st.columns(4)
    m1.metric("คลังกลาง (กล่อง)", int(_num(row.get("qty_box"))))
    m2.metric("คลังกลาง (ซอง)", int(_num(row.get("qty_pack"))))
    m3.metric("ราคา/กล่อง", f"฿{_num(row.get('price_box')):,.0f}")
    m4.metric("ราคา/ซอง", f"฿{_num(row.get('price_pack')):,.0f}")

    with st.spinner("กำลังโหลดประวัติ..."):
        created_text, history_df = load_product_history(name, str(row.get("id") or ""))

    st.markdown("<div style='height:8px'></div>", unsafe_allow_html=True)
    if created_text:
        st.caption(f"🕓 สร้างเมื่อ: {created_text}")
    else:
        st.caption("🕓 ไม่ทราบวันที่สร้าง (สินค้านี้มีอยู่ก่อนระบบบันทึกประวัติ หรือถูกเพิ่มโดยวิธีอื่น)")

    st.markdown("**ประวัติเข้า-ออกสินค้า**")
    if history_df.empty:
        st.caption("ยังไม่มีประวัติเข้า-ออกที่บันทึกไว้")
    else:
        st.dataframe(history_df, use_container_width=True, hide_index=True)
        st.caption("หมายเหตุ: ล็อตส่งสาขาจับคู่ด้วยชื่อสินค้าปัจจุบัน — gas/Code.gs อัปเดตชื่อในล็อตเก่าให้อัตโนมัติทุกครั้งที่มีการเปลี่ยนชื่อสินค้า (ครอบคลุมล็อตที่รับไปแล้วด้วย ไม่ใช่แค่ที่ค้างส่ง)")


with tab_browse:
    br1, br2 = st.columns([2, 1])
    with br1:
        browse_q = st.text_input("ค้นหาสินค้า", key="browse_product_q", placeholder="ชื่อ / หมวดหมู่ / บาร์โค้ด")
    with br2:
        browse_status = st.selectbox("สถานะ", ["ทั้งหมด", "เปิดขาย", "ปิดขาย"], key="browse_product_status")

    browse_df = catalog.copy()
    if not browse_df.empty:
        if browse_q.strip():
            q = browse_q.strip().lower()
            browse_df = browse_df[
                browse_df["name"].str.lower().str.contains(q, na=False)
                | browse_df["category"].str.lower().str.contains(q, na=False)
                | browse_df["barcode"].astype(str).str.lower().str.contains(q, na=False)
            ]
        if browse_status != "ทั้งหมด":
            active_mask = browse_df.apply(_is_active, axis=1)
            browse_df = browse_df[active_mask] if browse_status == "เปิดขาย" else browse_df[~active_mask]

    st.caption(f"{len(browse_df)} รายการ")

    if browse_df.empty:
        st.info("ไม่พบสินค้า")
    else:
        for _, row in browse_df.sort_values("name").iterrows():
            row_active = _is_active(row)
            with st.container(border=True):
                c1, c2, c3 = st.columns([1, 4, 1.4])
                with c1:
                    thumb_url = drive_thumbnail_url(str(row.get("image_url") or ""))
                    if thumb_url:
                        st.image(thumb_url, width=56)
                    else:
                        st.markdown(
                            "<div style='width:56px;height:56px;border-radius:10px;background:#f0ede8;"
                            "display:flex;align-items:center;justify-content:center;font-size:22px'>🎴</div>",
                            unsafe_allow_html=True,
                        )
                with c2:
                    st.markdown(f"**{row.get('name','')}**")
                    meta_bits = [str(b) for b in [row.get("category"), row.get("id")] if b]
                    if row.get("barcode"):
                        meta_bits.append(f"🔖 {row['barcode']}")
                    price_bits = []
                    if _num(row.get("price_box")) > 0:
                        price_bits.append(f"Box ฿{_num(row.get('price_box')):,.0f}")
                    if _num(row.get("price_pack")) > 0:
                        price_bits.append(f"Pack ฿{_num(row.get('price_pack')):,.0f}")
                    st.caption(" · ".join(meta_bits + price_bits) or "—")
                    st.caption(f"สต็อกกลาง — กล่อง {int(_num(row.get('qty_box')))} / ซอง {int(_num(row.get('qty_pack')))}")
                with c3:
                    st.markdown(
                        badge("เปิดขาย" if row_active else "ปิดขาย", "success" if row_active else "danger"),
                        unsafe_allow_html=True,
                    )
                    st.markdown("<div style='height:6px'></div>", unsafe_allow_html=True)
                    if st.button("ปิดขาย" if row_active else "เปิดขาย", key=f"browse_toggle_{row['name']}", use_container_width=True):
                        try:
                            gas_post({"_action": "updateProduct", "name": row["name"], "id": row.get("id") or None, "active": not row_active})
                            _flash(f"{'ปิด' if row_active else 'เปิด'}ขาย \"{row['name']}\" แล้ว")
                            st.cache_data.clear()
                            st.rerun()
                        except Exception as e:
                            st.error(f"ทำรายการไม่ได้: {e}")
                    if st.button("📜 ประวัติ", key=f"browse_history_{row['name']}", use_container_width=True):
                        _product_detail_dialog(row["name"])

with tab_edit:
    manage_cat_sel = st.selectbox("กรองหมวดหมู่", ["ทุกหมวดหมู่"] + ALL_CATEGORIES, key="edit_product_cat_filter")
    manage_catalog = catalog if manage_cat_sel == "ทุกหมวดหมู่" else catalog[catalog["category"] == manage_cat_sel]
    edit_names = sorted(manage_catalog["name"].tolist()) if not manage_catalog.empty else []
    edit_sel = st.selectbox("เลือกสินค้าที่จะแก้ไข", edit_names, key="edit_product_sel")
    edit_row = catalog[catalog["name"] == edit_sel].iloc[0] if edit_sel else None
    if edit_row is not None:
        st.caption(f"รหัสสินค้า: {edit_row.get('id') or '—'}")

        cur_image_url = str(edit_row.get("image_url") or "")
        preview_image_url = st.session_state.get(f"edit_product_image_url_{edit_sel}", "") or cur_image_url
        if preview_image_url:
            st.image(drive_thumbnail_url(preview_image_url), width=200)
        else:
            st.caption("(ยังไม่มีรูปสินค้า)")

        edit_img_file = st.file_uploader(
            "เปลี่ยนรูปสินค้า", type=["jpg", "jpeg", "png", "webp"], key=f"edit_product_img_{edit_sel}",
        )
        if edit_img_file is not None:
            st.image(edit_img_file, width=200)
            if st.button("📤 อัปโหลดรูปนี้", key=f"upload_edit_product_img_btn_{edit_sel}"):
                try:
                    b64 = base64.b64encode(edit_img_file.getvalue()).decode("ascii")
                    res = gas_post({
                        "_action": "uploadProductImage",
                        "base64": b64,
                        "mimeType": edit_img_file.type or "image/jpeg",
                        "filename": edit_img_file.name,
                    })
                    new_url = res.get("url", "")
                    gas_post({"_action": "updateProduct", "name": edit_sel, "id": edit_row.get("id") or None, "image_url": new_url})
                    st.session_state[f"edit_product_image_url_{edit_sel}"] = new_url
                    st.session_state.pop(f"edit_product_img_{edit_sel}", None)
                    _flash("อัปโหลดและบันทึกรูปสินค้าแล้ว")
                    st.cache_data.clear()
                    st.rerun()
                except Exception as e:
                    st.error(f"อัปโหลดรูปไม่ได้: {e}")

        with st.form(f"edit_product_form_{edit_sel}"):
            e_name = st.text_input("ชื่อสินค้า", value=edit_sel)
            e1, e2 = st.columns(2)
            _e_cur_cat = str(edit_row.get("category") or "")
            _e_cat_opts = [""] + ALL_CATEGORIES
            if _e_cur_cat and _e_cur_cat not in _e_cat_opts:
                _e_cat_opts.append(_e_cur_cat)
            e_category = e1.selectbox(
                "หมวดหมู่", _e_cat_opts, index=_e_cat_opts.index(_e_cur_cat),
                format_func=lambda c: c or "(ไม่ระบุ)",
            )
            e_slug = e2.text_input(
                "Slug (สำหรับลิงก์สั่งของโดยตรง)", value=str(edit_row.get("slug") or ""),
                help="ใช้สร้างลิงก์สั่งของตรงจากหน้า order-links.html เช่น ใส่ bt11 ไว้ว่างได้",
            )
            # Supabase stores active as the string "TRUE"/"FALSE", not a real bool —
            # bool("FALSE") is truthy in Python, so compare the string explicitly.
            e_active = st.checkbox("เปิดขาย (ไม่ติ๊ก = ปิดการขาย/หมด)", value=str(edit_row.get("active") or "").strip().upper() != "FALSE")
            e3, e4 = st.columns(2)
            # Supabase's catalog table names the pack-cost column cost_p, not cost_pack
            e_cost_box = e3.number_input("ต้นทุน/กล่อง", min_value=0.0, value=_num(edit_row.get("cost_box")), step=1.0)
            e_cost_pack = e4.number_input("ต้นทุน/ซอง", min_value=0.0, value=_num(edit_row.get("cost_p")), step=1.0)
            e5, e6 = st.columns(2)
            e_price_box = e5.number_input("ราคาขาย/กล่อง", min_value=0.0, value=_num(edit_row.get("price_box")), step=1.0)
            e_price_pack = e6.number_input("ราคาขาย/ซอง", min_value=0.0, value=_num(edit_row.get("price_pack")), step=1.0)
            e7, e8 = st.columns(2)
            e_limit_box = e7.number_input("จำนวนที่ขายออนไลน์ได้ (กล่อง)", min_value=0.0, value=_num(edit_row.get("limit_box")), step=1.0)
            e_limit_pack = e8.number_input("จำนวนที่ขายออนไลน์ได้ (ซอง)", min_value=0.0, value=_num(edit_row.get("limit_pack")), step=1.0)
            e_packs_per_box = st.number_input(
                "จำนวนซองต่อกล่อง (ใช้ตอน \"เบิกกล่องแยกเป็นซอง\" ในฟอร์มเบิกสินค้า)",
                min_value=0.0, value=_num(edit_row.get("packs_per_box")), step=1.0,
                help="เว้นว่าง/0 = ยังไม่ได้ตั้งค่า — เบิกกล่องแยกเป็นซองสินค้านี้ไม่ได้จนกว่าจะตั้งค่านี้",
            )
            e_barcode = st.text_input("บาร์โค้ด", value=str(edit_row.get("barcode") or ""))
            e_image_url = st.text_input("ลิงก์รูปภาพ", value=preview_image_url)
            e_notice = st.text_area("ข้อความแจ้งเตือนในสินค้า (notice)", value=str(edit_row.get("notice") or ""))
            submitted_e = st.form_submit_button("บันทึกการแก้ไข")
            if submitted_e:
                try:
                    payload = {
                        "_action": "updateProduct", "name": edit_sel, "id": edit_row.get("id") or None,
                        "category": e_category.strip(), "active": e_active,
                        "cost_box": e_cost_box, "cost_pack": e_cost_pack,
                        "price_box": e_price_box, "price_pack": e_price_pack,
                        "limit_box": e_limit_box, "limit_pack": e_limit_pack,
                        "packs_per_box": e_packs_per_box,
                        "barcode": e_barcode.strip(), "slug": e_slug.strip(), "image_url": e_image_url.strip(),
                        "notice": e_notice.strip(),
                    }
                    # Only send new_name when it actually changed — sending it
                    # unconditionally would trigger the rename path (which
                    # touches stock_branch too) on every no-op edit.
                    if e_name.strip() and e_name.strip() != edit_sel:
                        payload["new_name"] = e_name.strip()
                    gas_post(payload)
                    st.session_state.pop(f"edit_product_image_url_{edit_sel}", None)
                    _flash(f"แก้ไข \"{edit_sel}\" แล้ว")
                    st.cache_data.clear()
                    st.rerun()
                except Exception as e:
                    st.error(f"บันทึกไม่ได้: {e}")

        with st.expander("🗑️ ลบสินค้า"):
            st.caption(
                "ลบถาวร ลบไม่ได้ถ้ายังมีสต็อกเหลือ (คลังกลางหรือสาขาใดก็ตาม) — "
                "เคลียร์สต็อกให้เป็น 0 ก่อน หรือถ้าแค่ต้องการหยุดขาย ให้ไปติ๊กออก \"เปิดขาย\" แทน"
            )
            confirm_del = st.checkbox(f'ยืนยันลบ "{edit_sel}" ถาวร', key=f"confirm_del_product_{edit_sel}")
            if st.button("🗑️ ลบสินค้านี้ถาวร", key=f"del_product_btn_{edit_sel}", disabled=not confirm_del):
                try:
                    gas_post({"_action": "deleteProduct", "name": edit_sel, "id": edit_row.get("id") or None})
                    st.session_state.pop(f"edit_product_image_url_{edit_sel}", None)
                    _flash(f"ลบ \"{edit_sel}\" แล้ว")
                    st.cache_data.clear()
                    st.rerun()
                except Exception as e:
                    st.error(f"ลบไม่ได้: {e}")

with tab_categories:
    desc_map = {k[len(CAT_DESC_PREFIX):]: v for k, v in _cat_cfg.items() if k.startswith(CAT_DESC_PREFIX)}
    all_cats = ALL_CATEGORIES
    counts = catalog["category"].value_counts().to_dict() if not catalog.empty else {}

    st.caption("แก้ไขชื่อ/คำอธิบายในตารางได้เลย ลบแถวเพื่อลบหมวดหมู่ เพิ่มแถวว่างด้านล่างเพื่อเพิ่มหมวดหมู่ใหม่ แล้วกดบันทึก")

    cat_table = pd.DataFrame([
        {"หมวดหมู่": c, "จำนวนสินค้า": int(counts.get(c, 0)), "คำอธิบาย": desc_map.get(c, "")}
        for c in all_cats
    ])
    edited_cats = st.data_editor(
        cat_table,
        use_container_width=True,
        hide_index=True,
        num_rows="dynamic",
        column_config={
            "หมวดหมู่": st.column_config.TextColumn("หมวดหมู่", required=True),
            "จำนวนสินค้า": st.column_config.NumberColumn("จำนวนสินค้า", disabled=True),
            "คำอธิบาย": st.column_config.TextColumn("คำอธิบาย"),
        },
        key="cat_editor",
    )

    if st.button("บันทึก", key="save_categories_btn"):
        try:
            # แถวเดิม (index 0..len(all_cats)-1): ถ้าหายไปจากตาราง = ลบ, ถ้าชื่อ
            # เปลี่ยน = ย้ายสินค้าทุกชิ้นไปหมวดใหม่ (ไม่ใช่ลบ+เพิ่มใหม่ เพื่อไม่ให้
            # สินค้าหลุดหมวด) — st.data_editor คง index เดิมไว้ให้แถวที่ยังอยู่
            for orig_idx, orig_name in enumerate(all_cats):
                if orig_idx not in edited_cats.index:
                    if counts.get(orig_name):
                        get_supabase().table("catalog").update(
                            {"category": ""}
                        ).eq("category", orig_name).execute()
                    get_supabase().table("config").delete().eq(
                        "key", f"{CAT_DESC_PREFIX}{orig_name}"
                    ).execute()
                    continue
                new_name = str(edited_cats.loc[orig_idx, "หมวดหมู่"] or "").strip()
                new_desc = str(edited_cats.loc[orig_idx, "คำอธิบาย"] or "").strip()
                if not new_name:
                    continue
                if new_name != orig_name:
                    if counts.get(orig_name):
                        get_supabase().table("catalog").update(
                            {"category": new_name}
                        ).eq("category", orig_name).execute()
                    get_supabase().table("config").delete().eq(
                        "key", f"{CAT_DESC_PREFIX}{orig_name}"
                    ).execute()
                get_supabase().table("config").upsert({
                    "key": f"{CAT_DESC_PREFIX}{new_name}", "value": new_desc,
                }).execute()

            # แถวใหม่ที่พิมพ์เพิ่มท้ายตาราง (index เกินช่วงเดิม)
            for idx, row in edited_cats.iterrows():
                if idx < len(all_cats):
                    continue
                name = str(row["หมวดหมู่"] or "").strip()
                if not name:
                    continue
                desc = str(row["คำอธิบาย"] or "").strip()
                get_supabase().table("config").upsert({
                    "key": f"{CAT_DESC_PREFIX}{name}", "value": desc,
                }).execute()

            _flash("บันทึกแล้ว")
            st.cache_data.clear()
            st.rerun()
        except Exception as e:
            st.error(f"บันทึกไม่ได้: {e}")
