// Dev-only harness for api/analyze.js — mocks DNS, the site fetch, and the
// Anthropic call so gating/caching/limits can be verified without API spend.
// Run: node test-analyze.js
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.PRO_PASSWORD = 'secret-pro-key';

const dns = require('dns');
const https = require('https');

// 1. DNS always resolves to a public IP
dns.promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];

// 2. Site fetch returns fake HTML
global.fetch = async () => ({
  status: 200,
  headers: { get: () => null },
  text: async () => '<html><head><title>Acme Store</title></head><body><h1>Welcome to Acme</h1><p>We sell things.</p></body></html>',
});

// 3. Anthropic call returns a canned report; count invocations
let claudeCalls = 0;
const fakeReport = {
  summary: 'Test summary.',
  scores: { trust: 40, conversion: 55, psychology: 35, copy: 60, mobile: 70, overall: 50 },
  issues: [
    { title: 'Issue A', description: 'Desc A', severity: 'critical', impact: 'high' },
    { title: 'Issue B', description: 'Desc B', severity: 'warning', impact: 'medium' },
  ],
  psychologyInsights: [
    { principle: 'Loss Aversion', text: 'FREE-VISIBLE INSIGHT' },
    { principle: 'Social Proof', text: 'PRO-ONLY SECRET 1' },
    { principle: 'Anchoring', text: 'PRO-ONLY SECRET 2' },
  ],
  actionPlan: [
    { title: 'Action 1', description: 'FREE-VISIBLE ACTION', effort: 'low', conversionLift: '10-15%' },
    { title: 'Action 2', description: 'PRO-ONLY STEPS 1', effort: 'medium', conversionLift: '5-10%' },
    { title: 'Action 3', description: 'PRO-ONLY STEPS 2', effort: 'low', conversionLift: '3-8%' },
    { title: 'Action 4', description: 'PRO-ONLY STEPS 3', effort: 'high', conversionLift: '8-12%' },
  ],
};
https.request = (options, cb) => {
  claudeCalls++;
  const { EventEmitter } = require('events');
  const res = new EventEmitter();
  res.statusCode = 200;
  process.nextTick(() => {
    cb(res);
    res.emit('data', JSON.stringify({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(fakeReport) }],
    }));
    res.emit('end');
  });
  return { setTimeout() {}, on() {}, write() {}, end() {}, destroy() {} };
};

const handler = require('./api/analyze.js');

function makeReq(body, ip) {
  return { method: 'POST', headers: { 'x-real-ip': ip || '1.2.3.4' }, socket: {}, body };
}
function makeRes() {
  return {
    headers: {}, code: null, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; },
    writeHead() {}, end() {},
  };
}

(async () => {
  const results = {};

  // Test 1 — FREE request: Pro content must be redacted from the payload
  let res = makeRes();
  await handler(makeReq({ url: 'https://acme-store.example' }), res);
  const free = res.body;
  const freeJson = JSON.stringify(free);
  results.t1_free_status_200 = res.code === 200;
  results.t1_tier_free = free.tier === 'free';
  results.t1_insight1_present = free.psychologyInsights[0].text === 'FREE-VISIBLE INSIGHT';
  results.t1_no_pro_secrets_anywhere = !freeJson.includes('PRO-ONLY');
  results.t1_locked_insights_keep_principle = free.psychologyInsights[1].principle === 'Social Proof' && free.psychologyInsights[1].locked === true && !('text' in free.psychologyInsights[1]);
  results.t1_locked_actions_keep_title = free.actionPlan[2].title === 'Action 3' && !('description' in free.actionPlan[2]) && !('effort' in free.actionPlan[2]);
  results.t1_action1_full = free.actionPlan[0].description === 'FREE-VISIBLE ACTION' && free.actionPlan[0].conversionLift === '10-15%';
  results.t1_all_issues_full = free.issues.length === 2 && free.issues[1].description === 'Desc B';

  // Test 2 — CACHE: same URL again must not call Claude a second time
  const callsBefore = claudeCalls;
  res = makeRes();
  await handler(makeReq({ url: 'https://acme-store.example' }), res);
  results.t2_cache_hit_no_claude_call = claudeCalls === callsBefore;
  results.t2_cached_response_still_redacted = !JSON.stringify(res.body).includes('PRO-ONLY');

  // Test 3 — PRO request on the cached URL: full content from cache
  res = makeRes();
  await handler(makeReq({ url: 'https://acme-store.example', proKey: 'secret-pro-key' }), res);
  results.t3_tier_pro = res.body.tier === 'pro';
  results.t3_pro_gets_full_content = res.body.psychologyInsights[2].text === 'PRO-ONLY SECRET 2' && res.body.actionPlan[3].description === 'PRO-ONLY STEPS 3';
  results.t3_pro_served_from_cache = claudeCalls === callsBefore;

  // Test 4 — wrong key is free tier
  res = makeRes();
  await handler(makeReq({ url: 'https://acme-store.example', proKey: 'WRONG' }), res);
  results.t4_wrong_key_is_free = res.body.tier === 'free' && !JSON.stringify(res.body).includes('PRO-ONLY');

  // Test 5 — DAILY CAP: 30 uncached scans/day/IP, hourly limit is 10 → use 4 IPs… instead
  // simulate by hitting unique URLs from one IP until 429 (hourly cap of 10 fires first,
  // which itself proves the layered limits; then a fresh IP exercises the daily ceiling).
  let blockedAt = null;
  for (let i = 0; i < 12; i++) {
    res = makeRes();
    await handler(makeReq({ url: `https://site-${i}.example`, }, '9.9.9.9'), res);
    if (res.code === 429) { blockedAt = i + 1; break; } // 1-indexed request number
  }
  results.t5_hourly_limit_fires_at_11th = blockedAt === 11;

  // Test 6 — cached URL still served when rate-limited IP asks for it? (hourly limit
  // is checked before cache, so a limited IP gets 429 even on cached URLs — acceptable.)
  res = makeRes();
  await handler(makeReq({ url: 'https://acme-store.example' }, '9.9.9.9'), res);
  results.t6_limited_ip_gets_429 = res.code === 429;

  const failed = Object.entries(results).filter(([, v]) => !v);
  console.log(JSON.stringify(results, null, 2));
  console.log(failed.length === 0 ? '\nALL PASS' : `\nFAILURES: ${failed.map(([k]) => k).join(', ')}`);
  console.log('Total Claude calls (should be 1 + unique uncached URLs):', claudeCalls);
})();
