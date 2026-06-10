# Frontend Structure

Everything lives in `index.html` — markup, `<style>`, and `<script>`. No framework, no modules, no bundler. ~1,400 lines.

## Views (show/hide via `display`)

| Element id | Role |
|------------|------|
| `#home-view` | Hero + scan box, "How It Works", pricing section |
| `#analyzer-view` | Loading, error, and results states |
| `#limitBanner` | Shown when free scan limit hit |
| `#loading-state` | Spinner + 5 cycling fake steps |
| `#error-state` | Error message + retry |
| `#results-state` | The rendered report |

View switching: `showAnalyzerView`, `resetToHome`, `hideAll`, `showLoading`, `showError`.

## Core JS functions

| Function | Purpose |
|----------|---------|
| `startScan()` | Validate URL, enforce free limit (unless Pro), kick off analysis |
| `runAnalysis(url)` | `POST /api/analyze` with `{ url, proKey }`, 45s timeout, handle response |
| `renderResults(url, data)` | Build the whole report DOM; applies Pro/free gating via `data.tier` |
| `escHtml(str)` | Escape all Claude output before `innerHTML` (XSS defense) |
| `getScanCount` / `incrementScanCount` | Read/write monthly count in localStorage |
| `getProKey` / `setProKey` | Read/write the Pro key in localStorage |
| `updateNavProStatus()` | Flip nav link to green "Pro active ✓" when a key is stored |
| `openProKeyModal` / `closeProKeyModal` / `activateProKey` | Pro key modal lifecycle; on activate, re-runs `lastUrl` |
| `openWaitlist` / `closeWaitlist` / `submitWaitlist` | Agency waitlist modal → `POST /api/subscribe` |
| `goToStripe(url)` | `window.open` the Stripe link; silent no-op if `null` |

## localStorage keys

| Key | Shape | Meaning |
|-----|-------|---------|
| `cm_scans` | `{ "YYYY-M": count }` (month index 0–11) | Free scans used this month |
| `cm_pro_key` | string | The shared Pro key the user pasted |

`SCAN_LIMIT = 3`. Both keys are user-editable — the scan gate is a nudge, not enforcement. The Pro gate is verified server-side regardless of what's in `cm_pro_key`.

## Modals

- **Pro key modal** (`#proKeyModal`): text input → `activateProKey()`. Supports Enter to submit, Escape / click-outside to close.
- **Waitlist modal** (`#waitlistModal`): email input → `submitWaitlist()`; swaps to a success panel. Escape / click-outside to close.

## Stripe wiring

- On load, `fetch('/api/config')` populates `STRIPE_PRO_URL` / `STRIPE_AGENCY_URL` globals.
- Four "Get Pro" buttons (nav, pricing card, limit banner, results CTA) all call `goToStripe(STRIPE_PRO_URL)`.
- Agency CTA calls `openWaitlist()` — never `goToStripe` (Agency isn't sold yet).

## Render-time gating (in `renderResults`)

`const isPro = data.tier === 'pro';` drives:
- Psychology insights: `if (!isPro && idx > 0)` → locked card.
- Action plan: `if (!isPro && idx > 0)` → title shown, body/metrics locked.
- `#results-title` gets a "Pro" badge when `isPro`.
- `#upgrade-cta-section` hidden when `isPro`.

## Styling

- CSS custom properties in `:root` (dark theme: `--bg #0a0a0f`, `--accent #7c5cfc`, `--accent2 #c084fc`).
- Fonts: Syne (sans) + DM Mono (mono) from Google Fonts.
- Pro-gating styles: `.insight-locked`, `.insight-unlock-btn`, `.plan-desc-locked`, `.plan-unlock-btn`, `.tag-locked`, `.pro-badge-header`, `.pro-key-input`, `.nav-pro-key-link`.
- Responsive breakpoint at `max-width: 600px`.
