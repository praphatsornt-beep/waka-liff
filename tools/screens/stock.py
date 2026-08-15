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
    apply_theme, badge, page_header, kpi_card, admin_name,
    TEXT2, DANGER_TEXT,
)

GAS_URL  = "https://script.google.com/macros/s/AKfycbz52wvADM7O1zMjqKlT2G4HPkq8gwAon_fUCuKgbmUMkDPQkaYKUWnv598U3EkFN1AByQ/exec"
WAKA_S   = "wk26xK9mPqRt"  # shared secret doPost/doGet require via ?_s= (same value as tournament.py's WAKA_S)
ADMIN_CODE = "waka99"  # withdrawStock now also requires this to prove branch ownership, same as
                        # liff/app.html's admin bypass — Streamlit is an admin-only tool

BRANCHES = ["ต้นสักคอร์เนอร์", "เมืองทองธานี", "ศรีนครินทร์"]
ADJUST_REASONS = ["", "ซื้อเข้า", "แก้ไขยอดผิด", "อื่นๆ"]
WITHDRAW_REASONS = ["", "ขายออนไลน์", "ของชำรุด", "ตัวอย่าง/โชว์", "ส่งให้สปอนเซอร์", "อื่นๆ"]


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
def load_stock_branch() -> pd.DataFrame:
    rows = get_supabase().table("stock_branch").select("*").execute().data
    return pd.DataFrame(rows)


@st.cache_data(ttl=60)
def load_shipments() -> pd.DataFrame:
    rows = get_supabase().table("shipments").select("*").order("timestamp", desc=True).execute().data
    return pd.DataFrame(rows)


NOT_YET_SHIPPED = {"กำลังจัดส่งไปสาขา", "พร้อมรับ", "สาขายืนยัน", "รับแล้ว", "จัดส่งแล้ว"}


@st.cache_data(ttl=30)
def load_pending_branch_demand() -> dict:
    """Mirrors gas/Code.gs's `branch_summary` action: qty still owed to each
    branch from confirmed orders that haven't been shipped/handed over yet."""
    rows = (
        get_supabase().table("orders").select("branch,slip_status,fulfillment,items_json")
        .eq("slip_status", "ยืนยัน").execute().data
    )
    demand: dict = {}
    for r in rows:
        if (r.get("fulfillment") or "") in NOT_YET_SHIPPED:
            continue
        branch = r.get("branch") or ""
        for i in parse_items(r.get("items_json")):
            key = (branch, i.get("name", ""))
            d = demand.setdefault(key, {"qty_box": 0, "qty_pack": 0, "order_count": 0})
            qty = i.get("qty", 1) or 1
            if i.get("type") == "box":
                d["qty_box"] += qty
            else:
                d["qty_pack"] += qty
            d["order_count"] += 1
    return demand


def _safe_int(v, default: int = 0) -> int:
    """int(pd.to_numeric(v, errors='coerce') or 0) crashes on a genuine NaN —
    NaN is truthy in Python, so `or 0` never kicks in and int(nan) raises
    ValueError. Hit this via a data_editor NumberColumn cell cleared to blank
    (e.g. ขายออนไลน์ได้ (กล่อง)/(ซอง), which are nullable and user-editable)."""
    n = pd.to_numeric(v, errors="coerce")
    return int(n) if pd.notna(n) else default


def parse_items(items_json) -> list:
    if isinstance(items_json, list):
        return items_json
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


def status_kind(s: str) -> str:
    if s == "รับแล้ว":
        return "success"
    if s == "ยกเลิก":
        return "danger"
    return "pending"


# st.success() called right before st.rerun() never reaches the screen — the
# rerun wipes it before the browser paints, so the person clicking "บันทึก"
# sees nothing happen and clicks again (creating duplicate shipments/etc).
# Stash the message in session_state instead and show it as a toast on the
# NEXT run, after the state that already changed.
def _flash(msg: str) -> None:
    st.session_state["_flash_msg"] = msg


# ── Page ──────────────────────────────────────────────────────────────────────
apply_theme()
page_header("คลังสินค้าและสาขา", "คลังกลาง สต็อกสาขา และประวัติการโอน")

if "_flash_msg" in st.session_state:
    st.toast(st.session_state.pop("_flash_msg"), icon="✅")

catalog = load_catalog()
stock_branch = load_stock_branch()

low_stock = pd.DataFrame()
if not catalog.empty:
    low_stock = catalog[
        (pd.to_numeric(catalog["limit_box"], errors="coerce").fillna(0) > 0)
        & (pd.to_numeric(catalog["qty_box"], errors="coerce").fillna(0)
           <= pd.to_numeric(catalog["limit_box"], errors="coerce").fillna(0))
    ]

stock_value = 0.0
if not catalog.empty:
    stock_value = (
        pd.to_numeric(catalog.get("price_box", 0), errors="coerce").fillna(0)
        * pd.to_numeric(catalog.get("qty_box", 0), errors="coerce").fillna(0)
        + pd.to_numeric(catalog.get("price_pack", 0), errors="coerce").fillna(0)
        * pd.to_numeric(catalog.get("qty_pack", 0), errors="coerce").fillna(0)
    ).sum()

k1, k2, k3, k4 = st.columns(4)
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
with k4:
    st.markdown(kpi_card("มูลค่าสต็อกคลังกลาง (฿)", f"฿{stock_value:,.0f}"), unsafe_allow_html=True)

st.markdown("<div style='height:16px'></div>", unsafe_allow_html=True)

tab_central, tab_branch, tab_history = st.tabs(
    ["คลังกลาง", "สต็อกสาขา", "ประวัติการโอน"]
)

@st.dialog("➕ เพิ่ม/ลด สต็อกคลังกลาง")
def _adjust_central_stock_dialog():
    names = catalog["name"].tolist() if not catalog.empty else []
    with st.form("add_stock_form"):
        sel_name = st.selectbox("สินค้า", names)
        st.caption("สำหรับซื้อสินค้าเข้าคลัง หรือแก้ไขยอดนับที่ผิดพลาดเท่านั้น — ถ้าจะเบิกออกไปขาย/แจก/ทำตัวอย่าง ใช้ปุ่ม \"เบิกของจากคลังกลาง\" แทน")
        c1, c2 = st.columns(2)
        add_box = c1.number_input("กล่อง (+/-)", value=0, step=1)
        add_pack = c2.number_input("ซอง (+/-)", value=0, step=1)
        reason = st.selectbox("เหตุผล", ADJUST_REASONS)
        submitted = st.form_submit_button("บันทึก")
        if submitted:
            if add_box == 0 and add_pack == 0:
                st.warning("ใส่จำนวนที่จะปรับก่อน")
            else:
                try:
                    payload = {"_action": "addStock", "name": sel_name, "add_box": add_box, "add_pack": add_pack}
                    if reason:
                        payload["reason"] = reason
                    gas_post(payload)
                    _flash("ปรับสต็อกแล้ว")
                    st.cache_data.clear()
                    st.rerun()
                except Exception as e:
                    st.error(f"บันทึกไม่ได้: {e}")


@st.dialog("➖ เบิกของจากคลังกลาง")
def _withdraw_central_stock_dialog():
    names = catalog["name"].tolist() if not catalog.empty else []
    with st.form("withdraw_central_stock_form"):
        wc_name = st.selectbox("สินค้า", names)
        wc1, wc2 = st.columns(2)
        wc_type = wc1.radio("หน่วย", ["box", "pack"], format_func=lambda t: "กล่อง" if t == "box" else "ซอง", horizontal=True)
        wc_qty = wc2.number_input("จำนวน", min_value=1, value=1, step=1)
        wc_reason = st.selectbox("เหตุผล", WITHDRAW_REASONS, index=WITHDRAW_REASONS.index("ขายออนไลน์"))
        wc_submitted = st.form_submit_button("บันทึก")
        if wc_submitted:
            try:
                gas_post({
                    "_action": "withdrawCentralStock", "name": wc_name,
                    "type": wc_type, "qty": wc_qty, "reason": wc_reason,
                })
                _flash("เบิกของแล้ว + แจ้งทีมงานแล้ว")
                st.cache_data.clear()
                st.rerun()
            except Exception as e:
                st.error(f"บันทึกไม่ได้: {e}")


@st.dialog("🚚 สร้างล็อตส่งสาขา", width="large")
def _create_shipment_dialog():
    ship_branch = st.selectbox("สาขาปลายทาง", BRANCHES, key="ship_branch_sel")

    # Snapshot demand ONCE per branch selection instead of re-deriving it from
    # load_pending_branch_demand() (ttl=30 cache) on every rerun. The table's
    # row order below is `sorted(demand)` — if the cache refreshes mid-edit
    # (very plausible; typing a few "เผื่อ" values easily takes >30s) and the
    # underlying order set changed even slightly, product names can shift
    # row position between reruns. Streamlit's data_editor reapplies stored
    # edits by row POSITION, not by product name, so a shifted row silently
    # inherits someone else's edit while the row the user actually typed into
    # reverts to its fresh default (0) — this was reported as "เผื่อ กลายเป็น 0
    # ตอนจะบันทึก". Freezing the snapshot for the duration of one branch
    # selection keeps row identity stable regardless of what the cache does
    # in the background.
    if st.session_state.get("_ship_demand_branch") != ship_branch:
        st.session_state["_ship_demand_branch"] = ship_branch
        st.session_state["_ship_demand_snapshot"] = {
            name: d for (branch, name), d in load_pending_branch_demand().items() if branch == ship_branch
        }
    demand = st.session_state["_ship_demand_snapshot"]

    ship_items = []
    demand_edited = pd.DataFrame()
    if demand:
        st.caption(
            "ออเดอร์รอส่งไปสาขานี้ — ติ๊ก \"ส่ง\" เฉพาะรายการที่จะส่งรอบนี้ "
            "\"ออเดอร์\" คือยอดที่ลูกค้าสั่งไว้แล้ว (แก้ไม่ได้) ใส่ \"เผื่อ\" เพื่อเพิ่มสำหรับขายหน้าร้าน "
            "\"รวม\" คือยอดที่จะส่งจริง คำนวณให้อัตโนมัติ"
        )
        editor_key = f"ship_demand_editor_{ship_branch}"
        # IMPORTANT: "ส่ง"/"เผื่อ" are real user-editable widget cells — their
        # base value in the dataframe passed to data_editor must stay FIXED
        # (False / 0) on every rerun. Earlier this baked the last-known edited
        # value back into that same base cell every render; once the cell's
        # base matched its own edited value, data_editor saw "no difference
        # from base" and dropped it from edited_rows — so the very next
        # interaction (ticking a different row, editing another cell) wiped
        # every prior edit back to the fixed default. Only "รวม" (a disabled,
        # non-interactive column WE compute) is safe to rebuild from
        # edited_rows each render; "เผื่อ"/"ส่ง" must rely purely on
        # data_editor's own key-based persistence against a stable base.
        raw_edits = st.session_state.get(editor_key, {}).get("edited_rows", {})
        edit_state = {int(k): v for k, v in raw_edits.items()}

        rows = []
        for idx, name in enumerate(sorted(demand)):
            d = demand[name]
            ord_box, ord_pack = int(d["qty_box"]), int(d["qty_pack"])
            row_edits = edit_state.get(idx, {})
            buf_box = _safe_int(row_edits.get("เผื่อ (กล่อง)", 0))
            buf_pack = _safe_int(row_edits.get("เผื่อ (ซอง)", 0))
            rows.append({
                "ส่ง": False, "สินค้า": name,
                "ออเดอร์ (กล่อง)": ord_box, "ออเดอร์ (ซอง)": ord_pack,
                "เผื่อ (กล่อง)": 0, "เผื่อ (ซอง)": 0,
                "รวม (กล่อง)": ord_box + buf_box, "รวม (ซอง)": ord_pack + buf_pack,
                "จำนวนออเดอร์": d["order_count"],
            })
        demand_df = pd.DataFrame(rows)
        demand_edited = st.data_editor(
            demand_df,
            use_container_width=True,
            hide_index=True,
            disabled=["สินค้า", "ออเดอร์ (กล่อง)", "ออเดอร์ (ซอง)", "รวม (กล่อง)", "รวม (ซอง)", "จำนวนออเดอร์"],
            column_config={
                "ส่ง": st.column_config.CheckboxColumn("ส่ง", width="small"),
                "เผื่อ (กล่อง)": st.column_config.NumberColumn(min_value=0, step=1),
                "เผื่อ (ซอง)": st.column_config.NumberColumn(min_value=0, step=1),
            },
            key=editor_key,
        )
        for _, row in demand_edited.iterrows():
            if not row["ส่ง"]:
                continue
            ship_items.append({
                "name": row["สินค้า"],
                "qty_box": _safe_int(row["รวม (กล่อง)"]),
                "qty_pack": _safe_int(row["รวม (ซอง)"]),
                "qty_box_extra": 0, "qty_pack_extra": 0,
            })
    else:
        st.caption(f"ไม่มีออเดอร์รอส่งไปสาขา {ship_branch} ในตอนนี้ — เลือกสินค้าที่จะส่งเองได้ด้านล่าง")

    all_names = catalog["name"].tolist() if not catalog.empty else []
    extra_names = [n for n in all_names if n not in demand]
    with st.expander("➕ เพิ่มสินค้าอื่นที่ไม่มีออเดอร์ค้าง"):
        extra_sel = st.multiselect("เลือกสินค้า", extra_names, key=f"ship_extra_sel_{ship_branch}")
        for name in extra_sel:
            ec1, ec2 = st.columns(2)
            eb = ec1.number_input(f"{name} — กล่อง", min_value=0, value=0, step=1, key=f"shipextrabox_{ship_branch}_{name}")
            ep = ec2.number_input(f"{name} — ซอง", min_value=0, value=0, step=1, key=f"shipextrapack_{ship_branch}_{name}")
            ship_items.append({"name": name, "qty_box": eb, "qty_pack": ep, "qty_box_extra": 0, "qty_pack_extra": 0})

    if st.button("📦 สร้างล็อตส่งสาขา", key=f"submit_ship_{ship_branch}", type="primary"):
        items_payload = [it for it in ship_items if it["qty_box"] > 0 or it["qty_pack"] > 0]
        if not items_payload:
            st.warning("ใส่จำนวนที่จะส่งอย่างน้อย 1 รายการก่อน")
        else:
            try:
                result = gas_post({"_action": "createShipment", "to_branch": ship_branch, "items": items_payload})
                _flash(f"สร้างล็อต {result.get('shipment_id', '')} แล้ว")
                st.cache_data.clear()
                st.rerun()
            except Exception as e:
                st.error(f"สร้างล็อตไม่ได้: {e}")


with tab_central:
    ac1, ac2, ac3 = st.columns(3)
    with ac1:
        if st.button("➕ เพิ่ม/ลด สต็อกคลังกลาง", use_container_width=True):
            _adjust_central_stock_dialog()

    with ac2:
        if st.button("➖ เบิกของจากคลังกลาง", use_container_width=True):
            _withdraw_central_stock_dialog()

    with ac3:
        if st.button("🚚 สร้างล็อตส่งสาขา", use_container_width=True):
            # Force a fresh demand snapshot every time the dialog is opened —
            # otherwise reopening it for the same branch (e.g. right after
            # creating one lot) would keep showing the old pre-shipment
            # snapshot instead of picking up what's actually still pending.
            st.session_state.pop("_ship_demand_branch", None)
            st.session_state.pop("_ship_demand_snapshot", None)
            _create_shipment_dialog()

    st.markdown("<div style='height:12px'></div>", unsafe_allow_html=True)

    if catalog.empty:
        st.caption("ยังไม่มีข้อมูลสินค้า")
    else:
        cats = ["ทุกหมวดหมู่"] + sorted([c for c in catalog["category"].dropna().unique().tolist() if c])
        cat_sel = st.selectbox("กรองหมวดหมู่", cats, key="central_cat_filter")
        catalog_show = catalog if cat_sel == "ทุกหมวดหมู่" else catalog[catalog["category"] == cat_sel]
        # แสดงแค่สินค้าที่เปิดใช้งาน — ปิดขายไปแล้วไปเปิด/แก้ที่แท็บ "สินค้า" ใน
        # หน้าจัดการสินค้าแทน (มี toggle เปิด/ปิดขายอยู่แล้ว)
        catalog_show = catalog_show[catalog_show["active"].apply(lambda v: str(v or "").strip().upper() != "FALSE")]

        STATUS_ON, STATUS_OFF = "🟢", "🔴"

        show = catalog_show[["name", "category", "qty_box", "qty_pack", "limit_box", "limit_pack", "active"]].copy()
        show["id"] = catalog_show["id"] if "id" in catalog_show.columns else ""
        show["slug"] = catalog_show["slug"] if "slug" in catalog_show.columns else ""
        # NULL limit_box/limit_pack render as a literal "None" placeholder once
        # the column becomes editable — 0 means "no low-stock threshold set",
        # same meaning as NULL for _low_stock() below, so this is a safe default.
        show["limit_box"] = pd.to_numeric(show["limit_box"], errors="coerce").fillna(0)
        show["limit_pack"] = pd.to_numeric(show["limit_pack"], errors="coerce").fillna(0)
        show["active"] = show["active"].apply(lambda v: str(v or "").strip().upper() != "FALSE")
        show["สถานะ"] = show["active"].apply(lambda a: STATUS_ON if a else STATUS_OFF)

        def _low_stock(r):
            if not r["active"]:
                return ""
            if _safe_int(r["limit_box"]) > 0 and _safe_int(r["qty_box"]) <= _safe_int(r["limit_box"]):
                return "⚠️ ใกล้หมด"
            return ""

        show["แจ้งเตือน"] = show.apply(_low_stock, axis=1)
        show = show.sort_values("active", ascending=False, kind="stable")
        show = show.rename(columns={
            "id": "รหัสสินค้า", "name": "สินค้า", "slug": "Slug", "category": "หมวดหมู่", "qty_box": "กล่อง", "qty_pack": "ซอง",
            "limit_box": "ขายออนไลน์ได้ (กล่อง)", "limit_pack": "ขายออนไลน์ได้ (ซอง)",
        })
        show = show[["สถานะ", "รหัสสินค้า", "สินค้า", "Slug", "หมวดหมู่", "กล่อง", "ซอง", "ขายออนไลน์ได้ (กล่อง)", "ขายออนไลน์ได้ (ซอง)", "แจ้งเตือน"]]

        # data_editor เก็บ edit ไว้ตาม "ตำแหน่งแถว" ไม่ใช่ชื่อสินค้า — ถ้า show ที่
        # build ใหม่จาก catalog สดทุก rerun เปลี่ยนลำดับแถวระหว่างที่ยังแก้ไม่เสร็จ
        # (cache หมดอายุ, สินค้าอื่นถูกเปลี่ยน active ทำให้ sort ขยับ ฯลฯ) แถวที่ขยับ
        # จะรับ edit ของแถวอื่นไปแทน ส่วนแถวที่พิมพ์จริงจะเจอ base ใหม่ที่ตรงกับค่าที่
        # พิมพ์อยู่แล้วโดยบังเอิญหรือไม่ตรงเลย แล้วถูกมองว่า "ไม่มีอะไรเปลี่ยน" — กด
        # บันทึกแล้วเงียบๆไม่มีอะไรถูกเขียนจริง (บั๊กเดียวกับที่เจอใน
        # _create_shipment_dialog ด้านบน, เจอจริงกับ BT11 — พิมพ์ 240 กด บันทึก
        # ขึ้น "บันทึกแล้ว" แต่ยอดใน Supabase ไม่ขยับเลย) ต้อง freeze base ไว้คงที่
        # ตลอด "เซสชันแก้ไข" หนึ่งรอบต่อ cat_sel เหมือนที่ทำกับ shipment dialog
        snap_key = f"_catalog_snapshot_{cat_sel}"
        if snap_key not in st.session_state:
            st.session_state[snap_key] = show
        show = st.session_state[snap_key]

        cap_col, refresh_col = st.columns([5, 1])
        with cap_col:
            st.caption(
                "แก้ไข สถานะ / กล่อง / ซอง / ขายออนไลน์ได้ ในตารางได้เลย แล้วกดบันทึก — เลขกล่อง/ซองที่แก้เป็นยอดสต็อกใหม่ทั้งหมด "
                "ไม่ใช่จำนวนที่เพิ่ม, ขายออนไลน์ได้ = จำนวนที่ลูกค้ายังสั่งออนไลน์ได้ ลดลงทุกครั้งที่มีออเดอร์ (0 = ปิดขายออนไลน์)"
            )
        with refresh_col:
            if st.button("🔄 รีเฟรช", key=f"refresh_catalog_btn_{cat_sel}", use_container_width=True):
                st.session_state.pop(snap_key, None)
                st.cache_data.clear()
                st.rerun()
        edited = st.data_editor(
            show,
            use_container_width=True,
            hide_index=True,
            disabled=["รหัสสินค้า", "สินค้า", "Slug", "หมวดหมู่", "แจ้งเตือน"],
            column_config={
                "สถานะ": st.column_config.SelectboxColumn(" ", options=[STATUS_ON, STATUS_OFF], required=True, width="small"),
                "รหัสสินค้า": st.column_config.TextColumn("CODE", width="small"),
                "สินค้า": st.column_config.TextColumn(width="large"),
                "Slug": st.column_config.TextColumn(width="small"),
                "หมวดหมู่": st.column_config.TextColumn(width="small"),
                "กล่อง": st.column_config.NumberColumn("กล่อง", min_value=0, step=1, width="small"),
                "ซอง": st.column_config.NumberColumn("ซอง", min_value=0, step=1, width="small"),
                "ขายออนไลน์ได้ (กล่อง)": st.column_config.NumberColumn(width="small"),
                "ขายออนไลน์ได้ (ซอง)": st.column_config.NumberColumn(width="small"),
                "แจ้งเตือน": st.column_config.TextColumn(width="small"),
            },
            key=f"catalog_editor_{cat_sel}",
        )

        if st.button("บันทึก", key=f"save_catalog_btn_{cat_sel}"):
            try:
                for idx in show.index:
                    orig_row = show.loc[idx]
                    new_row = edited.loc[idx]
                    prod_name = orig_row["สินค้า"]

                    new_limit_box = _safe_int(new_row["ขายออนไลน์ได้ (กล่อง)"])
                    new_limit_pack = _safe_int(new_row["ขายออนไลน์ได้ (ซอง)"])
                    orig_limit_box = _safe_int(orig_row["ขายออนไลน์ได้ (กล่อง)"])
                    orig_limit_pack = _safe_int(orig_row["ขายออนไลน์ได้ (ซอง)"])
                    limit_changed = new_limit_box != orig_limit_box or new_limit_pack != orig_limit_pack

                    if new_row["สถานะ"] != orig_row["สถานะ"] or limit_changed:
                        payload = {"_action": "updateProduct", "name": prod_name}
                        if new_row["สถานะ"] != orig_row["สถานะ"]:
                            payload["active"] = new_row["สถานะ"] == STATUS_ON
                        if limit_changed:
                            payload["limit_box"] = new_limit_box
                            payload["limit_pack"] = new_limit_pack
                        gas_post(payload)

                    # updateProduct ไม่รองรับตั้งค่า qty_box/qty_pack ตรงๆ — ส่งเป็นผลต่าง
                    # (ใหม่ - เดิม) ผ่าน addStock แทน ซึ่งรองรับค่าติดลบอยู่แล้ว
                    delta_box = _safe_int(new_row["กล่อง"]) - _safe_int(orig_row["กล่อง"])
                    delta_pack = _safe_int(new_row["ซอง"]) - _safe_int(orig_row["ซอง"])
                    if delta_box != 0 or delta_pack != 0:
                        gas_post({"_action": "addStock", "name": prod_name, "add_box": delta_box, "add_pack": delta_pack})

                _flash("บันทึกแล้ว")
                st.session_state.pop(snap_key, None)
                st.cache_data.clear()
                st.rerun()
            except Exception as e:
                st.error(f"บันทึกไม่ได้: {e}")

with tab_branch:
    if stock_branch.empty:
        st.caption("ยังไม่มีข้อมูลสต็อกสาขา")
    else:
        # stock_branch.category is written from the shipment's items_json at
        # receive-time, and createShipment never actually populates it — it's
        # blank on effectively every row. catalog.category is the field
        # that's actually kept up to date (edited via "✏️ แก้ไขสินค้า" /
        # "หมวดหมู่สินค้า"), so map through the product name instead of
        # trusting stock_branch's own column.
        name_to_cat = dict(zip(catalog["name"], catalog["category"])) if not catalog.empty else {}

        sbf1, sbf2 = st.columns(2)
        with sbf1:
            sb_branches = ["ทุกสาขา"] + BRANCHES
            sb_branch_sel = st.selectbox("เลือกสาขา", sb_branches, key="branch_stock_branch_filter")
        with sbf2:
            sb_cats = ["ทุกหมวดหมู่"] + sorted(set(c for c in name_to_cat.values() if c))
            sb_cat_sel = st.selectbox("กรองหมวดหมู่", sb_cats, key="branch_cat_filter")

        sb_show = stock_branch
        if sb_cat_sel != "ทุกหมวดหมู่":
            sb_show = sb_show[sb_show["name"].map(name_to_cat) == sb_cat_sel]

        def _fmt_cell(box, pack):
            box, pack = _safe_int(box), _safe_int(pack)
            return "—" if box == 0 and pack == 0 else f"{box} / {pack}"

        pivot = {}
        for _, r in sb_show.iterrows():
            pivot.setdefault(r.get("name", ""), {})[r.get("branch", "")] = _fmt_cell(r.get("qty_box"), r.get("qty_pack"))

        show_branches = BRANCHES if sb_branch_sel == "ทุกสาขา" else [sb_branch_sel]
        pivot_df = pd.DataFrame([
            {"สินค้า": name, **{b: cells.get(b, "—") for b in show_branches}}
            for name, cells in sorted(pivot.items())
            if sb_branch_sel == "ทุกสาขา" or cells.get(sb_branch_sel, "—") != "—"
        ]).set_index("สินค้า")

        st.caption("กล่อง / ซอง ต่อสาขา")
        if pivot_df.empty:
            st.caption("ไม่มีสินค้าตรงตัวกรองนี้")
        else:
            st.table(pivot_df)

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
                    _flash("บันทึกแล้ว")
                    st.cache_data.clear()
                    st.rerun()
                except Exception as e:
                    st.error(f"บันทึกไม่ได้: {e}")

    with st.expander("📤 คืนสต็อกจากสาขากลับคลังกลาง"):
        names_r = sorted(stock_branch["name"].unique().tolist()) if not stock_branch.empty else []

        # สาขา/สินค้า อยู่นอก form โดยตั้งใจ — widget ใน st.form ไม่ trigger rerun
        # จนกว่าจะกด submit ปุ่มเดียว ถ้าเอาไว้ในฟอร์มเดียวกับช่องจำนวน ตอนเปลี่ยน
        # สาขา/สินค้า ค่า max_box/max_pack (จากแถวสต็อกปัจจุบัน) จะยังไม่อัปเดตตาม
        # จนกว่าจะกด submit ไปแล้วรอบนึง — เห็น "มี X" เป็นเลขของสินค้า/สาขาที่
        # เลือกไว้ก่อนหน้า ไม่ใช่ตัวที่กำลังเลือกอยู่ ทำให้กรอกจำนวนจริงไม่ได้เพราะ
        # max_value ยังผูกกับเลขเก่า (บั๊กที่เจอจริง: เลือก BT11 ที่ต้นสัก ซึ่งมี 139
        # กล่อง แต่ฟอร์มยังโชว์ "มี 8" ค้างจากสินค้า/สาขาที่เลือกไว้ก่อนหน้า)
        rb1, rb2 = st.columns(2)
        r_branch = rb1.selectbox("สาขา", BRANCHES, key="return_branch_sel")
        r_name = rb2.selectbox("สินค้า", names_r, key="return_name_sel")

        cur_row = pd.DataFrame()
        if not stock_branch.empty:
            cur_row = stock_branch[(stock_branch["branch"] == r_branch) & (stock_branch["name"] == r_name)]
        max_box = int(pd.to_numeric(cur_row["qty_box"], errors="coerce").fillna(0).iloc[0]) if not cur_row.empty else 0
        max_pack = int(pd.to_numeric(cur_row["qty_pack"], errors="coerce").fillna(0).iloc[0]) if not cur_row.empty else 0

        with st.form("return_stock_form"):
            rb3, rb4 = st.columns(2)
            r_qty_box = rb3.number_input(f"คืนกล่อง (มี {max_box})", min_value=0, max_value=max(max_box, 0), value=0, step=1)
            r_qty_pack = rb4.number_input(f"คืนซอง (มี {max_pack})", min_value=0, max_value=max(max_pack, 0), value=0, step=1)
            submitted_r = st.form_submit_button("คืนสต็อก")
            if submitted_r:
                if r_qty_box <= 0 and r_qty_pack <= 0:
                    st.warning("ใส่จำนวนที่จะคืนก่อน")
                else:
                    try:
                        gas_post({
                            "_action": "returnStock", "branch": r_branch, "name": r_name,
                            "qty_box": r_qty_box, "qty_pack": r_qty_pack,
                        })
                        _flash("คืนสต็อกแล้ว สต็อกกลางได้รับคืนแล้ว")
                        st.cache_data.clear()
                        st.rerun()
                    except Exception as e:
                        st.error(f"คืนสต็อกไม่ได้: {e}")

with tab_history:
    ships = load_shipments()
    if ships.empty:
        st.caption("ยังไม่มีประวัติการโอนสต็อก")
    else:
        for idx, (_, r) in enumerate(ships.iterrows()):
            items = parse_items(r.get("items_json", ""))
            summary = "; ".join(item_summary(i) for i in items)
            shipment_id = r.get("shipment_id", "")
            status = r.get("status", "")
            with st.container(border=True):
                c1, c2 = st.columns([3, 1])
                with c1:
                    st.markdown(f"**{shipment_id}** — 🏬 {r.get('to_branch', '')} · {r.get('timestamp', '')}")
                    st.caption(summary or "—")
                with c2:
                    st.markdown(badge(status, status_kind(status)), unsafe_allow_html=True)

                if status == "จัดส่ง":
                    b1, b2 = st.columns(2)
                    with b1:
                        if st.button("✅ สาขารับของแล้ว", key=f"recv_{shipment_id}_{idx}", use_container_width=True, type="primary"):
                            try:
                                result = gas_post({"_action": "receiveShipment", "shipment_id": shipment_id})
                                _flash("ล็อตนี้รับแล้ว" if result.get("already") else "รับของสำเร็จ! แจ้งลูกค้าแล้ว")
                                st.cache_data.clear()
                                st.rerun()
                            except Exception as e:
                                st.error(f"ทำรายการไม่ได้: {e}")
                    with b2:
                        if st.button("🗑 ยกเลิก", key=f"cancel_{shipment_id}_{idx}", use_container_width=True):
                            try:
                                gas_post({"_action": "cancelShipment", "shipment_id": shipment_id})
                                _flash("ยกเลิกล็อตแล้ว สต็อกกลางได้รับคืนแล้ว")
                                st.cache_data.clear()
                                st.rerun()
                            except Exception as e:
                                st.error(f"ยกเลิกไม่ได้: {e}")
                elif status == "รับแล้ว":
                    st.caption(f"รับเมื่อ: {r.get('received_at', '') or '—'}")

