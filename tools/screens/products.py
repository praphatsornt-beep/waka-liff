#!/usr/bin/env python3
"""จัดการสินค้าและหมวดหมู่ — เพิ่ม/แก้ไขสินค้า และจัดการหมวดหมู่สินค้า, แยกออกมาจากหน้าสต็อกสินค้า"""

import base64
import os
import sys
from pathlib import Path

import streamlit as st
import pandas as pd
import requests
from dotenv import load_dotenv

load_dotenv()

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from theme import apply_theme, page_header, admin_name

GAS_URL  = "https://script.google.com/macros/s/AKfycbz52wvADM7O1zMjqKlT2G4HPkq8gwAon_fUCuKgbmUMkDPQkaYKUWnv598U3EkFN1AByQ/exec"
WAKA_S   = "wk26xK9mPqRt"  # shared secret doPost/doGet require via ?_s= (same value as stock.py's WAKA_S)
ADMIN_CODE = "waka99"  # updateProduct/addProduct still require this to prove admin, same as stock.py


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


# st.success() called right before st.rerun() never reaches the screen — the
# rerun wipes it before the browser paints, so the person clicking "บันทึก"
# sees nothing happen and clicks again. Stash the message in session_state
# instead and show it as a toast on the NEXT run, after the state that
# already changed. (Same pattern as stock.py.)
def _flash(msg: str) -> None:
    st.session_state["_flash_msg"] = msg


# ── Page ──────────────────────────────────────────────────────────────────────
apply_theme()
page_header("จัดการสินค้าและหมวดหมู่", "เพิ่ม/แก้ไขสินค้า และจัดการหมวดหมู่สินค้า")

if "_flash_msg" in st.session_state:
    st.toast(st.session_state.pop("_flash_msg"), icon="✅")

catalog = load_catalog()

CAT_DESC_PREFIX = "category_desc_"
_cat_cfg = load_config()
_product_cats = sorted(set(catalog["category"].dropna().tolist())) if not catalog.empty else []
_product_cats = [c for c in _product_cats if c]
ALL_CATEGORIES = sorted(set(_product_cats) | {k[len(CAT_DESC_PREFIX):] for k in _cat_cfg if k.startswith(CAT_DESC_PREFIX)})

tab_manage, tab_categories = st.tabs(["🗂️ จัดการสินค้า", "🏷️ หมวดหมู่สินค้า"])

with tab_manage:
    sub_edit, sub_add = st.tabs(["✏️ แก้ไขสินค้า", "🆕 เพิ่มสินค้าใหม่"])

    with sub_edit:
        manage_cat_sel = st.selectbox("กรองหมวดหมู่", ["ทุกหมวดหมู่"] + ALL_CATEGORIES, key="edit_product_cat_filter")
        manage_catalog = catalog if manage_cat_sel == "ทุกหมวดหมู่" else catalog[catalog["category"] == manage_cat_sel]
        edit_names = sorted(manage_catalog["name"].tolist()) if not manage_catalog.empty else []
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
                e_limit_box = e7.number_input("ขั้นต่ำแจ้งเตือน (กล่อง)", min_value=0.0, value=_num(edit_row.get("limit_box")), step=1.0)
                e_limit_pack = e8.number_input("ขั้นต่ำแจ้งเตือน (ซอง)", min_value=0.0, value=_num(edit_row.get("limit_pack")), step=1.0)
                e_barcode = st.text_input("บาร์โค้ด", value=str(edit_row.get("barcode") or ""))
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
                        _flash(f"แก้ไข \"{edit_sel}\" แล้ว")
                        st.cache_data.clear()
                        st.rerun()
                    except Exception as e:
                        st.error(f"บันทึกไม่ได้: {e}")

    with sub_add:
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
            new_name = st.text_input("ชื่อสินค้า")
            p1, p2 = st.columns(2)
            new_category = p1.selectbox("หมวดหมู่", [""] + ALL_CATEGORIES, format_func=lambda c: c or "(ไม่ระบุ)")
            new_slug = p2.text_input(
                "Slug (สำหรับลิงก์สั่งของโดยตรง, ถ้ามี)",
                help="ใช้สร้างลิงก์สั่งของตรงจากหน้า order-links.html เช่น ใส่ bt11 เว้นว่างได้",
            )
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
                        _flash(f"เพิ่มสินค้า \"{new_name}\" แล้ว")
                        st.session_state.pop("new_product_image_url", None)
                        st.cache_data.clear()
                        st.rerun()
                    except Exception as e:
                        st.error(f"เพิ่มสินค้าไม่ได้: {e}")

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
