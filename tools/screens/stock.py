#!/usr/bin/env python3
"""Stock Dashboard — central warehouse stock, per-branch stock, transfer history"""

import base64
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
    apply_theme, badge, page_header, kpi_card,
    TEXT2, DANGER_TEXT,
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
GAS_URL  = "https://script.google.com/macros/s/AKfycbz52wvADM7O1zMjqKlT2G4HPkq8gwAon_fUCuKgbmUMkDPQkaYKUWnv598U3EkFN1AByQ/exec"
WAKA_S   = "wk26xK9mPqRt"  # shared secret doPost/doGet require via ?_s= (same value as tournament.py's WAKA_S)
ADMIN_CODE = "waka99"  # withdrawStock now also requires this to prove branch ownership, same as
                        # liff/app.html's admin bypass — Streamlit is an admin-only tool

BRANCHES = ["ต้นสักคอร์เนอร์", "เมืองทองธานี", "ศรีนครินทร์"]


# ── Auth — shipment history isn't dual-written to Supabase, read the Sheet directly ──
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
    payload = {**payload, "code": ADMIN_CODE}
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


@st.cache_data(ttl=30)
def load_stock_branch() -> pd.DataFrame:
    rows = get_supabase().table("stock_branch").select("*").execute().data
    return pd.DataFrame(rows)


@st.cache_data(ttl=60)
def load_shipments() -> pd.DataFrame:
    try:
        ws = get_gc().open_by_key(SHEET_ID).worksheet("shipments")
        rows = ws.get_all_values()
        if len(rows) < 2:
            return pd.DataFrame()
        df = pd.DataFrame(rows[1:], columns=rows[0])
        return df.iloc[::-1].reset_index(drop=True)  # newest first
    except Exception:
        return pd.DataFrame()


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


# ── Page ──────────────────────────────────────────────────────────────────────
apply_theme()
page_header("สต็อกสินค้า", "คลังกลาง สต็อกสาขา และประวัติการโอน")

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

tab_central, tab_branch, tab_history, tab_new_product, tab_categories = st.tabs(
    ["คลังกลาง", "สต็อกสาขา", "ประวัติการโอน", "🆕 เพิ่มสินค้าใหม่", "🏷️ หมวดหมู่สินค้า"]
)

with tab_central:
    ac1, ac3 = st.columns(2)
    with ac1:
        with st.popover("➕ เพิ่มสต็อกคลังกลาง", use_container_width=True):
            names = catalog["name"].tolist() if not catalog.empty else []
            with st.form("add_stock_form"):
                sel_name = st.selectbox("สินค้า", names)
                c1, c2 = st.columns(2)
                add_box = c1.number_input("เพิ่มกล่อง", min_value=0, value=0, step=1)
                add_pack = c2.number_input("เพิ่มซอง", min_value=0, value=0, step=1)
                submitted = st.form_submit_button("บันทึก")
                if submitted:
                    if add_box <= 0 and add_pack <= 0:
                        st.warning("ใส่จำนวนที่จะเพิ่มก่อน")
                    else:
                        try:
                            gas_post({"_action": "addStock", "name": sel_name, "add_box": add_box, "add_pack": add_pack})
                            st.success("เพิ่มสต็อกแล้ว")
                            st.cache_data.clear()
                            st.rerun()
                        except Exception as e:
                            st.error(f"บันทึกไม่ได้: {e}")

    with ac3:
        with st.popover("🚚 สร้างล็อตส่งสาขา", use_container_width=True):
            ship_branch = st.selectbox("สาขาปลายทาง", BRANCHES, key="ship_branch_sel")
            demand = {name: d for (branch, name), d in load_pending_branch_demand().items() if branch == ship_branch}

            if demand:
                st.caption("ออเดอร์รอส่งไปสาขานี้")
                demand_df = pd.DataFrame([
                    {"สินค้า": name, "รอส่ง (กล่อง)": d["qty_box"], "รอส่ง (ซอง)": d["qty_pack"], "ออเดอร์": d["order_count"]}
                    for name, d in demand.items()
                ]).sort_values("สินค้า")
                st.dataframe(demand_df, use_container_width=True, hide_index=True)
            else:
                st.caption(f"ไม่มีออเดอร์รอส่งไปสาขา {ship_branch} ในตอนนี้ — เลือกสินค้าที่จะส่งเองได้ด้านล่าง")

            all_names = catalog["name"].tolist() if not catalog.empty else []
            default_sel = [n for n in demand if n in all_names]
            sel_products = st.multiselect(
                "เลือกสินค้าที่จะส่ง", all_names, default=default_sel, key=f"ship_sel_{ship_branch}",
            )

            with st.form(f"create_shipment_form_{ship_branch}"):
                ship_items = []
                for name in sel_products:
                    d = demand.get(name, {"qty_box": 0, "qty_pack": 0})
                    sc1, sc2 = st.columns(2)
                    qb = sc1.number_input(f"{name} — กล่อง", min_value=0, value=int(d["qty_box"]), step=1, key=f"shipbox_{ship_branch}_{name}")
                    qp = sc2.number_input(f"{name} — ซอง", min_value=0, value=int(d["qty_pack"]), step=1, key=f"shippack_{ship_branch}_{name}")
                    ship_items.append({"name": name, "qty_box": qb, "qty_pack": qp, "qty_box_extra": 0, "qty_pack_extra": 0})

                submitted_ship = st.form_submit_button("📦 สร้างล็อตส่งสาขา")
                if submitted_ship:
                    items_payload = [it for it in ship_items if it["qty_box"] > 0 or it["qty_pack"] > 0]
                    if not items_payload:
                        st.warning("เลือกสินค้าและใส่จำนวนที่จะส่งก่อน")
                    else:
                        try:
                            result = gas_post({"_action": "createShipment", "to_branch": ship_branch, "items": items_payload})
                            st.success(f"สร้างล็อต {result.get('shipment_id', '')} แล้ว")
                            st.cache_data.clear()
                            st.rerun()
                        except Exception as e:
                            st.error(f"สร้างล็อตไม่ได้: {e}")

    st.markdown("<div style='height:12px'></div>", unsafe_allow_html=True)

    if not catalog.empty:
        cat_summary = (
            catalog.assign(
                qty_box=pd.to_numeric(catalog["qty_box"], errors="coerce").fillna(0),
                category=catalog["category"].fillna("(ไม่ระบุหมวดหมู่)"),
            )
            .groupby("category")
            .agg(สินค้า=("name", "count"), กล่องรวม=("qty_box", "sum"))
            .reset_index()
            .sort_values("category")
        )
        cat_cols = st.columns(min(len(cat_summary), 6) or 1)
        for i, (_, r) in enumerate(cat_summary.iterrows()):
            with cat_cols[i % len(cat_cols)]:
                st.markdown(
                    kpi_card(r["category"], f"{int(r['กล่องรวม']):,} กล่อง · {int(r['สินค้า'])} SKU"),
                    unsafe_allow_html=True,
                )
        st.markdown("<div style='height:12px'></div>", unsafe_allow_html=True)

    if catalog.empty:
        st.caption("ยังไม่มีข้อมูลสินค้า")
    else:
        cats = ["ทุกหมวดหมู่"] + sorted([c for c in catalog["category"].dropna().unique().tolist() if c])
        cat_sel = st.selectbox("กรองหมวดหมู่", cats, key="central_cat_filter")
        catalog_show = catalog if cat_sel == "ทุกหมวดหมู่" else catalog[catalog["category"] == cat_sel]

        STATUS_ON, STATUS_OFF = "🟢 เปิดขาย", "🔴 ปิดการขาย"

        show = catalog_show[["name", "category", "qty_box", "qty_pack", "limit_box", "limit_pack", "active"]].copy()
        show["id"] = catalog_show["id"] if "id" in catalog_show.columns else ""
        show["active"] = show["active"].apply(lambda v: str(v or "").strip().upper() != "FALSE")
        show["สถานะ"] = show["active"].apply(lambda a: STATUS_ON if a else STATUS_OFF)

        def _low_stock(r):
            if not r["active"]:
                return ""
            if (pd.to_numeric(r["limit_box"], errors="coerce") or 0) > 0 \
               and (pd.to_numeric(r["qty_box"], errors="coerce") or 0) <= (pd.to_numeric(r["limit_box"], errors="coerce") or 0):
                return "⚠️ ใกล้หมด"
            return ""

        show["แจ้งเตือน"] = show.apply(_low_stock, axis=1)
        show = show.rename(columns={
            "id": "รหัสสินค้า", "name": "สินค้า", "category": "หมวดหมู่", "qty_box": "กล่อง", "qty_pack": "ซอง",
            "limit_box": "ขั้นต่ำ (กล่อง)", "limit_pack": "ขั้นต่ำ (ซอง)",
        })
        show = show[["สถานะ", "รหัสสินค้า", "สินค้า", "หมวดหมู่", "กล่อง", "ซอง", "ขั้นต่ำ (กล่อง)", "ขั้นต่ำ (ซอง)", "แจ้งเตือน"]]

        edited = st.data_editor(
            show,
            use_container_width=True,
            hide_index=True,
            disabled=["รหัสสินค้า", "สินค้า", "หมวดหมู่", "กล่อง", "ซอง", "ขั้นต่ำ (กล่อง)", "ขั้นต่ำ (ซอง)", "แจ้งเตือน"],
            column_config={"สถานะ": st.column_config.SelectboxColumn("สถานะ", options=[STATUS_ON, STATUS_OFF], required=True)},
            key=f"catalog_editor_{cat_sel}",
        )
        changed = edited[edited["สถานะ"] != show["สถานะ"]]
        if not changed.empty:
            try:
                for _, r in changed.iterrows():
                    gas_post({"_action": "updateProduct", "name": r["สินค้า"], "active": r["สถานะ"] == STATUS_ON})
                st.cache_data.clear()
                st.rerun()
            except Exception as e:
                st.error(f"บันทึกไม่ได้: {e}")

    with st.expander("✏️ แก้ไขสินค้า"):
        edit_names = sorted(catalog["name"].tolist()) if not catalog.empty else []
        edit_sel = st.selectbox("เลือกสินค้าที่จะแก้ไข", edit_names, key="edit_product_sel")
        edit_row = catalog[catalog["name"] == edit_sel].iloc[0] if edit_sel else None
        if edit_row is not None:
            def _num(v, default=0.0):
                n = pd.to_numeric(v, errors="coerce")
                return float(n) if pd.notna(n) else default

            st.caption(f"รหัสสินค้า: {edit_row.get('id') or '—'}")

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
                # Supabase stores active as the string "TRUE"/"FALSE", not a real bool —
                # bool("FALSE") is truthy in Python, so compare the string explicitly.
                e_active = e2.checkbox("เปิดขาย (ไม่ติ๊ก = ปิดการขาย/หมด)", value=str(edit_row.get("active") or "").strip().upper() != "FALSE")
                e3, e4 = st.columns(2)
                # Supabase's catalog table names the pack-cost column cost_p, not cost_pack
                e_cost_box = e3.number_input("ต้นทุน/กล่อง", min_value=0.0, value=_num(edit_row.get("cost_box")), step=1.0)
                e_cost_pack = e4.number_input("ต้นทุน/ซอง", min_value=0.0, value=_num(edit_row.get("cost_p")), step=1.0)
                e5, e6 = st.columns(2)
                e_price_box = e5.number_input("ราคาขาย/กล่อง", min_value=0.0, value=_num(edit_row.get("price_box")), step=1.0)
                e_price_pack = e6.number_input("ราคาขาย/ซอง", min_value=0.0, value=_num(edit_row.get("price_pack")), step=1.0)
                e7, e8 = st.columns(2)
                e_limit_box = e7.number_input("ขั้นต่ำแจ้งเตือน (กล่อง)", min_value=0.0, value=_num(edit_row.get("limit_box")), step=1.0)
                e_limit_pack = e8.number_input("ขั้นต่ำแจ้งเตือน (ซอง)", min_value=0.0, value=_num(edit_row.get("limit_pack")), step=1.0)
                e_barcode = st.text_input("บาร์โค้ด", value=str(edit_row.get("barcode") or ""))
                e_slug = st.text_input(
                    "Slug (สำหรับลิงก์สั่งของโดยตรง)", value=str(edit_row.get("slug") or ""),
                    help="ใช้สร้างลิงก์สั่งของตรงจากหน้า order-links.html เช่น ใส่ bt11 ไว้ว่างได้",
                )
                e_image_url = st.text_input("ลิงก์รูปภาพ", value=str(edit_row.get("image_url") or ""))
                e_notice = st.text_area("ข้อความแจ้งเตือนในสินค้า (notice)", value=str(edit_row.get("notice") or ""))
                submitted_e = st.form_submit_button("บันทึกการแก้ไข")
                if submitted_e:
                    try:
                        payload = {
                            "_action": "updateProduct", "name": edit_sel,
                            "category": e_category.strip(), "active": e_active,
                            "cost_box": e_cost_box, "cost_pack": e_cost_pack,
                            "price_box": e_price_box, "price_pack": e_price_pack,
                            "limit_box": e_limit_box, "limit_pack": e_limit_pack,
                            "barcode": e_barcode.strip(), "slug": e_slug.strip(), "image_url": e_image_url.strip(),
                            "notice": e_notice.strip(),
                        }
                        # Only send new_name when it actually changed — sending it
                        # unconditionally would trigger the rename path (which
                        # touches stock_branch too) on every no-op edit.
                        if e_name.strip() and e_name.strip() != edit_sel:
                            payload["new_name"] = e_name.strip()
                        gas_post(payload)
                        st.success(f"แก้ไข \"{edit_sel}\" แล้ว")
                        st.cache_data.clear()
                        st.rerun()
                    except Exception as e:
                        st.error(f"บันทึกไม่ได้: {e}")

with tab_branch:
    if stock_branch.empty:
        st.caption("ยังไม่มีข้อมูลสต็อกสาขา")
    else:
        branch_sel = st.selectbox("เลือกสาขา", ["ทุกสาขา"] + BRANCHES, key="stock_branch_sel")
        show_b = stock_branch if branch_sel == "ทุกสาขา" else stock_branch[stock_branch["branch"] == branch_sel]
        show_b = show_b[["name", "branch", "qty_box", "qty_pack"]].sort_values(["branch", "name"]).rename(
            columns={"name": "สินค้า", "branch": "สาขา", "qty_box": "กล่อง", "qty_pack": "ซอง"}
        )
        st.dataframe(show_b, use_container_width=True, hide_index=True)

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
                    st.success("บันทึกแล้ว")
                    st.cache_data.clear()
                    st.rerun()
                except Exception as e:
                    st.error(f"บันทึกไม่ได้: {e}")

    with st.expander("📤 คืนสต็อกจากสาขากลับคลังกลาง"):
        names_r = sorted(stock_branch["name"].unique().tolist()) if not stock_branch.empty else []
        with st.form("return_stock_form"):
            rb1, rb2 = st.columns(2)
            r_branch = rb1.selectbox("สาขา", BRANCHES, key="return_branch_sel")
            r_name = rb2.selectbox("สินค้า", names_r, key="return_name_sel")

            cur_row = pd.DataFrame()
            if not stock_branch.empty:
                cur_row = stock_branch[(stock_branch["branch"] == r_branch) & (stock_branch["name"] == r_name)]
            max_box = int(pd.to_numeric(cur_row["qty_box"], errors="coerce").fillna(0).iloc[0]) if not cur_row.empty else 0
            max_pack = int(pd.to_numeric(cur_row["qty_pack"], errors="coerce").fillna(0).iloc[0]) if not cur_row.empty else 0

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
                        st.success("คืนสต็อกแล้ว สต็อกกลางได้รับคืนแล้ว")
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
                                st.success("ล็อตนี้รับแล้ว" if result.get("already") else "รับของสำเร็จ! แจ้งลูกค้าแล้ว")
                                st.cache_data.clear()
                                st.rerun()
                            except Exception as e:
                                st.error(f"ทำรายการไม่ได้: {e}")
                    with b2:
                        if st.button("🗑 ยกเลิก", key=f"cancel_{shipment_id}_{idx}", use_container_width=True):
                            try:
                                gas_post({"_action": "cancelShipment", "shipment_id": shipment_id})
                                st.success("ยกเลิกล็อตแล้ว สต็อกกลางได้รับคืนแล้ว")
                                st.cache_data.clear()
                                st.rerun()
                            except Exception as e:
                                st.error(f"ยกเลิกไม่ได้: {e}")
                elif status == "รับแล้ว":
                    st.caption(f"รับเมื่อ: {r.get('received_at', '') or '—'}")

with tab_new_product:
    st.markdown("**รูปสินค้า**")
    img_file = st.file_uploader("เลือกรูปสินค้า", type=["jpg", "jpeg", "png", "webp"], key="new_product_img")
    if img_file is not None:
        st.image(img_file, width=200)
        if st.button("📤 อัปโหลดรูปนี้", key="upload_new_product_img_btn"):
            try:
                b64 = base64.b64encode(img_file.getvalue()).decode("ascii")
                res = gas_post({
                    "_action": "uploadProductImage",
                    "base64": b64,
                    "mimeType": img_file.type or "image/jpeg",
                    "filename": img_file.name,
                })
                st.session_state["new_product_image_url"] = res.get("url", "")
                st.success("อัปโหลดรูปแล้ว — ลิงก์เติมในช่องด้านล่างให้แล้ว")
            except Exception as e:
                st.error(f"อัปโหลดรูปไม่ได้: {e}")

    uploaded_url = st.session_state.get("new_product_image_url", "")

    st.markdown("<div style='height:8px'></div>", unsafe_allow_html=True)

    with st.form("add_product_form_tab"):
        p1, p2 = st.columns(2)
        new_name = p1.text_input("ชื่อสินค้า")
        new_category = p2.selectbox("หมวดหมู่", [""] + ALL_CATEGORIES, format_func=lambda c: c or "(ไม่ระบุ)")
        p3, p4 = st.columns(2)
        new_cost_box = p3.number_input("ต้นทุน/กล่อง", min_value=0.0, value=0.0, step=1.0)
        new_cost_pack = p4.number_input("ต้นทุน/ซอง", min_value=0.0, value=0.0, step=1.0)
        p5, p6 = st.columns(2)
        new_price_box = p5.number_input("ราคาขาย/กล่อง", min_value=0.0, value=0.0, step=1.0)
        new_price_pack = p6.number_input("ราคาขาย/ซอง", min_value=0.0, value=0.0, step=1.0)
        p7, p8 = st.columns(2)
        new_initial_box = p7.number_input("สต็อกเริ่มต้น (กล่อง)", min_value=0, value=0, step=1)
        new_initial_pack = p8.number_input("สต็อกเริ่มต้น (ซอง)", min_value=0, value=0, step=1)
        p9, p10 = st.columns(2)
        new_limit_box = p9.number_input("ขั้นต่ำแจ้งเตือน (กล่อง)", min_value=0, value=0, step=1)
        new_limit_pack = p10.number_input("ขั้นต่ำแจ้งเตือน (ซอง)", min_value=0, value=0, step=1)
        new_barcode = st.text_input("บาร์โค้ด (ถ้ามี)")
        new_slug = st.text_input(
            "Slug (สำหรับลิงก์สั่งของโดยตรง, ถ้ามี)",
            help="ใช้สร้างลิงก์สั่งของตรงจากหน้า order-links.html เช่น ใส่ bt11 เว้นว่างได้",
        )
        new_image_url = st.text_input("ลิงก์รูปภาพ", value=uploaded_url, help="อัปโหลดรูปด้านบนแล้วลิงก์จะเติมให้อัตโนมัติ หรือวางลิงก์เองก็ได้")
        submitted_p = st.form_submit_button("เพิ่มสินค้า")
        if submitted_p:
            if not new_name.strip():
                st.warning("กรอกชื่อสินค้าก่อน")
            elif not catalog.empty and new_name.strip() in catalog["name"].values:
                st.error("มีสินค้าชื่อนี้อยู่แล้ว")
            else:
                try:
                    gas_post({
                        "_action": "addProduct",
                        "name": new_name.strip(), "category": new_category.strip(),
                        "cost_box": new_cost_box, "cost_pack": new_cost_pack,
                        "price_box": new_price_box, "price_pack": new_price_pack,
                        "initial_box": new_initial_box, "initial_pack": new_initial_pack,
                        "limit_box": new_limit_box, "limit_pack": new_limit_pack,
                        "barcode": new_barcode.strip(), "slug": new_slug.strip(),
                        "image_url": new_image_url.strip(),
                    })
                    st.success(f"เพิ่มสินค้า \"{new_name}\" แล้ว")
                    st.session_state.pop("new_product_image_url", None)
                    st.cache_data.clear()
                    st.rerun()
                except Exception as e:
                    st.error(f"เพิ่มสินค้าไม่ได้: {e}")

with tab_categories:
    desc_map = {k[len(CAT_DESC_PREFIX):]: v for k, v in _cat_cfg.items() if k.startswith(CAT_DESC_PREFIX)}
    all_cats = ALL_CATEGORIES
    counts = catalog["category"].value_counts().to_dict() if not catalog.empty else {}

    if not all_cats:
        st.caption("ยังไม่มีหมวดหมู่สินค้า")
    else:
        cat_table = pd.DataFrame([
            {"หมวดหมู่": c, "จำนวนสินค้า": int(counts.get(c, 0)), "คำอธิบาย": desc_map.get(c, "")}
            for c in all_cats
        ])
        st.dataframe(cat_table, use_container_width=True, hide_index=True)

    st.markdown("<div style='height:12px'></div>", unsafe_allow_html=True)

    with st.expander("➕ เพิ่มหมวดหมู่ใหม่"):
        with st.form("add_category_form", clear_on_submit=True):
            new_cat_name = st.text_input("ชื่อหมวดหมู่")
            new_cat_desc = st.text_area("คำอธิบาย", height=80)
            if st.form_submit_button("เพิ่มหมวดหมู่"):
                if not new_cat_name.strip():
                    st.warning("กรอกชื่อหมวดหมู่ก่อน")
                elif new_cat_name.strip() in all_cats:
                    st.error("มีหมวดหมู่นี้อยู่แล้ว")
                else:
                    try:
                        get_supabase().table("config").upsert({
                            "key": f"{CAT_DESC_PREFIX}{new_cat_name.strip()}", "value": new_cat_desc.strip(),
                        }).execute()
                        st.success(f'เพิ่มหมวดหมู่ "{new_cat_name}" แล้ว')
                        st.cache_data.clear()
                        st.rerun()
                    except Exception as e:
                        st.error(f"เพิ่มไม่ได้: {e}")

    with st.expander("✏️ แก้ไข / เปลี่ยนชื่อหมวดหมู่"):
        if not all_cats:
            st.caption("ยังไม่มีหมวดหมู่ให้แก้ไข")
        else:
            edit_cat_sel = st.selectbox("เลือกหมวดหมู่ที่จะแก้ไข", all_cats, key="edit_cat_sel")
            with st.form(f"edit_category_form_{edit_cat_sel}"):
                edit_cat_name = st.text_input("ชื่อหมวดหมู่", value=edit_cat_sel)
                edit_cat_desc = st.text_area("คำอธิบาย", value=desc_map.get(edit_cat_sel, ""), height=80)
                if st.form_submit_button("บันทึก"):
                    new_name = edit_cat_name.strip()
                    if not new_name:
                        st.warning("ชื่อหมวดหมู่ห้ามว่าง")
                    else:
                        try:
                            if new_name != edit_cat_sel:
                                # เปลี่ยนหมวดหมู่ของสินค้าทุกชิ้นที่อยู่หมวดเดิม
                                get_supabase().table("catalog").update(
                                    {"category": new_name}
                                ).eq("category", edit_cat_sel).execute()
                                # ย้ายคำอธิบายเดิมไปคีย์ใหม่แล้วลบคีย์เก่า
                                get_supabase().table("config").delete().eq(
                                    "key", f"{CAT_DESC_PREFIX}{edit_cat_sel}"
                                ).execute()
                            get_supabase().table("config").upsert({
                                "key": f"{CAT_DESC_PREFIX}{new_name}", "value": edit_cat_desc.strip(),
                            }).execute()
                            st.success("บันทึกแล้ว")
                            st.cache_data.clear()
                            st.rerun()
                        except Exception as e:
                            st.error(f"บันทึกไม่ได้: {e}")
