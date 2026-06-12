// CORS fails CLOSED: if the env var is forgotten, only the production origin
// may call this from a browser (same-origin frontend calls are unaffected).
// Set ALLOWED_ORIGIN=* explicitly for local API development.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://convertmind.ai';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

module.exports = function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Stripe URLs change rarely — let the CDN absorb the per-pageload hit.
  // TTL is kept short: when the founder sets STRIPE_PRO_URL, buy buttons
  // must go live in minutes, not be held hostage by an hour of edge cache.
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');

  return res.status(200).json({
    proUrl:    process.env.STRIPE_PRO_URL    || null,
    agencyUrl: process.env.STRIPE_AGENCY_URL || null,
  });
};
