// Dev-only test harness for api/email-report.js — not deployed (no export, run manually).
process.env.RESEND_API_KEY = 'test-key';

global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  require('fs').writeFileSync('email-preview.html', body.html);
  console.log('SUBJECT:', body.subject);
  console.log('TO:', body.to);
  console.log('FROM:', body.from);
  return { ok: true };
};

const handler = require('./api/email-report.js');

const mockReq = {
  method: 'POST',
  headers: { 'x-real-ip': '1.2.3.4' },
  socket: { remoteAddress: '1.2.3.4' },
  body: {
    email: 'jane@gmail.com',
    url: 'https://acme-store.example',
    scores: { trust: 38, conversion: 55, psychology: 31, copy: 62, mobile: 74, overall: 48 },
    topIssue: {
      title: 'Hero promises nothing measurable <script>alert(1)</script>',
      description: '"Welcome to Acme" tells a visitor what you\'re called, not what they gain. Loss-framed, outcome-specific headlines convert 27–41% better in this category.'
    },
    insight: {
      principle: 'Loss Aversion — Kahneman',
      text: 'Your pricing page frames Pro as a cost, not as recovered revenue. Reframing the $20.99 against the monthly value of one recovered customer flips the comparison in your favor.'
    },
    action: {
      title: 'Rewrite the hero headline around a measurable outcome',
      description: 'Replace the welcome message with a loss-framed, outcome-specific promise. Lead with what the visitor stops losing, not what you are called.',
      effort: 'low',
      conversionLift: '12%'
    },
    counts: { insights: 3, actions: 4 }
  }
};

function makeRes() {
  return {
    headers: {}, code: null, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; },
  };
}

(async () => {
  let failures = 0;

  // Send 1 — normal flow, writes email-preview.html
  let res = makeRes();
  await handler(mockReq, res);
  console.log('RESPONSE:', res.code, JSON.stringify(res.body));
  if (res.code !== 200) failures++;

  // XSS: the rendered email HTML must not contain a live <script> tag
  const html = require('fs').readFileSync('email-preview.html', 'utf8');
  const xssOk = !html.includes('<script>') && html.includes('&lt;script&gt;');
  console.log('EMAIL XSS ESCAPED:', xssOk ? 'PASS' : 'FAIL');
  if (!xssOk) failures++;

  // Sends 2-3 to the same recipient succeed; send 4 must hit the
  // per-recipient daily cap (3/day) regardless of IP.
  const codes = [];
  for (let i = 0; i < 3; i++) {
    res = makeRes();
    await handler({ ...mockReq, headers: { 'x-real-ip': `10.0.0.${i}` } }, res);
    codes.push(res.code);
  }
  const capOk = codes[0] === 200 && codes[1] === 200 && codes[2] === 429;
  console.log('RECIPIENT CAP (200,200,429 expected):', codes.join(','), capOk ? 'PASS' : 'FAIL');
  if (!capOk) failures++;

  // A different recipient is unaffected
  res = makeRes();
  await handler({ ...mockReq, body: { ...mockReq.body, email: 'other@example.com' } }, res);
  console.log('OTHER RECIPIENT (200 expected):', res.code, res.code === 200 ? 'PASS' : 'FAIL');
  if (res.code !== 200) failures++;

  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS CRASH:', e); process.exit(1); });
