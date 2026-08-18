#!/usr/bin/env python3
"""Stock Dashboard — central warehouse stock, per-branch stock, transfer history"""

import base64
import json
import os
import re
import sys
from datetime import date, timedelta
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
WITHDRAW_REASONS = ["", "เบิกขายออนไลน์", "ส่งให้สปอนเซอร์", "จัดกิจกรรม", "ชำรุด", "เบิกกล่องแยกเป็นซอง", "อื่นๆ"]


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


@st.cache_data(ttl=30)
def load_config() -> dict:
    rows = get_supabase().table("config").select("key,value").execute().data
    return {r["key"]: (r.get("value") or "") for r in rows}


def drive_thumbnail_url(url: str) -> str:
    """catalog.image_url is stored as a Drive share link
    (.../file/d/{id}/view?usp=sharing), which an <img> tag can't render —
    convert to the thumbnail endpoint, same as products.py's version."""
    url = str(url or "")
    if not url:
        return ""
    m = re.search(r"/d/([a-zA-Z0-9_-]+)", url)
    if m:
        return f"https://drive.google.com/thumbnail?id={m.group(1)}&sz=w800"
    return url


def df_to_csv_bytes(df: pd.DataFrame) -> bytes:
    return df.to_csv(index=False).encode("utf-8-sig")


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

CAT_DESC_PREFIX = "category_desc_"
_cat_cfg = load_config()
_product_cats = sorted(set(catalog["category"].dropna().tolist())) if not catalog.empty else []
_product_cats = [c for c in _product_cats if c]
ALL_CATEGORIES = sorted(set(_product_cats) | {k[len(CAT_DESC_PREFIX):] for k in _cat_cfg if k.startswith(CAT_DESC_PREFIX)})

low_stock = pd.DataFrame()
if not catalog.empty:
    low_stock = catalog[
        (pd.to_numeric(catalog["limit_box"], errors="coerce").fillna(0) > 0)
        & (pd.to_numeric(catalog["qty_box"], errors="coerce").fillna(0)
           <= pd.to_numeric(catalog["limit_box"], errors="coerce").fillna(0))
    ]

stock_value = 0.0
stock_cost = 0.0
if not catalog.empty:
    stock_value = (
        pd.to_numeric(catalog.get("price_box", 0), errors="coerce").fillna(0)
        * pd.to_numeric(catalog.get("qty_box", 0), errors="coerce").fillna(0)
        + pd.to_numeric(catalog.get("price_pack", 0), errors="coerce").fillna(0)
        * pd.to_numeric(catalog.get("qty_pack", 0), errors="coerce").fillna(0)
    ).sum()
    stock_cost = (
        pd.to_numeric(catalog.get("cost_box", 0), errors="coerce").fillna(0)
        * pd.to_numeric(catalog.get("qty_box", 0), errors="coerce").fillna(0)
        + pd.to_numeric(catalog.get("cost_p", 0), errors="coerce").fillna(0)
        * pd.to_numeric(catalog.get("qty_pack", 0), errors="coerce").fillna(0)
    ).sum()

k1, k2, k3, k4, k5 = st.columns(5)
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
with k5:
    st.markdown(kpi_card("ทุนคลังกลาง (฿)", f"฿{stock_cost:,.0f}"), unsafe_allow_html=True)

st.markdown("<div style='height:16px'></div>", unsafe_allow_html=True)

tab_central, tab_receive, tab_branch, tab_history = st.tabs(
    ["คลังกลาง", "รับสินค้าเข้าคลัง", "สต็อกสาขา", "ประวัติการโอน"]
)

@st.dialog("➕ เพิ่ม/ลด สต็อกคลังกลาง")
def _adjust_central_stock_dialog():
    names = catalog["name"].tolist() if not catalog.empty else []
    name_to_id = dict(zip(catalog["name"], catalog.get("id", ""))) if not catalog.empty else {}
    with st.form("add_stock_form"):
        sel_name = st.selectbox("สินค้า", names)
        st.caption("สำหรับแก้ไขยอดนับที่ผิดพลาดเท่านั้น — ถ้าซื้อสินค้าเข้าคลัง ใช้ปุ่ม \"🧾 บันทึกรับสินค้าเข้าคลัง\" ในแท็บ \"รับสินค้าเข้าคลัง\" แทน ถ้าจะเบิกออกไปขาย/แจก/ทำตัวอย่าง ใช้ปุ่ม \"เบิกของจากคลังกลาง\"")
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
                    payload = {
                        "_action": "addStock", "name": sel_name, "id": name_to_id.get(sel_name) or None,
                        "add_box": add_box, "add_pack": add_pack,
                    }
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
    # สินค้า/เหตุผล อยู่นอก form โดยตั้งใจ (เหมือน "คืนสต็อกจากสาขากลับคลังกลาง"
    # ด้านล่าง) — widget ใน st.form ไม่ trigger rerun จนกว่าจะกด submit ปุ่มเดียว
    # เหตุผลต้องอยู่นอกด้วย เพราะเลือก "เบิกกล่องแยกเป็นซอง" แล้วต้องสลับความหมาย
    # ของฟอร์มทันที (จากเบิกซองออก → กรอกจำนวนซองที่ได้จากการแกะ)
    wc_name = st.selectbox("สินค้า", names, key="wc_name_sel")

    cur_row = pd.DataFrame()
    if not catalog.empty:
        cur_row = catalog[catalog["name"] == wc_name]
    max_box = int(pd.to_numeric(cur_row["qty_box"], errors="coerce").fillna(0).iloc[0]) if not cur_row.empty else 0
    max_pack = int(pd.to_numeric(cur_row["qty_pack"], errors="coerce").fillna(0).iloc[0]) if not cur_row.empty else 0
    st.caption(f"คงเหลือคลังกลาง: กล่อง {max_box} · ซอง {max_pack}")

    wc_reason = st.selectbox("เหตุผล", WITHDRAW_REASONS, index=WITHDRAW_REASONS.index("เบิกขายออนไลน์"), key="wc_reason_sel")
    is_convert = wc_reason == "เบิกกล่องแยกเป็นซอง"
    per_box = int(pd.to_numeric(cur_row["packs_per_box"], errors="coerce").fillna(0).iloc[0]) if not cur_row.empty and "packs_per_box" in cur_row.columns else 0
    wc_id = cur_row.iloc[0]["id"] if not cur_row.empty and "id" in cur_row.columns else None

    if is_convert:
        if per_box <= 0:
            st.warning('สินค้านี้ยังไม่ได้ตั้งค่า "จำนวนซองต่อกล่อง" — ไปตั้งค่าที่หน้า "สินค้า" → แก้ไขสินค้า ก่อน')
        else:
            # อยู่นอก st.form โดยตั้งใจ — widget ใน form ไม่ sync ค่ากลับมาที่ script
            # จนกว่าจะกด submit ปุ่มเดียว ถ้าเอาไว้ในฟอร์ม พรีวิว "จะได้ซองเพิ่ม"
            # จะค้างเป็น 0 ตลอดจนกว่าจะกดปุ่มแปลงจริงๆ (บั๊กที่เจอ — เห็น "1 กล่อง
            # = 20 ซอง แต่จะได้ซองเพิ่ม: 0" ทั้งที่พิมพ์ 1 ไปแล้ว)
            wc_qty_box = st.number_input("แกะกี่กล่อง", min_value=0, max_value=max(max_box, 0), value=0, step=1, key=f"wc_qty_box_convert_{wc_name}")
            st.caption(f"1 กล่อง = {per_box} ซอง · จะได้ซองเพิ่ม: {wc_qty_box * per_box}")
            if st.button("แปลง"):
                if wc_qty_box <= 0:
                    st.warning("ใส่จำนวนกล่องที่จะแกะก่อน")
                else:
                    try:
                        gas_post({
                            "_action": "convertBoxToPack", "name": wc_name, "id": wc_id or None,
                            "qty_box": wc_qty_box,
                        })
                        _flash(f"แปลง {wc_name} {wc_qty_box} กล่อง → {wc_qty_box * per_box} ซอง แล้ว")
                        st.cache_data.clear()
                        st.rerun()
                    except Exception as e:
                        st.error(f"บันทึกไม่ได้: {e}")
    else:
        with st.form("withdraw_central_stock_form"):
            wc1, wc2 = st.columns(2)
            wc_qty_box = wc1.number_input("เบิกกล่อง", min_value=0, max_value=max(max_box, 0), value=0, step=1, key=f"wc_qty_box_{wc_name}")
            wc_qty_pack = wc2.number_input("เบิกซอง", min_value=0, max_value=max(max_pack, 0), value=0, step=1, key=f"wc_qty_pack_{wc_name}")
            wc_reason_other = st.text_input("ระบุเหตุผล (กรณีเลือก \"อื่นๆ\")", placeholder="เช่น คืนของชำรุดให้ผู้ผลิต")
            wc_submitted = st.form_submit_button("บันทึก")
            if wc_submitted:
                if wc_qty_box <= 0 and wc_qty_pack <= 0:
                    st.warning("ใส่จำนวนที่จะเบิกอย่างน้อย 1 ช่องก่อน")
                else:
                    final_reason = wc_reason_other.strip() if wc_reason == "อื่นๆ" and wc_reason_other.strip() else wc_reason
                    try:
                        gas_post({
                            "_action": "withdrawCentralStock", "name": wc_name, "id": wc_id or None,
                            "qty_box": wc_qty_box, "qty_pack": wc_qty_pack, "reason": final_reason,
                        })
                        _flash("เบิกของแล้ว + แจ้งทีมงานแล้ว")
                        st.cache_data.clear()
                        st.rerun()
                    except Exception as e:
                        st.error(f"บันทึกไม่ได้: {e}")


@st.dialog("🚚 สร้างล็อตส่งสาขา", width="large")
def _create_shipment_dialog():
    ship_branch = st.selectbox("สาขาปลายทาง", BRANCHES, key="ship_branch_sel")
    ship_name_to_id = dict(zip(catalog["name"], catalog.get("id", ""))) if not catalog.empty else {}

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
                "name": row["สินค้า"], "id": ship_name_to_id.get(row["สินค้า"]) or None,
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
            ship_items.append({"name": name, "id": ship_name_to_id.get(name) or None, "qty_box": eb, "qty_pack": ep, "qty_box_extra": 0, "qty_pack_extra": 0})

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


@st.dialog("🧾 บันทึกรับสินค้าเข้าคลัง", width="large")
def _receive_stock_dialog():
    # mode อยู่นอก form โดยตั้งใจ (เหมือนจุดอื่นในไฟล์นี้) — เปลี่ยนโหมดต้อง
    # สลับหน้าตาฟอร์มทั้งชุดทันที ซึ่ง widget ใน st.form ไม่ trigger rerun
    # จนกว่าจะกด submit ปุ่มเดียว
    mode = st.radio("สินค้า", ["สินค้าที่มีอยู่แล้ว", "+ เพิ่มสินค้าใหม่"], horizontal=True, key="rs_mode")

    supplier = st.text_input("ผู้ขาย/ร้านค้า", key="rs_supplier")
    doc_no = st.text_input("เลขที่เอกสาร/ใบกำกับภาษี", key="rs_doc_no")
    notes = st.text_input("หมายเหตุ (ถ้ามี)", key="rs_notes")

    st.caption(
        "บันทึกนี้เป็นการบันทึกค่าใช้จ่าย/ใบสั่งซื้อ (และสร้างสินค้าใหม่ถ้าเลือกโหมดนั้น) เท่านั้น "
        "— สต็อกคลังกลางจะยังไม่เพิ่มจนกว่าจะกด \"รับของเข้าคลัง\" ในแท็บ \"รับสินค้าเข้าคลัง\" ด้านล่างตอนของมาถึงจริง"
    )

    items_payload = []
    running_total = 0.0

    if mode == "สินค้าที่มีอยู่แล้ว":
        all_names = catalog["name"].tolist() if not catalog.empty else []
        name_to_row = {r["name"]: r for r in catalog.to_dict("records")} if not catalog.empty else {}
        sel_names = st.multiselect("เลือกสินค้าที่ซื้อเข้า", all_names, key="rs_products")
        st.caption("ทุน/หน่วย เว้นว่างไม่ต้องแก้ก็ได้ — ระบบใช้ต้นทุนปัจจุบันของสินค้านั้นให้อัตโนมัติ ถ้าแก้ จะอัปเดตต้นทุนสินค้าตัวนั้นให้เป็นราคาล่าสุดด้วย")

        for name in sel_names:
            row = name_to_row.get(name, {})
            cur_cost_box = float(row.get("cost_box") or 0)
            cur_cost_pack = float(row.get("cost_p") or 0)
            st.markdown(f"**{name}**")
            c1, c2, c3, c4 = st.columns(4)
            qb = c1.number_input("กล่อง", min_value=0, value=0, step=1, key=f"rs_qb_{name}")
            qp = c2.number_input("ซอง", min_value=0, value=0, step=1, key=f"rs_qp_{name}")
            cb = c3.number_input("ทุน/กล่อง", min_value=0.0, value=cur_cost_box, step=1.0, key=f"rs_cb_{name}")
            cp = c4.number_input("ทุน/ซอง", min_value=0.0, value=cur_cost_pack, step=1.0, key=f"rs_cp_{name}")
            if qb > 0 or qp > 0:
                running_total += qb * cb + qp * cp
                items_payload.append({
                    "name": name, "id": row.get("id") or None,
                    "qty_box": qb, "qty_pack": qp, "cost_box": cb, "cost_pack": cp,
                })
    else:
        new_count = st.number_input("จำนวนสินค้าใหม่ในใบนี้", min_value=1, value=1, step=1, key="rs_new_count")
        st.caption("จำนวนที่ซื้อเข้าจะยังไม่เข้าคลัง — ระบบจะสร้างสินค้าไว้ก่อน แล้วต้องกด \"รับของเข้าคลัง\" ทีหลังเหมือนสินค้าที่มีอยู่แล้ว")
        new_products = []
        for i in range(int(new_count)):
            with st.expander(f"สินค้าใหม่ #{i + 1}", expanded=True):
                img_file = st.file_uploader("รูปสินค้า", type=["jpg", "jpeg", "png", "webp"], key=f"rs_new_img_{i}")
                if img_file is not None:
                    st.image(img_file, width=160)
                    if st.button("📤 อัปโหลดรูปนี้", key=f"rs_upload_img_btn_{i}"):
                        try:
                            b64 = base64.b64encode(img_file.getvalue()).decode("ascii")
                            res = gas_post({
                                "_action": "uploadProductImage",
                                "base64": b64,
                                "mimeType": img_file.type or "image/jpeg",
                                "filename": img_file.name,
                            })
                            st.session_state[f"rs_new_image_url_{i}"] = res.get("url", "")
                            st.success("อัปโหลดรูปแล้ว — ลิงก์เติมในช่องด้านล่างให้แล้ว")
                        except Exception as e:
                            st.error(f"อัปโหลดรูปไม่ได้: {e}")
                uploaded_url = st.session_state.get(f"rs_new_image_url_{i}", "")

                new_name = st.text_input("ชื่อสินค้า", key=f"rs_new_name_{i}")
                n1, n2 = st.columns(2)
                new_category = n1.selectbox("หมวดหมู่", [""] + ALL_CATEGORIES, format_func=lambda c: c or "(ไม่ระบุ)", key=f"rs_new_category_{i}")
                new_slug = n2.text_input("Slug (สำหรับลิงก์สั่งของโดยตรง, ถ้ามี)", key=f"rs_new_slug_{i}")
                n3, n4 = st.columns(2)
                new_cost_box = n3.number_input("ต้นทุน/กล่อง", min_value=0.0, value=0.0, step=1.0, key=f"rs_new_cost_box_{i}")
                new_cost_pack = n4.number_input("ต้นทุน/ซอง", min_value=0.0, value=0.0, step=1.0, key=f"rs_new_cost_pack_{i}")
                n5, n6 = st.columns(2)
                new_price_box = n5.number_input("ราคาขาย/กล่อง", min_value=0.0, value=0.0, step=1.0, key=f"rs_new_price_box_{i}")
                new_price_pack = n6.number_input("ราคาขาย/ซอง", min_value=0.0, value=0.0, step=1.0, key=f"rs_new_price_pack_{i}")
                n7, n8 = st.columns(2)
                new_qty_box = n7.number_input("จำนวนที่ซื้อเข้า (กล่อง)", min_value=0, value=0, step=1, key=f"rs_new_qty_box_{i}")
                new_qty_pack = n8.number_input("จำนวนที่ซื้อเข้า (ซอง)", min_value=0, value=0, step=1, key=f"rs_new_qty_pack_{i}")
                n9, n10 = st.columns(2)
                new_limit_box = n9.number_input("จำนวนที่ขายออนไลน์ได้ (กล่อง)", min_value=0, value=0, step=1, key=f"rs_new_limit_box_{i}")
                new_limit_pack = n10.number_input("จำนวนที่ขายออนไลน์ได้ (ซอง)", min_value=0, value=0, step=1, key=f"rs_new_limit_pack_{i}")
                new_packs_per_box = st.number_input(
                    "จำนวนซองต่อกล่อง (ใช้ตอน \"เบิกกล่องแยกเป็นซอง\" ในฟอร์มเบิกสินค้า, ถ้ามี)",
                    min_value=0.0, value=0.0, step=1.0, key=f"rs_new_packs_per_box_{i}",
                )
                new_barcode = st.text_input("บาร์โค้ด (ถ้ามี)", key=f"rs_new_barcode_{i}")
                new_image_url = st.text_input(
                    "ลิงก์รูปภาพ", value=uploaded_url,
                    help="อัปโหลดรูปด้านบนแล้วลิงก์จะเติมให้อัตโนมัติ หรือวางลิงก์เองก็ได้", key=f"rs_new_image_url_input_{i}",
                )

                running_total += new_qty_box * new_cost_box + new_qty_pack * new_cost_pack
                new_products.append({
                    "name": new_name.strip(), "category": new_category.strip(), "slug": new_slug.strip(),
                    "cost_box": new_cost_box, "cost_pack": new_cost_pack,
                    "price_box": new_price_box, "price_pack": new_price_pack,
                    "qty_box": new_qty_box, "qty_pack": new_qty_pack,
                    "limit_box": new_limit_box, "limit_pack": new_limit_pack,
                    "packs_per_box": new_packs_per_box,
                    "barcode": new_barcode.strip(), "image_url": new_image_url.strip(),
                })

    st.markdown(f"**ยอดรวมประมาณการ: ฿{running_total:,.0f}**")

    paid_in_full = st.checkbox("จ่ายเต็มจำนวนแล้ว", value=True, key="rs_paid_full")
    deposit = None
    if not paid_in_full:
        deposit = st.number_input(
            "จ่ายมัดจำ/จ่ายแล้วจริง (บาท)", min_value=0.0, value=0.0, step=1.0, key="rs_deposit",
        )
        st.caption(f"ยอดค้างชำระโดยประมาณ: ฿{max(0.0, running_total - deposit):,.0f}")

    if st.button("💾 บันทึกรับสินค้าเข้าคลัง", type="primary", key="rs_submit"):
        if mode == "สินค้าที่มีอยู่แล้ว":
            if not items_payload:
                st.warning("เลือกสินค้าและใส่จำนวนอย่างน้อย 1 รายการก่อน")
                return
            try:
                payload = {
                    "_action": "recordPurchase",
                    "supplier": supplier.strip(), "doc_no": doc_no.strip(), "notes": notes.strip(),
                    "items": items_payload,
                }
                if not paid_in_full:
                    payload["amount_paid"] = deposit
                gas_post(payload)
                _flash("บันทึกรับสินค้าเข้าคลังแล้ว")
                st.cache_data.clear()
                st.rerun()
            except Exception as e:
                st.error(f"บันทึกไม่ได้: {e}")
        else:
            if not new_products:
                st.warning("เพิ่มสินค้าอย่างน้อย 1 รายการก่อน")
                return
            names_seen = set()
            for p in new_products:
                if not p["name"]:
                    st.warning("กรอกชื่อสินค้าให้ครบทุกรายการก่อน")
                    return
                if not catalog.empty and p["name"] in catalog["name"].values:
                    st.error(f"มีสินค้าชื่อ \"{p['name']}\" อยู่แล้ว — ถ้าจะซื้อสินค้านี้เข้าคลัง ใช้โหมด \"สินค้าที่มีอยู่แล้ว\" แทน")
                    return
                if p["name"] in names_seen:
                    st.error(f"ชื่อสินค้า \"{p['name']}\" ซ้ำกันในใบเดียวกัน — ตั้งชื่อให้ไม่ซ้ำ")
                    return
                names_seen.add(p["name"])
                if p["qty_box"] <= 0 and p["qty_pack"] <= 0:
                    st.warning(f"ใส่จำนวนที่ซื้อเข้าของ \"{p['name']}\" อย่างน้อย 1 ช่องก่อน")
                    return

            created_items = []
            created_names = []
            try:
                for p in new_products:
                    res = gas_post({
                        "_action": "addProduct",
                        "name": p["name"], "category": p["category"], "slug": p["slug"],
                        "cost_box": p["cost_box"], "cost_pack": p["cost_pack"],
                        "price_box": p["price_box"], "price_pack": p["price_pack"],
                        "initial_box": 0, "initial_pack": 0,
                        "limit_box": p["limit_box"], "limit_pack": p["limit_pack"],
                        "packs_per_box": p["packs_per_box"],
                        "barcode": p["barcode"], "image_url": p["image_url"],
                    })
                    created_names.append(res.get("name") or p["name"])
                    created_items.append({
                        "name": res.get("name") or p["name"], "id": res.get("id"),
                        "qty_box": p["qty_box"], "qty_pack": p["qty_pack"],
                        "cost_box": p["cost_box"], "cost_pack": p["cost_pack"],
                    })
            except Exception as e:
                done_text = ("สร้างสำเร็จแล้ว: " + ", ".join(created_names) + " — ") if created_names else ""
                st.error(
                    done_text + f"สร้างสินค้าไม่สำเร็จ: {e} — "
                    "สินค้าที่สร้างสำเร็จแล้วสามารถบันทึกรับเข้าคลังได้จากโหมด \"สินค้าที่มีอยู่แล้ว\" ส่วนที่เหลือลองสร้างใหม่อีกครั้ง"
                )
                return

            try:
                payload = {
                    "_action": "recordPurchase",
                    "supplier": supplier.strip(), "doc_no": doc_no.strip(), "notes": notes.strip(),
                    "items": created_items,
                }
                if not paid_in_full:
                    payload["amount_paid"] = deposit
                gas_post(payload)
                _flash(f"สร้างสินค้า {', '.join(created_names)} และบันทึกรับเข้าคลังแล้ว")
                for i in range(int(new_count)):
                    st.session_state.pop(f"rs_new_image_url_{i}", None)
                st.cache_data.clear()
                st.rerun()
            except Exception as e:
                st.error(
                    f"สร้างสินค้า {', '.join(created_names)} แล้ว แต่บันทึกรายการซื้อไม่สำเร็จ: {e} — "
                    "ลองกด \"บันทึกรับสินค้าเข้าคลัง\" อีกครั้งโดยเลือกสินค้าเหล่านี้จากโหมด \"สินค้าที่มีอยู่แล้ว\" แทน"
                )


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

        show = catalog_show[["name", "category", "qty_box", "qty_pack", "limit_box", "limit_pack", "active"]].copy()
        show["id"] = catalog_show["id"] if "id" in catalog_show.columns else ""
        show["slug"] = catalog_show["slug"] if "slug" in catalog_show.columns else ""
        # NULL limit_box/limit_pack render as a literal "None" placeholder once
        # the column becomes editable — 0 means "no low-stock threshold set",
        # same meaning as NULL for _low_stock() below, so this is a safe default.
        show["limit_box"] = pd.to_numeric(show["limit_box"], errors="coerce").fillna(0)
        show["limit_pack"] = pd.to_numeric(show["limit_pack"], errors="coerce").fillna(0)
        show["active"] = show["active"].apply(lambda v: str(v or "").strip().upper() != "FALSE")

        def _low_stock(r):
            if not r["active"]:
                return ""
            if _safe_int(r["limit_box"]) > 0 and _safe_int(r["qty_box"]) <= _safe_int(r["limit_box"]):
                return "⚠️ ใกล้หมด"
            return ""

        show["แจ้งเตือน"] = show.apply(_low_stock, axis=1)
        show = show.rename(columns={
            "id": "รหัสสินค้า", "name": "สินค้า", "slug": "Slug", "category": "หมวดหมู่", "qty_box": "กล่อง", "qty_pack": "ซอง",
            "limit_box": "ขายออนไลน์ได้ (กล่อง)", "limit_pack": "ขายออนไลน์ได้ (ซอง)",
        })
        show = show.sort_values("รหัสสินค้า", kind="stable")
        show = show[["รหัสสินค้า", "สินค้า", "Slug", "หมวดหมู่", "กล่อง", "ซอง", "ขายออนไลน์ได้ (กล่อง)", "ขายออนไลน์ได้ (ซอง)", "แจ้งเตือน"]]

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

        cap_col, save_col, refresh_col = st.columns([5, 1, 1])
        with cap_col:
            st.caption(
                "แก้ไข กล่อง / ซอง / ขายออนไลน์ได้ ในตารางได้เลย แล้วกดบันทึก — เลขกล่อง/ซองที่แก้เป็นยอดสต็อกใหม่ทั้งหมด "
                "ไม่ใช่จำนวนที่เพิ่ม, ขายออนไลน์ได้ = จำนวนที่ลูกค้ายังสั่งออนไลน์ได้ ลดลงทุกครั้งที่มีออเดอร์ (0 = ปิดขายออนไลน์)"
            )
        # ปุ่มบันทึกอยู่ที่ตำแหน่งนี้ (ข้างๆ ก่อนรีเฟรช) แต่ต้องรอผลจาก data_editor
        # ด้านล่างก่อนถึงจะรู้ว่ามีอะไรถูกแก้บ้าง — สร้าง placeholder ไว้ก่อน
        # แล้วค่อยเรียก .button() ใส่ตำแหน่งเดิมทีหลัง ตัว widget จะยังโผล่ตรงนี้
        # เหมือนเดิมแม้โค้ดที่สร้างมันรันทีหลัง (Streamlit วาดตาม container ไม่ใช่
        # ลำดับโค้ด)
        save_slot = save_col.empty()
        with refresh_col:
            if st.button("🔄 รีเฟรช", key=f"refresh_catalog_btn_{cat_sel}", use_container_width=True):
                st.session_state.pop(snap_key, None)
                st.cache_data.clear()
                st.rerun()
        edited = st.data_editor(
            show,
            use_container_width=True,
            hide_index=True,
            height=int((len(show) + 1) * 35 + 3),
            disabled=["รหัสสินค้า", "สินค้า", "Slug", "หมวดหมู่", "แจ้งเตือน"],
            column_config={
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

        if save_slot.button("บันทึก", key=f"save_catalog_btn_{cat_sel}", use_container_width=True):
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

                    if limit_changed:
                        gas_post({
                            "_action": "updateProduct", "name": prod_name,
                            "limit_box": new_limit_box, "limit_pack": new_limit_pack,
                        })

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

with tab_receive:
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

    rk1, rk2, rk3, rk4, rk5 = st.columns(5)
    with rk1:
        st.markdown(kpi_card("ซื้อเข้าวันนี้ (฿)", f"฿{today_cost:,.0f}"), unsafe_allow_html=True)
    with rk2:
        st.markdown(kpi_card("ซื้อเข้าเดือนนี้ (฿)", f"฿{month_cost:,.0f}"), unsafe_allow_html=True)
    with rk3:
        st.markdown(kpi_card("จำนวนครั้งเดือนนี้", month_count), unsafe_allow_html=True)
    with rk4:
        st.markdown(
            kpi_card("ยอดค้างชำระรวม (฿)", f"฿{outstanding_total:,.0f}", DANGER_TEXT if outstanding_total > 0 else TEXT2),
            unsafe_allow_html=True,
        )
    with rk5:
        st.markdown(
            kpi_card("รอรับของเข้าคลัง", pending_receipt, DANGER_TEXT if pending_receipt > 0 else TEXT2),
            unsafe_allow_html=True,
        )

    st.markdown("<div style='height:12px'></div>", unsafe_allow_html=True)
    if st.button("🧾 บันทึกรับสินค้าเข้าคลัง", type="primary"):
        _receive_stock_dialog()

    st.markdown("<div style='height:16px'></div>", unsafe_allow_html=True)

    tab_receive_history, tab_receive_report = st.tabs(["ประวัติการรับเข้า", "รายงานรับเข้า"])

    with tab_receive_history:
        rf1, rf2, rf3 = st.columns(3)
        with rf1:
            rh_from = st.date_input("จากวันที่", value=today - timedelta(days=30), key="rh_from")
        with rf2:
            rh_to = st.date_input("ถึงวันที่", value=today, key="rh_to")
        with rf3:
            rh_suppliers = sorted(s for s in purchases.get("supplier", pd.Series(dtype=str)).dropna().unique().tolist() if s) if not purchases.empty else []
            rh_supplier_filter = st.selectbox("ผู้ขาย", ["ทั้งหมด"] + rh_suppliers, key="rh_supplier")

        rhist = purchases
        if not rhist.empty:
            rhist = rhist[(rhist["date"] >= rh_from) & (rhist["date"] <= rh_to)]
            if rh_supplier_filter != "ทั้งหมด":
                rhist = rhist[rhist["supplier"] == rh_supplier_filter]

        if rhist.empty:
            st.caption("ไม่มีรายการรับเข้าในช่วงที่เลือก")
        else:
            rhist = rhist.sort_values("timestamp_dt", ascending=False)

            def _rp_status(r):
                if r["outstanding"] <= 0:
                    return "จ่ายครบ"
                if r["amount_paid"] > 0:
                    return "มัดจำ"
                return "ค้างชำระทั้งหมด"

            def _rp_items_text(ij):
                parts = []
                for it in parse_items(ij):
                    qb, qp = it.get("qty_box") or 0, it.get("qty_pack") or 0
                    unit = (f"{qb} กล่อง" if qb else "") + (f" {qp} ซอง" if qp else "")
                    parts.append(f"{it.get('name','')} x{unit.strip()}")
                return ", ".join(parts)

            rh_display = pd.DataFrame({
                "เลขที่": rhist["purchase_id"],
                "วันที่": rhist["date"],
                "ผู้ขาย": rhist.get("supplier", ""),
                "เอกสาร": rhist.get("doc_no", ""),
                "รายการสินค้า": rhist["items_json"].apply(_rp_items_text),
                "ยอดรวม": rhist["total_cost"],
                "จ่ายแล้ว": rhist["amount_paid"],
                "ค้างชำระ": rhist["outstanding"],
                "สถานะจ่ายเงิน": rhist.apply(_rp_status, axis=1),
                "สถานะรับของ": rhist.get("status", "รอสินค้า"),
                "พนักงาน": rhist.get("staff_name", ""),
            })
            st.dataframe(rh_display, use_container_width=True, hide_index=True)
            st.download_button(
                "⬇️ ดาวน์โหลดประวัติการรับเข้า (CSV)", df_to_csv_bytes(rh_display),
                file_name=f"waka_purchases_{rh_from}_{rh_to}.csv", mime="text/csv",
            )

            rh_pending = rhist[rhist.get("status", "รอสินค้า") == "รอสินค้า"]
            if not rh_pending.empty:
                st.markdown("<div style='height:12px'></div>", unsafe_allow_html=True)
                with st.expander(f"📥 รับของเข้าคลัง ({len(rh_pending)} ใบรอของ)", expanded=True):
                    for _, r in rh_pending.iterrows():
                        rc1, rc2 = st.columns([4, 1])
                        with rc1:
                            st.markdown(
                                f"**{r['purchase_id']}** — {r.get('supplier') or 'ไม่ระบุผู้ขาย'} — "
                                + _rp_items_text(r["items_json"]) + " — "
                                + badge(f"฿{r['total_cost']:,.0f}", "pending"),
                                unsafe_allow_html=True,
                            )
                        with rc2:
                            if st.button("📥 รับของแล้ว", key=f"recv_purchase_btn_{r['purchase_id']}", use_container_width=True):
                                try:
                                    gas_post({"_action": "receivePurchase", "purchase_id": r["purchase_id"]})
                                    _flash(f"รับของเข้าคลังแล้ว — {r['purchase_id']}")
                                    st.cache_data.clear()
                                    st.rerun()
                                except Exception as e:
                                    st.error(f"บันทึกไม่ได้: {e}")
                        st.markdown("<hr style='margin:8px 0'>", unsafe_allow_html=True)

            rh_unpaid = rhist[rhist["outstanding"] > 0]
            if not rh_unpaid.empty:
                st.markdown("<div style='height:12px'></div>", unsafe_allow_html=True)
                with st.expander(f"💳 บันทึกจ่ายเงินเพิ่ม ({len(rh_unpaid)} รายการค้างชำระ)"):
                    for _, r in rh_unpaid.iterrows():
                        st.markdown(
                            f"**{r['purchase_id']}** — {r.get('supplier') or 'ไม่ระบุผู้ขาย'} — "
                            + badge(f"ค้างชำระ ฿{r['outstanding']:,.0f}", "danger"),
                            unsafe_allow_html=True,
                        )
                        pc1, pc2 = st.columns([3, 1])
                        rp_add_amt = pc1.number_input(
                            "จำนวนที่จ่ายเพิ่ม (บาท)", min_value=0.0, max_value=float(r["outstanding"]),
                            value=0.0, step=1.0, key=f"rp_pay_add_{r['purchase_id']}",
                        )
                        if pc2.button("บันทึก", key=f"rp_pay_btn_{r['purchase_id']}"):
                            if rp_add_amt <= 0:
                                st.warning("ใส่จำนวนเงินก่อน")
                            else:
                                try:
                                    gas_post({
                                        "_action": "recordPurchasePayment",
                                        "purchase_id": r["purchase_id"], "add_amount": rp_add_amt,
                                    })
                                    _flash("บันทึกการจ่ายเงินแล้ว")
                                    st.cache_data.clear()
                                    st.rerun()
                                except Exception as e:
                                    st.error(f"บันทึกไม่ได้: {e}")
                        st.markdown("<hr style='margin:8px 0'>", unsafe_allow_html=True)

    with tab_receive_report:
        rr1, rr2 = st.columns(2)
        with rr1:
            rr_from = st.date_input("จากวันที่", value=today.replace(day=1), key="rr_from")
        with rr2:
            rr_to = st.date_input("ถึงวันที่", value=today, key="rr_to")

        rrep = purchases
        if not rrep.empty:
            rrep = rrep[(rrep["date"] >= rr_from) & (rrep["date"] <= rr_to)]

        if rrep.empty:
            st.caption("ไม่มีข้อมูลในช่วงที่เลือก")
        else:
            st.markdown("**รายงานรายวัน**")
            rr_by_day = rrep.groupby("date")["total_cost"].sum()
            st.bar_chart(rr_by_day)
            rr_daily_tbl = (
                rrep.groupby("date").agg(ยอดซื้อ=("total_cost", "sum"), จำนวนครั้ง=("purchase_id", "count"))
                .reset_index().rename(columns={"date": "วันที่"})
            )
            st.dataframe(rr_daily_tbl, use_container_width=True, hide_index=True)
            st.download_button(
                "⬇️ ดาวน์โหลดรายงานรายวัน (CSV)", df_to_csv_bytes(rr_daily_tbl),
                file_name=f"waka_purchases_daily_{rr_from}_{rr_to}.csv", mime="text/csv", key="rr_dl_daily",
            )

            st.markdown("<div style='height:16px'></div>", unsafe_allow_html=True)
            st.markdown("**รายงานรายเดือน**")
            rr_by_month = rrep.groupby("month")["total_cost"].sum()
            st.bar_chart(rr_by_month)
            rr_monthly_tbl = (
                rrep.groupby("month").agg(ยอดซื้อ=("total_cost", "sum"), จำนวนครั้ง=("purchase_id", "count"))
                .reset_index().rename(columns={"month": "เดือน"})
            )
            st.dataframe(rr_monthly_tbl, use_container_width=True, hide_index=True)
            st.download_button(
                "⬇️ ดาวน์โหลดรายงานรายเดือน (CSV)", df_to_csv_bytes(rr_monthly_tbl),
                file_name=f"waka_purchases_monthly_{rr_from}_{rr_to}.csv", mime="text/csv", key="rr_dl_monthly",
            )

            st.markdown("<div style='height:16px'></div>", unsafe_allow_html=True)
            st.markdown("**แยกตามผู้ขาย**")
            rr_by_supplier = (
                rrep.assign(ผู้ขาย=rrep.get("supplier", pd.Series(dtype=str)).fillna("ไม่ระบุ").replace("", "ไม่ระบุ"))
                .groupby("ผู้ขาย").agg(ยอดซื้อ=("total_cost", "sum"), จำนวนครั้ง=("purchase_id", "count"))
                .reset_index().sort_values("ยอดซื้อ", ascending=False)
            )
            st.dataframe(rr_by_supplier, use_container_width=True, hide_index=True)

with tab_branch:
    branch_name_to_id = dict(zip(catalog["name"], catalog.get("id", ""))) if not catalog.empty else {}

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

        st.caption("กล่อง / ซอง ต่อสาขา")

        if sb_branch_sel == "ทุกสาขา":
            def _fmt_cell(box, pack):
                box, pack = _safe_int(box), _safe_int(pack)
                return "—" if box == 0 and pack == 0 else f"{box} / {pack}"

            pivot = {}
            for _, r in sb_show.iterrows():
                pivot.setdefault(r.get("name", ""), {})[r.get("branch", "")] = _fmt_cell(r.get("qty_box"), r.get("qty_pack"))

            pivot_df = pd.DataFrame([
                {"สินค้า": name, **{b: cells.get(b, "—") for b in BRANCHES}}
                for name, cells in sorted(pivot.items())
            ]).set_index("สินค้า")

            if pivot_df.empty:
                st.caption("ไม่มีสินค้าตรงตัวกรองนี้")
            else:
                st.table(pivot_df)
            st.caption('เลือกสาขาใดสาขาหนึ่ง (ไม่ใช่ "ทุกสาขา") เพื่อแก้ไขจำนวนในตารางได้โดยตรง')
        else:
            # แก้ไขได้ตรงในตารางเฉพาะตอนเลือกสาขาเดียว — โหมด "ทุกสาขา" เป็นข้อความ
            # รวม "กล่อง / ซอง" ของหลายสาขาไว้ในช่องเดียว ไม่ใช่ตัวเลขที่แก้ตรงๆ ได้
            branch_raw = {}
            for _, r in sb_show[sb_show["branch"] == sb_branch_sel].iterrows():
                branch_raw[r.get("name", "")] = {"กล่อง": _safe_int(r.get("qty_box")), "ซอง": _safe_int(r.get("qty_pack"))}
            edit_base = pd.DataFrame([
                {"สินค้า": name, **vals} for name, vals in sorted(branch_raw.items())
            ])

            if edit_base.empty:
                st.caption("ไม่มีสินค้าตรงตัวกรองนี้")
            else:
                # freeze base ไว้คงที่ตลอด "เซสชันแก้ไข" หนึ่งรอบต่อ branch/cat_sel —
                # เหตุผลเดียวกับ snapshot ของตาราง "จัดการสต็อกคลังกลาง" ด้านบน:
                # data_editor จำ edit ตามตำแหน่งแถว ถ้า base เปลี่ยนลำดับระหว่างที่
                # ยังแก้ไม่เสร็จ (cache หมดอายุ ฯลฯ) edit จะไปเข้าแถวผิดตัวเงียบๆ
                snap_key = f"_branch_stock_snapshot_{sb_branch_sel}_{sb_cat_sel}"
                if snap_key not in st.session_state:
                    st.session_state[snap_key] = edit_base
                edit_base = st.session_state[snap_key]

                cap_col, save_col, refresh_col = st.columns([5, 1, 1])
                with cap_col:
                    st.caption("แก้ไขจำนวนกล่อง/ซองในตารางได้เลย แล้วกดบันทึก — เลขที่แก้เป็นยอดใหม่ทั้งหมด ไม่ใช่จำนวนที่เพิ่ม")
                save_slot = save_col.empty()
                with refresh_col:
                    if st.button("🔄 รีเฟรช", key=f"refresh_branch_stock_btn_{sb_branch_sel}_{sb_cat_sel}", use_container_width=True):
                        st.session_state.pop(snap_key, None)
                        st.cache_data.clear()
                        st.rerun()
                edited = st.data_editor(
                    edit_base,
                    use_container_width=True,
                    hide_index=True,
                    height=int((len(edit_base) + 1) * 35 + 3),
                    disabled=["สินค้า"],
                    column_config={
                        "สินค้า": st.column_config.TextColumn(width="large"),
                        "กล่อง": st.column_config.NumberColumn("กล่อง", min_value=0, step=1, width="small"),
                        "ซอง": st.column_config.NumberColumn("ซอง", min_value=0, step=1, width="small"),
                    },
                    key=f"branch_stock_editor_{sb_branch_sel}_{sb_cat_sel}",
                )

                if save_slot.button("บันทึก", key=f"save_branch_stock_btn_{sb_branch_sel}_{sb_cat_sel}", use_container_width=True):
                    try:
                        for idx in edit_base.index:
                            orig_row = edit_base.loc[idx]
                            new_row = edited.loc[idx]
                            prod_name = orig_row["สินค้า"]
                            delta_box = _safe_int(new_row["กล่อง"]) - _safe_int(orig_row["กล่อง"])
                            delta_pack = _safe_int(new_row["ซอง"]) - _safe_int(orig_row["ซอง"])
                            if delta_box != 0 or delta_pack != 0:
                                gas_post({
                                    "_action": "adjustBranchStock", "branch": sb_branch_sel, "name": prod_name,
                                    "id": branch_name_to_id.get(prod_name) or None,
                                    "add_box": delta_box, "add_pack": delta_pack,
                                })
                        _flash("บันทึกแล้ว")
                        st.session_state.pop(snap_key, None)
                        st.cache_data.clear()
                        st.rerun()
                    except Exception as e:
                        st.error(f"บันทึกไม่ได้: {e}")

    with st.expander("➖ เบิก / ปรับสต็อกสาขา"):
        names_b = sorted(stock_branch["name"].unique().tolist()) if not stock_branch.empty else []
        name_to_pb = dict(zip(catalog["name"], catalog.get("packs_per_box", pd.Series(dtype=float)))) if not catalog.empty else {}
        # สินค้า/checkbox อยู่นอก form โดยตั้งใจ — ต้องโชว์อัตราส่วนซอง/กล่องของ
        # สินค้าที่เลือกและสลับหน้าตาฟอร์มทันทีที่ติ๊ก ซึ่ง widget ใน st.form
        # ไม่ trigger rerun จนกว่าจะกด submit ปุ่มเดียว
        wb1, wb2 = st.columns(2)
        w_branch = wb1.selectbox("สาขา", BRANCHES, key="w_branch_sel")
        w_name = wb2.selectbox("สินค้า", names_b, key="w_name_sel")
        w_convert = st.checkbox("🔁 เบิกกล่องแยกเป็นซอง (แทนที่จะเบิกออกจากระบบจริง)", key="w_convert_chk")
        w_per_box = int(pd.to_numeric(name_to_pb.get(w_name), errors="coerce")) if pd.notna(pd.to_numeric(name_to_pb.get(w_name), errors="coerce")) else 0
        if w_convert and w_per_box <= 0:
            st.warning('สินค้านี้ยังไม่ได้ตั้งค่า "จำนวนซองต่อกล่อง" — ไปตั้งค่าที่หน้า "สินค้า" → แก้ไขสินค้า ก่อน')

        if w_convert:
            if w_per_box > 0:
                # อยู่นอก st.form โดยตั้งใจ — widget ใน form ไม่ sync ค่ากลับมาที่
                # script จนกว่าจะกด submit ปุ่มเดียว พรีวิว "จะได้ซองเพิ่ม" เลย
                # ต้องอยู่นอกฟอร์มด้วย ไม่งั้นจะค้างเป็น 0 จนกว่าจะกดปุ่มแปลงจริง
                # (บั๊กเดียวกับที่เจอในฝั่งคลังกลาง)
                w_qty = st.number_input("แกะกี่กล่อง", min_value=1, value=1, step=1, key=f"w_qty_convert_{w_name}")
                st.caption(f"1 กล่อง = {w_per_box} ซอง · จะได้ซองเพิ่ม: {w_qty * w_per_box}")
                if st.button("แปลง"):
                    try:
                        gas_post({
                            "_action": "convertBoxToPack", "branch": w_branch, "name": w_name,
                            "id": branch_name_to_id.get(w_name) or None,
                            "qty_box": w_qty,
                        })
                        _flash(f"แปลง {w_name} {w_qty} กล่อง → {w_qty * w_per_box} ซอง ที่สาขา {w_branch} แล้ว")
                        st.cache_data.clear()
                        st.rerun()
                    except Exception as e:
                        st.error(f"แปลงไม่ได้: {e}")
        else:
            with st.form("withdraw_stock_form"):
                wb3, wb4 = st.columns(2)
                w_type = wb3.radio("หน่วย", ["box", "pack"], format_func=lambda t: "กล่อง" if t == "box" else "ซอง", horizontal=True)
                w_qty = wb4.number_input("จำนวน", min_value=1, value=1, step=1, key=f"w_qty_{w_name}")
                w_reason = st.text_input("เหตุผล", placeholder="เช่น สินค้าเสียหาย, ปรับยอดนับสต็อก")
                submitted_w = st.form_submit_button("บันทึก")
                if submitted_w:
                    try:
                        gas_post({
                            "_action": "withdrawStock", "branch": w_branch, "name": w_name,
                            "id": branch_name_to_id.get(w_name) or None,
                            "type": w_type, "qty": w_qty, "reason": w_reason,
                        })
                        _flash("บันทึกแล้ว")
                        st.cache_data.clear()
                        st.rerun()
                    except Exception as e:
                        st.error(f"บันทึกไม่ได้: {e}")

    with st.expander("✏️ ปรับยอดนับสต็อกสาขา (นับจริงไม่ตรงกับระบบ)"):
        names_a = sorted(stock_branch["name"].unique().tolist()) if not stock_branch.empty else []
        ab1, ab2 = st.columns(2)
        a_branch = ab1.selectbox("สาขา", BRANCHES, key="a_branch_sel")
        a_name = ab2.selectbox("สินค้า", names_a, key="a_name_sel")

        a_cur = pd.DataFrame()
        if not stock_branch.empty:
            a_cur = stock_branch[(stock_branch["branch"] == a_branch) & (stock_branch["name"] == a_name)]
        a_cur_box = int(pd.to_numeric(a_cur["qty_box"], errors="coerce").fillna(0).iloc[0]) if not a_cur.empty else 0
        a_cur_pack = int(pd.to_numeric(a_cur["qty_pack"], errors="coerce").fillna(0).iloc[0]) if not a_cur.empty else 0
        st.caption(f"ยอดในระบบตอนนี้: กล่อง {a_cur_box} · ซอง {a_cur_pack}")

        # อยู่นอก st.form ทั้งหมดโดยตั้งใจ (เหมือนจุดอื่นในไฟล์นี้) — พรีวิว
        # "ยอดหลังปรับ" ต้องอัปเดตทันทีตามที่พิมพ์ ถ้าอยู่ใน form จะค้างค่าเก่า
        # จนกว่าจะกด submit (บั๊กเดียวกับที่เจอในฟอร์มแปลงกล่อง→ซองด้านบน)
        ab3, ab4 = st.columns(2)
        a_add_box = ab3.number_input("กล่อง (+/-)", value=0, step=1, key=f"a_add_box_{a_branch}_{a_name}")
        a_add_pack = ab4.number_input("ซอง (+/-)", value=0, step=1, key=f"a_add_pack_{a_branch}_{a_name}")
        st.caption(f"ยอดหลังปรับ: กล่อง {max(a_cur_box + a_add_box, 0)} · ซอง {max(a_cur_pack + a_add_pack, 0)}")
        a_reason = st.selectbox("เหตุผล", ADJUST_REASONS, key="a_reason_sel")
        if st.button("บันทึกยอดปรับ"):
            if a_add_box == 0 and a_add_pack == 0:
                st.warning("ใส่จำนวนที่จะปรับก่อน")
            else:
                try:
                    payload = {
                        "_action": "adjustBranchStock", "branch": a_branch, "name": a_name,
                        "id": branch_name_to_id.get(a_name) or None,
                        "add_box": a_add_box, "add_pack": a_add_pack,
                    }
                    if a_reason:
                        payload["reason"] = a_reason
                    gas_post(payload)
                    _flash("ปรับยอดสต็อกสาขาแล้ว")
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
                            "id": branch_name_to_id.get(r_name) or None,
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

