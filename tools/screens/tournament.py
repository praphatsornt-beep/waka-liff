#!/usr/bin/env python3
"""WAKA Tournament — Event & registrant management (mirrors liff/tournament_admin.html)"""

import json
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


def gas_post(payload: dict) -> dict:
    resp = requests.post(f"{GAS_URL}?_s={WAKA_S}", json=payload, timeout=30)
    result = resp.json()
    if not result.get("ok"):
        raise Exception(result.get("error", "GAS ตอบผิดพลาด"))
    return result


CLOSING_MESSAGE = (
    "ขอขอบคุณทุกท่านที่มาร่วมกิจกรรมกับพวกเราที่ WAKA นะครับ 🙏\n"
    "หวังเป็นอย่างยิ่งว่าทุกท่านจะได้รับความสนุกและความประทับใจจากงานของเรา "
    "แล้วพบกันใหม่ในกิจกรรมครั้งหน้านะครับ 💛\n"
    "หากมีข้อผิดพลาดประการใด ทางทีมงานต้องขออภัยเป็นอย่างยิ่ง และจะนำทุกข้อเสนอแนะไปปรับปรุง "
    "เพื่อให้กิจกรรมครั้งต่อ ๆ ไปดียิ่งขึ้นครับ 🙇"
)


@st.cache_resource
def get_supabase():
    import os
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


# ── Page config ───────────────────────────────────────────────────────────────
apply_theme()
page_header("ทัวร์นาเมนต์", "สร้าง จัดการ และติดตามผู้สมัครแข่งขัน")


@st.cache_data(ttl=30)
def load_events() -> list:
    # newest-created first, matching gas/Code.gs's tournament_events action (tevList.reverse())
    rows = get_supabase().table("tournament_events").select("*").execute().data
    return sorted(rows, key=lambda e: e.get("created_at") or "", reverse=True)


@st.cache_data(ttl=30)
def load_categories(event_id: str) -> list:
    rows = (
        get_supabase().table("tournament_categories").select("*")
        .eq("event_id", event_id).neq("status", "deleted").execute().data
    )
    return sorted(rows, key=lambda c: c.get("sort_order") or 0)


@st.cache_data(ttl=30)
def load_players(event_id: str) -> list:
    return (
        get_supabase().table("tournament_registrations").select("*")
        .eq("event_id", event_id).execute().data
    )


CONFIRMED_REG_STATUS = ("verified", "cash")


@st.cache_data(ttl=30)
def load_all_players() -> list:
    """Cross-event registrations for overview KPIs / remaining-slots — one
    query instead of looping load_players() per event."""
    return get_supabase().table("tournament_registrations").select("event_id,amount_paid,slip_status").execute().data


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

    all_players = load_all_players()
    applicants_by_event: dict = {}
    fee_collected = 0
    for p in all_players:
        applicants_by_event[p.get("event_id")] = applicants_by_event.get(p.get("event_id"), 0) + 1
        if p.get("slip_status") in CONFIRMED_REG_STATUS:
            fee_collected += int(p.get("amount_paid") or 0)

    ok1, ok2, ok3, ok4 = st.columns(4)
    ok1.metric("ทัวร์นาเมนต์ทั้งหมด", len(events))
    ok2.metric("เปิดรับสมัคร", sum(1 for e in events if e.get("status") == "open"))
    ok3.metric("ผู้สมัครรวม", len(all_players))
    ok4.metric("ค่าสมัครเก็บแล้ว (฿)", f"{fee_collected:,}")

    ef1, ef2 = st.columns([2, 1])
    ev_search = ef1.text_input("🔍 ค้นหาชื่องาน", key="ev_search", label_visibility="collapsed", placeholder="🔍 ค้นหาชื่องาน")
    ev_status_filter = ef2.selectbox(
        "สถานะ", ["ทุกสถานะ"] + list(STATUS_LABEL.keys()), key="ev_status_filter",
        format_func=lambda s: "ทุกสถานะ" if s == "ทุกสถานะ" else STATUS_LABEL.get(s, s),
        label_visibility="collapsed",
    )

    if ev_search:
        events = [e for e in events if ev_search.lower() in (e.get("name") or "").lower()]
    if ev_status_filter != "ทุกสถานะ":
        events = [e for e in events if e.get("status") == ev_status_filter]

    if not events:
        st.info("ไม่มีทัวร์นาเมนต์ตามเงื่อนไขที่เลือก")
    for ev in events:
        link = f"{LIFF_BASE}?event={ev['event_id']}"
        meta = f"📅 {ev.get('date','—')}"
        if ev.get("entry_fee"):
            meta += f" · 💰 {int(ev['entry_fee']):,} บาท"
        applicants_n = applicants_by_event.get(ev["event_id"], 0)
        if ev.get("max_players"):
            max_players_n = int(ev["max_players"])
            slots_left = max(max_players_n - applicants_n, 0)
            meta += f" · 👤 {applicants_n}/{max_players_n} (เหลือ {slots_left} ที่)"
        elif applicants_n:
            meta += f" · 👤 {applicants_n} คนสมัครแล้ว"
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
                cats = load_categories(ev["event_id"])
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
        players = load_players(sel_id)
    except Exception as e:
        st.error(f"โหลดไม่ได้: {e}")
        players = []

    total = len(players)
    checked = sum(1 for p in players if p.get("checked_in_at"))
    verified = sum(1 for p in players if p.get("slip_status") in CONFIRMED_REG_STATUS)
    fee_paid = sum(int(p.get("amount_paid") or 0) for p in players if p.get("slip_status") in CONFIRMED_REG_STATUS)
    fee_pending = sum(int(p.get("amount_paid") or 0) for p in players if p.get("slip_status") not in CONFIRMED_REG_STATUS)
    k1, k2, k3, k4, k5 = st.columns(5)
    k1.metric("ผู้สมัครทั้งหมด", total)
    k2.metric("เช็คอินแล้ว", checked)
    k3.metric("ชำระเงินแล้ว", verified)
    k4.metric("ค่าสมัครเก็บแล้ว (฿)", f"{fee_paid:,}")
    k5.metric("รอเก็บ (฿)", f"{fee_pending:,}")

    dl_col, notify_col = st.columns([1, 1])
    with dl_col:
        try:
            csv_resp = requests.get(GAS_URL, params={"action": "api", "do": "tournament_export", "_s": WAKA_S, "event": sel_id}, timeout=30)
            st.download_button("⬇️ Export CSV", csv_resp.content, file_name=f"{sel_id}.csv", mime="text/csv")
        except Exception:
            pass
    with notify_col:
        eligible_players = [
            p for p in players
            if p.get("slip_status") in CONFIRMED_REG_STATUS and str(p.get("line_user_id") or "").strip()
        ]
        with st.popover(f"🏆 ส่งข้อความปิดงาน ({len(eligible_players)})", use_container_width=True):
            st.caption("ส่งข้อความนี้ให้ผู้สมัครที่ชำระเงินแล้วทุกคนในทัวร์นาเมนต์นี้ (แก้ไขได้ก่อนส่ง) — เช่น ขอบคุณ/ปิดงานหลังทัวร์นาเมนต์จบ")
            closing_msg = st.text_area(
                "ข้อความ", value=CLOSING_MESSAGE,
                key=f"tour_closing_msg_{sel_id}", height=170, label_visibility="collapsed",
            )
            if st.button(
                f"🏆 ส่งให้ผู้สมัคร {len(eligible_players)} คน",
                key=f"tour_closing_btn_{sel_id}", type="primary", use_container_width=True,
                disabled=not eligible_players,
            ):
                try:
                    result = gas_post({
                        "_action": "notifyTournamentPlayers",
                        "reg_ids": [p["reg_id"] for p in eligible_players],
                        "custom_message": closing_msg,
                    })
                    st.success(f"ส่งแล้ว {result.get('sent', 0)} คน")
                except Exception as e:
                    st.error(f"ส่งไม่ได้: {e}")

    st.markdown(f"**รายชื่อผู้สมัคร** ({len(players)} คน)")
    search = st.text_input("🔍 ค้นหา", placeholder="ชื่อ / เบอร์ / reg_id")
    rows = players
    if search:
        s = search.lower()
        rows = [p for p in rows if s in (p.get("real_name","")+p.get("player_name","")+p.get("phone","")+p.get("reg_id","")).lower()]

    if not rows:
        st.info("ไม่พบผู้สมัครตามที่ค้นหา" if search else "ยังไม่มีผู้สมัครในทัวร์นาเมนต์นี้")

    for p in rows:
        c1, c2, c3, c4 = st.columns([3, 2, 2, 2])
        name_line = f"#{p.get('sequence_no','')} · {p.get('player_name') or '—'} ({p.get('real_name','—')})"
        c1.write(name_line)
        cats = p.get("selected_categories")
        if isinstance(cats, str):
            try:
                cats = json.loads(cats)
            except Exception:
                cats = []
        cat_names = ", ".join(c.get("name", "") for c in (cats or []) if c.get("name"))
        c1.caption(f"🏷️ {cat_names}" if cat_names else "🏷️ ไม่ระบุประเภท")
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
