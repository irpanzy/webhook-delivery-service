const crypto = require('crypto');

/**
 * Generate HMAC-SHA256 signature for webhook payload.
 * Format mimics industry standard (Stripe / GitHub):
 * Header: X-Webhook-Signature: t=1711234567,v1=hex_digest
 *
 * @param {string|object} payload - Webhook payload
 * @param {string} secret - Subscription signing secret
 * @param {number} [timestamp] - Current unix epoch in seconds
 * @returns {{ headerValue: string, timestamp: number, signature: string }}
 */
function signPayload(payload, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const signedPayload = `${timestamp}.${payloadString}`;
  
  const signature = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  const headerValue = `t=${timestamp},v1=${signature}`;
  return { headerValue, timestamp, signature };
}

/**
 * Verify HMAC-SHA256 signature from header.
 *
 * @param {string|object} payload - Webhook payload
 * @param {string} signatureHeader - Header value, e.g. "t=1711234567,v1=abc..."
 * @param {string} secret - Subscription signing secret
 * @param {number} [toleranceSeconds=300] - Tolerance for clock skew (default 5 mins)
 * @returns {boolean}
 */
function verifySignature(payload, signatureHeader, secret, toleranceSeconds = 300) {
  if (!signatureHeader || !secret) return false;

  const parts = signatureHeader.split(',');
  const timestampPart = parts.find((p) => p.startsWith('t='));
  const sigPart = parts.find((p) => p.startsWith('v1='));

  if (!timestampPart || !sigPart) return false;

  const timestamp = parseInt(timestampPart.substring(2), 10);
  const receivedSig = sigPart.substring(3);

  // Check timestamp drift to prevent replay attacks
  const currentEpoch = Math.floor(Date.now() / 1000);
  if (toleranceSeconds > 0 && Math.abs(currentEpoch - timestamp) > toleranceSeconds) {
    return false;
  }

  const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const signedPayload = `${timestamp}.${payloadString}`;

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(receivedSig, 'hex'),
      Buffer.from(expectedSig, 'hex')
    );
  } catch {
    return false;
  }
}

module.exports = {
  signPayload,
  verifySignature,
};
