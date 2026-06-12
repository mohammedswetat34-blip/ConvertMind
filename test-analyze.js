// Dev-only harness for api/analyze.js — mocks DNS, the site fetch, and the
// Anthropic call so gating/caching/limits/validation can be verified without
// API spend. Run: node test-analyze.js  (exits nonzero on any failure)
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.PRO_PASSWORD = 'secret-pro-key';

const dns = require('dns');
const https = require('https');

// 1. DNS resolves to a public IP, unless dnsMode flips it to a failure
let dnsMode = 'ok';
dns.promises.lookup = async () => {
  if (dnsMode === 'fail') { const e = new Error('ENOTFOUND'); throw e; }
  return [{ address: '93.184.216.34', family: 4 }];
};

// 2. Site fetch — 'html' returns a normal page; 'bigstream' streams 64KB
//    chunks forever (verifies the body byte-cap stops reading).
let fetchMode = 'html';
let bigstreamPulls = 0;

global.fetch = async () => {
  if (fetchMode === 'bigstream') {
    const stream = new ReadableStream({
      pull(controller) {
        bigstreamPulls++;
        if (bigstreamPulls > 50) { controller.close(); return; } // safety valve
        controller.enqueue(new Uint8Array(65536).fill(120)); // 'x' bytes
      },
    });
    return new Response(stream, { status: 200 });
  }
  return new Response(
    '<html><head><title>Acme Store</title></head><body><h1>Welcome to Acme</h1><p>We sell things.</p></body></html>',
    { status: 200 }
  );
};

// 3. Anthropic mock — modes: 'tool' | 'text' | 'fail-once-429' |
//    'invalid-once' | 'tool-malicious' | 'tool-extra'
let mockMode = 'tool';
let failOnceArmed = false;
let invalidOnceArmed = false;
let claudeCalls = 0;
let lastRequestBody = null;

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

const maliciousReport = {
  ...fakeReport,
  issues: [
    { title: 'XSS probe', description: 'desc', severity: 'catastrophic', impact: '"><img src=x onerror=alert(1)>' },
    { title: 'Issue B', description: 'Desc B', severity: 'warning', impact: 'medium' },
  ],
  actionPlan: [
    { title: 'Evil action', description: 'desc', effort: '<script>alert(1)</script>', conversionLift: '<b>9000%</b>' },
    ...fakeReport.actionPlan.slice(1),
  ],
};

const extraFieldsReport = {
  ...fakeReport,
  evil: 'EVIL_TOPLEVEL',
  scores: { ...fakeReport.scores, internalDebug: 'EVIL_SCORE' },
  _meta: { secret: 'EVIL_META' },
};

function claudePayload() {
  if (mockMode === 'text') {
    return JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(fakeReport) }] });
  }
  let report = fakeReport;
  if (mockMode === 'tool-malicious') report = maliciousReport;
  if (mockMode === 'tool-extra') report = extraFieldsReport;
  if (mockMode === 'invalid-once' && invalidOnceArmed) {
    invalidOnceArmed = false;
    report = { garbage: true };
  }
  return JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'submit_audit', input: report }] });
}

https.request = (options, cb) => {
  claudeCalls++;
  const { EventEmitter } = require('events');
  const res = new EventEmitter();
  const fail = mockMode === 'fail-once-429' && failOnceArmed;
  if (fail) failOnceArmed = false;
  res.statusCode = fail ? 429 : 200;
  const payload = fail ? JSON.stringify({ error: { type: 'rate_limit_error' } }) : claudePayload();
  let written = '';
  return {
    setTimeout() {}, on() {}, destroy() {},
    write(b) { written += b; },
    end() {
      lastRequestBody = written;
      process.nextTick(() => {
        cb(res);
        res.emit('data', payload);
        res.emit('end');
      });
    },
  };
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

  // ── t0/t1: request shape + free redaction ──────────────────────────────────
  let res = makeRes();
  await handler(makeReq({ url: 'https://acme-store.example' }), res);
  const sent = JSON.parse(lastRequestBody);
  results.t0_tool_choice_forced = sent.tool_choice && sent.tool_choice.name === 'submit_audit';
  results.t0_schema_locked = sent.tools[0].input_schema.additionalProperties === false;
  results.t0_untrusted_markers = sent.messages[0].content.includes('<<<SITE_CONTENT_START>>>')
    && sent.messages[0].content.includes('UNTRUSTED DATA');

  const free = res.body;
  const freeJson = JSON.stringify(free);
  results.t1_free_200 = res.code === 200 && free.tier === 'free';
  results.t1_no_pro_content = !freeJson.includes('PRO-ONLY');
  results.t1_insight1_open = free.psychologyInsights[0].text === 'FREE-VISIBLE INSIGHT';
  results.t1_locked_shapes = free.psychologyInsights[1].locked === true && !('text' in free.psychologyInsights[1])
    && free.actionPlan[2].locked === true && !('description' in free.actionPlan[2]) && !('effort' in free.actionPlan[2]);
  results.t1_action1_full = free.actionPlan[0].description === 'FREE-VISIBLE ACTION';

  // ── t2/t3/t4: cache + pro + wrong key ──────────────────────────────────────
  let callsBefore = claudeCalls;
  res = makeRes();
  await handler(makeReq({ url: 'https://acme-store.example' }), res);
  results.t2_cache_hit = claudeCalls === callsBefore && !JSON.stringify(res.body).includes('PRO-ONLY');

  res = makeRes();
  await handler(makeReq({ url: 'https://acme-store.example', proKey: 'secret-pro-key' }), res);
  results.t3_pro_full_from_cache = res.body.tier === 'pro'
    && res.body.psychologyInsights[2].text === 'PRO-ONLY SECRET 2'
    && claudeCalls === callsBefore;

  res = makeRes();
  await handler(makeReq({ url: 'https://acme-store.example', proKey: 'WRONG' }), res);
  results.t4_wrong_key_free = res.body.tier === 'free' && !JSON.stringify(res.body).includes('PRO-ONLY');

  // ── t4b: cache hit carries the `cached` flag (frontend skips the counter) ──
  res = makeRes();
  await handler(makeReq({ url: 'https://acme-store.example' }), res);
  results.t4b_cache_flag_set = res.body.cached === true;
  // a fresh (uncached) scan must NOT carry it
  res = makeRes();
  await handler(makeReq({ url: 'https://fresh-uncached.example' }, '7.7.7.7'), res);
  results.t4b_fresh_no_cache_flag = res.body.cached === undefined && res.code === 200;

  // ── t7: tracking params + case + trailing slash collapse to one entry ──────
  callsBefore = claudeCalls;
  res = makeRes();
  await handler(makeReq({ url: 'https://acme-store.example/?utm_source=tw&fbclid=abc&ref=hn' }), res);
  results.t7_tracking_params_hit_cache = claudeCalls === callsBefore && res.code === 200;
  res = makeRes();
  await handler(makeReq({ url: 'https://ACME-STORE.example/' }), res);
  results.t7_case_slash_hit_cache = claudeCalls === callsBefore && res.code === 200;

  // ── t10: meaningful query params DO get distinct cache entries ─────────────
  callsBefore = claudeCalls;
  res = makeRes();
  await handler(makeReq({ url: 'https://shop.example/products?page=1' }, '2.2.2.2'), res);
  res = makeRes();
  await handler(makeReq({ url: 'https://shop.example/products?page=2' }, '2.2.2.2'), res);
  results.t10_query_pages_distinct = claudeCalls === callsBefore + 2;
  // same page, different param order + tracking noise → cache hit
  res = makeRes();
  await handler(makeReq({ url: 'https://shop.example/products?utm_medium=email&page=1' }, '2.2.2.2'), res);
  results.t10_param_order_and_tracking_collapse = claudeCalls === callsBefore + 2;

  // ── t11: port is part of the key ────────────────────────────────────────────
  res = makeRes();
  await handler(makeReq({ url: 'https://shop.example:8443/products?page=1' }, '2.2.2.2'), res);
  results.t11_port_distinct = claudeCalls === callsBefore + 3;

  // ── t12: malicious enums/values are normalized server-side ─────────────────
  mockMode = 'tool-malicious';
  res = makeRes();
  await handler(makeReq({ url: 'https://evil.example' }, '3.3.3.3'), res);
  const mal = res.body;
  results.t12_impact_normalized = mal.issues[0].impact === 'low' && mal.issues[0].severity === 'info';
  results.t12_effort_normalized = mal.actionPlan[0].effort === 'low';
  results.t12_lift_clamped_string = typeof mal.actionPlan[0].conversionLift === 'string' && mal.actionPlan[0].conversionLift.length <= 24;
  mockMode = 'tool';

  // ── t13: unknown fields never reach ANY tier ────────────────────────────────
  mockMode = 'tool-extra';
  res = makeRes();
  await handler(makeReq({ url: 'https://extra.example' }, '3.3.3.3'), res);
  const extraFree = JSON.stringify(res.body);
  results.t13_free_allowlisted = !('evil' in res.body) && !extraFree.includes('EVIL');
  res = makeRes();
  await handler(makeReq({ url: 'https://extra.example', proKey: 'secret-pro-key' }, '3.3.3.3'), res);
  const extraPro = JSON.stringify(res.body);
  results.t13_pro_allowlisted = !('evil' in res.body) && !extraPro.includes('EVIL');
  mockMode = 'tool';

  // ── t14: invalid model output → one semantic retry → success ───────────────
  mockMode = 'invalid-once';
  invalidOnceArmed = true;
  callsBefore = claudeCalls;
  res = makeRes();
  await handler(makeReq({ url: 'https://retry-validate.example' }, '4.4.4.4'), res);
  results.t14_validation_retry_recovers = res.code === 200 && claudeCalls === callsBefore + 2;
  mockMode = 'tool';

  // ── t8: text fallback still parses ──────────────────────────────────────────
  mockMode = 'text';
  res = makeRes();
  await handler(makeReq({ url: 'https://text-mode.example' }, '4.4.4.4'), res);
  results.t8_text_fallback = res.code === 200 && res.body.summary === 'Test summary.';
  mockMode = 'tool';

  // ── t9: transport 429 retry ─────────────────────────────────────────────────
  mockMode = 'fail-once-429';
  failOnceArmed = true;
  callsBefore = claudeCalls;
  res = makeRes();
  await handler(makeReq({ url: 'https://retry-mode.example' }, '4.4.4.4'), res);
  results.t9_transport_retry = res.code === 200 && claudeCalls === callsBefore + 2;
  mockMode = 'tool';

  // ── t15: body read is byte-capped (server streams forever) ─────────────────
  fetchMode = 'bigstream';
  bigstreamPulls = 0;
  res = makeRes();
  await handler(makeReq({ url: 'https://big.example' }, '5.5.5.5'), res);
  // 512KB cap / 64KB chunks = 8 pulls (+1 in flight); >12 means cap failed
  results.t15_body_capped = res.code === 200 && bigstreamPulls <= 12;
  fetchMode = 'html';

  // ── t16: DNS failure → friendly conversion message, NO budget spent ────────
  // A dead/typo'd domain must not (a) leak "URL is not allowed" or (b) drain
  // the daily instance budget, which is only for real Claude calls.
  dnsMode = 'fail';
  callsBefore = claudeCalls;
  res = makeRes();
  await handler(makeReq({ url: 'https://nonexistent-typo-domain.example' }, '6.6.6.6'), res);
  results.t16_dns_friendly_message = res.code === 400 && /couldn.t find that website/i.test(res.body.error);
  results.t16_dns_no_claude_call = claudeCalls === callsBefore;
  dnsMode = 'ok';

  // ── t5/t6: hourly rate limit ────────────────────────────────────────────────
  let blockedAt = null;
  for (let i = 0; i < 12; i++) {
    res = makeRes();
    await handler(makeReq({ url: `https://site-${i}.example` }, '9.9.9.9'), res);
    if (res.code === 429) { blockedAt = i + 1; break; }
  }
  results.t5_hourly_limit_at_11th = blockedAt === 11;
  res = makeRes();
  await handler(makeReq({ url: 'https://acme-store.example' }, '9.9.9.9'), res);
  results.t6_limited_ip_429 = res.code === 429;

  const failed = Object.entries(results).filter(([, v]) => !v);
  console.log(JSON.stringify(results, null, 2));
  console.log(failed.length === 0 ? '\nALL PASS' : `\nFAILURES: ${failed.map(([k]) => k).join(', ')}`);
  console.log('Total Claude calls:', claudeCalls);
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS CRASH:', e); process.exit(1); });
