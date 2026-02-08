const crypto = require('node:crypto');

function getPayPalEnv() {
  const env = String(process.env.PAYPAL_ENV || 'sandbox').trim().toLowerCase();
  return env === 'live' ? 'live' : 'sandbox';
}

function getPayPalApiBase() {
  return getPayPalEnv() === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

function getClientId() {
  return String(process.env.PAYPAL_CLIENT_ID || '').trim();
}

function getWebhookId() {
  return String(process.env.PAYPAL_WEBHOOK_ID || '').trim();
}

function getPlanId() {
  return String(process.env.PAYPAL_PLAN_ID || '').trim();
}

function isPayPalConfigured() {
  return Boolean(getClientId() && String(process.env.PAYPAL_CLIENT_SECRET || '').trim() && getPlanId());
}

async function getAccessToken(fetchImpl = fetch) {
  const clientId = getClientId();
  const clientSecret = String(process.env.PAYPAL_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) throw new Error('PayPal credentials are not configured');

  const base = getPayPalApiBase();
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const r = await fetchImpl(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data?.access_token) {
    const msg = data?.error_description || data?.error || `PayPal token request failed (${r.status})`;
    throw new Error(msg);
  }
  return data.access_token;
}

function safeBaseUrl(req) {
  const configured = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;

  // Best-effort derive from incoming request
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').toString().split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.get('host') || '').toString().split(',')[0].trim();
  if (!host) return 'https://localhost';
  return `${proto}://${host}`;
}

async function createSubscription({ userId, returnUrl, cancelUrl }, fetchImpl = fetch) {
  const planId = getPlanId();
  if (!planId) throw new Error('PAYPAL_PLAN_ID is not configured');

  const token = await getAccessToken(fetchImpl);
  const base = getPayPalApiBase();

  // custom_id can be used to correlate webhook events to a user
  const customId = String(userId || '').trim();
  const requestId = crypto.randomUUID();

  const payload = {
    plan_id: planId,
    custom_id: customId,
    application_context: {
      return_url: returnUrl,
      cancel_url: cancelUrl,
      user_action: 'SUBSCRIBE_NOW'
    }
  };

  const r = await fetchImpl(`${base}/v1/billing/subscriptions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': requestId
    },
    body: JSON.stringify(payload)
  });

  const data = await r.json().catch(() => null);
  if (!r.ok || !data?.id) {
    const msg = data?.message || `Failed to create PayPal subscription (${r.status})`;
    throw new Error(msg);
  }

  const approveUrl = Array.isArray(data?.links)
    ? data.links.find((l) => l && l.rel === 'approve')?.href
    : null;

  if (!approveUrl) throw new Error('PayPal subscription response missing approve link');

  return { id: data.id, approveUrl, raw: data };
}

async function getSubscription(subscriptionId, fetchImpl = fetch) {
  const id = String(subscriptionId || '').trim();
  if (!id) throw new Error('subscriptionId is required');

  const token = await getAccessToken(fetchImpl);
  const base = getPayPalApiBase();
  const r = await fetchImpl(`${base}/v1/billing/subscriptions/${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = data?.message || `Failed to get PayPal subscription (${r.status})`;
    throw new Error(msg);
  }
  return data;
}

async function verifyWebhookSignature({ headers, rawBodyBuffer, webhookEvent }, fetchImpl = fetch) {
  const webhookId = getWebhookId();
  if (!webhookId) throw new Error('PAYPAL_WEBHOOK_ID is not configured');

  const token = await getAccessToken(fetchImpl);
  const base = getPayPalApiBase();

  // PayPal sends verification fields in headers.
  const transmissionId = headers['paypal-transmission-id'] || headers['PAYPAL-TRANSMISSION-ID'];
  const transmissionTime = headers['paypal-transmission-time'] || headers['PAYPAL-TRANSMISSION-TIME'];
  const certUrl = headers['paypal-cert-url'] || headers['PAYPAL-CERT-URL'];
  const authAlgo = headers['paypal-auth-algo'] || headers['PAYPAL-AUTH-ALGO'];
  const transmissionSig = headers['paypal-transmission-sig'] || headers['PAYPAL-TRANSMISSION-SIG'];

  const bodyObj = webhookEvent || (() => {
    try {
      return JSON.parse(rawBodyBuffer?.toString('utf8') || '{}');
    } catch {
      return null;
    }
  })();

  if (!bodyObj) return false;

  const verifyPayload = {
    auth_algo: String(authAlgo || ''),
    cert_url: String(certUrl || ''),
    transmission_id: String(transmissionId || ''),
    transmission_sig: String(transmissionSig || ''),
    transmission_time: String(transmissionTime || ''),
    webhook_id: webhookId,
    webhook_event: bodyObj
  };

  const r = await fetchImpl(`${base}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(verifyPayload)
  });

  const data = await r.json().catch(() => null);
  if (!r.ok) return false;
  return String(data?.verification_status || '').toUpperCase() === 'SUCCESS';
}

module.exports = {
  getPayPalEnv,
  getPayPalApiBase,
  getClientId,
  getPlanId,
  getWebhookId,
  isPayPalConfigured,
  safeBaseUrl,
  createSubscription,
  getSubscription,
  verifyWebhookSignature
};
