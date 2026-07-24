#!/usr/bin/env python3
"""Shared WAKA visual theme (fonts, dark navy/gold card-game palette, status colors).

Colors and fonts are lifted from the WAKA Admin Dashboard design mockup —
dark navy-black background, gold-bordered cards, turquoise primary CTAs.
Import and call `apply_theme()` once near the top of each page, after
`st.set_page_config(...)`.
"""

import streamlit as st

BG = "#0C0E13"
SURFACE = "#161A22"
SURFACE_ALT = "#1B212B"
BORDER = "rgba(184,134,59,0.45)"
BORDER2 = "#B8863B"
DIVIDER = "rgba(255,255,255,0.08)"
DIVIDER2 = "rgba(255,255,255,0.06)"
TEXT = "#F1EDE4"
TEXT2 = "#9A9284"
TEXT3 = "#6E6658"
TEXT4 = "#B8B0A2"
ACCENT_LIGHT = "#2A2416"
ACCENT_TEXT = "#F0C767"
PRIMARY_BTN = "#1C6C7C"
SIDEBAR_BG = "#12151C"
SIDEBAR_TEXT = "#E8E4DD"

PENDING_BG, PENDING_TEXT = "rgba(196,121,31,0.18)", "#C4791F"
SUCCESS_BG, SUCCESS_TEXT = "rgba(63,122,79,0.20)", "#4E9A61"
DANGER_BG, DANGER_TEXT = "rgba(178,58,46,0.20)", "#D9584A"

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

[data-testid="stMain"] .block-container {{ padding-top: 2.2rem !important; }}

[data-testid="stSidebar"] {{ background: {SIDEBAR_BG}; }}
[data-testid="stSidebar"][aria-expanded="true"] {{ width: 200px !important; min-width: 200px !important; }}
[data-testid="stSidebar"] * {{ color: {SIDEBAR_TEXT} !important; }}
[data-testid="stSidebarNav"] span {{ font-size: 15px !important; }}
[data-testid="stSidebarHeader"] {{ padding-bottom: 0 !important; }}

[data-testid="stSidebarNavLink"] {{ border-radius: 8px; }}
[data-testid="stSidebarNavLink"][aria-current="page"] {{
  background: {ACCENT_LIGHT} !important;
}}
[data-testid="stSidebarNavLink"][aria-current="page"] * {{
  color: {ACCENT_TEXT} !important;
}}

/* Collapsed sidebar: keep a narrow icon-only rail instead of hiding fully */
[data-testid="stSidebar"][aria-expanded="false"] {{
  width: 96px !important;
  min-width: 96px !important;
  transform: none !important;
  visibility: visible !important;
}}
[data-testid="stSidebar"][aria-expanded="false"] [data-testid="stSidebarHeader"] {{
  flex-direction: row;
  align-items: center;
  justify-content: center;
  width: 96px;
  height: auto;
  padding: 10px 0;
  gap: 6px;
}}
[data-testid="stSidebar"][aria-expanded="false"] [data-testid="stBaseButton-headerNoPadding"] {{
  visibility: visible !important;
  width: 22px !important;
  height: 22px !important;
  min-width: 22px !important;
  min-height: 22px !important;
  padding: 0 !important;
}}
[data-testid="stSidebar"][aria-expanded="false"] [data-testid="stBaseButton-headerNoPadding"] [data-testid="stIconMaterial"] {{
  font-size: 16px !important;
}}
[data-testid="stSidebar"][aria-expanded="false"] [data-testid="stSidebarHeader"] > div {{
  display: flex;
  align-items: center;
  justify-content: center;
  width: auto;
}}
[data-testid="stSidebar"][aria-expanded="false"] [data-testid="stSidebarLogo"] {{
  width: 26px !important;
  height: 26px !important;
  object-fit: contain;
}}
[data-testid="stSidebar"][aria-expanded="false"] [data-testid="stSidebarNavLink"] {{
  position: relative;
  justify-content: center;
  padding: 12px 0;
}}
[data-testid="stSidebar"][aria-expanded="false"] [data-testid="stSidebarContent"] {{
  overflow: visible !important;
}}
[data-testid="stSidebar"][aria-expanded="false"] [data-testid="stSidebarNavLink"] span[label] {{
  position: absolute;
  left: calc(100% + 10px);
  top: 50%;
  transform: translateY(-50%);
  background: #12151C;
  color: {SIDEBAR_TEXT} !important;
  padding: 6px 11px;
  border-radius: 6px;
  font-size: 12.5px;
  white-space: nowrap;
  box-shadow: 0 4px 14px rgba(0,0,0,0.4);
  opacity: 0;
  pointer-events: none;
  transition: opacity .12s ease;
  z-index: 50;
}}
[data-testid="stSidebar"][aria-expanded="false"] [data-testid="stSidebarNavLink"]:hover span[label] {{
  opacity: 1;
}}
[data-testid="stSidebar"][aria-expanded="false"] [data-testid="stSidebarNavLink"] [data-testid="stIconEmoji"] {{
  font-size: 24px;
}}
[data-testid="stSidebar"][aria-expanded="false"] [data-testid="stNavSectionHeader"],
[data-testid="stSidebar"][aria-expanded="false"] [data-testid="stSidebarUserContent"] .stButton {{
  display: none;
}}

/* Streamlit also renders its own logo + "expand sidebar" button in the main
   toolbar for reopening a collapsed sidebar — redundant now that our rail
   keeps a working logo + collapse toggle visible at all times. */
[data-testid="stHeaderLogo"],
[data-testid="stExpandSidebarButton"] {{
  display: none !important;
}}

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
  background: {PRIMARY_BTN};
  border-color: {PRIMARY_BTN};
  color: #fff;
}}

[data-testid="stSidebar"] .stButton > button {{
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.14);
}}
[data-testid="stSidebar"] .stButton > button:hover {{
  background: rgba(255,255,255,0.12);
  border-color: rgba(255,255,255,0.22);
}}

[data-testid="stExpander"] {{
  border: 1px solid {BORDER};
  border-radius: 13px;
  background: {SURFACE};
}}
[data-testid="stExpander"] summary {{
  padding: 8px 12px !important;
}}
[data-testid="stExpander"] summary span {{
  font-size: 12px !important;
  font-weight: 500 !important;
  color: {TEXT3} !important;
}}

[data-testid="stVerticalBlockBorderWrapper"] {{
  border-color: {BORDER} !important;
  border-radius: 13px !important;
  background: {SURFACE};
}}

[data-testid="stPopoverBody"] {{
  background: {SURFACE};
  border: 1px solid {BORDER};
}}

[data-testid="stTabs"] button[role="tab"] {{ font-weight: 600; border-radius: 7px; }}

/* Selectbox/multiselect dropdown menus default to the trigger's (often
   narrow) width, truncating long option labels. The option list is a
   virtualized (absolutely-positioned) list, so width:max-content can't
   measure its content — force a fixed wider width at every wrapping level
   instead, and let each option's label wrap rather than ellipsis-truncate. */
div[data-baseweb="popover"]:has(ul[data-testid="stSelectboxVirtualDropdown"]),
div[data-baseweb="popover"]:has(ul[data-testid="stSelectboxVirtualDropdown"]) > div,
div[data-baseweb="popover"]:has(ul[data-testid="stSelectboxVirtualDropdown"]) > div > div {{
  width: 340px !important;
  max-width: 340px !important;
}}
ul[data-testid="stSelectboxVirtualDropdown"],
ul[data-testid="stSelectboxVirtualDropdown"] > div,
ul[data-testid="stSelectboxVirtualDropdown"] li[role="option"] {{
  width: 340px !important;
}}
ul[data-testid="stSelectboxVirtualDropdown"] li[role="option"] * {{
  overflow: visible !important;
  text-overflow: unset !important;
  white-space: normal !important;
}}

/* Smaller text in form controls (search/select/date inputs + their dropdown
   options) — the default size felt oversized next to the rest of the UI. */
div.stTextInput input, div.stDateInput input,
div.stSelectbox div[data-baseweb="select"] span,
div.stMultiSelect div[data-baseweb="select"] span,
ul[data-testid="stSelectboxVirtualDropdown"] li[role="option"] {{
  font-size: 13px !important;
}}

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


def flat(html: str) -> str:
    """Strip leading whitespace from each line so Python's source indentation
    doesn't get read back as a markdown indented-code-block by st.markdown."""
    return "\n".join(line.strip() for line in html.strip().splitlines())


def page_header(title: str, subtitle: str = "") -> None:
    """Same title/subtitle treatment on every page. Uses Streamlit's native
    st.subheader/st.caption rather than custom HTML — a raw-HTML div at
    26px/bold intermittently dropped combining tone marks in Thai text
    (e.g. "วันนี้" rendering as "วันนี") in this environment; native
    widgets don't have that problem."""
    st.subheader(title)
    if subtitle:
        st.caption(subtitle)


def kpi_card(label: str, value, value_color: str = TEXT) -> str:
    """Plain KPI card: label above a big value, no icon/footer — matches the
    4-card row at the top of the orders/tournament/gym mockup pages."""
    return flat(f"""<div style="background:{SURFACE};border:1px solid {BORDER};border-radius:12px;padding:16px 18px">
    <div style="font-size:13px;color:{TEXT2}">{label}</div>
    <div style="font-family:'Prompt',sans-serif;font-size:24px;font-weight:700;margin-top:4px;color:{value_color}">{value}</div>
    </div>""")
