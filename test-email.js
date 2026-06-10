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

const mockRes = {
  headers: {},
  setHeader(k, v) { this.headers[k] = v; },
  status(c) { this.code = c; return this; },
  json(o) { console.log('RESPONSE:', this.code, JSON.stringify(o)); }
};

handler(mockReq, mockRes);
