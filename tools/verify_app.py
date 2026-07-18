#!/usr/bin/env python3
"""Streamlit Cloud entry point shim — actual app lives in tools/pages/orders.py.

Streamlit Community Cloud's main file path can't be changed after an app is
created without deleting and recreating it (losing Secrets config + URL), so
this stub keeps the existing deployment pointed at the real dashboard.
"""

import runpy

runpy.run_path("tools/pages/orders.py", run_name="__main__")
