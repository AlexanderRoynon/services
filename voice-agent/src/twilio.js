import crypto from 'crypto';
import fetch from 'node-fetch';

/**
 * Validate Twilio signature for x-www-form-urlencoded bodies.
 * See: https://www.twilio.com/docs/usage/security#validating-requests
 */
export function validateTwilioSignature({ enabled, authToken, url, headers, body }) {
  if (!enabled) return true;

  const sigHeader = headers['x-twilio-signature'] || headers['X-Twilio-Signature'];
  if (!sigHeader || !authToken || !url) return false;

  // Twilio expects URL + sorted POST params concatenated (for form-encoded bodies)
  const params = [];
  if (body && typeof body === 'object') {
    for (const k of Object.keys(body).sort()) {
      params.push(k + body[k]);
    }
  }
  const toSign = url + params.join('');
  const computed = crypto
    .createHmac('sha1', authToken)
    .update(Buffer.from(toSign, 'utf8'))
    .digest('base64');

  // Constant-time compare
  const a = Buffer.from(computed);
  const b = Buffer.from(String(sigHeader));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Redirect a live call to play an audio URL, then return to /twilio/voice.
 */
export async function redirectCallToPlay({ accountSid, authToken, callSid, audioUrl }) {
  const host = process.env.VOICE_AGENT_HOST;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`;

  const twiml = `
    <Response>
      <Play>${audioUrl}</Play>
      <Redirect method="POST">https://${host}/twilio/voice</Redirect>
    </Response>
  `.trim();

  const body = new URLSearchParams({ Twiml: twiml });

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Twilio redirect error: ${r.status} ${txt}`);
  }
}
