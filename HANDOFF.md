# ConvertMind — Complete Handoff Document

> ⚠️ **SUPERSEDED (2026-06-10).** This document describes the project as of June 5 and is kept for history only. Much of it is now stale: Stripe URLs moved to env vars via `/api/config`, subscribe rate limiting was added, stale root files were deleted, Pro price is $20.99, the Pro content gate is now enforced server-side, cost guards and report caching were added to `analyze.js`, `/api/email-report` exists, and `og-image.png` / `robots.txt` / `welcome.html` were created. For current truth see `project-context/SKILL.md` and `project-context/references/`.

**Date:** 2026-06-05  
**Session:** Full audit + fix pass before launch  
**Author:** Senior CTO / Full-Stack / QA / PM review

---

## Current Project State

ConvertMind is a single-page SaaS web app that performs AI-powered website conversion audits. A user enters any URL, the backend fetches and strips the page HTML, passes it to Claude Haiku, and returns a structured JSON report. The frontend renders scores, identified weaknesses, psychology insights, and a prioritized action plan.

**Tech stack:**
- Frontend: Vanilla JS + CSS, single `index.html` (no framework, no build step)
- Backend: Two Vercel serverless functions (`api/analyze.js`, `api/subscribe.js`)
- AI: Anthropic Claude Haiku (`claude-haiku-4-5-20251001`) via native `https` (no SDK dependency at runtime)
- Email: Resend API (optional, for waitlist confirmation emails)
- Payments: Stripe Payment Links (zero-code checkout, links pasted into constants)
- Hosting: Vercel (`vercel.json` → `"outputDirectory": "."`)

**Current state:**
- ✅ Core scan flow is fully functional
- ✅ SSRF protections are comprehensive and tested (21/21 bypass attempts blocked)
- ✅ Rate limiting in place (10 req/IP/hour, x-real-ip based to prevent spoofing)
- ✅ All AI output is HTML-escaped before rendering (no XSS)
- ✅ Stripe payment links wired up with placeholder guard (alert shown if links not configured)
- ✅ Waitlist email collection working via Resend
- ✅ Scan limit (3/month) enforced client-side via localStorage
- ⚠️  Stripe payment links still contain placeholder values — **must replace before going live**
- ⚠️  `ANTHROPIC_API_KEY` must be set in Vercel environment variables
- ⚠️  `ALLOWED_ORIGIN` should be set to `https://convertmind.ai` in production

---

## Files Modified

This session touched **one file only:** `index.html`

| File | Changes |
|------|---------|
| `index.html` | 19 fixes across head, CSS, HTML, and JS |
| `api/analyze.js` | Not modified this session (fully hardened in previous session) |
| `api/subscribe.js` | Not modified |
| `package.json` | Not modified |
| `vercel.json` | Not modified |
| `.env.example` | Not modified |

---

## All Changes Made

### Head (meta tags)
**Added missing OG and Twitter card tags** so social shares render properly:
```html
<meta property="og:url" content="https://convertmind.ai">
<meta property="og:image" content="https://convertmind.ai/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="ConvertMind — AI Website Audit">
<meta name="twitter:description" content="Scan your website. Discover what's killing conversions. Get a psychology-backed improvement plan.">
```

### CSS additions
**`.limit-upgrade-btn`** — styled inline button for the scan limit banner:
```css
.limit-upgrade-btn {
  display: inline-block; margin-left: 10px;
  background: var(--accent); color: white; border: none;
  padding: 5px 14px; border-radius: 7px;
  font-family: var(--sans); font-weight: 700; font-size: 13px;
  cursor: pointer; transition: opacity 0.2s; vertical-align: middle;
}
```

**`.pricing-features .soon`** — amber badge for unbuilt Pro features:
```css
.pricing-features .soon {
  display: inline-block; font-size: 10px; font-weight: 700;
  background: rgba(251,191,36,0.12); color: var(--amber);
  padding: 2px 7px; border-radius: 100px;
  text-transform: uppercase; letter-spacing: 0.5px;
  margin-left: 4px; vertical-align: middle;
}
```

**Mobile fix** — featured pricing card gets `margin-top: 16px` at ≤600px so the absolute-positioned badge doesn't clip into the card above it.

### HTML copy fixes
| Location | Before | After |
|----------|--------|-------|
| How It Works subtitle | "Three steps from URL..." | "Four steps from URL..." |
| Starter plan features | "5-step action plan" | "4-step action plan" |
| Limit banner | Plain text "Join the waitlist" | Button → `goToStripe(STRIPE_PRO_URL)` |
| Pro plan features | Competitor comparison (no label) | + `<span class="soon">soon</span>` |
| Pro plan features | Email reports (no label) | + `<span class="soon">soon</span>` |
| Pro plan features | API access (no label) | + `<span class="soon">soon</span>` |
| Start Free button | `behavior:'instant'` | `behavior:'smooth'` |
| Waitlist modal title | "Join the Waitlist" | "Get Agency Updates" |
| Waitlist modal body | "Be first to access Pro features..." | "Be first to know when Agency features launch..." |
| Waitlist success text | "We'll email you as soon as Pro access opens." | "We'll email you when Agency features launch. In the meantime, try Pro..." |
| Footer copyright | © 2025 | © 2026 |

### JavaScript fixes

**`resetToHome()`** — now resets the limit banner and re-enables the scan button:
```javascript
function resetToHome() {
  document.getElementById('home-view').style.display = 'block';
  document.getElementById('analyzer-view').style.display = 'none';
  document.getElementById('limitBanner').style.display = 'none';  // NEW
  hideAll();
  document.getElementById('url-input').value = '';
  document.getElementById('scan-btn').disabled = false;           // NEW
  document.getElementById('scan-btn').textContent = 'Scan Now →'; // NEW
  window.scrollTo(0, 0);
}
```

**`startScan()`** — disables scan button while scan is in progress:
```javascript
  document.getElementById('scan-btn').disabled = true;
  document.getElementById('scan-btn').textContent = 'Scanning…';
  showAnalyzerView();
  showLoading();
  runAnalysis(url);
```

**`runAnalysis()`** — added 45s client-side AbortController timeout, re-enables scan button on both success and error paths, and shows a specific message for timeouts:
```javascript
async function runAnalysis(url) {
  const abortCtrl = new AbortController();
  const fetchTimeout = setTimeout(() => abortCtrl.abort(), 45000);
  try {
    const res = await fetch('/api/analyze', {
      ...
      signal: abortCtrl.signal
    });
    clearTimeout(fetchTimeout);
    ...
    document.getElementById('scan-btn').disabled = false;
    document.getElementById('scan-btn').textContent = 'Scan Now →';
    ...
  } catch (err) {
    clearTimeout(fetchTimeout);
    document.getElementById('scan-btn').disabled = false;
    document.getElementById('scan-btn').textContent = 'Scan Now →';
    const msg = err.name === 'AbortError'
      ? 'Analysis timed out. Please try again.'
      : (err.message || 'Analysis failed. Please try again.');
    showError(msg);
  }
}
```

**`renderResults()` — score clamping:**
```javascript
// Before
const val = data.scores[key] ?? 0;
// After
const val = Math.min(100, Math.max(0, Number(data.scores[key]) || 0));
```

**`renderResults()` — double requestAnimationFrame for bar animation:**
```javascript
// Before: single rAF could miss the initial width:0 paint on some browsers
requestAnimationFrame(() => { ... });
// After: two frames guarantees the initial state is committed before transition
requestAnimationFrame(() => requestAnimationFrame(() => { ... }));
```

**`renderResults()` — empty states for all three sections:**
```javascript
if (!issuesList.children.length) {
  issuesList.innerHTML = '<p style="color:var(--muted);font-size:14px;padding:4px 0">No issues identified.</p>';
}
// (same pattern for insightsGrid and planList)
```

**`submitWaitlist()`** — button disabled during async POST to prevent double-submit:
```javascript
const btn = document.querySelector('.modal-submit');
btn.disabled = true;
try { await fetch(...); } catch {}
btn.disabled = false;
```

**Escape key handler for modal:**
```javascript
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('waitlistModal').classList.contains('open')) {
    closeWaitlist();
  }
});
```

---

## Bugs Fixed

| # | Severity | Bug | Fix |
|---|----------|-----|-----|
| 1 | **Critical** | "Three steps" copy but 4 step cards shown | Changed to "Four steps" |
| 2 | **Critical** | "5-step action plan" on free tier — API returns exactly 4 | Changed to "4-step action plan" |
| 3 | **Critical** | Scan limit banner said "Join the waitlist" — missed Stripe conversion | Replaced with `Get Pro — $29/mo →` button |
| 4 | **High** | Scan limit banner not cleared when going home — stale state on new month | `resetToHome()` now resets banner |
| 5 | **High** | Scan button stayed disabled after error or navigation — user stuck | Button re-enabled in all exit paths |
| 6 | **High** | No client-side timeout on `/api/analyze` — could hang indefinitely | 45s AbortController added |
| 7 | **High** | Pro plan listed Competitor comparison, Email reports, API access as live features | "soon" badges added to all three |
| 8 | **High** | Waitlist modal said "Be first to access Pro features" — Pro IS now buyable | Updated to position waitlist for Agency tier |
| 9 | **High** | Waitlist success said "Pro access opens" — contradicts live Stripe | Updated to reference Agency features |
| 10 | **Medium** | Score values had no clamping — AI returning >100 breaks bar overflow | `Math.min(100, Math.max(0, ...))` |
| 11 | **Medium** | Score bars animated with single rAF — snap on some browsers | Double rAF guarantees initial paint |
| 12 | **Medium** | Empty sections render as blank when AI returns zero items | Fallback text added to all three section types |
| 13 | **Medium** | `submitWaitlist()` allowed double-submit on double-click | Button disabled during async operation |
| 14 | **Medium** | No Escape key to close waitlist modal | `keydown` listener added |
| 15 | **Medium** | "Start Free" used `behavior:'instant'` — jarring scroll | Changed to `behavior:'smooth'` |
| 16 | **Medium** | Footer copyright said © 2025 — it's 2026 | Fixed to © 2026 |
| 17 | **Low** | Missing `og:url`, `og:image`, `twitter:card` meta tags — poor social sharing | All added to `<head>` |
| 18 | **Low** | Featured pricing card badge could clip into card above it on mobile | `margin-top: 16px` added in mobile breakpoint |
| 19 | **Low** | `AbortError` showed generic "Analysis failed" message | Shows "Analysis timed out. Please try again." |

---

## Remaining Bugs

| # | Severity | Description | Notes |
|---|----------|-------------|-------|
| R1 | **Critical** | Stripe payment links are still placeholders | Not a code bug — requires you to generate links in Stripe dashboard and paste them into `STRIPE_PRO_URL` / `STRIPE_AGENCY_URL` in `index.html` |
| R2 | **High** | Root-level `analyze.js` and `subscribe.js` are stale duplicate files | The root `analyze.js` uses the old Anthropic SDK. Only `api/*.js` files serve as routes on Vercel. These won't cause production issues but will confuse future developers. Should be deleted. |
| R3 | **Medium** | `ALLOWED_ORIGIN=*` in `.env.example` — should be locked to production domain | Not exploitable without a leaked API key, but best practice: set `ALLOWED_ORIGIN=https://convertmind.ai` in Vercel env vars |
| R4 | **Medium** | Scan limit is purely client-side (localStorage) — trivially bypassed via incognito/DevTools | Accepted risk for pre-auth MVP. Real enforcement requires server-side session tracking. |
| R5 | **Medium** | `api/subscribe.js` has no rate limiting — anyone can flood it with email submissions | Could cause Resend API quota exhaustion. Add a simple in-memory rate limit identical to `api/analyze.js`. |
| R6 | **Low** | No `og:image` file exists at `https://convertmind.ai/og-image.png` | The meta tag references it but the image needs to be created and deployed. Without it, social shares show no image. |
| R7 | **Low** | DNS rebinding window exists between `validateUrlSafety()` and the actual `fetch()` | Accepted as residual risk — closing it requires fetching by IP directly, which is complex. No practical exploit path for current scale. |
| R8 | **Low** | No `robots.txt` or `sitemap.xml` | Not launch-blocking but affects SEO indexing speed. |
| R9 | **Low** | Modal has no keyboard focus trap — Tab key moves focus outside modal | Accessibility concern, not a functional bug. Low priority for launch. |
| R10 | **Info** | Pro plan still lists "Priority action roadmap" and "Full psychological breakdown" as Pro-only features, but free tier gets identical output | Feature differentiation is not yet enforced. Acceptable for MVP since there's no auth layer. |

---

## Launch Readiness Score

**7.5 / 10**

| Dimension | Score | Notes |
|-----------|-------|-------|
| Security | 9/10 | SSRF hardened, rate limiting solid, XSS protected. Only gap: subscribe rate limit |
| Core functionality | 9/10 | Scan → results flow works end-to-end |
| Payment integration | 6/10 | Stripe guard in place, links not yet configured |
| Copy & messaging | 8/10 | All copy bugs fixed. Waitlist positioning now consistent |
| Mobile responsiveness | 8/10 | Responsive for all sections. Minor badge overlap fixed |
| Conversion funnel | 7/10 | Limit banner now drives to Stripe. Upgrade CTA after results. Missing: og:image |
| Error handling | 8/10 | Timeout, abort, empty states all handled |
| Production config | 5/10 | ALLOWED_ORIGIN is `*`, Stripe links are placeholders |

**Blocking items before go-live:**
1. Set real Stripe payment link URLs in `index.html`
2. Set `ANTHROPIC_API_KEY` in Vercel env vars
3. Optionally set `RESEND_API_KEY` and `ALLOWED_ORIGIN` in Vercel env vars

---

## Biggest Risks Before Launch

### Risk 1 — Stripe links are placeholders (CRITICAL)
Every "Get Pro" button currently shows an `alert()` instead of opening checkout. Revenue is zero until this is fixed. Takes 5 minutes.

### Risk 2 — No og:image means bad social sharing
Every tweet/LinkedIn post about ConvertMind will show a blank card. Users sharing their audit results (the viral loop) will look broken. Create a simple 1200×630px image and deploy it.

### Risk 3 — Scan limit is client-side only
A motivated free user can bypass the 3-scan limit in seconds via DevTools or incognito. This means your API costs are unprotected for anyone who finds this. Current rate limit (10/IP/hour server-side) provides some protection, but a distributed attack would still run up costs.

### Risk 4 — Subscribe endpoint has no rate limit
`/api/subscribe` accepts unlimited email submissions. A bot could exhaust your Resend free tier (100 emails/day) in one second, breaking confirmation emails for real users.

### Risk 5 — Root stale files could confuse a developer
If you or a contributor edits `analyze.js` (root) thinking it's the live code, changes will silently have no effect. The real handler is `api/analyze.js`.

### Risk 6 — ALLOWED_ORIGIN=* in production
With CORS open, any website can call your `/api/analyze` and drain your Anthropic credits. The server-side rate limit partially mitigates this, but locking to your domain costs nothing.

---

## Highest ROI Next Tasks

In priority order:

1. **[30 min] Configure Stripe payment links** — Go to Stripe dashboard → Payment Links → Create link for "ConvertMind Pro $29/month" and "ConvertMind Agency $99/month". Paste the IDs into `STRIPE_PRO_URL` and `STRIPE_AGENCY_URL` in `index.html`. This is the only thing standing between you and revenue.

2. **[15 min] Set production environment variables on Vercel** — `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `ALLOWED_ORIGIN=https://convertmind.ai`. Without the API key, the app shows a 500 error to every user.

3. **[1 hour] Create og:image** — A 1200×630px dark-themed image with the ConvertMind logo and tagline. Use Figma, Canva, or even a screenshot. Deploy it to the root. This is the highest-leverage viral/sharing improvement.

4. **[30 min] Add rate limiting to `/api/subscribe`** — Copy the `checkRateLimit` + `getClientIp` pattern from `api/analyze.js` into `api/subscribe.js`. Prevents Resend quota exhaustion.

5. **[15 min] Delete stale root files** — Delete `analyze.js` and `subscribe.js` from the project root. They use the old SDK, have no security hardening, and are not served by Vercel. Pure confusion risk.

6. **[2 hours] Add server-side scan enforcement** — Replace the localStorage counter with a server-side check using a hashed IP + month key stored in a KV store (Vercel KV or Upstash Redis). This properly enforces the free tier limit and protects API costs.

7. **[4 hours] Email reports MVP** — After first paying customers, implement post-scan email collection + HTML report delivery via Resend. This is the highest-leverage feature for retention and word-of-mouth.

---

## Exact Next Steps For Tomorrow

### Step 1 — Get Stripe live (30 min)
```
1. Go to https://dashboard.stripe.com/payment-links
2. Create "ConvertMind Pro" → $29/month recurring → copy link ID (e.g. abc123)
3. Create "ConvertMind Agency" → $99/month recurring → copy link ID
4. Open index.html, find lines ~869-870:
   const STRIPE_PRO_URL    = 'https://buy.stripe.com/REPLACE_WITH_PRO_LINK';
   const STRIPE_AGENCY_URL = 'https://buy.stripe.com/REPLACE_WITH_AGENCY_LINK';
5. Replace REPLACE_WITH_PRO_LINK with your actual ID (e.g. abc123)
6. Replace REPLACE_WITH_AGENCY_LINK with your actual ID
7. Test: click "Get Pro →" in the nav — it should open Stripe checkout
```

### Step 2 — Deploy to Vercel (15 min)
```
1. Push index.html to your Git repo
2. In Vercel dashboard → Settings → Environment Variables, add:
   ANTHROPIC_API_KEY = sk-ant-...
   RESEND_API_KEY = re_... (optional but recommended)
   ALLOWED_ORIGIN = https://convertmind.ai
3. Trigger a new deployment
4. Test the live URL end-to-end: scan a URL, confirm results render, click "Get Pro"
```

### Step 3 — Fix subscribe rate limiting (30 min)
Open `api/subscribe.js` and add at the top (copy from `api/analyze.js`):
```javascript
const rateLimitMap = new Map();
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 20; // slightly higher than analyze since it's lower cost

function checkRateLimit(ip) { /* same implementation as analyze.js */ }
function getClientIp(req) { /* same implementation as analyze.js */ }
```
Then in the handler, add after the OPTIONS check:
```javascript
const clientIp = getClientIp(req);
if (!checkRateLimit(clientIp)) {
  return res.status(429).json({ error: 'Too many requests.' });
}
```

### Step 4 — Create og:image (1 hour)
Create a 1200×630px image (dark background `#0a0a0f`, purple accent `#7c5cfc`) with:
- ConvertMind logo / wordmark
- Tagline: "AI Website Audit & Optimization"
- Save as `og-image.png` in the project root
- The meta tag already references it at `https://convertmind.ai/og-image.png`

### Step 5 — Delete stale root files
```bash
git rm analyze.js subscribe.js
git commit -m "Remove stale root-level API files (replaced by api/ directory)"
```

### Step 6 — Smoke test the full user flow
Before calling it launched:
- [ ] Enter a URL → scan runs → results appear with scores, issues, insights, action plan
- [ ] Upgrade CTA visible at bottom of results with correct scan count
- [ ] Click "Get Pro" → opens Stripe checkout (not an alert)
- [ ] Run 3 scans → limit banner appears with "Get Pro — $29/mo →" button
- [ ] Click "← New Scan" → goes home, banner is gone, button is re-enabled
- [ ] Sign up for waitlist → success screen says Agency features (not Pro)
- [ ] Test on mobile (375px) — scan box stacks, pricing cards stack, CTA full-width

---

## Key Files Reference

```
files/
├── index.html              ← ENTIRE frontend (HTML + CSS + JS, ~1160 lines)
│   ├── lines 1-12          ← Meta tags (og:url, twitter:card now added)
│   ├── lines 14-650        ← All CSS
│   ├── lines 651-870       ← HTML structure (nav, hero, pricing, results, modal)
│   ├── lines 869-870       ← STRIPE_PRO_URL / STRIPE_AGENCY_URL ← EDIT THESE
│   ├── lines 872-879       ← goToStripe() guard function
│   ├── lines 903-933       ← startScan() + scan-btn disable
│   ├── lines 1003-1044     ← runAnalysis() with AbortController timeout
│   └── lines 1060-1160     ← renderResults() + modal + keyboard handlers
│
├── api/
│   ├── analyze.js          ← Main analysis endpoint (SSRF-hardened, rate-limited)
│   └── subscribe.js        ← Waitlist email endpoint (needs rate limiting added)
│
├── analyze.js              ← STALE — old SDK version, NOT served by Vercel, DELETE ME
├── subscribe.js            ← STALE — near-duplicate, NOT served by Vercel, DELETE ME
│
├── .env.example            ← ANTHROPIC_API_KEY, RESEND_API_KEY, ALLOWED_ORIGIN
├── vercel.json             ← { "outputDirectory": "." } — no changes needed
└── package.json            ← @anthropic-ai/sdk dep (unused at runtime, safe to remove)
```

---

*This document was generated after a full audit session on 2026-06-05. All 19 bugs found were fixed in the same session. The project is feature-complete for MVP launch pending Stripe link configuration and Vercel environment variable setup.*
