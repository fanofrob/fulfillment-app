# Fulfillment App — Persistent Rules

## Shopify API Token

- The token is stored in `shopify_token.json`, **not** `.env`.
- The current token (`shpat_...`) was created before new OAuth scopes were added, so it may be missing required scopes.
- **To get a fresh token with updated scopes:** re-run the connect flow by visiting `http://localhost:8000/api/shopify/connect` in the browser. This re-authenticates with Shopify, creates a new `shpat_` token that includes the new scopes, and automatically saves it to `shopify_token.json`.
- After updating scopes or getting auth errors, always re-run the connect flow rather than manually editing the token file.
