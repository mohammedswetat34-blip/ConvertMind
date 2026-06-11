// Dev-only harness for api/verify-key.js. Run: node test-verify-key.js
// Exits nonzero on any failure.
process.env.PRO_PASSWORD = 'secret-pro-key';

const handler = require('./api/verify-key.js');

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

  let res = makeRes();
  await handler(makeReq({ proKey: 'secret-pro-key' }), res);
  results.valid_key_accepted = res.code === 200 && res.body.valid === true;

  res = makeRes();
  await handler(makeReq({ proKey: 'wrong-key' }), res);
  results.wrong_key_rejected = res.code === 200 && res.body.valid === false;

  res = makeRes();
  await handler(makeReq({}), res);
  results.missing_key_rejected = res.body.valid === false;

  res = makeRes();
  await handler(makeReq({ proKey: 'x'.repeat(500) }), res);
  results.oversized_key_rejected = res.body.valid === false;

  res = makeRes();
  await handler(makeReq({ proKey: { evil: true } }), res);
  results.non_string_rejected = res.body.valid === false;

  // Unset secret server-side → nothing validates
  const saved = process.env.PRO_PASSWORD;
  delete process.env.PRO_PASSWORD;
  res = makeRes();
  await handler(makeReq({ proKey: 'secret-pro-key' }), res);
  results.no_env_secret_rejects = res.body.valid === false;
  process.env.PRO_PASSWORD = saved;

  // Rate limit: 20/hr → 21st attempt from one IP gets 429
  let blockedAt = null;
  for (let i = 0; i < 25; i++) {
    res = makeRes();
    await handler(makeReq({ proKey: `guess-${i}` }, '8.8.8.8'), res);
    if (res.code === 429) { blockedAt = i + 1; break; }
  }
  results.rate_limit_at_21st = blockedAt === 21;

  const failed = Object.entries(results).filter(([, v]) => !v);
  console.log(JSON.stringify(results, null, 2));
  console.log(failed.length === 0 ? '\nALL PASS' : `\nFAILURES: ${failed.map(([k]) => k).join(', ')}`);
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS CRASH:', e); process.exit(1); });
