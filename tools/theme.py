#!/usr/bin/env python3
"""Shared WAKA visual theme (fonts, coffee/gray palette, status colors).

Colors and fonts are lifted from the WAKA Admin Dashboard design mockup's
`themeVars()` (light mode) so every Streamlit admin page matches it.
Import and call `apply_theme()` once near the top of each page, after
`st.set_page_config(...)`.
"""

import streamlit as st

BG = "#F0EEEA"
SURFACE = "#FFFFFF"
SURFACE_ALT = "#F5F3EE"
BORDER = "#DDD8CE"
BORDER2 = "#CFC9BC"
DIVIDER = "#E6E2D8"
DIVIDER2 = "#ECE9E1"
TEXT = "#2B2723"
TEXT2 = "#6B655C"
TEXT3 = "#78716A"
TEXT4 = "#57514A"
ACCENT_LIGHT = "#E4D9CB"
ACCENT_TEXT = "#56392A"
SIDEBAR_BG = "#1E1B18"
SIDEBAR_TEXT = "#E8E4DD"

PENDING_BG, PENDING_TEXT = "#F6E7CF", "#C4791F"
SUCCESS_BG, SUCCESS_TEXT = "#E1EFDE", "#3F7A4F"
DANGER_BG, DANGER_TEXT = "#F6DEDA", "#B23A2E"

_CSS = f"""
<style>
@import url('https://fonts.googleapis.com/css2?family=Prompt:wght@500;600;700&family=Public+Sans:wght@400;500;600;700&display=swap');

html, body, [class*="css"] {{ font-family: 'Public Sans', sans-serif; }}
h1, h2, h3, h4,
[data-testid="stMetricValue"],
[data-testid="stSidebar"] h1,
[data-testid="stSidebar"] h2,
[data-testid="stSidebar"] h3 {{ font-family: 'Prompt', sans-serif !important; }}

.stApp {{ background: {BG}; color: {TEXT}; }}

[data-testid="stSidebar"] {{ background: {SIDEBAR_BG}; width: 200px !important; min-width: 200px !important; }}
[data-testid="stSidebar"] * {{ color: {SIDEBAR_TEXT} !important; }}
[data-testid="stSidebarNav"] span {{ font-size: 13.5px !important; }}
[data-testid="stSidebarHeader"] {{ padding-bottom: 0 !important; }}

[data-testid="stMetric"] {{
  background: {SURFACE};
  border: 1px solid {BORDER};
  border-radius: 12px;
  padding: 14px 16px;
}}
[data-testid="stMetricValue"] {{ color: {TEXT}; }}
[data-testid="stMetricLabel"] {{ color: {TEXT2}; }}

.stButton > button {{
  border-radius: 9px;
  font-weight: 600;
  border: 1px solid {BORDER2};
}}
.stButton > button[kind="primary"] {{
  background: {ACCENT_TEXT};
  border-color: {ACCENT_TEXT};
  color: #fff;
}}

[data-testid="stExpander"] {{
  border: 1px solid {BORDER};
  border-radius: 13px;
  background: {SURFACE};
}}

[data-testid="stTabs"] button[role="tab"] {{ font-weight: 600; border-radius: 7px; }}

[data-testid="stDataFrame"] {{ border-radius: 10px; overflow: hidden; }}
</style>
"""


def apply_theme() -> None:
    st.markdown(_CSS, unsafe_allow_html=True)


def badge(text: str, kind: str = "pending") -> str:
    """Inline HTML status pill matching the mockup's pending/success/danger colors."""
    colors = {
        "pending": (PENDING_BG, PENDING_TEXT),
        "success": (SUCCESS_BG, SUCCESS_TEXT),
        "danger": (DANGER_BG, DANGER_TEXT),
    }
    bg, color = colors.get(kind, colors["pending"])
    return (
        f'<span style="background:{bg};color:{color};font-size:11px;font-weight:700;'
        f'padding:3px 10px;border-radius:20px;white-space:nowrap">{text}</span>'
    )
