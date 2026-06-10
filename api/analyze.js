const https = require('https');
const dns   = require('dns');
const net   = require('net');

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// ── RATE LIMITING ─────────────────────────────────────────────────────────────
const rateLimitMap = new Map();
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1-hour sliding window
const RATE_MAX       = 10;              // max requests per IP per window

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

// ── COST GUARDS ───────────────────────────────────────────────────────────────
// Three layers protect the Anthropic bill beyond the hourly rate limit:
//   1. reportCache   — identical URLs within 1h are served from memory (free, instant)
//   2. dailyLimitMap — per-IP daily ceiling (the hourly limit alone allows 240/day)
//   3. dailyBudget   — per-instance ceiling on total Claude calls per UTC day
// All are per-Lambda-instance and best-effort, same as the rate limiter.
const reportCache  = new Map(); // href -> { result, ts }
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX    = 500;

const dailyLimitMap = new Map();
const DAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DAILY_MAX     = 30; // scans per IP per rolling 24h

let dailyBudget = { day: '', used: 0 };
const DAILY_BUDGET_MAX = 400; // Claude calls per instance per UTC day

function checkDailyLimit(ip) {
  const now  = Date.now();
  const prev = (dailyLimitMap.get(ip) || []).filter((t) => now - t < DAY_WINDOW_MS);
  if (prev.length >= DAILY_MAX) return false;
  prev.push(now);
  dailyLimitMap.set(ip, prev);
  if (dailyLimitMap.size > 10_000) {
    for (const [k, v] of dailyLimitMap) {
      if (v.every((t) => now - t >= DAY_WINDOW_MS)) dailyLimitMap.delete(k);
    }
  }
  return true;
}

function checkAndSpendBudget() {
  const today = new Date().toISOString().slice(0, 10);
  if (dailyBudget.day !== today) dailyBudget = { day: today, used: 0 };
  if (dailyBudget.used >= DAILY_BUDGET_MAX) return false;
  dailyBudget.used++;
  return true;
}

function getCachedReport(href) {
  const hit = reportCache.get(href);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) { reportCache.delete(href); return null; }
  return hit.result;
}

function setCachedReport(href, result) {
  if (reportCache.size >= CACHE_MAX) {
    const oldest = reportCache.keys().next().value;
    reportCache.delete(oldest);
  }
  reportCache.set(href, { result, ts: Date.now() });
}

// ── TIER VIEW ─────────────────────────────────────────────────────────────────
// The free payload must not CONTAIN Pro content anywhere — the client-side
// lock rendering is presentation; this redaction is the actual gate.
// Free users get: full summary, scores, all issues, insight #1 and action #1.
// Insights #2+ keep only the principle name; actions #2+ keep only the title
// (exactly what the locked cards display).
function prepareTierView(result, isPro) {
  const view = structuredClone(result);
  view.tier = isPro ? 'pro' : 'free';
  if (!isPro) {
    if (Array.isArray(view.psychologyInsights)) {
      view.psychologyInsights = view.psychologyInsights.map((ins, i) =>
        i === 0 ? ins : { principle: (ins && ins.principle) || '', locked: true });
    }
    if (Array.isArray(view.actionPlan)) {
      view.actionPlan = view.actionPlan.map((item, i) =>
        i === 0 ? item : { title: (item && item.title) || '', locked: true });
    }
  }
  return view;
}

/**
 * Extract the real client IP.
 *
 * On Vercel, the edge sets `x-real-ip` to the actual client IP before the
 * request reaches the serverless function. This header is infrastructure-set
 * and cannot be spoofed by the client (unlike x-forwarded-for, whose leftmost
 * entry is attacker-controlled when Vercel appends to the chain rather than
 * prepending).
 *
 * Fall-back order:
 *   1. x-real-ip          — Vercel-controlled, authoritative
 *   2. last x-forwarded-for entry — nearest trusted proxy's stamp
 *   3. socket.remoteAddress — direct connection (local dev)
 */
function getClientIp(req) {
  const realIp = req.headers['x-real-ip'];
  if (realIp) return realIp.trim();

  const fwd = req.headers['x-forwarded-for'];
  if (fwd) {
    // Take the LAST (rightmost) entry — appended by the nearest trusted proxy.
    // The leftmost entries are client-supplied and untrustworthy.
    const parts = fwd.split(',');
    return parts[parts.length - 1].trim();
  }

  return req.socket?.remoteAddress || 'unknown';
}

// ── SSRF PROTECTION ───────────────────────────────────────────────────────────

/**
 * Returns true if the IPv4 address belongs to a private / reserved range.
 * Covers RFC-1918, loopback, link-local (APIPA / AWS IMDS), unspecified,
 * and broadcast.
 */
function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => isNaN(n) || n < 0 || n > 255)) return true;
  if (p[0] === 10) return true;                                    // RFC-1918 /8
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;     // RFC-1918 /12
  if (p[0] === 192 && p[1] === 168) return true;                  // RFC-1918 /16
  if (p[0] === 127) return true;                                   // loopback
  if (p[0] === 169 && p[1] === 254) return true;                  // link-local / AWS IMDS
  if (p[0] === 0) return true;                                     // "this" network
  if (p[0] === 255) return true;                                   // broadcast
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;    // RFC-6598 shared address
  if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return true; // RFC-2544 benchmarking
  return false;
}

/**
 * Returns true if the IPv6 address belongs to a private / reserved range.
 *
 * Handles:
 *   ::1                loopback
 *   ::                 unspecified (OS maps to 0.0.0.0 / loopback in many contexts)
 *   fe80::/10          link-local
 *   fc00::/7           unique-local (ULA — includes fd00::/8)
 *   ::ffff:x.x.x.x    IPv4-mapped — check the embedded IPv4 address
 *   ::x.x.x.x         IPv4-compatible (deprecated) — same treatment
 *
 * NOTE: raw addresses must be passed WITHOUT surrounding brackets.
 */
function isPrivateIPv6(rawAddr) {
  const addr = rawAddr.replace(/%.*$/, '').toLowerCase();

  // Loopback
  if (addr === '::1') return true;

  // Unspecified address (equivalent to 0.0.0.0 in v6 space)
  if (addr === '::' || addr === '0:0:0:0:0:0:0:0') return true;

  // Link-local fe80::/10 (fe80 – febf)
  if (addr.startsWith('fe8') || addr.startsWith('fe9') ||
      addr.startsWith('fea') || addr.startsWith('feb')) return true;

  // Unique-local fc00::/7 (fc00 – fdff)
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true;

  // IPv4-mapped ::ffff:x.x.x.x  — e.g. ::ffff:169.254.169.254
  if (addr.startsWith('::ffff:')) {
    const v4part = addr.slice(7); // everything after '::ffff:'
    if (net.isIPv4(v4part)) return isPrivateIPv4(v4part);
    // Some OSes return it in hex-group form (::ffff:7f00:1); expand to dotted
    const expanded = expandHexGroupsToIPv4(v4part);
    if (expanded) return isPrivateIPv4(expanded);
  }

  // IPv4-compatible ::x.x.x.x (deprecated but still parsed by some stacks)
  if (addr.startsWith('::') && !addr.startsWith('::f')) {
    const v4part = addr.slice(2);
    if (net.isIPv4(v4part)) return isPrivateIPv4(v4part);
  }

  return false;
}

/**
 * Convert a two-hex-group IPv4 tail (e.g. "7f00:1" → "127.0.0.1").
 * Returns null if the input doesn't look like two colon-separated hex groups.
 */
function expandHexGroupsToIPv4(tail) {
  const m = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!m) return null;
  const word1 = parseInt(m[1], 16);
  const word2 = parseInt(m[2], 16);
  return `${(word1 >> 8) & 0xff}.${word1 & 0xff}.${(word2 >> 8) & 0xff}.${word2 & 0xff}`;
}

/**
 * Validates that a parsed URL's hostname does not resolve to a private or
 * reserved IP address. Returns { safe: true } or { safe: false, reason }.
 *
 * Defense strategy:
 *   1. Reject literal private IPs in the hostname immediately.
 *   2. DNS-resolve the hostname and check every returned address.
 *
 * IMPORTANT: brackets must be stripped from IPv6 hostnames.
 * `new URL('http://[::1]/').hostname` returns '[::1]' (with brackets),
 * so we strip them before calling net.isIPv4 / net.isIPv6.
 */
async function validateUrlSafety(parsedUrl) {
  // Strip surrounding brackets from IPv6 literals
  let hostname = parsedUrl.hostname;
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }

  // 1a. Literal IPv4
  if (net.isIPv4(hostname)) {
    return isPrivateIPv4(hostname)
      ? { safe: false, reason: `Private IPv4 address: ${hostname}` }
      : { safe: true };
  }

  // 1b. Literal IPv6
  if (net.isIPv6(hostname)) {
    return isPrivateIPv6(hostname)
      ? { safe: false, reason: `Private IPv6 address: ${hostname}` }
      : { safe: true };
  }

  // 2. DNS resolution — check every A/AAAA record
  let addresses;
  try {
    addresses = await dns.promises.lookup(hostname, { all: true });
  } catch {
    return { safe: false, reason: 'DNS resolution failed' };
  }

  if (!addresses || addresses.length === 0) {
    return { safe: false, reason: 'No DNS records found' };
  }

  for (const { address, family } of addresses) {
    if (family === 4 && isPrivateIPv4(address)) {
      return { safe: false, reason: `Resolved to private IPv4: ${address}` };
    }
    if (family === 6 && isPrivateIPv6(address)) {
      return { safe: false, reason: `Resolved to private IPv6: ${address}` };
    }
  }

  return { safe: true };
}

/**
 * Fetch a URL while following redirects safely.
 *
 * Standard `fetch()` follows redirects automatically without re-running our
 * SSRF check on the redirect target. An attacker could host a public page
 * that returns "302 Location: http://169.254.169.254/" and bypass the check.
 *
 * This function uses `redirect: 'manual'` and re-validates every Location
 * header through validateUrlSafety before following it.
 *
 * Limits: 5 hops maximum; only http/https Location URLs are followed.
 */
async function safeFetch(initialUrl, signal) {
  const MAX_REDIRECTS = 5;
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsedCurrent;
    try {
      parsedCurrent = new URL(currentUrl);
    } catch {
      throw new Error('Invalid redirect destination URL');
    }

    if (!['http:', 'https:'].includes(parsedCurrent.protocol)) {
      throw new Error(`Redirect to disallowed protocol: ${parsedCurrent.protocol}`);
    }

    // Re-run SSRF check on every hop (catches redirect-to-internal attacks)
    const safety = await validateUrlSafety(parsedCurrent);
    if (!safety.safe) {
      throw new Error(`Redirect blocked: ${safety.reason}`);
    }

    const res = await fetch(currentUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ConvertMindBot/1.0)' },
      signal,
      redirect: 'manual', // never auto-follow; we do it manually
    });

    if (res.status >= 300 && res.status < 400) {
      if (hop === MAX_REDIRECTS) throw new Error('Too many redirects');
      const location = res.headers.get('location');
      if (!location) throw new Error('Redirect response missing Location header');
      try {
        currentUrl = new URL(location, currentUrl).href;
      } catch {
        throw new Error('Invalid Location header URL');
      }
      continue;
    }

    return res; // final response
  }

  throw new Error('Too many redirects');
}

// ── CORS ──────────────────────────────────────────────────────────────────────
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

// ── ANTHROPIC CALL (native https, no SDK) ─────────────────────────────────────
function callAnthropic(apiKey, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`Anthropic API error ${res.statusCode}: ${data}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse Anthropic HTTP response: ${e.message}`));
        }
      });
    });

    req.setTimeout(25000, () => {
      req.destroy(new Error('Anthropic request timed out after 25s'));
    });

    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── JSON EXTRACTION ───────────────────────────────────────────────────────────
function extractBalanced(str, start) {
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return str.slice(start, i + 1); }
  }
  return null;
}

function patchTruncated(text) {
  const stack = [];
  let inString = false, escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let patched = text.trimEnd().replace(/[,:\s]+$/, '');
  if (inString) patched += '"';
  patched += stack.reverse().join('');
  return patched;
}

function extractJSON(raw) {
  const text = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  const anchorIdx = text.indexOf('{"summary"');
  if (anchorIdx !== -1) {
    const candidate = extractBalanced(text, anchorIdx);
    if (candidate) {
      try { return JSON.parse(candidate); } catch {}
      try { return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1')); } catch {}
    }
  }

  const firstBrace = text.indexOf('{');
  if (firstBrace !== -1) {
    const candidate = extractBalanced(text, firstBrace);
    if (candidate) {
      try { return JSON.parse(candidate); } catch {}
      try { return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1')); } catch {}
    }
  }

  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = text.slice(firstBrace, lastBrace + 1);
    try { return JSON.parse(candidate); } catch {}
    try { return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1')); } catch {}
  }

  if (firstBrace !== -1) {
    const patched = patchTruncated(text.slice(firstBrace));
    try { return JSON.parse(patched); } catch {}
    try { return JSON.parse(patched.replace(/,\s*([}\]])/g, '$1')); } catch {}
  }

  return null;
}

// ── HANDLER ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  // Rate limiting — using x-real-ip (Vercel-controlled) to prevent spoofing
  const clientIp = getClientIp(req);
  if (!checkRateLimit(clientIp)) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  const { url, proKey } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid URL' });
  }

  // Reject unreasonably long URLs before any further processing
  if (url.length > 2048) {
    return res.status(400).json({ error: 'URL too long' });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('Bad protocol');
  } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  const isPro = !!(proKey && process.env.PRO_PASSWORD && proKey === process.env.PRO_PASSWORD);

  // Serve identical recent scans from memory — zero Claude cost, instant response.
  // Only successful analyses are cached, so anything in here already passed SSRF.
  const cached = getCachedReport(parsedUrl.href);
  if (cached) {
    return res.status(200).json(prepareTierView(cached, isPro));
  }

  // Daily per-IP ceiling + instance budget — only uncached scans spend money
  if (!checkDailyLimit(clientIp)) {
    return res.status(429).json({ error: 'Daily scan limit reached. Please come back tomorrow.' });
  }
  if (!checkAndSpendBudget()) {
    return res.status(503).json({ error: 'The scanner is at capacity right now. Please try again in a little while.' });
  }

  // SSRF protection — validate initial URL
  const safety = await validateUrlSafety(parsedUrl);
  if (!safety.safe) {
    console.warn('SSRF attempt blocked:', url, '—', safety.reason);
    return res.status(400).json({ error: 'URL is not allowed' });
  }

  // Fetch target website using safeFetch (validates every redirect hop)
  let siteContent = '';
  let fetchFailed = false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const siteRes = await safeFetch(parsedUrl.href, controller.signal);
    clearTimeout(timeout);
    const html = await siteRes.text();
    siteContent = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 8000);
  } catch (fetchErr) {
    siteContent = `[Could not fetch page content: ${fetchErr.message}]`;
    fetchFailed = true;
  }

  const prompt = `You are an expert conversion rate optimizer and consumer psychologist. Analyze this website and provide a comprehensive audit.

Website URL: ${url}
Website Content (extracted text):
${siteContent}

Use this exact JSON structure:

{
  "summary": "2-3 sentence executive summary of the site's main conversion issues and biggest opportunity",
  "scores": {
    "trust": <0-100>,
    "conversion": <0-100>,
    "psychology": <0-100>,
    "copy": <0-100>,
    "mobile": <0-100>,
    "overall": <0-100>
  },
  "issues": [
    {
      "title": "Short issue title",
      "description": "Specific explanation of the problem and why it hurts conversions",
      "severity": "critical|warning|info",
      "impact": "high|medium|low"
    }
  ],
  "psychologyInsights": [
    {
      "principle": "Psychology principle name (e.g. Social Proof, Scarcity, Authority)",
      "text": "How this principle applies to this specific site — what's missing or could be improved"
    }
  ],
  "actionPlan": [
    {
      "title": "Short action title",
      "description": "Specific, actionable step with clear implementation guidance",
      "effort": "low|medium|high",
      "conversionLift": "estimated % lift range e.g. 5-15%"
    }
  ]
}

Rules:
- issues: exactly 4 items, sorted by severity (critical first)
- psychologyInsights: exactly 3 items covering different principles
- actionPlan: exactly 4 items, sorted by ROI (highest first)
- Keep each description to 1-2 sentences — be concise and specific
- EVIDENCE: ground every issue in what the page actually says — where possible, quote a short verbatim fragment (3-8 words, in "quotes") from the extracted text. Never invent or paraphrase content that is not in the text.
- The FIRST action item must include one concrete, ready-to-use example in its description (e.g. an exact rewritten headline or CTA label built from this site's own offer).
- psychologyInsights must point at specific elements of THIS site (its headline, its pricing, its CTAs) — not textbook definitions.
- Scores must reflect actual observed quality, not be artificially high
- If content could not be fetched, say so plainly in the summary, score conservatively, and keep findings honest about that limitation

Respond with ONLY the JSON object. Start your response with { and end with }. No other text.`;

  let rawText = '';
  try {
    const response = await callAnthropic(process.env.ANTHROPIC_API_KEY, {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      stream: false,
      messages: [{ role: 'user', content: prompt }],
    });

    if (response.stop_reason && response.stop_reason !== 'end_turn') {
      console.warn('Anthropic stop_reason:', response.stop_reason, '— response may be truncated');
    }

    rawText = (response.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');

  } catch (err) {
    console.error('Anthropic call failed:', err.message);
    return res.status(500).json({ error: 'Analysis failed. Please try again.' });
  }

  const result = extractJSON(rawText);
  if (!result) {
    console.error('JSON extraction failed. Raw response (first 500 chars):', rawText.slice(0, 500));
    return res.status(500).json({ error: 'Failed to parse AI response. Please try again.' });
  }

  // Cache only clean analyses — a temporarily-unreachable site shouldn't be
  // locked to a degraded report for the next hour.
  if (!fetchFailed) {
    setCachedReport(parsedUrl.href, result);
  }

  return res.status(200).json(prepareTierView(result, isPro));
};
