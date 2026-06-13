#!/usr/bin/env node
/**
 * Score calibration benchmark for ConvertMind.
 *
 * Runs the live /api/analyze endpoint against a fixed set of well-known sites
 * and prints their six scores + confidence, plus distribution stats. Designed
 * to be run TWICE around a calibration change to produce a before/after diff:
 *
 *   node benchmark-scores.js before     # against current prod (old calibration)
 *   # ...deploy new calibration...
 *   node benchmark-scores.js after      # against new prod
 *   node benchmark-scores.js compare    # prints before vs after table
 *
 * Config:
 *   BASE_URL env var (default https://www.convertmind.xyz)
 *   Results saved to benchmark-<label>.json next to this script.
 *
 * NOTE: each run makes 8 real Claude calls against the live engine and counts
 * against the daily per-IP scan cap. It does not modify any deployment.
 */
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'https://www.convertmind.xyz';
const SITES = [
  ['Apple',   'https://www.apple.com'],
  ['Notion',  'https://www.notion.com'],
  ['Shopify', 'https://www.shopify.com'],
  ['Stripe',  'https://stripe.com'],
  ['Webflow', 'https://webflow.com'],
  ['HubSpot', 'https://www.hubspot.com'],
  ['Vercel',  'https://vercel.com'],
  ['Linear',  'https://linear.app'],
];
const DIMS = ['overall', 'trust', 'conversion', 'psychology', 'copy', 'mobile'];

function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function stdev(xs) {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}
function pad(s, n) { return String(s).padEnd(n); }
function padL(s, n) { return String(s).padStart(n); }

async function scan(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 70000);
  try {
    const res = await fetch(`${BASE_URL}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { error: `${res.status}: ${body.error || 'unknown'}` };
    return {
      scores: body.scores || {},
      confidence: typeof body.confidence === 'number' ? body.confidence : null,
      cached: !!body.cached,
    };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(t);
  }
}

function printTable(rows) {
  console.log('\n' + pad('Site', 10) + DIMS.map((d) => padL(d.slice(0, 5), 7)).join('') + padL('conf', 7) + '  note');
  console.log('-'.repeat(10 + DIMS.length * 7 + 7 + 6));
  for (const r of rows) {
    if (r.error) { console.log(pad(r.name, 10) + padL('— ' + r.error, 7 * DIMS.length)); continue; }
    console.log(
      pad(r.name, 10) +
      DIMS.map((d) => padL(r.scores[d] ?? '–', 7)).join('') +
      padL(r.confidence ?? '–', 7) +
      '  ' + (r.cached ? 'cached' : '')
    );
  }
}

function printStats(rows) {
  const overalls = rows.filter((r) => !r.error && typeof r.scores.overall === 'number').map((r) => r.scores.overall);
  if (!overalls.length) { console.log('\n(no successful scans — cannot compute stats)'); return; }
  console.log('\nDistribution (overall):');
  console.log(`  n=${overalls.length}  min=${Math.min(...overalls)}  max=${Math.max(...overalls)}  range=${Math.max(...overalls) - Math.min(...overalls)}`);
  console.log(`  mean=${mean(overalls).toFixed(1)}  stdev=${stdev(overalls).toFixed(1)}`);
  const band = (lo, hi) => overalls.filter((x) => x >= lo && x <= hi).length;
  console.log(`  90-100: ${band(90, 100)}   75-89: ${band(75, 89)}   55-74: ${band(55, 74)}   35-54: ${band(35, 54)}   0-34: ${band(0, 34)}`);
}

function file(label) { return path.join(__dirname, `benchmark-${label}.json`); }

async function run(label) {
  console.log(`Benchmarking ${SITES.length} sites against ${BASE_URL} (label: ${label})`);
  const rows = [];
  for (const [name, url] of SITES) {
    process.stdout.write(`  scanning ${name}… `);
    const r = await scan(url);
    console.log(r.error ? `ERROR ${r.error}` : `overall ${r.scores.overall} (conf ${r.confidence})`);
    rows.push({ name, url, ...r });
    await new Promise((res) => setTimeout(res, 1500)); // be gentle on rate limits
  }
  printTable(rows);
  printStats(rows);
  fs.writeFileSync(file(label), JSON.stringify(rows, null, 2));
  console.log(`\nSaved → ${file(label)}`);
}

function compare() {
  const before = JSON.parse(fs.readFileSync(file('before'), 'utf8'));
  const after = JSON.parse(fs.readFileSync(file('after'), 'utf8'));
  const byName = (arr) => Object.fromEntries(arr.map((r) => [r.name, r]));
  const b = byName(before), a = byName(after);
  console.log('\nBEFORE → AFTER (overall score)\n' + '-'.repeat(40));
  console.log(pad('Site', 10) + padL('before', 9) + padL('after', 9) + padL('Δ', 8));
  for (const [name] of SITES) {
    const bo = b[name] && !b[name].error ? b[name].scores.overall : null;
    const ao = a[name] && !a[name].error ? a[name].scores.overall : null;
    const delta = (bo != null && ao != null) ? (ao - bo > 0 ? '+' : '') + (ao - bo) : '–';
    console.log(pad(name, 10) + padL(bo ?? '–', 9) + padL(ao ?? '–', 9) + padL(delta, 8));
  }
  const ov = (arr) => arr.filter((r) => !r.error && r.scores).map((r) => r.scores.overall);
  const bo = ov(before), ao = ov(after);
  if (bo.length && ao.length) {
    console.log('\nRange:  before ' + (Math.max(...bo) - Math.min(...bo)) + '  →  after ' + (Math.max(...ao) - Math.min(...ao)));
    console.log('Stdev:  before ' + stdev(bo).toFixed(1) + '  →  after ' + stdev(ao).toFixed(1));
  }
}

const mode = process.argv[2] || 'before';
if (mode === 'compare') compare();
else run(mode).catch((e) => { console.error(e); process.exit(1); });
