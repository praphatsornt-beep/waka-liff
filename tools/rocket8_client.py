#!/usr/bin/env python3
"""Shared HTTP client for the Rocket8 Express shipping API."""

import os

import requests
from dotenv import load_dotenv

load_dotenv()


class Rocket8Error(Exception):
    pass


def _env(key: str) -> str:
    """.env locally; Streamlit Cloud never deploys .env (gitignored), so fall
    back to st.secrets there — same pattern get_supabase() uses in the screens."""
    val = os.environ.get(key, "")
    if val:
        return val
    try:
        import streamlit as st
        return st.secrets.get(key, "")
    except Exception:
        return ""


def _base_url() -> str:
    base = _env("ROCKET8_API_BASE")
    if not base:
        raise Rocket8Error("ROCKET8_API_BASE is not set in .env or st.secrets")
    return base.rstrip("/")


def _headers() -> dict:
    token = _env("ROCKET8_API_TOKEN")
    if not token:
        raise Rocket8Error("ROCKET8_API_TOKEN is not set in .env or st.secrets")
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def search_shipment_orders(search: str) -> dict:
    """GET /public/v1/shipment-orders?search=... (tracking_no or r8_booking_ref)."""
    res = requests.get(
        f"{_base_url()}/public/v1/shipment-orders",
        params={"search": search},
        headers=_headers(),
        timeout=15,
    )
    if not res.ok:
        raise Rocket8Error(f"search_shipment_orders failed ({res.status_code}): {res.text}")
    return res.json()


def get_shipment_order_items(partner_awb_no: str) -> list:
    """GET /public/v1/shipment-orders/:partner_awb_no/shipment-order-items."""
    res = requests.get(
        f"{_base_url()}/public/v1/shipment-orders/{partner_awb_no}/shipment-order-items",
        headers=_headers(),
        timeout=15,
    )
    if not res.ok:
        raise Rocket8Error(f"get_shipment_order_items failed ({res.status_code}): {res.text}")
    return res.json().get("data", [])


def get_tracking(partner_awb_no: str, event_types: str = "create,tracking,update,cancel") -> dict:
    """GET /public/v1/shipment-orders/:partner_awb_no/shipment-logs?event_type=..."""
    res = requests.get(
        f"{_base_url()}/public/v1/shipment-orders/{partner_awb_no}/shipment-logs",
        params={"event_type": event_types},
        headers=_headers(),
        timeout=15,
    )
    if not res.ok:
        raise Rocket8Error(f"get_tracking failed ({res.status_code}): {res.text}")
    return res.json()


def cancel_shipment(tracking_no: str, remark: str = "") -> dict:
    """POST /public/v1/shipment-orders/:tracking_no/cancel (single order)."""
    res = requests.post(
        f"{_base_url()}/public/v1/shipment-orders/{tracking_no}/cancel",
        json={"remark": remark},
        headers=_headers(),
        timeout=15,
    )
    if not res.ok:
        raise Rocket8Error(f"cancel_shipment failed ({res.status_code}): {res.text}")
    return res.json()


def bulk_cancel(tracking_nos: list, remark: str = "") -> dict:
    """POST /public/v1/shipment-orders/bulk-cancel. Returns {"successes": [...], "fails": [...]}."""
    res = requests.post(
        f"{_base_url()}/public/v1/shipment-orders/bulk-cancel",
        json={"tracking_no": tracking_nos, "remark": remark},
        headers=_headers(),
        timeout=15,
    )
    if not res.ok:
        raise Rocket8Error(f"bulk_cancel failed ({res.status_code}): {res.text}")
    return res.json().get("data", {})


# WAKA SPACE's registered pickup point in Rocket8 (id confirmed live against
# staging on 2026-08-14: GET /public/v1/pickup-points, default_flag=1,
# "คลังสาธุ" — matches 108,110 ซ.สาธุประดิษฐ์ ทุ่งวัดดอน สาทร กรุงเทพฯ 10120).
PICKUP_POINT_ID = 418
SENDER = {
    "name": "WAKA SPACE",
    "address": "108, 110 ซ.สาธุประดิษฐ์",
    "district": "ทุ่งวัดดอน",
    "city": "สาทร",
    "province": "กรุงเทพมหานคร",
    "postal_code": "10120",
    "phone_number": "0824451956",
}

PARTNERS = ["FLASH", "SHOPEE_EXPRESS", "DHL", "THAILAND_POST", "FLASH_BULKY", "FLASH_FRUIT"]


def bulk_create(orders: list) -> dict:
    """POST /public/v2/shipment-orders/bulk-create.

    `orders` is the raw list Rocket8 expects — NOT wrapped in {"orders": [...]}
    (confirmed live: the API does `req.body.map(...)`, so a wrapper object
    throws "req.body.map is not a function"). Each item needs at minimum:
    pickup_point_id, from{name,address,district,city,province,postal_code,
    phone_number}, to{same shape}, parcel{package_name,width,height,length,
    weight}, partner. weight/width/height/length are all `integer` —
    weight is in GRAMS (confirmed live: sending weight=500 for a 0.5kg
    parcel returned est.weight=500 with a normal ~23-baht FLASH quote).

    Returns {"successes": [...], "fails": [...]} — always check both, since
    a 200 response can still contain per-order failures.
    """
    res = requests.post(
        f"{_base_url()}/public/v2/shipment-orders/bulk-create",
        json=orders,
        headers=_headers(),
        timeout=30,
    )
    if not res.ok:
        raise Rocket8Error(f"bulk_create failed ({res.status_code}): {res.text}")
    return res.json().get("data", {})


def build_order(
    *, to_name: str, to_phone: str, to_address: str, to_district: str, to_city: str,
    to_province: str, to_postal_code: str, weight_g: int, package_name: str = "การ์ดเกม",
    width: int = 20, height: int = 10, length: int = 20, items: list = None,
    partner: str = "FLASH", cod_amount: float = 0, ref_number: str = "",
) -> dict:
    """Build one bulk_create() order dict using WAKA's registered pickup point/sender."""
    order = {
        "pickup_point_id": PICKUP_POINT_ID,
        "from": SENDER,
        "to": {
            "name": to_name, "phone_number": to_phone, "address": to_address,
            "district": to_district, "city": to_city, "province": to_province,
            "postal_code": to_postal_code,
        },
        "parcel": {
            "package_name": package_name, "width": width, "height": height,
            "length": length, "weight": weight_g,
        },
        "partner": partner,
        "cod_amount": cod_amount,
    }
    if items:
        order["parcel"]["items"] = items
    if ref_number:
        order["ref_number"] = ref_number
    return order


def create_shipment_order(**kwargs) -> dict:
    """build_order(**kwargs) + bulk_create([...]) for the single-order case.

    Raises Rocket8Error if the order lands in "fails" (e.g. bad address),
    otherwise returns the success object (contains partner_awb_no, r8_booking_ref, ...).
    """
    result = bulk_create([build_order(**kwargs)])
    fails = result.get("fails") or []
    if fails:
        err = fails[0].get("error", {})
        raise Rocket8Error(err.get("message", "unknown error") + f" — {err.get('validator') or err.get('data') or ''}")
    successes = result.get("successes") or []
    if not successes:
        raise Rocket8Error(f"bulk_create returned no successes and no fails: {result}")
    return successes[0]
