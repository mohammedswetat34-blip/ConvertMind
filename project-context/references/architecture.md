# Architecture

## Hosting & deployment

- **Platform:** Vercel. Production URL `https://convert-mind.vercel.app` (custom domain `convertmind.ai` planned, not yet live).
- **`vercel.json`** sets `outputDirectory: "."` so the repo root is served as static files. `index.html` is the entry point.
- **No build step.** Nothing is compiled or bundled. Editing `index.html` and redeploying is the whole loop.
- **`package.json` has zero dependencies** — metadata only (`engines.node: ">=18"`). An earlier `@anthropic-ai/sdk` dependency was removed; the backend uses the native `https` module instead.

## Routing

- Any file in `api/*.js` becomes a serverless function at `/api/<name>` automatically (Vercel convention). No router config.
- Three functions exist: `/api/analyze`, `/api/config`, `/api/subscribe`.
- Each function exports a single `module.exports = function handler(req, res)`.

## Request lifecycle (analyze)

```
Browser (index.html)
  │  POST /api/analyze { url, proKey }
  ▼
api/analyze.js  (Vercel serverless)
  │  1. CORS + method check
  │  2. Rate limit by client IP (in-memory Map)
  │  3. Validate URL (length, protocol, SSRF safety)
  │  4. safeFetch the target site (re-validates every redirect hop)
  │  5. Strip HTML → 8,000 chars of text
  │  6. Build prompt, call Claude via native https
  │  7. Extract JSON (4-strategy fallback chain)
  │  8. Attach tier (pro/free) by comparing proKey to PRO_PASSWORD
  ▼
Browser renders report, gating sections by tier
```

## Security posture

- **SSRF protection** (the most substantial security code in the project, `analyze.js`):
  - `isPrivateIPv4` / `isPrivateIPv6` reject RFC-1918, loopback, link-local (incl. cloud metadata `169.254.169.254`), ULA, IPv4-mapped IPv6, etc.
  - `validateUrlSafety` rejects literal private IPs and DNS-resolves hostnames, checking every A/AAAA record.
  - `safeFetch` uses `redirect: 'manual'` and re-runs the safety check on every hop (max 5) — defeats redirect-to-internal attacks.
- **CORS:** all endpoints honor `ALLOWED_ORIGIN` (default `*`; set to the prod domain to lock down).
- **Security headers** (`vercel.json`, applied to all routes): `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`.
- **XSS:** all Claude output is passed through `escHtml()` before `innerHTML` insertion on the frontend.
- **IP spoofing resistance:** client IP is read from `x-real-ip` (Vercel-set, unspoofable) first, then the *last* `x-forwarded-for` entry.
- **Rate limiting:** in-memory `Map` per Lambda instance — analyze 10/hr/IP, subscribe 20/hr/IP. Not distributed; resets on cold start.

## What's deliberately absent

No database, no ORM, no auth provider, no session store, no webhook handler, no queue, no cron. State that must persist lives in the user's `localStorage`. This is an intentional early-stage simplification (see [pricing-and-pro.md](pricing-and-pro.md)).
