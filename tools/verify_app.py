#!/usr/bin/env python3
"""Streamlit Cloud entry point — navigation router + home dashboard.

Filename must stay tools/verify_app.py: Streamlit Community Cloud's main file
path can't be changed after an app is created without deleting and recreating
it (losing Secrets config + URL).
"""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from pathlib import Path

import json
import os
import streamlit as st
from dotenv import load_dotenv

load_dotenv()

from theme import (
    apply_theme, page_header, flat, SURFACE, BORDER, TEXT2, TEXT3, ACCENT_LIGHT,
    ACCENT_TEXT, PRIMARY_BTN, DIVIDER, DIVIDER2, PENDING_TEXT, SUCCESS_TEXT, DANGER_TEXT,
)


def _require_login() -> None:
    """Password gate + admin-name capture for the whole dashboard.

    There are no per-user accounts (one shared password for now), so
    admin_name is a self-reported free-text field, not a verified identity —
    it's a lightweight deterrent/audit trail (logged into GAS write actions'
    notes and LINE messages), not real access control. Runs once here at the
    entry point: every other page (screens/*.py) is executed by pg.run()
    inside this same script run, so this single check gates them all.
    """
    admin_password = os.environ.get("ADMIN_PASSWORD", "")
    if not admin_password:
        try:
            admin_password = st.secrets["ADMIN_PASSWORD"]
        except Exception:
            admin_password = ""
    if not admin_password:
        st.error("ยังไม่ได้ตั้งรหัสผ่านแอดมิน — เพิ่ม ADMIN_PASSWORD ใน Streamlit Secrets (หรือ .env ตอนรันเครื่อง local) ก่อนใช้งาน")
        st.stop()

    if st.session_state.get("authed") and st.session_state.get("admin_name"):
        return

    st.markdown("<div style='height:100px'></div>", unsafe_allow_html=True)
    _, mid, _ = st.columns([1, 1.2, 1])
    with mid:
        st.markdown("### 🔒 WAKA ADMIN DASHBOARD")
        if not st.session_state.get("authed"):
            pw = st.text_input("รหัสผ่าน", type="password", key="login_pw")
            if st.button("เข้าสู่ระบบ", use_container_width=True, type="primary"):
                if pw == admin_password:
                    st.session_state["authed"] = True
                    st.rerun()
                else:
                    st.error("รหัสผ่านไม่ถูกต้อง")
        else:
            st.caption("เกือบเสร็จแล้ว — กรอกชื่อไว้บันทึกในทุกการดำเนินการที่ทำจากตอนนี้")
            name = st.text_input("ชื่อผู้ดูแลระบบ (แสดงในประวัติการยืนยัน/ยกเลิก/แก้ไขสินค้า)", key="login_name")
            if st.button("เริ่มใช้งาน", use_container_width=True, type="primary") and name.strip():
                st.session_state["admin_name"] = name.strip()
                st.rerun()
    st.stop()

TH_TZ = timezone(timedelta(hours=7))

ASSETS_DIR = Path(__file__).resolve().parent / "assets"

THAI_DAYS = ["วันจันทร์", "วันอังคาร", "วันพุธ", "วันพฤหัสบดี", "วันศุกร์", "วันเสาร์", "วันอาทิตย์"]
THAI_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
               "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"]

PENDING_SLIP_STATUSES = ["รอตรวจ", "รอตรวจเพิ่ม", "ยอดไม่ตรง", "สลิปซ้ำ", "บัญชีไม่ตรง", "สงสัยปลอม"]


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


def _load_orders():
    try:
        sb = get_supabase()
        rows = (
            sb.table("orders").select("*")
            .order("timestamp", desc=True).limit(200).execute().data
        )
        today = datetime.now(TH_TZ).strftime("%Y-%m-%d")
        orders_today = 0
        revenue_today = 0
        pending_count = 0
        for o in rows:
            ts = o.get("timestamp") or ""
            slip = o.get("slip_status") or ""
            if ts.startswith(today):
                orders_today += 1
                if slip == "ยืนยัน":
                    revenue_today += int(o.get("total") or 0)
            if slip in PENDING_SLIP_STATUSES:
                pending_count += 1
        return {
            "orders_today": orders_today, "revenue_today": revenue_today,
            "pending_count": pending_count, "recent_orders": rows,
        }
    except Exception as e:
        return {"_error": str(e)}


def _load_tourney():
    try:
        sb = get_supabase()
        events = sb.table("tournament_events").select("*").execute().data
        open_events = [e for e in events if e.get("status") == "open"]
        open_ids = [e["event_id"] for e in open_events]
        pending_applicants = 0
        regs_by_event = {}
        if open_ids:
            regs = (
                sb.table("tournament_registrations").select("event_id,slip_status")
                .in_("event_id", open_ids).execute().data
            )
            for r in regs:
                eid = r.get("event_id")
                regs_by_event[eid] = regs_by_event.get(eid, 0) + 1
                if r.get("slip_status") == "pending":
                    pending_applicants += 1
        return {
            "open_count": len(open_ids),
            "total_count": len(events),
            "pending_applicants": pending_applicants,
            "open_events": open_events,
            "regs_by_event": regs_by_event,
        }
    except Exception as e:
        return {"_error": str(e)}


def _load_stock_warnings():
    try:
        sb = get_supabase()
        rows = sb.table("catalog").select("name,qty_box,limit_box").execute().data
        low = [
            r for r in rows
            if int(r.get("limit_box") or 0) > 0 and int(r.get("qty_box") or 0) <= int(r.get("limit_box") or 0)
        ]
        return sorted(low, key=lambda r: int(r.get("qty_box") or 0))
    except Exception:
        return []


def _load_gym():
    try:
        sb = get_supabase()
        today = datetime.now(TH_TZ).strftime("%Y-%m-%d")
        rows = sb.table("wakagym_registrations").select("*").eq("event_date", today).execute().data

        total_tokens = sum(int(r.get("tokens_earned") or 0) for r in rows)
        total_promo = sum(int(r.get("promo_packs") or 0) for r in rows)
        rewards_given = sum(1 for r in rows if str(r.get("rewards_given")).lower() == "true")
        cash_amount = 0
        transfer_amount = 0
        for r in rows:
            entry_fee = int(r.get("note") or 0) or 200
            if (r.get("payment_method") or "transfer") == "cash":
                cash_amount += entry_fee
            else:
                transfer_amount += entry_fee

        pending_slips = len(
            sb.table("wakagym_registrations").select("reg_id").eq("slip_status", "pending").execute().data
        )
        return {
            "date": today, "total_players": len(rows), "total_tokens": total_tokens,
            "total_promo": total_promo, "rewards_given": rewards_given,
            "cash_amount": cash_amount, "transfer_amount": transfer_amount,
            "total_amount": cash_amount + transfer_amount, "pending_slips": pending_slips,
        }
    except Exception as e:
        return {"_error": str(e)}


@st.cache_data(ttl=30)
def load_summary():
    with ThreadPoolExecutor(max_workers=4) as ex:
        f_orders = ex.submit(_load_orders)
        f_tourney = ex.submit(_load_tourney)
        f_gym = ex.submit(_load_gym)
        f_stock = ex.submit(_load_stock_warnings)
        return f_orders.result(), f_tourney.result(), f_gym.result(), f_stock.result()


def top_products(recent_orders: list, limit: int = 5) -> list:
    agg = {}
    for o in recent_orders:
        if o.get("slip_status") != "ยืนยัน":
            continue
        items = o.get("items_json") or []
        if isinstance(items, str):
            try:
                items = json.loads(items)
            except Exception:
                items = []
        for i in items:
            name = i.get("name", "")
            if not name:
                continue
            qty = i.get("qty", 1) or 1
            price = i.get("price", 0) or 0
            a = agg.setdefault(name, {"qty": 0, "revenue": 0})
            a["qty"] += qty
            a["revenue"] += qty * price
    rows = [{"name": k, **v} for k, v in agg.items()]
    return sorted(rows, key=lambda r: r["revenue"], reverse=True)[:limit]


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


def stock_warning_card(low_stock: list) -> str:
    rows_html = ""
    for item in low_stock[:5]:
        rows_html += f"""
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 22px;border-bottom:1px solid {DIVIDER2}">
          <span style="font-size:13.5px">{item.get('name', '')}</span>
          <span style="font-size:12.5px;color:{DANGER_TEXT}">เหลือ {int(item.get('qty_box') or 0)} / จุดสั่งซื้อ {int(item.get('limit_box') or 0)}</span>
        </div>
        """
    if not rows_html:
        rows_html = f'<div style="padding:10px 22px;font-size:13px;color:{TEXT3}">ไม่มีสินค้าใกล้หมด</div>'
    return flat(f"""<div style="background:{SURFACE};border:1px solid {BORDER};border-radius:14px;padding:6px 0">
    <div style="padding:14px 22px 12px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid {DIVIDER}">
      <span style="font-weight:600;font-size:14.5px">⚠️ สินค้าใกล้หมด ({len(low_stock)})</span>
      <a href="/stock" target="_self" style="text-decoration:none;color:{ACCENT_TEXT};font-size:12.5px;font-weight:600">จัดการคลังสินค้า →</a>
    </div>
    {flat(rows_html)}
    </div>""")


def top_products_card(products: list) -> str:
    rows_html = ""
    for p in products:
        rows_html += f"""
        <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 22px;border-bottom:1px solid {DIVIDER2}">
          <span style="font-size:13.5px">{p['name']}</span>
          <span style="font-size:12.5px;color:{TEXT3}">{p['qty']} ชิ้น</span>
          <span style="font-size:13px;font-weight:700;color:{ACCENT_TEXT}">฿{p['revenue']:,.0f}</span>
        </div>
        """
    if not rows_html:
        rows_html = f'<div style="padding:9px 22px;font-size:13px;color:{TEXT3}">ยังไม่มีข้อมูลสินค้าขายดี</div>'
    return flat(f"""<div style="background:{SURFACE};border:1px solid {BORDER};border-radius:14px;padding:6px 0">
    <div style="padding:14px 22px 12px;font-weight:600;font-size:14.5px;border-bottom:1px solid {DIVIDER}">สินค้าขายดี</div>
    {flat(rows_html)}
    </div>""")


def open_tournaments_card(open_events: list, regs_by_event: dict) -> str:
    rows_html = ""
    for ev in open_events[:4]:
        applied = regs_by_event.get(ev["event_id"], 0)
        max_p = int(ev.get("max_players") or 0)
        pct = min(round(applied / max_p * 100), 100) if max_p else 0
        cap_str = f"{applied}/{max_p}" if max_p else f"{applied} คน"
        rows_html += f"""
        <div style="margin-bottom:14px">
          <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px">
            <span style="font-weight:600">{ev.get('name', '')}</span>
            <span style="color:{TEXT2}">{ev.get('date', '—')}</span>
          </div>
          <div style="height:7px;background:{DIVIDER};border-radius:4px;overflow:hidden">
            <div style="height:100%;background:{PRIMARY_BTN};width:{pct}%"></div>
          </div>
          <div style="text-align:right;font-size:11px;color:{TEXT3};margin-top:3px">{cap_str}</div>
        </div>
        """
    if not rows_html:
        rows_html = f'<div style="font-size:13px;color:{TEXT3}">ไม่มีทัวร์นาเมนต์เปิดรับสมัคร</div>'
    return flat(f"""<div style="background:{SURFACE};border:1px solid {BORDER};border-radius:14px;padding:18px 20px">
    <div style="font-weight:600;font-size:14.5px;margin-bottom:14px">ทัวร์นาเมนต์ที่กำลังเปิดรับสมัคร</div>
    {flat(rows_html)}
    </div>""")


def home():
    now = datetime.now(TH_TZ)
    subtitle = f"{THAI_DAYS[now.weekday()]}ที่ {now.day} {THAI_MONTHS[now.month - 1]} {now.year + 543}"

    page_header("ภาพรวมวันนี้ · ทุกสาขา", subtitle)

    orders, tourney, gym, low_stock = load_summary()
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
                <div style="height:100%;background:{ACCENT_TEXT};width:{pct}%"></div>
              </div>
            </div>
            """
        if not rows_html:
            rows_html = f'<div style="font-size:13px;color:{TEXT3}">ยังไม่มียอดขายวันนี้</div>'
        st.markdown(
            flat(f"""<div style="background:{SURFACE};border:1px solid {BORDER};border-radius:14px;padding:18px 20px">
            <div style="font-weight:600;font-size:14.5px;margin-bottom:14px">ยอดขายแยกตามสาขา</div>
            {flat(rows_html)}
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
            flat(f"""<div style="background:{SURFACE};border:1px solid {BORDER};border-radius:14px;padding:6px 0">
            <div style="padding:16px 22px 12px;font-weight:600;font-size:14.5px;border-bottom:1px solid {DIVIDER}">กิจกรรมล่าสุด</div>
            {flat(rows_html)}
            </div>"""),
            unsafe_allow_html=True,
        )

    st.markdown("<div style='height:20px'></div>", unsafe_allow_html=True)
    st.markdown(stock_warning_card(low_stock), unsafe_allow_html=True)

    st.markdown("<div style='height:20px'></div>", unsafe_allow_html=True)
    d1, d2 = st.columns([1, 1.4])
    with d1:
        st.markdown(top_products_card(top_products(recent_orders)), unsafe_allow_html=True)
    with d2:
        st.markdown(
            open_tournaments_card(tourney.get("open_events", []), tourney.get("regs_by_event", {})),
            unsafe_allow_html=True,
        )


st.set_page_config(page_title="WAKA", page_icon="🏠", layout="wide", initial_sidebar_state="expanded")
apply_theme()
_require_login()
st.logo(str(ASSETS_DIR / "waka_logo.png"), icon_image=str(ASSETS_DIR / "waka_icon.png"), size="large")

home_pg = st.Page(home, title="หน้าแรก", icon="🏠", url_path="", default=True)
orders_pg = st.Page("screens/orders.py", title="ออเดอร์", icon="🛒", url_path="orders")
tournament_pg = st.Page("screens/tournament.py", title="ทัวร์นาเมนต์", icon="🏆", url_path="tournament")
wakagym_pg = st.Page("screens/wakagym.py", title="WAKA GYM", icon="🏋️", url_path="wakagym")
stock_pg = st.Page("screens/stock.py", title="สต็อกและสินค้า", icon="📦", url_path="stock")
report_pg = st.Page("screens/report.py", title="รายงาน", icon="📊", url_path="report")
settings_pg = st.Page("screens/settings.py", title="ตั้งค่า", icon="⚙️", url_path="settings")

pg = st.navigation({"เมนูหลัก": [home_pg, orders_pg, stock_pg, report_pg, tournament_pg, wakagym_pg, settings_pg]})

with st.sidebar:
    if st.button("🔄 โหลดใหม่", use_container_width=True):
        st.cache_data.clear()
        st.rerun()
    st.caption(f"👤 {st.session_state.get('admin_name', '')}")
    if st.button("ออกจากระบบ", use_container_width=True):
        st.session_state.pop("authed", None)
        st.session_state.pop("admin_name", None)
        st.rerun()

pg.run()
