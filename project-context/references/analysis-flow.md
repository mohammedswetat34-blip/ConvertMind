# Analysis Flow

End-to-end path of a single scan, from button click to rendered report.

## 1. Trigger (`startScan`, index.html)

- Reads `#url-input`, trims, prepends `https://` if no protocol, validates with `new URL()`.
- **Scan-limit check:** if NOT a Pro user (`!getProKey()`) AND `getScanCount() >= SCAN_LIMIT` (3), shows the limit banner and stops.
- Otherwise: stores `lastUrl`, disables the button, switches to the analyzer view, shows the loading animation, calls `runAnalysis(url)`.

## 2. Loading animation (`showLoading`)

- Cycles 5 fake step labels (`step-1`…`step-5`) on a timer to fill the ~20–30s wait. Purely cosmetic.

## 3. API call (`runAnalysis`)

```js
POST /api/analyze
body: { url, proKey: getProKey() }
```
- 45s client-side abort timeout.
- On non-OK response, throws with the server's `error` message.
- On success: `incrementScanCount()`, re-enable button, mark loading steps done, then `renderResults(url, data)` after a 400ms beat.

## 4. Backend processing (`api/analyze.js`)

1. **Guards:** CORS, POST-only, `ANTHROPIC_API_KEY` present, rate limit, URL present + ≤2048 chars, valid http/https.
2. **SSRF:** `validateUrlSafety(parsedUrl)` — reject private/reserved targets.
3. **Fetch:** `safeFetch` with 12s abort; strip `<script>`/`<style>`/tags/whitespace; slice to 8,000 chars. On fetch failure, sends a `[Could not fetch page content: …]` placeholder so Claude still scores conservatively.
4. **Prompt:** instructs Claude (expert CRO + consumer psychologist) to return a fixed JSON shape (see below).
5. **Call Claude:** native `https` POST to `api.anthropic.com/v1/messages`, 25s timeout, `claude-haiku-4-5-20251001`, `max_tokens: 3000`.
6. **Parse:** `extractJSON` runs a 4-strategy fallback chain (anchor on `{"summary"`, first balanced brace, first→last brace, then `patchTruncated` for cut-off responses) — resilient to Claude wrapping JSON in prose or truncation.
7. **Tier:** `result.tier = (proKey === PRO_PASSWORD) ? 'pro' : 'free'`.
8. Returns the JSON report.

## 5. Report shape (Claude's contract)

```json
{
  "summary": "2-3 sentence executive summary",
  "scores": { "trust":0-100, "conversion":0-100, "psychology":0-100,
              "copy":0-100, "mobile":0-100, "overall":0-100 },
  "issues": [ { "title", "description", "severity":"critical|warning|info",
                "impact":"high|medium|low" } ],      // exactly 4, critical first
  "psychologyInsights": [ { "principle", "text" } ], // exactly 3, distinct principles
  "actionPlan": [ { "title", "description", "effort":"low|medium|high",
                    "conversionLift":"e.g. 5-15%" } ] // exactly 4, highest ROI first
}
```
Backend appends `"tier": "pro" | "free"`.

## 6. Render (`renderResults`) — see [pricing-and-pro.md](pricing-and-pro.md) for the gating

- Summary + 6 animated score bars: always fully shown (free and pro).
- All 4 issues: always fully shown (showing the problems builds urgency).
- Psychology insights: free sees #1 full, #2–3 locked. Pro sees all.
- Action plan: free sees #1 full, #2–4 title-only with locked body/metrics. Pro sees all.
- Upgrade CTA shown for free, hidden for pro. "Pro" badge added to the report title for pro.

## Failure modes

- **Fetch fails** (DNS, timeout, blocked) → Claude still returns a conservative report from the placeholder text.
- **Claude returns non-JSON / truncated** → `extractJSON` attempts recovery; if all 4 strategies fail, returns HTTP 500 `"Failed to parse AI response"`.
- **Rate limited** → HTTP 429.
- **Client timeout (45s)** → frontend shows "Analysis timed out."
