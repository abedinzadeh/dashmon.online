# PayPal API Cheat Sheet

## Quick Commands:
1. Get Token: curl -X POST {BASE}/v1/oauth2/token -u "ID:SECRET" -d "grant_type=client_credentials"
2. Create Product: curl -X POST {BASE}/v1/catalogs/products -H "Authorization: Bearer TOKEN" -d '{"name":"...","type":"SERVICE"}'
3. Create Plan: curl -X POST {BASE}/v1/billing/plans -H "Authorization: Bearer TOKEN" -d '{"product_id":"PROD-...","name":"...","billing_cycles":[...]}'

## Base URLs:
- Sandbox: https://api-m.sandbox.paypal.com
- Live: https://api-m.paypal.com

## Your Credentials:
- Sandbox Client ID: GET IT FROM .ENV
- Live Client ID: GET IT FROM .ENV
