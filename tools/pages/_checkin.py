#!/usr/bin/env python3
"""WAKA Tournament — Check-in page (staff use on event day)"""

import json
import re
from pathlib import Path

import streamlit as st
from dotenv import load_dotenv

load_dotenv()

try:
    import gspread
    import pandas as pd
    from google.oauth2.service_account import Credentials
except ImportError as e:
    st.error(f"ติดตั้ง packages ก่อน: `pip install -r requirements.txt`\n\nรายละเอียด: {e}")
    st.stop()

try:
    from streamlit_qrcode_scanner import qrcode_scanner as _qr_scanner
    HAS_SCANNER = True
except ImportError:
    HAS_SCANNER = False

# ── Paths & constants ──────────────────────────────────────────────────────────
SCOPES   = ["https://www.googleapis.com/auth/spreadsheets"]
SA_PATH  = Path("service_account.json")
CONFIG_PATH      = Path("events_config.json")
CONFIG_SHEET_TAB = "_config"
DEFAULT_OUTPUT_URL = "https://docs.google.com/spreadsheets/d/1WSfd9sKHl2H5O7Ai1DvqVaL7Tuwni-nfBc-hTX8HilA"

# ── Google Auth ────────────────────────────────────────────────────────────────
@st.cache_resource
def get_gc():
    try:
        if "GOOGLE_SERVICE_ACCOUNT" in st.secrets:
            info = json.loads(st.secrets["GOOGLE_SERVICE_ACCOUNT"])
            creds = Credentials.from_service_account_info(info, scopes=SCOPES)
            return gspread.authorize(creds)
    except Exception:
        pass
    creds = Credentials.from_service_account_file(str(SA_PATH), scopes=SCOPES)
    return gspread.authorize(creds)

# ── Config loading (โหลดจาก Google Sheet ก่อน fallback ไฟล์ local) ──────────
def _parse_sheet_id_simple(url: str) -> str:
    m = re.search(r"/spreadsheets/d/([a-zA-Z0-9_-]+)", url.strip())
    if m:
        return m.group(1)
    if re.match(r"^[a-zA-Z0-9_-]{20,}$", url.strip()):
        return url.strip()
    raise ValueError("URL ไม่ถูกต้อง")

def _bootstrap_output_url() -> str:
    try:
        url = st.secrets.get("OUTPUT_SHEET_URL", "") or ""
        if url.strip():
            return url.strip()
    except Exception:
        pass
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8")).get("output_sheet_url", "")
        except Exception:
            pass
    return DEFAULT_OUTPUT_URL

def load_config() -> dict:
    bootstrap_url = _bootstrap_output_url()
    if bootstrap_url:
        try:
            sid = _parse_sheet_id_simple(bootstrap_url)
            ws  = get_gc().open_by_key(sid).worksheet(CONFIG_SHEET_TAB)
            raw = ws.cell(1, 1).value
            if raw:
                return json.loads(raw)
        except Exception:
            pass
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"events": [], "output_sheet_url": bootstrap_url or ""}

# ── Helpers ────────────────────────────────────────────────────────────────────
def parse_sheet_id(url: str) -> str:
    m = re.search(r"/spreadsheets/d/([a-zA-Z0-9_-]+)", url.strip())
    if m:
        return m.group(1)
    if re.match(r"^[a-zA-Z0-9_-]{20,}$", url.strip()):
        return url.strip()
    raise ValueError("Output Sheet URL ไม่ถูกต้อง")

def sync_checkin(out_id: str, ev_name: str, ci_state: dict, name_filter=None):
    ws   = get_gc().open_by_key(out_id).worksheet(f"ลงทะเบียน — {ev_name}")
    rows = ws.get_all_values()
    if len(rows) < 2:
        return
    hdr    = rows[0]
    n_idx  = next((i for i, h in enumerate(hdr) if h == "ชื่อที่ใช้แข่ง"), 1)
    ci_idx = next((i for i, h in enumerate(hdr) if "เช็คอิน" in h), 2)
    for r_idx, r in enumerate(rows[1:], start=2):
        pname = r[n_idx] if n_idx < len(r) else ""
        if name_filter and pname != name_filter:
            continue
        if pname in ci_state:
            ws.update_cell(r_idx, ci_idx + 1, ci_state[pname])

# ── Page config ────────────────────────────────────────────────────────────────
st.set_page_config(page_title="WAKA Check-in", page_icon="🎫", layout="centered")
st.title("🎫 เช็คอิน วันงาน")

# ── Load config ────────────────────────────────────────────────────────────────
config     = load_config()
events     = config.get("events", [])
output_url = config.get("output_sheet_url", "")

if not events:
    st.warning("ยังไม่มีการแข่งขัน — ตั้งค่าในหน้าหลักแล้วกด 💾 บันทึกการตั้งค่าก่อน")
    st.stop()
if not output_url:
    st.warning("ยังไม่ได้ตั้งค่า Output Sheet — กลับหน้าหลักแล้วกรอก URL แล้วกด 💾 บันทึก")
    st.stop()

try:
    out_id = parse_sheet_id(output_url)
except Exception as e:
    st.error(str(e))
    st.stop()

# ── Event selector ─────────────────────────────────────────────────────────────
event_names = [
    str(e.get("ชื่อการแข่งขัน", "")).strip()
    for e in events
    if str(e.get("ชื่อการแข่งขัน", "")).strip()
]
ev = st.selectbox("การแข่งขัน", event_names)

data_key      = f"ci_data_{ev}"
names_key     = f"ci_names_{ev}"
scan_key      = f"ci_scan_{ev}"
last_scan_key = f"ci_last_{ev}"

# ── Load participants ──────────────────────────────────────────────────────────
col_btn, col_stat = st.columns([1, 3])
if col_btn.button("📋 โหลดรายชื่อ", key=f"load_{ev}"):
    try:
        ws   = get_gc().open_by_key(out_id).worksheet(f"ลงทะเบียน — {ev}")
        rows = ws.get_all_values()
        if len(rows) < 2:
            st.warning("ยังไม่มีรายชื่อ — สร้างใบลงทะเบียนจากหน้าหลักก่อน")
        else:
            hdr    = rows[0]
            n_idx  = next((i for i, h in enumerate(hdr) if h == "ชื่อที่ใช้แข่ง"), 1)
            ci_idx = next((i for i, h in enumerate(hdr) if "เช็คอิน" in h), 2)
            numi   = next((i for i, h in enumerate(hdr) if h == "ลำดับ"), 0)
            names, ci_data = [], {}
            for r in rows[1:]:
                name = r[n_idx]  if n_idx  < len(r) else ""
                ci_v = r[ci_idx] if ci_idx < len(r) else ""
                num  = r[numi]   if numi   < len(r) else ""
                if name:
                    names.append((num, name))
                    ci_data[name] = ci_v
            st.session_state[names_key] = names
            st.session_state[data_key]  = ci_data
            st.rerun()
    except gspread.WorksheetNotFound:
        st.error(f"ไม่พบชีต 'ลงทะเบียน — {ev}' — สร้างจากหน้าหลักก่อน")
    except Exception as e:
        st.error(f"โหลดไม่ได้: {e}")

if names_key not in st.session_state:
    st.stop()

names   = st.session_state[names_key]
ci_data = st.session_state.get(data_key, {})
valid   = {n for _, n in names}
checked = sum(1 for n in valid if ci_data.get(n))
col_stat.metric("เช็คอินแล้ว", f"{checked} / {len(names)}")

# ── QR Scanner ─────────────────────────────────────────────────────────────────
if HAS_SCANNER:
    st.write("**📷 สแกน QR จากอีเมลผู้แข่ง**")
    scanned = _qr_scanner(key=f"qr_{ev}")

    if scanned and scanned != st.session_state.get(last_scan_key, ""):
        st.session_state[last_scan_key] = scanned
        if scanned.startswith("WAKA|"):
            parts = scanned.split("|")
            sname = parts[2] if len(parts) >= 3 else ""
            if sname in valid:
                if ci_data.get(sname):
                    st.session_state[scan_key] = ("warning", f"⚠️ {sname} เช็คอินไปแล้ว")
                else:
                    ci_data[sname] = "✓"
                    st.session_state[data_key] = ci_data
                    try:
                        sync_checkin(out_id, ev, ci_data, name_filter=sname)
                    except Exception:
                        pass
                    st.session_state[scan_key] = ("success", f"✅ เช็คอิน **{sname}** แล้ว!")
            else:
                st.session_state[scan_key] = ("error", f"ไม่พบ '{sname}' ในรายการ {ev}")
        else:
            st.session_state[scan_key] = ("error", "QR ไม่ถูกต้อง — ใช้ QR จากอีเมลยืนยัน")

    if scan_key in st.session_state:
        lvl, msg = st.session_state[scan_key]
        if lvl == "success":   st.success(msg)
        elif lvl == "warning": st.warning(msg)
        else:                  st.error(msg)

    st.divider()

# ── Manual list ────────────────────────────────────────────────────────────────
search = st.text_input("🔍 ค้นหา", placeholder="พิมพ์ชื่อ…")
df_rows = [
    {"เช็คอิน ✓": bool(ci_data.get(n, "")), "#": num, "ชื่อที่ใช้แข่ง": n}
    for num, n in names
]
df = pd.DataFrame(df_rows)
if search:
    df = df[df["ชื่อที่ใช้แข่ง"].str.contains(search, case=False, na=False)]

edited = st.data_editor(
    df,
    key=f"ed_{ev}",
    column_config={
        "เช็คอิน ✓":      st.column_config.CheckboxColumn("เช็คอิน ✓", width="small"),
        "#":               st.column_config.TextColumn("#", width="small"),
        "ชื่อที่ใช้แข่ง": st.column_config.TextColumn("ชื่อที่ใช้แข่ง"),
    },
    disabled=["#", "ชื่อที่ใช้แข่ง"],
    hide_index=True,
    use_container_width=True,
)

if st.button("💾 บันทึกเช็คอิน"):
    for _, row in edited.iterrows():
        ci_data[row["ชื่อที่ใช้แข่ง"]] = "✓" if row["เช็คอิน ✓"] else ""
    st.session_state[data_key] = ci_data
    try:
        sync_checkin(out_id, ev, ci_data)
        st.success("✅ บันทึกเช็คอินแล้ว")
    except Exception as e:
        st.error(f"บันทึกไม่ได้: {e}")
    st.rerun()
