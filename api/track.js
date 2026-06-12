// Lightweight, zero-dependency telemetry: the frontend beacons funnel events
// and JS errors here; each becomes ONE structured console line, searchable in
// Vercel Logs ("[track]"). No PII, no report content, no free-text fields
// beyond a sanitized 120-char meta. This is the "simplest reliable
// equivalent" of an analytics/error tool until a real Sentry DSN exists.

// CORS fails CLOSED — see api/config.js for rationale.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://www.convertmind.xyz';

// Only these events are accepted — anything else is dropped (log injection /
// noise defense). Keep in sync with the frontend track() call sites.
const EVENTS = new Set([
  'scan_started', 'scan_succeeded', 'scan_failed', 'scan_limit_hit',
  'email_report_submitted', 'email_report_failed',
  'pro_cta_clicked', 'pro_key_attempted', 'pro_key_succeeded', 'pro_key_failed',
  'waitlist_submitted', 'waitlist_failed',
  'js_error',
]);

const rateLimitMap = new Map();
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX       = 120; // generous — events are cheap, but bounded

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

// Strip control chars / newlines so a malicious meta can't forge log lines.
function sanitizeMeta(v) {
  if (typeof v !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const clean = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120);
  return clean || undefined;
}

module.exports = function handler(req, res) {
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
    return res.status(429).json({ error: 'Too many events' });
  }

  const { event, meta } = req.body || {};
  if (typeof event !== 'string' || !EVENTS.has(event)) {
    return res.status(400).json({ error: 'Unknown event' });
  }

  const line = { event };
  const m = sanitizeMeta(meta);
  if (m) line.meta = m;
  console.log('[track]', JSON.stringify(line));

  return res.status(204).end();
};
