"""
Shopify OAuth router.
Handles the connect → Shopify approval → callback → token storage flow.

Setup (one-time):
  1. Add SHOPIFY_API_KEY and SHOPIFY_API_SECRET to backend/.env
  2. In Shopify Dev Dashboard → ghf_fulfillment2 → Configuration,
     add http://localhost:8000/api/shopify/callback to "Allowed redirection URL(s)"
  3. Visit http://localhost:8000/api/shopify/connect in your browser
  4. Approve in Shopify → token saved automatically
"""
import hashlib
import hmac
import os
import secrets
import requests

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse

from services import shopify_service

router = APIRouter()

# Scopes needed for Phase 2 + future phases
SCOPES = "read_orders,write_orders,write_fulfillments,read_fulfillments,read_products"

# Where Shopify sends the user back after approval
REDIRECT_URI = "http://localhost:8000/api/shopify/callback"

# After successful OAuth, redirect here so the user lands back in the app
FRONTEND_SUCCESS_URL = "http://localhost:5173/orders?shopify=connected"

# Simple in-memory nonce store (fine for a single-operator tool)
_pending_states: set = set()


@router.get("/connect")
def shopify_connect():
    """
    Start the Shopify OAuth flow.
    Visit http://localhost:8000/api/shopify/connect in your browser.
    """
    if not shopify_service.oauth_ready():
        raise HTTPException(
            status_code=503,
            detail=(
                "Missing SHOPIFY_API_KEY or SHOPIFY_API_SECRET in .env. "
                "Add them and restart the server."
            ),
        )

    state = secrets.token_hex(16)
    _pending_states.add(state)

    auth_url = (
        f"https://{shopify_service.SHOPIFY_SHOP_DOMAIN}/admin/oauth/authorize"
        f"?client_id={shopify_service.SHOPIFY_API_KEY}"
        f"&scope={SCOPES}"
        f"&redirect_uri={REDIRECT_URI}"
        f"&state={state}"
    )
    return RedirectResponse(auth_url)


@router.get("/callback")
def shopify_callback(request: Request, code: str = None, state: str = None, hmac_param: str = None, shop: str = None):
    """
    Shopify redirects here after the user approves the app.
    Exchanges the code for a permanent access token and saves it.
    """
    # Validate state to prevent CSRF
    if not state or state not in _pending_states:
        raise HTTPException(status_code=400, detail="Invalid or expired state parameter.")
    _pending_states.discard(state)

    if not code:
        raise HTTPException(status_code=400, detail="No code returned from Shopify.")

    # Validate HMAC signature (Shopify signs the callback params)
    query_params = dict(request.query_params)
    received_hmac = query_params.pop("hmac", None)
    if received_hmac and shopify_service.SHOPIFY_API_SECRET:
        message = "&".join(f"{k}={v}" for k, v in sorted(query_params.items()))
        expected = hmac.new(
            shopify_service.SHOPIFY_API_SECRET.encode(),
            message.encode(),
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(expected, received_hmac):
            raise HTTPException(status_code=403, detail="HMAC validation failed.")

    # Exchange code for access token
    # Use the shop param returned by Shopify (always the .myshopify.com domain)
    token_shop = shop or shopify_service.SHOPIFY_SHOP_DOMAIN
    resp = requests.post(
        f"https://{token_shop}/admin/oauth/access_token",
        json={
            "client_id": shopify_service.SHOPIFY_API_KEY,
            "client_secret": shopify_service.SHOPIFY_API_SECRET,
            "code": code,
        },
        timeout=15,
    )

    if not resp.ok:
        raise HTTPException(
            status_code=502,
            detail=f"Shopify token exchange failed: {resp.text}",
        )

    token = resp.json().get("access_token")
    if not token:
        raise HTTPException(status_code=502, detail="No access_token in Shopify response.")

    shopify_service.save_access_token(token)

    # Redirect back to the frontend
    return RedirectResponse(FRONTEND_SUCCESS_URL)


@router.get("/status")
def shopify_status():
    """Check whether Shopify is connected."""
    return {
        "connected": shopify_service.is_configured(),
        "oauth_ready": shopify_service.oauth_ready(),
        "shop": shopify_service.SHOPIFY_SHOP_DOMAIN or None,
    }


@router.delete("/disconnect")
def shopify_disconnect():
    """Remove the stored access token (forces re-auth)."""
    shopify_service._cached_token = None
    token_file = shopify_service._TOKEN_FILE
    if os.path.exists(token_file):
        os.remove(token_file)
    return {"disconnected": True}
