# API Endpoints

Five stateless serverless functions in `api/`. All share the same CORS pattern (`ALLOWED_ORIGIN` env var, OPTIONS preflight → 204; **fails closed** — defaults to `https://convertmind.ai` when unset, set `*` explicitly for local dev) and the same `getClientIp` helper (prefers unspoofable `x-real-ip`). All have `maxDuration: 60` via `vercel.json`.

---

## POST /api/analyze

Core endpoint. Fetches a site, runs the Claude audit, returns the report.

**Request**
```json
{ "url": "https://example.com", "proKey": "<optional shared key>" }
```

**Validation / guards (in order)**
1. POST only (else 405); `ANTHROPIC_API_KEY` must be set (else 500).
2. Rate limit: **10 requests / hour / IP** (in-memory Map). Exceed → 429.
3. `url` required, string, ≤2048 chars; must parse as http/https (else 400).
4. **Cache check**: cache key = protocol + lowercased host + **port** + path + sorted query with **known tracking params stripped** (`utm_*`, `gclid`, `fbclid`, `msclkid`, `ref`). Meaningful query params (`?page=2`, tenant IDs) get distinct entries — only tracking noise collapses. Hit within 1h → served from per-instance memory (no Claude cost; daily caps not charged). Cache holds the full **validated** report; tier view is applied per request.
5. **Daily IP cap**: 30 uncached scans / rolling 24h / IP → 429 `"Daily scan limit reached…"`.
6. **Instance budget**: 400 Claude calls / UTC day / instance → 503 `"The scanner is at capacity…"`.
7. SSRF: `validateUrlSafety` rejects private/reserved IPs and DNS results → 400 `"URL is not allowed"`.

**Processing**
- `safeFetch` (12s abort covering **headers AND body read**, manual-redirect with per-hop SSRF re-check, redirect bodies cancelled) → body capped at **512 KB** (`readBodyCapped`) → strip HTML → 8,000 chars. Site content is wrapped in `<<<SITE_CONTENT_START/END>>>` markers and declared untrusted in the prompt (prompt-injection guard).
- Claude call: native `https`, `claude-haiku-4-5-20251001`, `max_tokens: 3000`, 25s timeout, **one retry** on fast transient failures (429/5xx/conn errors failing in <8s; timeouts never retry — 60s duration budget). Prompt demands verbatim-quote evidence in issues and a ready-to-use example in action item #1.
- **Structured output**: forced tool-use (`submit_audit` tool, `tool_choice` pinned, `additionalProperties: false`, maxLength bounds). `extractJSON` text parsing remains as fallback only.
- **Server-side validation** (`validateReport`): every report is normalized before caching/serving — strings length-clamped, enums whitelisted (invalid → safe default), scores clamped 0–100, unknown fields dropped. Invalid shape → **one semantic retry** (budget-guarded), then 500. Responses are **built field-by-field** (`prepareTierView`) — model output is never cloned, so unknown properties cannot reach any tier.
- Cache the full result (only if the site fetch succeeded), then **`prepareTierView`**: stamps `tier`; for free requests **redacts** insights #2+ to `{ principle, locked: true }` and action items #2+ to `{ title, locked: true }`. Pro content never reaches free clients.

**Response 200** — tier-shaped report object (see [analysis-flow.md](analysis-flow.md)) plus `"tier": "pro"|"free"`.

**Errors** — 400 (bad/blocked URL), 405, 429 (hourly or daily limit), 503 (instance budget), 500 (`"Analysis failed"` on Claude error, `"Failed to parse AI response"` on parse failure).

---

## GET /api/config

Exposes Stripe URLs to the frontend at runtime (keeps them out of source).

**Request** — GET, no body.

**Response 200**
```json
{ "proUrl": "https://buy.stripe.com/…" | null,
  "agencyUrl": "https://buy.stripe.com/…" | null }
```
Values come from `STRIPE_PRO_URL` / `STRIPE_AGENCY_URL`; `null` if unset. No rate limit (public, cheap). Non-GET → 405. Response is CDN-cached (`Cache-Control: public, max-age=300, s-maxage=3600`) so page loads don't invoke the function.

Frontend loads this on page load; buttons silently no-op if a URL is `null`.

---

## POST /api/verify-key

Validates a Pro key without running an analysis — the frontend calls this before storing a key, so a random string never shows "Pro active" or bypasses the scan limit.

**Request** — `{ "proKey": "<candidate>" }`

**Guards** — POST only; rate limit **20 attempts / hour / IP** → 429 (bounds online guessing); key must be a string ≤200 chars (else `valid: false`).

**Behavior** — constant-time comparison against `PRO_PASSWORD` (sha256 digests + `crypto.timingSafeEqual`). Unset `PRO_PASSWORD` → always `valid: false`.

**Response 200** — `{ "valid": true | false }`.

---

## POST /api/subscribe

Waitlist email capture for Agency.

**Request**
```json
{ "email": "user@example.com" }
```

**Guards**
1. POST only (else 405).
2. Rate limit: **20 requests / hour / IP**. Exceed → 429.
3. `email` required, string, contains `@` (else 400). Sanitized: trim, lowercase, ≤254 chars.

**Behavior**
- If `RESEND_API_KEY` set → sends a branded confirmation email via Resend. **A failed send returns 502** (the email is the only signup record; the frontend shows an error instead of a false success).
- If not set (local dev) → just `console.log`s the signup and returns success.

**Response 200** — `{ "success": true }`. **502** — send failed.

---

## POST /api/email-report

Emails the free-tier slice of a just-completed audit to the user ("Keep this report" capture on the report page).

**Request**
```json
{
  "email": "user@example.com",
  "url": "https://scanned-site.com",
  "scores": { "trust": 38, "conversion": 55, "psychology": 31, "copy": 62, "mobile": 74, "overall": 48 },
  "topIssue": { "title": "…", "description": "…" },
  "insight": { "principle": "…", "text": "…" },
  "action": { "title": "…", "description": "…", "effort": "low", "conversionLift": "12%" },
  "counts": { "insights": 3, "actions": 4 }
}
```

**Guards**
1. POST only (else 405).
2. Rate limit: **10 requests / hour / IP** (tighter than subscribe — each call sends a full email).
3. **Per-recipient cap: 3 report emails / address / 24h** → 429 (anti mail-bomb; independent of IP).
4. `email` required, contains `@`, ≤254 chars. `url` must parse as http/https (else 400).
5. All content strings are length-clamped and HTML-escaped server-side; scores clamped 0–100; counts clamped 0–20.

**Behavior**
- Builds a light-background, inline-styled email: score breakdown bars, top issue, first insight, first action item, locked-content block with Pro CTA (`SITE_URL/#pricing`), forward nudge.
- Client only ever sends the free-tier slice — Pro content never leaves the browser for free users.
- If `RESEND_API_KEY` unset → logs and returns success (local dev).
- **Unlike subscribe, a Resend failure is fatal** → 502 `"Could not send the email. Please try again."` (the email is the product of this call).

**Response 200** — `{ "success": true }`.

**Env** — `SITE_URL` (defaults to `https://convertmind.ai`) controls CTA/footer links.

**Dev harness** — `node test-email.js` (repo root) runs the handler with mock data and writes the rendered email to `email-preview.html` for visual checks.

---

## Cross-cutting notes

- **Rate limiting is per-Lambda-instance**, not global. A scaled-out or freshly-cold function has its own empty Map. Treat limits as best-effort.
- **No authentication** on any endpoint. `/api/analyze` distinguishes Pro via the shared `proKey`, nothing more.
- **CORS** defaults to `*`; set `ALLOWED_ORIGIN` to the production origin to restrict browser callers.
