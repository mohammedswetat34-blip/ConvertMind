---
name: convertmind-context
description: Project context for ConvertMind — an AI-powered website conversion-audit SaaS. Static frontend + Vercel serverless functions, no database, no auth. Use this to understand the architecture, analysis flow, pricing/Pro gating, Stripe integration, API endpoints, and frontend structure before changing code.
---

# ConvertMind — Project Context

ConvertMind is a single-page SaaS that audits any website's conversion potential using Claude. A visitor pastes a URL, the backend fetches the page, sends the extracted text to Claude (Haiku), and returns a structured JSON report (scores, issues, psychology insights, action plan). The frontend renders it, gating part of the report behind a Pro tier.

## System at a glance

- **No framework, no build step.** Plain HTML/CSS/JS in one file (`index.html`), served statically by Vercel (`outputDirectory: "."`).
- **No database, no user accounts, no auth, no sessions.** All "state" is `localStorage` on the client.
- **Backend = 3 stateless serverless functions** in `api/` (auto-routed by Vercel): `analyze.js`, `config.js`, `subscribe.js`.
- **Monetization is a shared-password gate**, not a real auth system (deliberate early-stage choice — see [pricing-and-pro.md](references/pricing-and-pro.md)).
- **Model:** `claude-haiku-4-5-20251001`, called via native Node `https` (no SDK), `max_tokens: 3000`.

## File map

| Path | Role |
|------|------|
| `index.html` | Entire frontend: markup, CSS, and all JS (~1,400 lines) |
| `api/analyze.js` | Core endpoint — fetch site, call Claude, return report + tier |
| `api/config.js` | Returns Stripe URLs from env vars at runtime |
| `api/subscribe.js` | Waitlist email capture (optional Resend send) |
| `vercel.json` | Static output dir + security headers |
| `package.json` | Metadata only — no runtime dependencies |
| `.env.example` | Documents all environment variables |

## Environment variables

| Var | Used by | Purpose |
|-----|---------|---------|
| `ANTHROPIC_API_KEY` | analyze.js | Required. Claude API auth |
| `PRO_PASSWORD` | analyze.js | Shared key that unlocks the full Pro report |
| `STRIPE_PRO_URL` | config.js | Pro checkout Payment Link |
| `STRIPE_AGENCY_URL` | config.js | Agency link (exists, not wired to a button) |
| `RESEND_API_KEY` | subscribe.js | Optional. Sends waitlist confirmation emails |
| `ALLOWED_ORIGIN` | all 3 | CORS lock; `*` by default, set to prod domain to restrict |

## Knowledge base navigation

- [architecture.md](references/architecture.md) — hosting, routing, request lifecycle, security posture
- [analysis-flow.md](references/analysis-flow.md) — end-to-end scan flow from click to rendered report
- [pricing-and-pro.md](references/pricing-and-pro.md) — pricing tiers, Pro gating logic, what's locked/unlocked
- [apis.md](references/apis.md) — every endpoint: contract, validation, rate limits, errors
- [frontend.md](references/frontend.md) — view states, render functions, localStorage keys, modals

## Known gotchas

- **Scan limit is client-side only** (`localStorage` key `cm_scans`). Trivially bypassed by clearing storage. Not a real limit — it's a nudge. Server-side cost guards (hourly + daily IP limits, per-instance budget, 1h per-URL cache) bound the damage.
- **Pro content gate is real and server-side**: `analyze.js` → `prepareTierView()` redacts insights #2+ and action items #2+ from the payload for free requests. Pro is verified by comparing `proKey` to `PRO_PASSWORD`.
- **Rate limiting and caching are per-Lambda-instance** (in-memory `Map`s), not distributed. Reset on cold start; best-effort only.
- **Stripe URLs are runtime-loaded** from `/api/config`; in production an unset/unreachable config makes buy buttons fall back to a `mailto:hello@convertmind.ai` (never a silent no-op). On localhost they log a console warning instead.
- **Pro fulfillment is manual**: Stripe Payment Link → operator emails the shared key. Payment Links should redirect to `/welcome.html` (key-activation instructions) — set in the Stripe dashboard, see `.env.example`.
- **Report emails** (`/api/email-report`) send only the free-tier slice; see [apis.md](references/apis.md).
