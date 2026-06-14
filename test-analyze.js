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
  if (fetchMode === 'thin') {
    // JS-shell: almost no readable text after stripping → low quality
    return new Response('<html><head><title>App</title></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>', { status: 200 });
  }
  if (fetchMode === 'noisy') {
    // Shopify-like: real nav/footer/cookie junk + a product grid full of
    // prices that must NOT become fake "pricing strategy" findings.
    return new Response(
      '<html><head><title>Noisy Store</title></head><body>' +
      '<div class="cookie">We use cookies to improve your experience. Accept all cookies.</div>' +
      '<nav><a href="/">Home</a><a href="/shop">Shop</a><a href="/sale">Sale</a></nav>' +
      '<div class="grid">' +
      Array.from({ length: 8 }, (_, i) => `<div class="card"><span>Item ${i}</span><span>$${100 + i}.00</span><a href="/p${i}">Buy now</a></div>`).join('') +
      '</div>' +
      '<nav class="footer"><a href="/">Home</a><a href="/shop">Shop</a><a href="/sale">Sale</a></nav>' +
      '<footer>© 2026 Noisy Inc. Terms of Service. Privacy Policy. All rights reserved.</footer>' +
      '</body></html>',
      { status: 200 }
    );
  }
  // Default: a realistic, content-rich, HIGH-quality page (title + meta +
  // multiple headings + CTA + >800 chars body) so confidence is NOT capped.
  return new Response(
    '<html><head><title>Acme Store — Premium Widgets</title>' +
    '<meta name="description" content="Acme sells premium widgets with fast free shipping and a 30-day money-back guarantee."></head><body>' +
    '<nav><a href="/">Home</a><a href="/shop">Shop</a></nav>' +
    '<h1>Welcome to Acme — the easiest way to buy widgets online</h1>' +
    '<h2>Why teams choose Acme</h2>' +
    '<p>Acme has shipped over one million widgets to happy customers worldwide. ' +
    'Our pricing is simple and transparent, every order ships free within 24 hours, ' +
    'and a 30-day money-back guarantee backs every purchase. Teams at leading ' +
    'companies rely on Acme to keep their operations running without interruption.</p>' +
    '<h2>How it works</h2>' +
    '<p>Choose your widget, check out in seconds, and track delivery in real time. ' +
    'Our support team answers every message within an hour, and onboarding is free ' +
    'for every plan. Thousands of five-star reviews describe Acme as fast, safe, ' +
    'and genuinely delightful to use day after day across every region we serve.</p>' +
    '<h2>Built for growing teams</h2>' +
    '<p>From solo founders to enterprise procurement departments, Acme scales with ' +
    'your needs. Volume discounts apply automatically, invoices are generated for ' +
    'every order, and our API lets you reorder programmatically whenever stock runs ' +
    'low. Security reviews, signed agreements, and dedicated account managers are ' +
    'available for larger customers who need them on day one of their contract.</p>' +
    '<a class="btn" href="/buy">Start your order now</a>' +
    '<footer>© 2026 Acme Inc. Terms of Service. Privacy Policy.</footer></body></html>',
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
  // Model no longer emits `overall` (computed server-side). Includes confidence.
  confidence: 85,
  scores: { trust: 40, conversion: 55, psychology: 35, copy: 60, mobile: 70 },
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
  if (mockMode === 'tool-oneissue') report = { ...fakeReport, issues: [fakeReport.issues[0]] };
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

  // ══ EXTRACTION UNIT TESTS (extractStructured, exported from the handler) ════
  const { extractStructured } = handler;

  const noisyHtml =
    '<html><head><title>Shop Acme — Best Deals</title>' +
    '<meta name="description" content="Acme sells premium widgets with fast free shipping."></head><body>' +
    '<header><nav><a href="/">Home</a><a href="/shop">Shop</a><a href="/about">About</a></nav></header>' +
    '<div class="cookie-banner">We use cookies to improve your experience. Accept all cookies. Cookie policy.</div>' +
    '<h1>Premium widgets that ship in 24 hours</h1>' +
    '<h2>Why customers choose Acme</h2>' +
    '<p>Acme has shipped over one million widgets to delighted customers across the globe, ' +
    'with transparent pricing and a thirty day money back guarantee on every order placed today.</p>' +
    '<a class="btn-primary" href="/buy">Add to cart</a>' +
    '<nav class="footer-nav"><a href="/">Home</a><a href="/shop">Shop</a><a href="/about">About</a></nav>' +
    '<footer>© 2026 Acme Inc. Privacy Policy. Terms of Service. All rights reserved. Cookie policy.</footer>' +
    '</body></html>';
  const ex = extractStructured(noisyHtml, false);
  const exJson = JSON.stringify(ex).toLowerCase();
  results.x_title = ex.title === 'Shop Acme — Best Deals';
  results.x_meta_preserved = /premium widgets with fast free shipping/.test(ex.metaDescription);
  results.x_cta_preserved = ex.ctas.some((c) => /add to cart/i.test(c));
  results.x_cookie_junk_removed = !exJson.includes('we use cookies') && !ex.bodyTextSample.toLowerCase().includes('accept all cookies');
  results.x_footer_legal_removed = !ex.bodyTextSample.toLowerCase().includes('all rights reserved') && !ex.bodyTextSample.toLowerCase().includes('terms of service');
  results.x_nav_deduped = ex.navItems.filter((n) => n.toLowerCase() === 'home').length === 1;

  // thin JS page → low quality + JS warning
  const exThin = extractStructured('<html><head><title>App</title></head><body><div id="root"></div><script src="/b.js"></script></body></html>', false);
  results.x_thin_low_quality = exThin.extractedContentQuality === 'low';
  results.x_thin_warns_js = exThin.extractionWarnings.some((w) => /javascript/i.test(w));

  // duplicate spam → collapsed in body + duplicate warning
  const dupHtml = '<html><head><title>Dup Co</title><meta name="description" content="x"></head><body>' +
    '<h1>Welcome to our store today</h1><h2>Featured</h2>' +
    Array(20).fill('<li>Shop all our products now</li>').join('') +
    '<p>Some genuinely unique and sufficiently long body content describing the offering in detail for analysis purposes here.</p>' +
    '<a class="btn" href="/x">Get started</a></body></html>';
  const exDup = extractStructured(dupHtml, false);
  results.x_dup_collapsed = (exDup.bodyTextSample.match(/Shop all our products now/gi) || []).length === 1;
  results.x_dup_warns = exDup.extractionWarnings.some((w) => /duplicate/i.test(w));

  // fetch failure → low quality, explicit warning
  const exFail = extractStructured('', true);
  results.x_fetchfail_low = exFail.extractedContentQuality === 'low' && exFail.extractionWarnings.length > 0;

  // ══ INTEGRATION: noisy Shopify-like HTML must not yield confident fake findings
  fetchMode = 'noisy';
  let resN = makeRes();
  await handler(makeReq({ url: 'https://noisy-store.example' }, '12.0.0.1'), resN);
  results.x_noisy_quality_not_high = resN.body.extractionQuality === 'medium' || resN.body.extractionQuality === 'low';
  results.x_noisy_confidence_capped = resN.body.confidence <= 65;
  results.x_noisy_pricing_warning = (resN.body.extractionWarnings || []).some((w) => /price|carousel|product/i.test(w));
  fetchMode = 'html';

  // ── t0/t1: request shape + free redaction ──────────────────────────────────
  let res = makeRes();
  await handler(makeReq({ url: 'https://acme-store.example' }), res);
  const sent = JSON.parse(lastRequestBody);
  results.t0_tool_choice_forced = sent.tool_choice && sent.tool_choice.name === 'submit_audit';
  results.t0_schema_locked = sent.tools[0].input_schema.additionalProperties === false;
  results.t0_untrusted_markers = sent.messages[0].content.includes('<<<EVIDENCE_START>>>')
    && sent.messages[0].content.includes('UNTRUSTED DATA');
  // Structured evidence (not a flat blob) is what reaches the model
  results.t0_structured_evidence = sent.messages[0].content.includes('"bodyTextSample"')
    && sent.messages[0].content.includes('"extractedContentQuality"');

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

  // ── t17: overall is COMPUTED from weighted dimensions, not model-emitted ───
  // weights: conv .30, trust .25, copy .20, psych .15, mobile .10
  // 55*.3 + 40*.25 + 60*.2 + 35*.15 + 70*.1 = 16.5+10+12+5.25+7 = 50.75 → 51
  res = makeRes();
  await handler(makeReq({ url: 'https://calib-overall.example' }, '10.0.0.1'), res);
  results.t17_overall_computed = res.body.scores.overall === 51;
  // model's free-emitted overall (was 50 in older shape) is ignored entirely
  results.t17_five_dims_present = ['trust','conversion','psychology','copy','mobile']
    .every((k) => typeof res.body.scores[k] === 'number');

  // ── t18: confidence is surfaced on both tiers ──────────────────────────────
  results.t18_confidence_present = res.body.confidence === 85;
  res = makeRes();
  await handler(makeReq({ url: 'https://calib-overall.example', proKey: 'secret-pro-key' }, '10.0.0.1'), res);
  results.t18_confidence_pro = res.body.confidence === 85;

  // ── t19: thin/JS-shell content → confidence clamped ≤35 server-side ────────
  fetchMode = 'thin';
  res = makeRes();
  await handler(makeReq({ url: 'https://js-shell-app.example' }, '10.0.0.2'), res);
  results.t19_thin_confidence_capped = res.code === 200 && res.body.confidence <= 35;
  fetchMode = 'html';

  // ── t20: issues quota relaxed — a 1-issue report is now valid (was minItems 4)
  mockMode = 'tool-oneissue';
  res = makeRes();
  await handler(makeReq({ url: 'https://strong-site.example' }, '10.0.0.3'), res);
  results.t20_single_issue_ok = res.code === 200 && res.body.issues.length === 1;
  mockMode = 'tool';

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
