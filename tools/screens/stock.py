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

@st.dialog("🚚 สร้างล็อตส่งสาขา", width="large")
def _create_shipment_dialog():
    ship_branch = st.selectbox("สาขาปลายทาง", BRANCHES, key="ship_branch_sel")
    demand = {name: d for (branch, name), d in load_pending_branch_demand().items() if branch == ship_branch}

    ship_items = []
    demand_edited = pd.DataFrame()
    if demand:
        st.caption(
            "ออเดอร์รอส่งไปสาขานี้ — แก้ไข \"จะส่ง\" ต่อรายการได้เลย (ค่าเริ่มต้น = ยอดที่รอส่ง, "
            "ใส่ 0 ถ้าสินค้ายังไม่มาหรือยังไม่ส่งรอบนี้, แก้ให้มากกว่ายอดรอส่งเพื่อเผื่อขายหน้าร้าน)"
        )
        demand_df = pd.DataFrame([
            {
                "สินค้า": name,
                "รอส่ง (กล่อง)": int(d["qty_box"]), "รอส่ง (ซอง)": int(d["qty_pack"]),
                "จะส่ง (กล่อง)": int(d["qty_box"]), "จะส่ง (ซอง)": int(d["qty_pack"]),
                "ออเดอร์": d["order_count"],
            }
            for name, d in demand.items()
        ]).sort_values("สินค้า").reset_index(drop=True)
        demand_edited = st.data_editor(
            demand_df,
            use_container_width=True,
            hide_index=True,
            disabled=["สินค้า", "รอส่ง (กล่อง)", "รอส่ง (ซอง)", "ออเดอร์"],
            column_config={
                "จะส่ง (กล่อง)": st.column_config.NumberColumn(min_value=0, step=1),
                "จะส่ง (ซอง)": st.column_config.NumberColumn(min_value=0, step=1),
            },
            key=f"ship_demand_editor_{ship_branch}",
        )
        for _, row in demand_edited.iterrows():
            ship_items.append({
                "name": row["สินค้า"],
                "qty_box": int(pd.to_numeric(row["จะส่ง (กล่อง)"], errors="coerce") or 0),
                "qty_pack": int(pd.to_numeric(row["จะส่ง (ซอง)"], errors="coerce") or 0),
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
    ac1, ac3 = st.columns(2)
    with ac1:
        with st.popover("➕ เพิ่ม/ลด สต็อกคลังกลาง", use_container_width=True):
            names = catalog["name"].tolist() if not catalog.empty else []
            with st.form("add_stock_form"):
                sel_name = st.selectbox("สินค้า", names)
                st.caption("ใส่ค่าติดลบเพื่อลดสต็อก เช่น กดเพิ่มสต็อกผิดจำนวน")
                c1, c2 = st.columns(2)
                add_box = c1.number_input("กล่อง (+/-)", value=0, step=1)
                add_pack = c2.number_input("ซอง (+/-)", value=0, step=1)
                submitted = st.form_submit_button("บันทึก")
                if submitted:
                    if add_box == 0 and add_pack == 0:
                        st.warning("ใส่จำนวนที่จะปรับก่อน")
                    else:
                        try:
                            gas_post({"_action": "addStock", "name": sel_name, "add_box": add_box, "add_pack": add_pack})
                            _flash("ปรับสต็อกแล้ว")
                            st.cache_data.clear()
                            st.rerun()
                        except Exception as e:
                            st.error(f"บันทึกไม่ได้: {e}")

    with ac3:
        if st.button("🚚 สร้างล็อตส่งสาขา", use_container_width=True):
            _create_shipment_dialog()

    st.markdown("<div style='height:12px'></div>", unsafe_allow_html=True)

    if catalog.empty:
        st.caption("ยังไม่มีข้อมูลสินค้า")
    else:
        cats = ["ทุกหมวดหมู่"] + sorted([c for c in catalog["category"].dropna().unique().tolist() if c])
        cat_sel = st.selectbox("กรองหมวดหมู่", cats, key="central_cat_filter")
        catalog_show = catalog if cat_sel == "ทุกหมวดหมู่" else catalog[catalog["category"] == cat_sel]

        STATUS_ON, STATUS_OFF = "🟢", "🔴"

        show = catalog_show[["name", "category", "qty_box", "qty_pack", "limit_box", "limit_pack", "active"]].copy()
        show["id"] = catalog_show["id"] if "id" in catalog_show.columns else ""
        show["slug"] = catalog_show["slug"] if "slug" in catalog_show.columns else ""
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
        show = show.sort_values("active", ascending=False, kind="stable")
        show = show.rename(columns={
            "id": "รหัสสินค้า", "name": "สินค้า", "slug": "Slug", "category": "หมวดหมู่", "qty_box": "กล่อง", "qty_pack": "ซอง",
            "limit_box": "ขั้นต่ำ (กล่อง)", "limit_pack": "ขั้นต่ำ (ซอง)",
        })
        show = show[["สถานะ", "รหัสสินค้า", "สินค้า", "Slug", "หมวดหมู่", "กล่อง", "ซอง", "ขั้นต่ำ (กล่อง)", "ขั้นต่ำ (ซอง)", "แจ้งเตือน"]]

        st.caption("แก้ไข สถานะ / กล่อง / ซอง ในตารางได้เลย แล้วกดบันทึก — เลขกล่อง/ซองที่แก้เป็นยอดสต็อกใหม่ทั้งหมด ไม่ใช่จำนวนที่เพิ่ม")
        edited = st.data_editor(
            show,
            use_container_width=True,
            hide_index=True,
            disabled=["รหัสสินค้า", "สินค้า", "Slug", "หมวดหมู่", "ขั้นต่ำ (กล่อง)", "ขั้นต่ำ (ซอง)", "แจ้งเตือน"],
            column_config={
                "สถานะ": st.column_config.SelectboxColumn(" ", options=[STATUS_ON, STATUS_OFF], required=True, width="small"),
                "กล่อง": st.column_config.NumberColumn("กล่อง", min_value=0, step=1),
                "ซอง": st.column_config.NumberColumn("ซอง", min_value=0, step=1),
            },
            key=f"catalog_editor_{cat_sel}",
        )

        if st.button("บันทึก", key=f"save_catalog_btn_{cat_sel}"):
            try:
                for idx in show.index:
                    orig_row = show.loc[idx]
                    new_row = edited.loc[idx]
                    prod_name = orig_row["สินค้า"]

                    if new_row["สถานะ"] != orig_row["สถานะ"]:
                        gas_post({"_action": "updateProduct", "name": prod_name, "active": new_row["สถานะ"] == STATUS_ON})

                    # updateProduct ไม่รองรับตั้งค่า qty_box/qty_pack ตรงๆ — ส่งเป็นผลต่าง
                    # (ใหม่ - เดิม) ผ่าน addStock แทน ซึ่งรองรับค่าติดลบอยู่แล้ว
                    delta_box = int(pd.to_numeric(new_row["กล่อง"], errors="coerce") or 0) - int(pd.to_numeric(orig_row["กล่อง"], errors="coerce") or 0)
                    delta_pack = int(pd.to_numeric(new_row["ซอง"], errors="coerce") or 0) - int(pd.to_numeric(orig_row["ซอง"], errors="coerce") or 0)
                    if delta_box != 0 or delta_pack != 0:
                        gas_post({"_action": "addStock", "name": prod_name, "add_box": delta_box, "add_pack": delta_pack})

                _flash("บันทึกแล้ว")
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
            box = int(pd.to_numeric(box, errors="coerce") or 0)
            pack = int(pd.to_numeric(pack, errors="coerce") or 0)
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

