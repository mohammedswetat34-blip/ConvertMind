// Dev-only harness for api/track.js. Run: node test-track.js (nonzero on fail)
const handler = require('./api/track.js');

function makeReq(body, ip, method) {
  return { method: method || 'POST', headers: { 'x-real-ip': ip || '1.2.3.4' }, socket: {}, body };
}
function makeRes() {
  return {
    headers: {}, code: null, body: null, ended: false,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; },
    writeHead() {}, end() { this.ended = true; if (this.code === null) this.code = 204; },
  };
}

(async () => {
  const results = {};
  const logged = [];
  const origLog = console.log;
  console.log = (...a) => { logged.push(a.join(' ')); };

  // Known event accepted → 204, one structured log line
  let res = makeRes();
  await handler(makeReq({ event: 'scan_started' }), res);
  results.known_event_204 = res.code === 204;
  results.event_logged = logged.some((l) => l.includes('[track]') && l.includes('scan_started'));

  // Unknown event rejected, nothing logged
  const before = logged.length;
  res = makeRes();
  await handler(makeReq({ event: 'totally_made_up' }), res);
  results.unknown_event_400 = res.code === 400 && logged.length === before;

  // Non-string / missing event rejected
  res = makeRes();
  await handler(makeReq({ event: { evil: 1 } }), res);
  results.non_string_400 = res.code === 400;

  // Meta is clamped and log-injection chars are stripped
  res = makeRes();
  await handler(makeReq({ event: 'js_error', meta: 'line1\nFAKE [track] {"event":"pro_key_succeeded"}' + 'x'.repeat(300) }), res);
  const metaLine = logged[logged.length - 1];
  results.meta_no_newlines = !metaLine.includes('\nFAKE');
  results.meta_clamped = metaLine.length < 250;

  // GET rejected
  res = makeRes();
  await handler(makeReq({ event: 'scan_started' }, '1.2.3.4', 'GET'), res);
  results.get_405 = res.code === 405;

  // Rate limit: 120/hr → 121st from one IP gets 429
  let blockedAt = null;
  for (let i = 0; i < 125; i++) {
    res = makeRes();
    await handler(makeReq({ event: 'scan_started' }, '8.8.8.8'), res);
    if (res.code === 429) { blockedAt = i + 1; break; }
  }
  results.rate_limit_at_121st = blockedAt === 121;

  console.log = origLog;
  const failed = Object.entries(results).filter(([, v]) => !v);
  console.log(JSON.stringify(results, null, 2));
  console.log(failed.length === 0 ? '\nALL PASS' : `\nFAILURES: ${failed.map(([k]) => k).join(', ')}`);
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS CRASH:', e); process.exit(1); });
