#!/usr/bin/env python3
"""WAKA Tournament — Event & registrant management (mirrors liff/tournament_admin.html)"""

import sys
from pathlib import Path
from datetime import datetime, timezone, timedelta

import requests
import streamlit as st
import pandas as pd
from dotenv import load_dotenv

load_dotenv()

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from theme import apply_theme, badge, page_header

try:
    from streamlit_qrcode_scanner import qrcode_scanner as _qr_scanner
    HAS_SCANNER = True
except ImportError:
    HAS_SCANNER = False

WAKA_S   = "wk26xK9mPqRt"
GAS_URL  = "https://script.google.com/macros/s/AKfycbz52wvADM7O1zMjqKlT2G4HPkq8gwAon_fUCuKgbmUMkDPQkaYKUWnv598U3EkFN1AByQ/exec"
LIFF_BASE = "https://liff.line.me/2010457385-JHbMDl5I"
TH_TZ = timezone(timedelta(hours=7))

STATUS_LABEL = {"open": "🟢 เปิดรับสมัคร", "closed": "🟡 ปิดรับสมัคร",
                "draft": "⚫ Draft", "completed": "✅ จบแล้ว"}
SLIP_LABEL = {"cash": "💵 เงินสด", "pending": "🟡 รอตรวจ", "verified": "🟢 ยืนยันแล้ว"}


def gas_get(do: str, **params) -> dict:
    q = {"action": "api", "do": do, "_s": WAKA_S, **params}
    r = requests.get(GAS_URL, params=q, timeout=30)
    r.raise_for_status()
    return r.json()


# ── Page config ───────────────────────────────────────────────────────────────
apply_theme()
page_header("ทัวร์นาเมนต์", "สร้าง จัดการ และติดตามผู้สมัครแข่งขัน")

if st.button("🔄 โหลดใหม่"):
    st.cache_data.clear()
    st.rerun()


@st.cache_data(ttl=30)
def load_events() -> list:
    return gas_get("tournament_events").get("events", [])


tab_events, tab_players = st.tabs(["🗓 จัดการทัวร์นาเมนต์", "👥 ผู้สมัคร / เช็คอิน"])

# ══════════════════════════════════════════════════════════════════════════════
# TAB 1 — Events
# ══════════════════════════════════════════════════════════════════════════════
with tab_events:
    with st.expander("➕ สร้างทัวร์นาเมนต์ใหม่"):
        name = st.text_input("ชื่องาน *", key="new_name")
        c1, c2 = st.columns(2)
        ev_date = c1.date_input("วันจัดงาน *", key="new_date")
        max_players = c2.number_input("จำนวนผู้สมัครสูงสุด (0 = ไม่จำกัด)", min_value=0, value=0, key="new_max")
        reg_close = st.date_input("วันปิดรับสมัคร (ไม่บังคับ)", value=None, key="new_close")
        rules = st.text_area("กติกา / รายละเอียด (แสดงในฟอร์มลูกค้า)", key="new_rules")

        st.markdown("**ประเภทการแข่งขัน** (เพิ่มได้หลายประเภท ต่างราคา — เว้นว่างถ้าใช้ค่าสมัครเดียว)")
        cats_df = st.data_editor(
            pd.DataFrame(columns=["ชื่อประเภท", "ราคา"]),
            num_rows="dynamic", key="new_cats", use_container_width=True,
            column_config={"ราคา": st.column_config.NumberColumn("ราคา", min_value=0)},
        )
        flat_fee = st.number_input("ค่าสมัคร (บาท) — ใช้เมื่อไม่มีประเภท", min_value=0, value=0, key="new_fee")

        if st.button("สร้างทัวร์นาเมนต์", type="primary"):
            if not name.strip():
                st.error("กรุณากรอกชื่องาน")
            else:
                cats = [
                    {"name": str(r["ชื่อประเภท"]).strip(), "fee": int(r["ราคา"] or 0)}
                    for _, r in cats_df.iterrows() if str(r["ชื่อประเภท"] or "").strip()
                ]
                try:
                    d = gas_get(
                        "tournament_create_event",
                        name=name.strip(),
                        date=str(ev_date),
                        entry_fee=0 if cats else flat_fee,
                        max_players=max_players,
                        registration_close=str(reg_close) if reg_close else "",
                        rules_text=rules,
                    )
                    if not d.get("ok"):
                        st.error(d.get("error", "เกิดข้อผิดพลาด"))
                    else:
                        for c in cats:
                            gas_get("tournament_add_category", event=d["event_id"], name=c["name"], fee=c["fee"])
                        st.success(f"สร้างแล้ว ✅ ลิงก์ลงทะเบียน:\n\n{d['reg_link']}")
                        st.code(d["reg_link"])
                        st.cache_data.clear()
                except Exception as e:
                    st.error(f"เกิดข้อผิดพลาด: {e}")

    st.divider()
    events = load_events()
    if not events:
        st.info("ยังไม่มีทัวร์นาเมนต์")
    for ev in events:
        link = f"{LIFF_BASE}?event={ev['event_id']}"
        meta = f"📅 {ev.get('date','—')}"
        if ev.get("entry_fee"):
            meta += f" · 💰 {int(ev['entry_fee']):,} บาท"
        if ev.get("max_players"):
            meta += f" · 👤 max {ev['max_players']}"
        label = f"{STATUS_LABEL.get(ev.get('status',''), ev.get('status',''))} · **{ev['name']}** — {meta}"

        with st.expander(label):
            st.code(link)

            bc1, bc2, bc3, bc4 = st.columns(4)
            if ev.get("status") != "open" and bc1.button("🟢 เปิดรับสมัคร", key=f"open_{ev['event_id']}"):
                gas_get("tournament_update_event", event=ev["event_id"], status="open")
                st.cache_data.clear(); st.rerun()
            if ev.get("status") == "open" and bc2.button("🟡 ปิดรับสมัคร", key=f"close_{ev['event_id']}"):
                gas_get("tournament_update_event", event=ev["event_id"], status="closed")
                st.cache_data.clear(); st.rerun()
            if ev.get("status") != "completed" and bc3.button("✅ จบแล้ว", key=f"done_{ev['event_id']}"):
                gas_get("tournament_update_event", event=ev["event_id"], status="completed")
                st.cache_data.clear(); st.rerun()

            st.markdown("**ประเภทการแข่งขัน**")
            try:
                cats = gas_get("tournament_categories", event=ev["event_id"]).get("categories", [])
            except Exception:
                cats = []
            for c in cats:
                cc1, cc2, cc3 = st.columns([3, 1, 1])
                cc1.write(c["name"])
                cc2.write(f"฿{int(c['entry_fee']):,}")
                if cc3.button("ลบ", key=f"delcat_{c['category_id']}"):
                    gas_get("tournament_delete_category", category_id=c["category_id"])
                    st.rerun()
            nc1, nc2, nc3 = st.columns([3, 1, 1])
            new_cat_name = nc1.text_input("ชื่อรายการใหม่", key=f"ncname_{ev['event_id']}", label_visibility="collapsed", placeholder="ชื่อรายการ")
            new_cat_fee = nc2.number_input("ราคา", key=f"ncfee_{ev['event_id']}", label_visibility="collapsed", min_value=0)
            if nc3.button("+ เพิ่ม", key=f"addcat_{ev['event_id']}"):
                if new_cat_name.strip():
                    gas_get("tournament_add_category", event=ev["event_id"], name=new_cat_name.strip(), fee=new_cat_fee)
                    st.rerun()

            st.markdown("**แก้ไขข้อมูล**")
            with st.form(key=f"editform_{ev['event_id']}"):
                e_name = st.text_input("ชื่องาน", value=ev.get("name", ""))
                ec1, ec2 = st.columns(2)
                e_date = ec1.text_input("วันจัดงาน (yyyy-mm-dd)", value=ev.get("date", ""))
                e_max = ec2.number_input("จำนวนสูงสุด (0 = ไม่จำกัด)", min_value=0, value=int(ev.get("max_players") or 0))
                e_close = st.text_input("วันปิดรับสมัคร (yyyy-mm-dd, ไม่บังคับ)", value=ev.get("registration_close", ""))
                e_fee = st.number_input("ค่าสมัคร (บาท — ใช้เมื่อไม่มีประเภท)", min_value=0, value=int(ev.get("entry_fee") or 0))
                e_rules = st.text_area("กติกา / รายละเอียด", value=ev.get("rules_text", ""))
                if st.form_submit_button("💾 บันทึก"):
                    if not e_name.strip() or not e_date.strip():
                        st.error("กรุณากรอกชื่องานและวันจัดงาน")
                    else:
                        gas_get("tournament_update_event", event=ev["event_id"], name=e_name.strip(),
                                date=e_date.strip(), max_players=e_max, registration_close=e_close.strip(),
                                entry_fee=e_fee, rules_text=e_rules)
                        st.cache_data.clear(); st.rerun()

# ══════════════════════════════════════════════════════════════════════════════
# TAB 2 — Registrants / check-in
# ══════════════════════════════════════════════════════════════════════════════
with tab_players:
    events = load_events()
    if not events:
        st.info("ยังไม่มีทัวร์นาเมนต์")
        st.stop()

    ev_names = {ev["event_id"]: f"{ev['name']} ({ev.get('date','—')})" for ev in events}
    sel_id = st.selectbox("เลือกทัวร์นาเมนต์", list(ev_names.keys()), format_func=lambda i: ev_names[i])

    try:
        players = gas_get("tournament_list", event=sel_id).get("players", [])
    except Exception as e:
        st.error(f"โหลดไม่ได้: {e}")
        players = []

    total = len(players)
    checked = sum(1 for p in players if p.get("checked_in_at"))
    verified = sum(1 for p in players if p.get("slip_status") in ("verified", "cash"))
    k1, k2, k3 = st.columns(3)
    k1.metric("ผู้สมัครทั้งหมด", total)
    k2.metric("เช็คอินแล้ว", checked)
    k3.metric("ชำระเงินแล้ว", verified)

    try:
        csv_resp = requests.get(GAS_URL, params={"action": "api", "do": "tournament_export", "_s": WAKA_S, "event": sel_id}, timeout=30)
        st.download_button("⬇️ Export CSV", csv_resp.content, file_name=f"{sel_id}.csv", mime="text/csv")
    except Exception:
        pass

    if HAS_SCANNER:
        st.markdown("**📷 สแกน QR เช็คอิน**")
        scanned = _qr_scanner(key=f"qr_{sel_id}")
        if scanned:
            match = next((p for p in players if p["reg_id"] == scanned.strip()), None)
            if not match:
                st.error(f"ไม่พบ reg_id '{scanned}' ในทัวร์นาเมนต์นี้")
            elif match.get("checked_in_at"):
                st.warning(f"⚠️ {match.get('player_name') or match.get('real_name')} เช็คอินไปแล้ว")
            else:
                now = datetime.now(TH_TZ).strftime("%Y-%m-%d %H:%M")
                gas_get("tournament_update_reg", reg_id=match["reg_id"], field="checked_in_at", value=now)
                st.success(f"✅ เช็คอิน {match.get('player_name') or match.get('real_name')} แล้ว!")
                st.rerun()
        st.divider()

    search = st.text_input("🔍 ค้นหา", placeholder="ชื่อ / เบอร์ / reg_id")
    rows = players
    if search:
        s = search.lower()
        rows = [p for p in rows if s in (p.get("real_name","")+p.get("player_name","")+p.get("phone","")+p.get("reg_id","")).lower()]

    for p in rows:
        c1, c2, c3, c4 = st.columns([3, 2, 2, 2])
        name_line = f"#{p.get('sequence_no','')} · {p.get('player_name') or '—'} ({p.get('real_name','—')})"
        c1.write(name_line)
        c2.write(f"📞 {p.get('phone','—')}")
        slip_kind = "success" if p.get("slip_status") in ("cash", "verified") else "pending"
        c3.markdown(
            badge(SLIP_LABEL.get(p.get("slip_status",""), p.get("slip_status","—")), slip_kind),
            unsafe_allow_html=True,
        )
        with c4:
            b1, b2 = st.columns(2)
            if p.get("slip_status") == "pending" and b1.button("✅ ยืนยัน", key=f"verify_{p['reg_id']}"):
                gas_get("tournament_update_reg", reg_id=p["reg_id"], field="slip_status", value="verified")
                st.rerun()
            if p.get("checked_in_at"):
                b2.write("🎫 เช็คอินแล้ว")
            elif b2.button("🎫 เช็คอิน", key=f"checkin_{p['reg_id']}"):
                now = datetime.now(TH_TZ).strftime("%Y-%m-%d %H:%M")
                gas_get("tournament_update_reg", reg_id=p["reg_id"], field="checked_in_at", value=now)
                st.rerun()
