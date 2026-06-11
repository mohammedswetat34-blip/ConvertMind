// CORS fails CLOSED — see api/config.js for rationale.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://convertmind.ai';

// ── RATE LIMITING ─────────────────────────────────────────────────────────────
// Slightly higher ceiling than /api/analyze (email is cheaper than an AI call),
// but still prevents bots from exhausting the Resend free tier.
const rateLimitMap = new Map();
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1-hour sliding window
const RATE_MAX       = 20;              // max submissions per IP per window

function checkRateLimit(ip) {
  const now  = Date.now();
  const prev = (rateLimitMap.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (prev.length >= RATE_MAX) return false;
  prev.push(now);
  rateLimitMap.set(ip, prev);
  // Evict fully-expired entries to keep the Map bounded
  if (rateLimitMap.size > 10_000) {
    for (const [k, v] of rateLimitMap) {
      if (v.every((t) => now - t >= RATE_WINDOW_MS)) rateLimitMap.delete(k);
    }
  }
  return true;
}

/**
 * Extract the real client IP.
 * Uses x-real-ip first (Vercel-controlled, cannot be spoofed),
 * falls back to the last x-forwarded-for entry, then socket address.
 */
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

// ── CORS ──────────────────────────────────────────────────────────────────────
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limiting — using x-real-ip (Vercel-controlled) to prevent spoofing
  const clientIp = getClientIp(req);
  if (!checkRateLimit(clientIp)) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  const { email } = req.body || {};
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  const sanitizedEmail = email.trim().toLowerCase().slice(0, 254);

  // If Resend API is configured, the confirmation email IS the signup record
  // (nothing else stores the address) — so a failed send must NOT report
  // success to the user.
  if (process.env.RESEND_API_KEY) {
    try {
      const resendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.EMAIL_FROM || 'ConvertMind <noreply@convertmind.ai>',
          to: sanitizedEmail,
          subject: "You're on the ConvertMind list! 🚀",
          html: `
            <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1a1a2e;">
              <h2 style="font-size: 24px; font-weight: 800; margin-bottom: 12px;">You're on the list!</h2>
              <p style="color: #555; line-height: 1.6; margin-bottom: 16px;">
                Thanks for signing up. We'll notify you when Agency features launch — competitor analysis, white-label reports, and bulk scanning for teams.
              </p>
              <p style="color: #555; line-height: 1.6; margin-bottom: 16px;">
                In the meantime, you can run <strong>3 free scans per month</strong> at
                <a href="https://convertmind.ai" style="color: #7c5cfc;">convertmind.ai</a>
                — or upgrade to Pro for unlimited scans at $20.99/mo.
              </p>
              <a href="https://convertmind.ai" style="display:inline-block;margin-top:8px;background:#7c5cfc;color:white;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:14px;">Start Scanning →</a>
              <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
              <p style="font-size: 12px; color: #999;">ConvertMind · You received this because you signed up at convertmind.ai</p>
            </div>
          `,
        }),
      });
      if (!resendRes.ok) {
        const errText = await resendRes.text().catch(() => '');
        console.error('Resend waitlist email error:', resendRes.status, errText.slice(0, 300));
        return res.status(502).json({ error: 'Could not complete signup. Please try again.' });
      }
    } catch (emailErr) {
      console.error('Resend waitlist email error:', emailErr.message);
      return res.status(502).json({ error: 'Could not complete signup. Please try again.' });
    }
  } else if (process.env.VERCEL) {
    // Missing key in production: the email IS the signup record, so a silent
    // no-op would lose the lead while telling them "you're on the list".
    console.error('RESEND_API_KEY missing in production — waitlist signup NOT recorded');
    return res.status(503).json({ error: 'Signups are temporarily unavailable. Please try again later.' });
  } else {
    // Local dev — just log the signup
    console.log('Waitlist signup (local dev):', sanitizedEmail);
  }

  return res.status(200).json({ success: true });
};
