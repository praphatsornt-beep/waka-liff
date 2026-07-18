#!/usr/bin/env python3
"""Streamlit Cloud entry point — navigation router + home dashboard.

Filename must stay tools/verify_app.py: Streamlit Community Cloud's main file
path can't be changed after an app is created without deleting and recreating
it (losing Secrets config + URL).
"""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests
import streamlit as st

from theme import (
    apply_theme, SURFACE, BORDER, TEXT2, TEXT3, ACCENT_LIGHT, ACCENT_TEXT,
    DIVIDER, DIVIDER2, PENDING_TEXT, SUCCESS_TEXT,
)

WAKA_S  = "wk26xK9mPqRt"
GAS_URL = "https://script.google.com/macros/s/AKfycbz52wvADM7O1zMjqKlT2G4HPkq8gwAon_fUCuKgbmUMkDPQkaYKUWnv598U3EkFN1AByQ/exec"
TH_TZ = timezone(timedelta(hours=7))
GYM_SHEET_ID = "1aUHbSt3qlQ4uMIzlCGbF-iFm0AqSeqx12nxk5ny1JoY"

ASSETS_DIR = Path(__file__).resolve().parent / "assets"

THAI_DAYS = ["วันจันทร์", "วันอังคาร", "วันพุธ", "วันพฤหัสบดี", "วันศุกร์", "วันเสาร์", "วันอาทิตย์"]
THAI_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
               "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"]


def gas_get(do: str, **params) -> dict:
    q = {"action": "api", "do": do, "_s": WAKA_S, **params}
    r = requests.get(GAS_URL, params=q, timeout=30)
    r.raise_for_status()
    return r.json()


def count_tournament_pending(events: list):
    open_ids = [e["event_id"] for e in events if e.get("status") == "open"]
    if not open_ids:
        return 0

    def _count(eid):
        try:
            players = gas_get("tournament_list", event=eid).get("players", [])
            return sum(1 for p in players if p.get("slip_status") == "pending")
        except Exception:
            return 0

    try:
        with ThreadPoolExecutor(max_workers=len(open_ids)) as ex:
            return sum(ex.map(_count, open_ids))
    except Exception:
        return None


def count_gym_pending_slips():
    """Best-effort pending-slip count via gspread. Returns None (not 0) on any
    failure so the UI can show "—" instead of a misleading zero."""
    try:
        import json as _json
        import gspread
        from google.oauth2.service_account import Credentials

        scopes = ["https://www.googleapis.com/auth/spreadsheets"]
        if "GOOGLE_SERVICE_ACCOUNT" in st.secrets:
            info = _json.loads(st.secrets["GOOGLE_SERVICE_ACCOUNT"])
            creds = Credentials.from_service_account_info(info, scopes=scopes)
        else:
            creds = Credentials.from_service_account_file("service_account.json", scopes=scopes)
        gc = gspread.authorize(creds)
        ws = gc.open_by_key(GYM_SHEET_ID).worksheet("wakagym_reg")
        rows = ws.get_all_values()
        if len(rows) < 2 or "slip_status" not in rows[0]:
            return 0
        idx = rows[0].index("slip_status")
        return sum(1 for r in rows[1:] if len(r) > idx and r[idx] == "pending")
    except Exception:
        return None


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
            "pending_applicants": count_tournament_pending(events),
        }
    except Exception as e:
        tourney = {"_error": str(e)}

    try:
        today = datetime.now(TH_TZ).strftime("%Y-%m-%d")
        gym = gas_get("wakagym_summary", date=today)
        gym["pending_slips"] = count_gym_pending_slips()
    except Exception as e:
        gym = {"_error": str(e)}

    return orders, tourney, gym


def branch_sales_today(recent_orders: list, today_str: str):
    totals = {}
    for o in recent_orders:
        if not o.get("timestamp", "").startswith(today_str):
            continue
        if o.get("slip_status") != "ยืนยัน":
            continue
        b = o.get("branch") or "—"
        totals[b] = totals.get(b, 0) + int(o.get("total", 0))
    return sorted(totals.items(), key=lambda kv: kv[1], reverse=True)


def recent_activity(recent_orders: list, limit: int = 5):
    out = []
    for o in recent_orders[:limit]:
        try:
            t = datetime.fromisoformat(o.get("timestamp", "")).strftime("%H:%M")
        except Exception:
            t = ""
        out.append((f"อนุมัติสลิปออเดอร์ #{o.get('order_id', '')} ({o.get('real_name', '')})", t))
    return out


def _flat(html: str) -> str:
    """Strip leading whitespace from each line so Python's source indentation
    doesn't get read back as a markdown indented-code-block."""
    return "\n".join(line.strip() for line in html.strip().splitlines())


def action_card(label: str, count, link: str) -> str:
    shown = "—" if count is None else count
    return f"""
    <a href="{link}" target="_self" style="text-decoration:none;color:inherit">
      <div style="cursor:pointer;background:{SURFACE};border:1px solid {BORDER};border-left:4px solid {PENDING_TEXT};
                  border-radius:12px;padding:16px 18px;display:flex;align-items:center;gap:14px">
        <div style="flex:1">
          <div style="font-size:13px;color:{TEXT2}">{label}</div>
          <div style="font-family:'Prompt',sans-serif;font-size:22px;font-weight:700;color:{PENDING_TEXT};margin-top:2px">{shown}</div>
        </div>
        <div style="font-size:13px;color:{ACCENT_TEXT};font-weight:600;white-space:nowrap">ไปตรวจ →</div>
      </div>
    </a>
    """


def summary_card(icon: str, label: str, big_number, big_suffix: str, secondary: str,
                  foot1_label: str, foot1_value, foot1_color: str,
                  foot2_label: str, foot2_value, foot2_color: str) -> str:
    return f"""
    <div style="background:{SURFACE};border:1px solid {BORDER};border-radius:14px;padding:22px 22px 20px">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div style="font-size:13px;color:{TEXT2};font-weight:600">{label}</div>
        <div style="width:26px;height:26px;border-radius:8px;background:{ACCENT_LIGHT};display:flex;
                    align-items:center;justify-content:center;font-size:13px">{icon}</div>
      </div>
      <div style="font-family:'Prompt',sans-serif;font-weight:700;font-size:34px;margin-top:10px">{big_number}
        <span style="font-size:15px;font-weight:500;color:{TEXT2}">{big_suffix}</span></div>
      <div style="font-size:20px;font-weight:700;color:{ACCENT_TEXT};margin-top:2px">{secondary}</div>
      <div style="display:flex;gap:10px;margin-top:16px;padding-top:14px;border-top:1px solid {DIVIDER}">
        <div style="flex:1">
          <div style="font-size:11px;color:{TEXT2}">{foot1_label}</div>
          <div style="font-size:16px;font-weight:700;color:{foot1_color}">{foot1_value}</div>
        </div>
        <div style="flex:1">
          <div style="font-size:11px;color:{TEXT2}">{foot2_label}</div>
          <div style="font-size:16px;font-weight:700;color:{foot2_color}">{foot2_value}</div>
        </div>
      </div>
    </div>
    """


def home():
    now = datetime.now(TH_TZ)
    subtitle = f"{THAI_DAYS[now.weekday()]}ที่ {now.day} {THAI_MONTHS[now.month - 1]} {now.year + 543}"

    st.markdown(
        f"""<div style="font-family:'Prompt',sans-serif;font-weight:700;font-size:26px">ภาพรวมวันนี้ · ทุกสาขา</div>
        <div style="color:{TEXT2};font-size:13.5px;margin-top:2px;margin-bottom:18px">{subtitle}</div>""",
        unsafe_allow_html=True,
    )

    if st.button("🔄 โหลดใหม่"):
        st.cache_data.clear()
        st.rerun()

    orders, tourney, gym = load_summary()
    if "_error" in orders or "_error" in tourney or "_error" in gym:
        for section, data in (("ออเดอร์", orders), ("ทัวร์นาเมนต์", tourney), ("WAKA GYM", gym)):
            if "_error" in data:
                st.caption(f"{section} โหลดไม่ได้: {data['_error']}")

    st.markdown(
        f'<div style="font-size:13px;font-weight:700;color:{TEXT2};margin:8px 0 10px">ต้องดำเนินการวันนี้</div>',
        unsafe_allow_html=True,
    )
    a1, a2, a3 = st.columns(3)
    with a1:
        st.markdown(action_card("ออเดอร์รอตรวจสลิป", orders.get("pending_count"), "/orders"), unsafe_allow_html=True)
    with a2:
        st.markdown(action_card("ผู้สมัครรอยืนยันสลิป", tourney.get("pending_applicants"), "/tournament"), unsafe_allow_html=True)
    with a3:
        st.markdown(action_card("สลิป WAKA GYM รอตรวจ", gym.get("pending_slips"), "/wakagym"), unsafe_allow_html=True)

    st.markdown("<div style='height:14px'></div>", unsafe_allow_html=True)

    recent_orders = orders.get("recent_orders", [])
    today_str = now.strftime("%Y-%m-%d")
    today_orders = [o for o in recent_orders if o.get("timestamp", "").startswith(today_str) and o.get("slip_status") == "ยืนยัน"]
    revenue_today = sum(int(o.get("total", 0)) for o in today_orders)

    c1, c2, c3 = st.columns(3)
    with c1:
        st.markdown(summary_card(
            "📦", "ออเดอร์วันนี้", orders.get("orders_today", 0), "ออเดอร์", f"฿{revenue_today:,.0f}",
            "รอตรวจสลิป", orders.get("pending_count", 0), PENDING_TEXT,
            "ยอดขาย", f"฿{orders.get('revenue_today', 0):,.0f}", SUCCESS_TEXT,
        ), unsafe_allow_html=True)
    with c2:
        st.markdown(summary_card(
            "🏆", "ทัวร์นาเมนต์", tourney.get("open_count", 0), "งานเปิดรับสมัคร",
            f"จากทั้งหมด {tourney.get('total_count', 0)} งาน",
            "รอยืนยันสลิป", tourney.get("pending_applicants") if tourney.get("pending_applicants") is not None else "—", PENDING_TEXT,
            "เปิดรับสมัคร", tourney.get("open_count", 0), SUCCESS_TEXT,
        ), unsafe_allow_html=True)
    with c3:
        st.markdown(summary_card(
            "🏋️", "WAKA GYM วันนี้", gym.get("total_players", 0), "ผู้เล่น", f"฿{gym.get('total_amount', 0):,.0f}",
            "รอตรวจสลิป", gym.get("pending_slips") if gym.get("pending_slips") is not None else "—", PENDING_TEXT,
            "ผู้เล่น", gym.get("total_players", 0), SUCCESS_TEXT,
        ), unsafe_allow_html=True)

    st.markdown("<div style='height:20px'></div>", unsafe_allow_html=True)

    b1, b2 = st.columns([1, 1.4])
    with b1:
        bars = branch_sales_today(recent_orders, today_str)
        rows_html = ""
        max_total = max((t for _, t in bars), default=1) or 1
        for branch, total in bars:
            pct = round(total / max_total * 100)
            rows_html += f"""
            <div style="margin-bottom:14px">
              <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px">
                <span style="font-weight:600">สาขา{branch}</span>
                <span style="font-weight:700;color:{ACCENT_TEXT}">฿{total:,.0f}</span>
              </div>
              <div style="height:7px;background:{DIVIDER};border-radius:4px;overflow:hidden">
                <div style="height:100%;background:#6F4E37;width:{pct}%"></div>
              </div>
            </div>
            """
        if not rows_html:
            rows_html = f'<div style="font-size:13px;color:{TEXT3}">ยังไม่มียอดขายวันนี้</div>'
        st.markdown(
            _flat(f"""<div style="background:{SURFACE};border:1px solid {BORDER};border-radius:14px;padding:18px 20px">
            <div style="font-weight:600;font-size:14.5px;margin-bottom:14px">ยอดขายแยกตามสาขา</div>
            {_flat(rows_html)}
            </div>"""),
            unsafe_allow_html=True,
        )

    with b2:
        activity = recent_activity(recent_orders)
        rows_html = ""
        for text, time_str in activity:
            rows_html += f"""
            <div style="display:flex;align-items:center;gap:14px;padding:13px 22px;border-bottom:1px solid {DIVIDER2}">
              <div style="width:7px;height:7px;border-radius:50%;background:{SUCCESS_TEXT};flex:none"></div>
              <div style="flex:1;font-size:13.5px">{text}</div>
              <div style="font-size:12px;color:{TEXT3}">{time_str}</div>
            </div>
            """
        if not rows_html:
            rows_html = f'<div style="padding:13px 22px;font-size:13px;color:{TEXT3}">ยังไม่มีกิจกรรม</div>'
        st.markdown(
            _flat(f"""<div style="background:{SURFACE};border:1px solid {BORDER};border-radius:14px;padding:6px 0">
            <div style="padding:16px 22px 12px;font-weight:600;font-size:14.5px;border-bottom:1px solid {DIVIDER}">กิจกรรมล่าสุด</div>
            {_flat(rows_html)}
            </div>"""),
            unsafe_allow_html=True,
        )


st.set_page_config(page_title="WAKA", page_icon="🏠", layout="wide", initial_sidebar_state="expanded")
apply_theme()
st.logo(str(ASSETS_DIR / "waka_logo.png"), icon_image=str(ASSETS_DIR / "waka_icon.png"))

home_pg = st.Page(home, title="หน้าแรก", icon="🏠", url_path="", default=True)
orders_pg = st.Page("pages/orders.py", title="ออเดอร์", icon="🛒", url_path="orders")
tournament_pg = st.Page("pages/tournament.py", title="ทัวร์นาเมนต์", icon="🏆", url_path="tournament")
wakagym_pg = st.Page("pages/wakagym.py", title="WAKA GYM", icon="🏋️", url_path="wakagym")

pg = st.navigation({"เมนูหลัก": [home_pg, orders_pg, tournament_pg, wakagym_pg]})
pg.run()
