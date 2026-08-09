#!/usr/bin/env python3
"""Settings — shop config (bank info, staff PINs, category descriptions).

_config is Supabase-primary (see gas/Code.gs getConfig_/setConfig_) — this
page reads and writes Supabase directly via service_role. GAS still caches
config for 120s (CacheService, used by order/PIN checks in gas/Code.gs), so
a save here can take up to 2 minutes to be visible to LIFF/GAS — acceptable
for admin-only settings that change rarely.
"""

import os
import sys
from pathlib import Path

import streamlit as st
from dotenv import load_dotenv

load_dotenv()

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from theme import apply_theme, page_header

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


def set_config(config: dict) -> None:
    rows = [{"key": k, "value": str(v)} for k, v in config.items()]
    get_supabase().table("config").upsert(rows).execute()
    st.cache_data.clear()


@st.cache_data(ttl=30)
def load_config() -> dict:
    rows = get_supabase().table("config").select("key,value").execute().data
    return {r["key"]: (r.get("value") or "") for r in rows}


# ── Page ──────────────────────────────────────────────────────────────────────
apply_theme()
page_header("ตั้งค่า", "ข้อมูลธนาคาร PIN พนักงาน")

cfg = load_config()

with st.form("bank_settings_form"):
    st.subheader("ข้อมูลธนาคาร & ค่าจัดส่ง")
    b1, b2 = st.columns(2)
    bank_name = b1.text_input("ธนาคาร", value=cfg.get("bank_name", ""))
    bank_account = b2.text_input("เลขบัญชี", value=cfg.get("bank_account", ""))
    b3, b4 = st.columns(2)
    bank_account_name = b3.text_input("ชื่อบัญชี (ไทย, คั่นหลายชื่อด้วย |)", value=cfg.get("bank_account_name", ""))
    bank_account_name_en = b4.text_input("ชื่อบัญชี (Eng, คั่นหลายชื่อด้วย |)", value=cfg.get("bank_account_name_en", ""))
    b5, b6 = st.columns(2)
    delivery_fee = b5.number_input("ค่าจัดส่ง (บาท)", min_value=0, value=int(cfg.get("delivery_fee") or 0), step=1)
    admin_pin = b6.text_input(
        "PIN แอดมิน (ไม่ใช้งานจริง — ค่าที่ตรวจสอบจริงอยู่ใน GAS Script Properties)",
        value=cfg.get("admin_pin", ""),
    )
    if st.form_submit_button("บันทึก"):
        try:
            set_config({
                "bank_name": bank_name.strip(),
                "bank_account": bank_account.strip(),
                "bank_account_name": bank_account_name.strip(),
                "bank_account_name_en": bank_account_name_en.strip(),
                "delivery_fee": delivery_fee,
                "admin_pin": admin_pin.strip(),
            })
            st.success("บันทึกแล้ว")
            st.rerun()
        except Exception as e:
            st.error(f"บันทึกไม่ได้: {e}")

st.markdown("<div style='height:8px'></div>", unsafe_allow_html=True)

with st.form("pin_settings_form"):
    st.subheader("PIN พนักงานแต่ละสาขา")
    pin_inputs = {}
    cols = st.columns(len(BRANCHES))
    for col, branch in zip(cols, BRANCHES):
        pin_inputs[branch] = col.text_input(branch, value=cfg.get(f"staff_pin_{branch}", ""))
    if st.form_submit_button("บันทึก PIN"):
        try:
            set_config({f"staff_pin_{b}": v.strip() for b, v in pin_inputs.items()})
            st.success("บันทึก PIN แล้ว")
            st.rerun()
        except Exception as e:
            st.error(f"บันทึกไม่ได้: {e}")

st.markdown("<div style='height:8px'></div>", unsafe_allow_html=True)

with st.expander("ตั้งค่าขั้นสูง"):
    covered = {"bank_name", "bank_account", "bank_account_name", "bank_account_name_en", "delivery_fee", "admin_pin"}
    covered |= {f"staff_pin_{b}" for b in BRANCHES}
    # หมวดหมู่สินค้า (category_desc_*) จัดการที่หน้าสต็อก → แท็บ "หมวดหมู่สินค้า" แทน
    other_keys = sorted(k for k in cfg if k not in covered and not k.startswith("category_desc_"))

    if other_keys:
        st.caption("คีย์เหล่านี้บางตัวถูกตั้งค่าอัตโนมัติผ่านบอท LINE (group_staff, finance_line_id) — แก้ที่นี่ได้แต่ปกติไม่ต้องยุ่ง")
        with st.form("advanced_config_form"):
            adv_inputs = {}
            for k in other_keys:
                adv_inputs[k] = st.text_input(k, value=cfg.get(k, ""))
            if st.form_submit_button("บันทึก"):
                try:
                    set_config({k: v.strip() for k, v in adv_inputs.items()})
                    st.success("บันทึกแล้ว")
                    st.rerun()
                except Exception as e:
                    st.error(f"บันทึกไม่ได้: {e}")

    st.markdown("**เพิ่มคีย์ใหม่**")
    with st.form("new_config_key_form", clear_on_submit=True):
        nk1, nk2 = st.columns(2)
        new_key = nk1.text_input("คีย์")
        new_value = nk2.text_input("ค่า")
        if st.form_submit_button("เพิ่ม") and new_key.strip():
            try:
                set_config({new_key.strip(): new_value.strip()})
                st.success(f'เพิ่ม "{new_key}" แล้ว')
                st.rerun()
            except Exception as e:
                st.error(f"เพิ่มไม่ได้: {e}")
