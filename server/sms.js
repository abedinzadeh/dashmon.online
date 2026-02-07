// Twilio SMS helper
// Supports:
//  - API Key auth: TWILIO_ACCOUNT_SID + TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET
//  - Auth Token fallback: TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN
//
// Test mode: SMS_TEST_MODE=true -> no outbound SMS, returns stub response.

function isTrue(v) {
  return String(v || '').toLowerCase() === 'true';
}

function getTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  if (!accountSid) throw new Error('TWILIO_ACCOUNT_SID is not set');

  const apiKeySid = process.env.TWILIO_API_KEY_SID;
  const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  // Lazy require so tests/servers can start without twilio installed in some contexts.
  const twilio = require('twilio');

  if (apiKeySid && apiKeySecret) {
    return twilio(apiKeySid, apiKeySecret, { accountSid });
  }
  if (authToken) {
    return twilio(accountSid, authToken);
  }
  throw new Error('Twilio credentials not set (need TWILIO_API_KEY_SID/SECRET or TWILIO_AUTH_TOKEN)');
}

async function sendSms({ to, body }) {
  const from = String(process.env.TWILIO_FROM || '').trim();
  if (!from) throw new Error('TWILIO_FROM is not set');
  if (!to) throw new Error('SMS recipient is required');
  if (!body) throw new Error('SMS body is required');

  if (isTrue(process.env.SMS_TEST_MODE)) {
    console.log(`[SMS][TEST_MODE] to=${to} from=${from} body=${String(body).slice(0, 120)}`);
    return { provider: 'twilio', sid: 'TEST_MODE', testMode: true };
  }

  const client = getTwilioClient();
  const msg = await client.messages.create({ to, from, body });
  return { provider: 'twilio', sid: msg.sid, testMode: false };
}

module.exports = { sendSms };
