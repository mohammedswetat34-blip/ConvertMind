const crypto = require('crypto');

// CORS fails CLOSED — see api/config.js for rationale.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://www.convertmind.xyz';

// ── RATE LIMITING ─────────────────────────────────────────────────────────────
// Bounds online guessing of the shared key (20 guesses/hr/IP). The key is a
// long random secret, so this is ample margin.
const rateLimitMap = new Map();
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX       = 20;

function checkRateLimit(ip) {
  const now  = Date.now();
  const prev = (rateLimitMap.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (prev.length >= RATE_MAX) return false;
  prev.push(now);
  rateLimitMap.set(ip, prev);
  if (rateLimitMap.size > 10_000) {
    for (const [k, v] of rateLimitMap) {
      if (v.every((t) => now - t >= RATE_WINDOW_MS)) rateLimitMap.delete(k);
    }
  }
  return true;
}

function getClientIp(req) {
  const realIp = req.headers['x-real-ip'];
  if (realIp) return realIp.trim();
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) {
    const parts = fwd.split(',');
    return parts[parts.length - 1].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

// Constant-time comparison via fixed-length digests (timingSafeEqual requires
// equal-length buffers, and hashing first removes length leakage entirely).
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Small fixed delay on every failed attempt: free for legitimate users (they
// fail once, maybe twice), but taxes distributed brute-forcing 250ms/guess on
// top of the rate limit.
const FAIL_DELAY_MS = 250;
const failDelay = () => new Promise((r) => setTimeout(r, FAIL_DELAY_MS));

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const clientIp = getClientIp(req);
  if (!checkRateLimit(clientIp)) {
    return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  }

  const { proKey } = req.body || {};
  if (!proKey || typeof proKey !== 'string' || proKey.length > 200) {
    await failDelay();
    return res.status(200).json({ valid: false });
  }

  const valid = !!(process.env.PRO_PASSWORD && safeEqual(proKey, process.env.PRO_PASSWORD));
  if (!valid) await failDelay();
  return res.status(200).json({ valid });
};
