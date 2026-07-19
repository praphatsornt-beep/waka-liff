#!/usr/bin/env python3
"""WAKA GYM Management Dashboard"""

import json
import sys
from pathlib import Path
from datetime import date, timedelta, timezone, datetime

import streamlit as st
import pandas as pd
from dotenv import load_dotenv

load_dotenv()

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from theme import apply_theme, badge, page_header

try:
    import gspread
    from google.oauth2.service_account import Credentials
except ImportError as e:
    st.error(f"ติดตั้ง packages ก่อน: `pip install -r requirements.txt`\n\n{e}")
    st.stop()

SCOPES   = ["https://www.googleapis.com/auth/spreadsheets"]
SA_PATH  = Path("service_account.json")
SHEET_ID = "1aUHbSt3qlQ4uMIzlCGbF-iFm0AqSeqx12nxk5ny1JoY"
GAS_URL    = "https://script.google.com/macros/s/AKfycbz52wvADM7O1zMjqKlT2G4HPkq8gwAon_fUCuKgbmUMkDPQkaYKUWnv598U3EkFN1AByQ/exec"

TH_TZ = timezone(timedelta(hours=7))

# ── Auth ─────────────────────────────────────────────────────────────────────
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


def _now_th():
    return datetime.now(TH_TZ).strftime("%Y-%m-%d")


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


# ── Data loading ─────────────────────────────────────────────────────────────
@st.cache_data(ttl=120)
def load_registrations() -> pd.DataFrame:
    try:
        rows = get_supabase().table("wakagym_registrations").select("*").execute().data
        return pd.DataFrame(rows) if rows else pd.DataFrame()
    except Exception as e:
        st.error(f"โหลด wakagym_reg ไม่ได้: {e}")
        return pd.DataFrame()


@st.cache_data(ttl=120)
def load_player_stats() -> pd.DataFrame:
    try:
        ws = get_gc().open_by_key(SHEET_ID).worksheet("player_stats")
        rows = ws.get_all_values()
        if len(rows) < 2:
            return pd.DataFrame()
        df = pd.DataFrame(rows[1:], columns=rows[0])
        for col in ["total_plays", "total_tokens", "boxes_earned", "boxes_given"]:
            if col in df.columns:
                df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0).astype(int)
        df["row_num"] = range(2, len(df) + 2)
        return df
    except gspread.exceptions.WorksheetNotFound:
        return pd.DataFrame()
    except Exception as e:
        st.error(f"โหลด player_stats ไม่ได้: {e}")
        return pd.DataFrame()


def update_reg_field(reg_id: str, field: str, value: str):
    import requests
    requests.get(
        GAS_URL,
        params={"action": "api", "do": "wakagym_update_reg", "reg_id": reg_id, "field": field, "value": value},
        timeout=15,
    )


def give_box(player_name: str):
    import requests
    requests.get(
        GAS_URL,
        params={"action": "api", "do": "wakagym_give_box", "player_name": player_name},
        timeout=15,
    )


# ── Page config ──────────────────────────────────────────────────────────────
apply_theme()

st.markdown("""<style>
    [data-testid="stExpander"] { margin-bottom: 8px; }
    [data-testid="stMetricValue"] { font-size: 1.3rem; }
    div[data-testid="stImage"] img { border-radius: 10px; }
    .stProgress>div>div { border-radius: 6px; }
</style>""", unsafe_allow_html=True)

page_header("WAKA GYM", "เช็คอิน บันทึกผลแข่ง สถิติสะสม และตรวจสลิป")

t1, t2 = st.columns([3, 1])
with t1:
    st.empty()
with t2:
    if st.button("🔄 โหลดใหม่", use_container_width=True):
        st.cache_data.clear()
        st.rerun()

tab_today, tab_stats, tab_slips = st.tabs(["📋 วันนี้", "📦 สะสม", "🧾 ตรวจสลิป"])

# ── Tab 1: Today ─────────────────────────────────────────────────────────────
with tab_today:
    df_reg = load_registrations()

    with st.sidebar:
        st.header("กรอง")
        selected_date = st.date_input("วันที่", value=date.today())
        today_str = selected_date.strftime("%Y-%m-%d")

    if df_reg.empty:
        st.info("ยังไม่มีข้อมูลลงทะเบียน")
    else:
        today_df = df_reg[df_reg.get("event_date", pd.Series(dtype=str)) == today_str].copy()

        if today_df.empty:
            st.info(f"ไม่มีผู้ลงทะเบียนวันที่ {today_str}")
        else:
            slip_col = today_df["slip_status"] if "slip_status" in today_df.columns else pd.Series("", index=today_df.index)
            pay_col = today_df["payment_method"] if "payment_method" in today_df.columns else pd.Series("", index=today_df.index)

            verified = today_df[slip_col.isin(["verified", "cash"])]
            pending = today_df[slip_col == "pending"]
            cash_count = today_df[pay_col == "cash"]

            total_tokens = 0
            total_promo = 0
            if "tokens_earned" in today_df.columns:
                total_tokens = pd.to_numeric(today_df["tokens_earned"], errors="coerce").fillna(0).sum()
            if "promo_packs" in today_df.columns:
                total_promo = pd.to_numeric(today_df["promo_packs"], errors="coerce").fillna(0).sum()

            kpi = (
                f"📋 **{len(today_df)}** คน &nbsp;|&nbsp; "
                f"{badge(f'{len(verified)} ยืนยัน', 'success')} &nbsp; "
                f"{badge(f'{len(pending)} รอตรวจ', 'pending')} &nbsp; "
                f"🪙 **{int(total_tokens)}** token &nbsp;|&nbsp; "
                f"🎁 **{int(total_promo)}** promo &nbsp;|&nbsp; "
                f"💵 **{len(cash_count)}** เงินสด"
            )
            st.markdown(kpi, unsafe_allow_html=True)

            names_list = []
            for _, r in today_df.iterrows():
                pname = r.get("player_name") or r.get("real_name") or r.get("display_name") or "—"
                names_list.append(pname)

            if st.button("📋 คัดลอกรายชื่อแข่ง"):
                names_text = "\n".join(f"{i+1}. {n}" for i, n in enumerate(names_list))
                st.code(names_text, language=None)

            st.markdown("---")

            for _, row in today_df.iterrows():
                rid = row.get("reg_id", "")
                pname = row.get("player_name") or row.get("real_name") or "—"
                rname = row.get("real_name", "")
                slip_st = row.get("slip_status", "pending")
                pay = row.get("payment_method", "transfer")
                tokens = row.get("tokens_earned", "")
                promo = row.get("promo_packs", "")
                rewards_given = row.get("rewards_given", "")

                s_icon = "✅" if slip_st in ("verified", "cash") else ("❌" if slip_st == "rejected" else "🟡")
                pay_icon = "💵" if pay == "cash" else "📱"
                token_info = f"🪙{tokens}" if tokens else ""
                promo_info = f"🎁{promo}" if promo else ""
                given_icon = " ✅แจก" if str(rewards_given).lower() == "true" else ""

                label = f"{s_icon} **#{rid}** · {pname} · {pay_icon} {token_info} {promo_info}{given_icon}"

                with st.expander(label, expanded=(slip_st == "pending")):
                    col1, col2 = st.columns([1, 2])
                    with col1:
                        slip_url = row.get("slip_url", "")
                        if slip_url and slip_url.startswith("http"):
                            st.image(slip_url, width=150)
                        elif pay == "cash":
                            st.caption("💵 จ่ายเงินสด")
                        else:
                            st.caption("ไม่มีสลิป")
                    with col2:
                        name_display = f"**{pname}**"
                        if rname and rname != pname:
                            name_display += f" ({rname})"
                        reward_line = ""
                        if tokens:
                            reward_line += f" · 🪙 {tokens} token"
                        if promo:
                            reward_line += f" · 🎁 {promo} promo"
                        slip_kind = "success" if slip_st in ("verified", "cash") else ("danger" if slip_st == "rejected" else "pending")
                        st.markdown(
                            f"🏷️ {name_display} &nbsp; {badge(slip_st, slip_kind)}\n\n"
                            f"📱 {row.get('phone', '—')} · {pay_icon}{reward_line}",
                            unsafe_allow_html=True,
                        )
                        if row.get("note"):
                            st.caption(f"📝 {row.get('note')}")

                        c1, c2, c3 = st.columns(3)
                        with c1:
                            if slip_st not in ("verified", "cash"):
                                if st.button("✅ ยืนยัน", key=f"verify_{rid}"):
                                    update_reg_field(rid, "slip_status", "verified")
                                    st.cache_data.clear()
                                    st.rerun()
                        with c2:
                            if slip_st not in ("rejected", "cash"):
                                if st.button("❌ ปฏิเสธ", key=f"reject_{rid}"):
                                    update_reg_field(rid, "slip_status", "rejected")
                                    st.cache_data.clear()
                                    st.rerun()
                        with c3:
                            if tokens and str(rewards_given).lower() != "true":
                                if st.button("🎁 แจกแล้ว", key=f"give_{rid}"):
                                    update_reg_field(rid, "rewards_given", "TRUE")
                                    st.cache_data.clear()
                                    st.rerun()

# ── Tab 2: Player Stats ─────────────────────────────────────────────────────
with tab_stats:
    df_stats = load_player_stats()

    if df_stats.empty:
        st.info("ยังไม่มีข้อมูลผู้เล่น")
    else:
        search = st.text_input("🔍 ค้นหาผู้เล่น", placeholder="ชื่อแข่ง / ชื่อจริง", key="stats_search")
        if search:
            s = search.lower()
            mask = pd.Series([False] * len(df_stats))
            for col_name in ["player_name", "display_name", "real_name"]:
                if col_name in df_stats.columns:
                    mask = mask | df_stats[col_name].str.lower().str.contains(s, na=False)
            df_stats = df_stats[mask]

        for _, row in df_stats.iterrows():
            pname = row.get("player_name") or row.get("real_name") or "—"
            plays = int(row.get("total_plays", 0))
            tokens = int(row.get("total_tokens", 0))
            boxes_e = int(row.get("boxes_earned", 0))
            boxes_g = int(row.get("boxes_given", 0))

            pending_box = boxes_e - boxes_g
            badge = f" 🎁 **Box ค้าง {pending_box}**" if pending_box > 0 else ""

            with st.expander(f"👤 **{pname}** · เล่น {plays} ครั้ง · 🪙 {tokens}/30{badge}"):
                c1, c2, c3 = st.columns(3)
                c1.metric("เข้าร่วม", plays)
                c2.metric("🪙 Token", f"{tokens}/30")
                c3.metric("Box ได้/แจก", f"{boxes_e}/{boxes_g}")

                pct = min(tokens / 30 * 100, 100)
                st.progress(pct / 100, text=f"🪙 {tokens}/30 token")

                if pending_box > 0:
                    if st.button(f"🎁 ให้ Box แล้ว ({pending_box} ค้าง)", key=f"box_{pname}"):
                        give_box(pname)
                        st.cache_data.clear()
                        st.rerun()

# ── Tab 3: Slip Verification ─────────────────────────────────────────────────
with tab_slips:
    df_reg2 = load_registrations()

    if df_reg2.empty:
        st.info("ยังไม่มีข้อมูล")
    else:
        slip_col2 = df_reg2["slip_status"] if "slip_status" in df_reg2.columns else pd.Series("", index=df_reg2.index)
        pending_df = df_reg2[slip_col2 == "pending"].copy()
        pending_df = pending_df.iloc[::-1].reset_index(drop=True)

        if pending_df.empty:
            st.success("ไม่มีสลิปรอตรวจ")
        else:
            st.markdown(f"**{len(pending_df)}** สลิปรอตรวจ")
            for _, row in pending_df.iterrows():
                rid = row.get("reg_id", "")
                pname = row.get("player_name") or row.get("real_name") or "—"
                ev_date = row.get("event_date", "")

                with st.expander(f"🟡 #{rid} · {pname} · {ev_date}"):
                    col1, col2 = st.columns([1, 2])
                    with col1:
                        slip_url = row.get("slip_url", "")
                        if slip_url and slip_url.startswith("http"):
                            st.image(slip_url, width=200)
                        else:
                            st.caption("ไม่มีรูปสลิป")
                    with col2:
                        st.markdown(f"🏷️ **{pname}**\n\n📅 {ev_date}")
                        c1, c2 = st.columns(2)
                        with c1:
                            if st.button("✅ ยืนยัน", key=f"sv_{rid}"):
                                update_reg_field(rid, "slip_status", "verified")
                                st.cache_data.clear()
                                st.rerun()
                        with c2:
                            if st.button("❌ ปฏิเสธ", key=f"sr_{rid}"):
                                update_reg_field(rid, "slip_status", "rejected")
                                st.cache_data.clear()
                                st.rerun()
