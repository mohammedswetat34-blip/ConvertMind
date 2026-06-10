# Pricing & Pro Gating

## Tiers

| Tier | Price | Status | CTA |
|------|-------|--------|-----|
| Starter (Free) | $0 | Live | "Start Free" (focuses URL input) |
| Pro | $20.99/mo (~~$29.99~~ shown struck-through) | Live — Stripe Payment Link active | "Get Pro — $20.99/mo →" |
| Agency | $69.99/mo at launch | Waitlist only — no product exists | "Join Agency Waitlist →" (`openWaitlist()`) |

- Pro Stripe link: env var `STRIPE_PRO_URL`, served via `/api/config`.
- Agency Stripe link exists (`STRIPE_AGENCY_URL`) but is **intentionally not wired to any button** — Agency is "Coming Soon."

## The monetization model (intentional design)

The team explicitly rejected webhooks, KV stores, per-user tokens, Clerk, and full subscription infra as premature at zero customers. The chosen MVP is a **shared Pro password**:

1. Customer pays via the Stripe Payment Link.
2. Operator manually emails them the shared key (the value of `PRO_PASSWORD`).
3. Customer clicks **"Have a key?"** in the nav, pastes the key into the Pro modal.
4. Key is stored in `localStorage` as `cm_pro_key` and sent with every `/api/analyze` request as `proKey`.
5. The server compares `proKey === process.env.PRO_PASSWORD` and stamps `tier: 'pro'` on the report.

**Rotation:** change `PRO_PASSWORD` in Vercel, redeploy, email active subscribers the new key. All existing keys invalidate.

**Known trade-off:** the key is transferable/shareable. Acceptable at early stage (~0–30 customers); replace with magic-link JWT later. The product *value* gate (truncated report) is the real retention driver, not the enforcement.

## What's gated, exactly

**The gate is enforced server-side.** `api/analyze.js` → `prepareTierView()` redacts the payload for free requests: insights #2–3 are reduced to `{ principle, locked: true }` and action items #2–4 to `{ title, locked: true }` before the response leaves the server. Free users cannot recover Pro content from DevTools/network. The client-side lock rendering in `renderResults` is presentation on top of that:

| Report section | Free | Pro |
|----------------|------|-----|
| Executive summary | Full | Full |
| 6 score bars (incl. numbers) | Full | Full |
| All 4 issues | Full | Full |
| Psychology insight #1 | Full | Full |
| Psychology insights #2–3 | **Locked** — principle name shown, text hidden, "Unlock with Pro →" | Full |
| Action item #1 | Full (desc + effort + lift) | Full |
| Action items #2–4 | **Title shown**, description + effort + conversion-lift locked, "Get Pro →" | Full |
| Report title badge | none | "Pro" badge |
| Upgrade CTA block | shown | hidden |
| Scan limit | 3/month (localStorage) | bypassed |

## Why this converts

- Locked action items show the *title* ("Rewrite your headline using loss aversion") but not the *how* — an intolerable gap for a business owner.
- Hidden `+?% conversion` numbers taunt against the visible `+12–18%` on item #1.
- Two more site-specific psychology insights sit one click away.

## Relevant code locations

- Gate logic: `index.html` → `renderResults()` (`isPro = data.tier === 'pro'`).
- Server verification: `api/analyze.js` → `const isPro = proKey && process.env.PRO_PASSWORD && proKey === process.env.PRO_PASSWORD`.
- Pro key storage/UI: `getProKey` / `setProKey` / `openProKeyModal` / `activateProKey` / `updateNavProStatus` in `index.html`.
- Pricing cards markup: `index.html` `<section class="pricing-section">`.
