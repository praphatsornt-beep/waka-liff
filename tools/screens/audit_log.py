#!/usr/bin/env python3
"""Audit log — who did what, when, at which branch (gas/Code.gs's
_logStaffAction_ writes one row per staff-attributed action here). Read-only:
Supabase is written to only by GAS."""

import os
import sys
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import requests
import streamlit as st
from dotenv import load_dotenv

load_dotenv()

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from theme import apply_theme, page_header, kpi_card, admin_name, ACCENT_TEXT

GAS_URL = "https://script.google.com/macros/s/AKfycbz52wvADM7O1zMjqKlT2G4HPkq8gwAon_fUCuKgbmUMkDPQkaYKUWnv598U3EkFN1AByQ/exec"
WAKA_S = st.secrets["WAKA_S"]
ADMIN_CODE = st.secrets["ADMIN_CODE"]

ACTION_LABELS = {
    "cancel_order": "ยกเลิกออเดอร์",
    "confirm_slip": "ยืนยันสลิป",
    "reject_slip": "ปฏิเสธสลิป",
    "handover_order": "ส่งมอบออเดอร์",
    "partial_ready": "แจ้งพร้อมรับบางส่วน",
    "partial_cancel_items": "ยกเลิกสินค้าบางรายการ",
    "create_shipment": "สร้างล็อตส่งสาขา",
    "cancel_shipment": "ยกเลิกล็อตส่งสาขา",
    "receive_shipment": "รับของเข้าสาขา",
    "withdraw_stock": "เบิกสต็อกสาขา",
    "cancel_withdraw_stock": "ยกเลิกการเบิกสต็อกสาขา",
    "withdraw_central_stock": "เบิกคลังกลาง",
    "return_stock": "คืนสต็อกกลับคลังกลาง",
    "add_stock": "ปรับสต็อกคลังกลาง",
    "record_purchase": "บันทึกซื้อสินค้าเข้า",
    "receive_purchase": "รับของเข้าคลัง (ซื้อเข้า)",
    "purchase_payment": "บันทึกจ่ายเงินเพิ่ม (ซื้อเข้า)",
    "add_product": "เพิ่มสินค้าใหม่",
    "rename_product": "เปลี่ยนชื่อสินค้า",
    "update_product": "แก้ไขสินค้า",
    "walkin_sale": "ขายหน้าร้าน",
    "cancel_walkin_sale": "ยกเลิกขายหน้าร้าน",
    "cancel_walkin_sale_item": "ยกเลิกขายหน้าร้าน (รายสินค้า)",
}


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
def load_actions() -> pd.DataFrame:
    rows = (
        get_supabase().table("staff_actions").select("*")
        .order("created_at", desc=True).limit(2000).execute().data
    )
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df["created_at_dt"] = pd.to_datetime(df["created_at"], errors="coerce", utc=True)
    df["date"] = df["created_at_dt"].dt.tz_convert("Asia/Bangkok").dt.date
    df["เวลา"] = df["created_at_dt"].dt.tz_convert("Asia/Bangkok").dt.strftime("%Y-%m-%d %H:%M:%S")
    df["การกระทำ"] = df["action"].map(lambda a: ACTION_LABELS.get(a, a))
    return df


@st.cache_data(ttl=60)
def load_product_names() -> dict:
    rows = get_supabase().table("catalog").select("id,name").execute().data
    return {r["id"]: r["name"] for r in rows if r.get("id") and r.get("name")}


def df_to_csv_bytes(df: pd.DataFrame) -> bytes:
    return df.to_csv(index=False).encode("utf-8-sig")


# ── Page ──────────────────────────────────────────────────────────────────────
apply_theme()
page_header("ประวัติการทำงาน", "ใครทำอะไร เมื่อไหร่ ที่สาขาไหน — ตรวจสอบผู้รับผิดชอบย้อนหลังได้")

if "_flash_msg" in st.session_state:
    st.toast(st.session_state.pop("_flash_msg"), icon="✅")

actions = load_actions()
if actions.empty:
    st.caption("ยังไม่มีประวัติการทำงานบันทึกไว้")
else:
    f1, f2, f3, f4 = st.columns([1, 1, 1, 1])
    with f1:
        date_from = st.date_input("จากวันที่", value=date.today() - timedelta(days=7))
    with f2:
        date_to = st.date_input("ถึงวันที่", value=date.today())
    with f3:
        staff_opts = ["ทุกคน"] + sorted(actions["staff_name"].dropna().unique().tolist())
        staff_sel = st.selectbox("พนักงาน", staff_opts)
    with f4:
        action_opts = ["ทุกประเภท"] + sorted(actions["การกระทำ"].dropna().unique().tolist())
        action_sel = st.selectbox("ประเภทการกระทำ", action_opts)

    branch_opts = ["ทุกสาขา"] + sorted(actions["branch"].dropna().unique().tolist())
    branch_sel = st.selectbox("สาขา", branch_opts)

    show = actions[(actions["date"] >= date_from) & (actions["date"] <= date_to)]
    if staff_sel != "ทุกคน":
        show = show[show["staff_name"] == staff_sel]
    if action_sel != "ทุกประเภท":
        show = show[show["การกระทำ"] == action_sel]
    if branch_sel != "ทุกสาขา":
        show = show[show["branch"] == branch_sel]

    k1, k2, k3 = st.columns(3)
    with k1:
        st.markdown(kpi_card("จำนวนการกระทำ", len(show), ACCENT_TEXT), unsafe_allow_html=True)
    with k2:
        st.markdown(kpi_card("จำนวนพนักงาน", show["staff_name"].nunique()), unsafe_allow_html=True)
    with k3:
        st.markdown(kpi_card("จำนวนสาขาที่มีกิจกรรม", show["branch"].dropna().nunique()), unsafe_allow_html=True)

    st.markdown("<div style='height:12px'></div>", unsafe_allow_html=True)

    # ยกเลิกการเบิกสต็อกสาขาที่พนักงานกดผิด — คืนสต็อก + แจ้งกลุ่มทีมงาน (ทำที่ GAS)
    wd_rows = show[show["action"] == "withdraw_stock"]
    if True:
        cancelled_ids = set(
            actions[actions["action"] == "cancel_withdraw_stock"]["target_id"].dropna().astype(str)
        )
        with st.expander("↩️ ยกเลิกการเบิกสต็อกสาขา (กรณีกดผิด)", expanded=True):
            st.caption("เลือกรายการเบิกที่ต้องการยกเลิก — ระบบจะคืนสต็อกให้สาขา ลบรายการเบิก และแจ้งกลุ่มไลน์ทีมงาน")
            wd_opts = {}
            for _, r in wd_rows.head(50).iterrows():
                rid = str(r["id"])
                if rid in cancelled_ids:
                    continue
                label = f"{r['เวลา']} · {r.get('staff_name') or '-'} · {r.get('branch') or '-'} · {r.get('detail') or ''}"
                wd_opts[label] = rid
            if not wd_opts:
                st.caption("ไม่มีรายการเบิกสต็อกสาขาในช่วง/ตัวกรองที่เลือก (ลองขยายช่วงวันที่ หรือตั้งสาขา/ประเภทเป็น \"ทุก...\")")
            else:
                sel_label = st.selectbox("รายการเบิก", list(wd_opts.keys()), key="cancel_wd_sel")
                if st.button("ยกเลิกการเบิกนี้", type="primary", key="cancel_wd_btn"):
                    try:
                        payload = {
                            "_action": "cancelWithdrawStock", "action_id": wd_opts[sel_label],
                            "code": ADMIN_CODE, "staff_name": admin_name(),
                        }
                        resp = requests.post(f"{GAS_URL}?_s={WAKA_S}", json=payload, timeout=30)
                        res = resp.json()
                        if res.get("error"):
                            st.error(res["error"])
                        else:
                            load_actions.clear()
                            st.session_state["_flash_msg"] = "ยกเลิกการเบิกแล้ว คืนสต็อกเรียบร้อย"
                            st.rerun()
                    except Exception as e:
                        st.error(f"ยกเลิกไม่สำเร็จ: {e}")


    if show.empty:
        st.caption("ไม่มีประวัติในช่วงที่เลือก")
    else:
        # target_id ของการกระทำที่เกี่ยวกับสินค้าเป็นรหัสสินค้า (P0001) — แปลงเป็นชื่อ
        # ส่วนการกระทำอื่น (ออเดอร์/ล็อต/ใบซื้อ ฯลฯ) ไม่ใช่รหัสสินค้า คงค่าเดิมไว้
        product_names = load_product_names()
        show = show.assign(สินค้า=show["target_id"].map(lambda t: product_names.get(t, t)))
        display_cols = ["เวลา", "staff_name", "branch", "การกระทำ", "สินค้า", "detail"]
        display_df = show[display_cols].rename(columns={
            "staff_name": "พนักงาน", "branch": "สาขา", "detail": "รายละเอียด",
        })
        st.dataframe(display_df, use_container_width=True, hide_index=True)
        st.download_button(
            "⬇️ ดาวน์โหลดประวัติ (CSV)", df_to_csv_bytes(display_df),
            file_name=f"waka_staff_actions_{date_from}_{date_to}.csv", mime="text/csv",
        )

        st.markdown("<div style='height:16px'></div>", unsafe_allow_html=True)
        with st.expander("📊 สรุปจำนวนการกระทำต่อพนักงาน"):
            by_staff = (
                show.groupby("staff_name")
                .size()
                .reset_index(name="จำนวนครั้ง")
                .rename(columns={"staff_name": "พนักงาน"})
                .sort_values("จำนวนครั้ง", ascending=False)
            )
            st.dataframe(by_staff, use_container_width=True, hide_index=True)
