// CORS fails CLOSED — see api/config.js for rationale.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://convertmind.ai';
const SITE_URL = process.env.SITE_URL || 'https://convertmind.ai';

// ── RATE LIMITING ─────────────────────────────────────────────────────────────
// Tighter than /api/subscribe — each request sends a full report email.
const rateLimitMap = new Map();
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1-hour sliding window
const RATE_MAX       = 10;             // max report emails per IP per window

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

// ── PER-RECIPIENT CAP ─────────────────────────────────────────────────────────
// Stops the endpoint being used to mail-bomb a victim address (which would
// also poison our sender reputation). Independent of the per-IP limit:
// distributed IPs still can't flood one inbox.
const recipientMap = new Map();
const RECIPIENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECIPIENT_MAX       = 3; // report emails per recipient per day

function checkRecipientLimit(email) {
  const now  = Date.now();
  const prev = (recipientMap.get(email) || []).filter((t) => now - t < RECIPIENT_WINDOW_MS);
  if (prev.length >= RECIPIENT_MAX) return false;
  prev.push(now);
  recipientMap.set(email, prev);
  if (recipientMap.size > 10_000) {
    for (const [k, v] of recipientMap) {
      if (v.every((t) => now - t >= RECIPIENT_WINDOW_MS)) recipientMap.delete(k);
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

// ── SANITIZATION ──────────────────────────────────────────────────────────────
// Everything in the payload is client-supplied and ends up inside email HTML —
// escape it all, clamp lengths, and coerce numbers.
function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clampStr(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function clampScore(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0;
}

function clampCount(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 20 ? Math.round(n) : fallback;
}

// Light-background-safe score colors (email clients ignore CSS vars / dark themes)
function scoreColor(val) {
  if (val >= 70) return '#16a34a';
  if (val >= 40) return '#d97706';
  return '#dc2626';
}

// ── EMAIL TEMPLATE ────────────────────────────────────────────────────────────
function scoreRow(label, val) {
  const color = scoreColor(val);
  return `
    <tr>
      <td style="padding:7px 0;font-size:12px;color:#666;width:160px;">${esc(label)}</td>
      <td style="padding:7px 12px 7px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
          <tr>
            <td bgcolor="${color}" width="${val}%" style="height:6px;border-radius:3px;font-size:0;line-height:0;">&nbsp;</td>
            <td bgcolor="#eeeeee" width="${100 - val}%" style="height:6px;border-radius:3px;font-size:0;line-height:0;">&nbsp;</td>
          </tr>
        </table>
      </td>
      <td style="padding:7px 0;font-size:13px;font-weight:700;color:${color};width:36px;text-align:right;font-family:'Courier New',monospace;">${val}</td>
    </tr>`;
}

function buildEmailHtml(data) {
  const { domain, scores, topIssue, insight, action, counts } = data;
  const overall = scores.overall;
  const overallColor = scoreColor(overall);

  const lockedInsights = Math.max(0, counts.insights - 1);
  const lockedActions  = Math.max(0, counts.actions - 1);
  const lockedLine = (lockedInsights || lockedActions)
    ? `${lockedInsights} more psychology insight${lockedInsights === 1 ? '' : 's'} and ${lockedActions} more fix step${lockedActions === 1 ? '' : 's'} — each with estimated conversion lift — are in your full report.`
    : 'The full prioritized fix plan with estimated conversion lift is in your Pro report.';

  const scoreLabels = [
    ['Trust & Credibility', scores.trust],
    ['Conversion Design',   scores.conversion],
    ['Psychology Score',    scores.psychology],
    ['Copy Effectiveness',  scores.copy],
    ['Mobile Experience',   scores.mobile],
    ['Overall Profit Score', scores.overall],
  ];

  const issueBlock = topIssue ? `
    <!-- TOP ISSUE -->
    <p style="margin:28px 0 10px;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#999;font-family:'Courier New',monospace;">#1 Critical Issue</p>
    <div style="background:#fef2f2;border-left:3px solid #dc2626;border-radius:0 8px 8px 0;padding:16px 18px;">
      <p style="margin:0 0 6px;font-size:15px;font-weight:700;color:#1a1a2e;">🔴 ${esc(topIssue.title)}</p>
      <p style="margin:0;font-size:13.5px;line-height:1.6;color:#555;">${esc(topIssue.description)}</p>
    </div>` : '';

  const insightBlock = insight ? `
    <!-- INSIGHT -->
    <p style="margin:28px 0 10px;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#999;font-family:'Courier New',monospace;">Psychology Insight 1 of ${counts.insights}</p>
    <div style="background:#f5f3ff;border-left:3px solid #7c5cfc;border-radius:0 8px 8px 0;padding:16px 18px;">
      <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#7c5cfc;">${esc(insight.principle)}</p>
      <p style="margin:0;font-size:13.5px;line-height:1.6;color:#555;">${esc(insight.text)}</p>
    </div>` : '';

  const actionBlock = action ? `
    <!-- ACTION ITEM -->
    <p style="margin:28px 0 10px;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#999;font-family:'Courier New',monospace;">Fix 1 of ${counts.actions} — start here</p>
    <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:16px 18px;">
      <p style="margin:0 0 6px;font-size:15px;font-weight:700;color:#1a1a2e;">1. ${esc(action.title)}</p>
      <p style="margin:0 0 10px;font-size:13.5px;line-height:1.6;color:#555;">${esc(action.description)}</p>
      <p style="margin:0;font-size:11px;font-family:'Courier New',monospace;color:#888;">
        ${esc(action.effort)} effort${action.conversionLift ? ` &nbsp;·&nbsp; +${esc(action.conversionLift)} est. conversion lift` : ''}
      </p>
    </div>` : '';

  return `
<div style="background:#f4f4f7;padding:32px 16px;">
  <div style="max-width:560px;margin:0 auto;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;">

    <!-- HEADER -->
    <p style="margin:0 0 18px;font-size:18px;font-weight:800;color:#1a1a2e;">
      Convert<span style="color:#7c5cfc;">Mind</span>
      <span style="font-size:11px;font-weight:400;color:#999;letter-spacing:1px;font-family:'Courier New',monospace;">&nbsp;· AI CONVERSION AUDIT</span>
    </p>

    <!-- CARD -->
    <div style="background:#ffffff;border-radius:14px;padding:32px 28px;border:1px solid #e5e7eb;">

      <!-- HERO -->
      <p style="margin:0 0 4px;font-size:12px;color:#888;font-family:'Courier New',monospace;">${esc(domain)}</p>
      <p style="margin:0 0 22px;font-size:22px;font-weight:800;color:#1a1a2e;">
        Your site scored <span style="color:${overallColor};">${overall}/100</span>
      </p>

      <!-- SCORES -->
      <p style="margin:0 0 8px;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#999;font-family:'Courier New',monospace;">Score Breakdown</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        ${scoreLabels.map(([label, val]) => scoreRow(label, val)).join('')}
      </table>

      ${issueBlock}
      ${insightBlock}
      ${actionBlock}

      <!-- LOCKED / PRO CTA -->
      <div style="margin-top:28px;border:1px dashed #cbd5e1;border-radius:10px;padding:20px;text-align:center;background:#fafafa;">
        <p style="margin:0 0 6px;font-size:14px;font-weight:700;color:#1a1a2e;">🔒 ${lockedLine}</p>
        <p style="margin:0 0 16px;font-size:12.5px;color:#777;line-height:1.6;">You already know <strong>what's wrong</strong>. Pro shows you exactly <strong>how to fix all of it</strong> — unlimited scans, $20.99/mo, cancel anytime.</p>
        <a href="${SITE_URL}/#pricing" style="display:inline-block;background:#7c5cfc;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:14px;">Unlock the full fix plan →</a>
      </div>

      <!-- FORWARD NUDGE -->
      <p style="margin:24px 0 0;font-size:12.5px;color:#888;line-height:1.6;font-style:italic;">
        Working with a developer, marketer, or agency? Forward this email — it has everything needed to start fixing the top issue today.
      </p>
    </div>

    <!-- FOOTER -->
    <p style="margin:20px 0 0;font-size:11px;color:#aaa;line-height:1.7;text-align:center;">
      You received this because you requested your audit report at <a href="${SITE_URL}" style="color:#7c5cfc;text-decoration:none;">convertmind.ai</a>.<br>
      Made changes? Re-scan free anytime. Occasionally we'll send a high-value conversion tip — unsubscribe with one click.<br>
      © ConvertMind
    </p>
  </div>
</div>`;
}

// ── HANDLER ───────────────────────────────────────────────────────────────────
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

  const body = req.body || {};

  // Email
  const email = body.email;
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  const sanitizedEmail = email.trim().toLowerCase().slice(0, 254);

  if (!checkRecipientLimit(sanitizedEmail)) {
    return res.status(429).json({ error: 'This address has already received the maximum number of reports today.' });
  }

  // URL → domain (subject line + header)
  let domain;
  try {
    const parsed = new URL(clampStr(body.url, 2048));
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('bad protocol');
    domain = parsed.hostname;
  } catch {
    return res.status(400).json({ error: 'Valid report URL required' });
  }

  // Scores
  const rawScores = body.scores && typeof body.scores === 'object' ? body.scores : {};
  const scores = {
    trust:      clampScore(rawScores.trust),
    conversion: clampScore(rawScores.conversion),
    psychology: clampScore(rawScores.psychology),
    copy:       clampScore(rawScores.copy),
    mobile:     clampScore(rawScores.mobile),
    overall:    clampScore(rawScores.overall),
  };

  // Free-tier content blocks — only what the free report already shows
  const topIssue = body.topIssue && typeof body.topIssue === 'object' ? {
    title:       clampStr(body.topIssue.title, 200),
    description: clampStr(body.topIssue.description, 700),
  } : null;

  const insight = body.insight && typeof body.insight === 'object' ? {
    principle: clampStr(body.insight.principle, 120),
    text:      clampStr(body.insight.text, 700),
  } : null;

  const action = body.action && typeof body.action === 'object' ? {
    title:          clampStr(body.action.title, 200),
    description:    clampStr(body.action.description, 700),
    effort:         ['low', 'medium', 'high'].includes(body.action.effort) ? body.action.effort : 'low',
    conversionLift: clampStr(body.action.conversionLift, 40),
  } : null;

  const rawCounts = body.counts && typeof body.counts === 'object' ? body.counts : {};
  const counts = {
    insights: clampCount(rawCounts.insights, 3),
    actions:  clampCount(rawCounts.actions, 4),
  };

  const html = buildEmailHtml({ domain, scores, topIssue, insight, action, counts });
  const subject = `Your ConvertMind audit: ${domain} scored ${scores.overall}/100`;

  // No Resend key (local dev) — log and succeed so the UI flow is testable
  if (!process.env.RESEND_API_KEY) {
    console.log('Report email requested (no RESEND_API_KEY):', sanitizedEmail, domain);
    return res.status(200).json({ success: true });
  }

  // Unlike /api/subscribe, the email IS the product of this call —
  // a send failure must surface to the user, not be swallowed.
  try {
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'ConvertMind <noreply@convertmind.ai>',
        to: sanitizedEmail,
        subject,
        html,
      }),
    });
    if (!resendRes.ok) {
      const errText = await resendRes.text().catch(() => '');
      console.error('Resend report email error:', resendRes.status, errText.slice(0, 500));
      return res.status(502).json({ error: 'Could not send the email. Please try again.' });
    }
  } catch (emailErr) {
    console.error('Resend report email error:', emailErr.message);
    return res.status(502).json({ error: 'Could not send the email. Please try again.' });
  }

  return res.status(200).json({ success: true });
};
