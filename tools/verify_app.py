#!/usr/bin/env python3
"""Streamlit Cloud entry point — navigation router + home dashboard.

Filename must stay tools/verify_app.py: Streamlit Community Cloud's main file
path can't be changed after an app is created without deleting and recreating
it (losing Secrets config + URL).
"""

from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests
import streamlit as st

from theme import apply_theme

WAKA_S  = "wk26xK9mPqRt"
GAS_URL = "https://script.google.com/macros/s/AKfycbz52wvADM7O1zMjqKlT2G4HPkq8gwAon_fUCuKgbmUMkDPQkaYKUWnv598U3EkFN1AByQ/exec"
TH_TZ = timezone(timedelta(hours=7))

ASSETS_DIR = Path(__file__).resolve().parent / "assets"


def gas_get(do: str, **params) -> dict:
    q = {"action": "api", "do": do, "_s": WAKA_S, **params}
    r = requests.get(GAS_URL, params=q, timeout=30)
    r.raise_for_status()
    return r.json()


@st.cache_data(ttl=30)
def load_summary():
    try:
        orders = gas_get("dashboard")
    except Exception as e:
        orders = {"_error": str(e)}

    try:
        events = gas_get("tournament_events").get("events", [])
        tourney = {
            "open_count": sum(1 for e in events if e.get("status") == "open"),
            "total_count": len(events),
        }
    except Exception as e:
        tourney = {"_error": str(e)}

    try:
        today = datetime.now(TH_TZ).strftime("%Y-%m-%d")
        gym = gas_get("wakagym_summary", date=today)
    except Exception as e:
        gym = {"_error": str(e)}

    return orders, tourney, gym


def home():
    st.markdown("## 🏠 ภาพรวม WAKA")

    if st.button("🔄 โหลดใหม่"):
        st.cache_data.clear()
        st.rerun()

    orders, tourney, gym = load_summary()

    c1, c2, c3 = st.columns(3)

    with c1:
        st.markdown("### 📦 ออเดอร์วันนี้")
        if "_error" in orders:
            st.caption(f"โหลดไม่ได้: {orders['_error']}")
        else:
            st.metric("ออเดอร์", orders.get("orders_today", 0))
            st.metric("ยอดขาย (ยืนยันแล้ว)", f"฿{orders.get('revenue_today', 0):,.0f}")
            st.metric("รอตรวจสลิป", orders.get("pending_count", 0))

    with c2:
        st.markdown("### 🏆 ทัวร์นาเมนต์")
        if "_error" in tourney:
            st.caption(f"โหลดไม่ได้: {tourney['_error']}")
        else:
            st.metric("เปิดรับสมัคร", tourney.get("open_count", 0))
            st.metric("ทั้งหมด", tourney.get("total_count", 0))

    with c3:
        st.markdown("### 🏋️ WAKA GYM วันนี้")
        if "_error" in gym:
            st.caption(f"โหลดไม่ได้: {gym['_error']}")
        else:
            st.metric("ผู้เล่น", gym.get("total_players", 0))
            st.metric("ยอดรวม", f"฿{gym.get('total_amount', 0):,.0f}")

    st.divider()
    st.caption("ดูรายละเอียดเพิ่มเติมได้ที่แท็บด้านซ้าย: ออเดอร์ / ทัวร์นาเมนต์ / WAKA GYM")


st.set_page_config(page_title="WAKA", page_icon="🏠", layout="wide", initial_sidebar_state="expanded")
apply_theme()
st.logo(str(ASSETS_DIR / "waka_logo.png"), icon_image=str(ASSETS_DIR / "waka_icon.png"))

home_pg = st.Page(home, title="หน้าแรก", icon="🏠", url_path="", default=True)
orders_pg = st.Page("pages/orders.py", title="ออเดอร์", icon="🛒", url_path="orders")
tournament_pg = st.Page("pages/tournament.py", title="ทัวร์นาเมนต์", icon="🏆", url_path="tournament")
wakagym_pg = st.Page("pages/wakagym.py", title="WAKA GYM", icon="🏋️", url_path="wakagym")

pg = st.navigation({"เมนูหลัก": [home_pg, orders_pg, tournament_pg, wakagym_pg]})
pg.run()
