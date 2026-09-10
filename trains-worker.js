// =====================================================================
// Life - Student Edition: live trains proxy (Cloudflare Worker)
// =====================================================================
// Why this exists: National Rail's data needs a private key, and the browser
// can't call it directly. This Worker holds the key, asks National Rail for
// the next hour of departures, and hands the result back to the web page.
//
// Set up once in the Cloudflare dashboard (Workers & Pages):
//   1. Create a Worker, choose "Start with Hello World", then Edit code.
//      Replace everything with this file and press Deploy.
//   2. Settings > Variables and Secrets:
//        RDM_KEY          (Secret)  your Rail Data Marketplace consumer key
//        ALLOWED_ORIGINS  (Text)    e.g. https://dpaul.studio
//                                   comma-separate several sites; leave unset to allow any
//   3. Copy the Worker's address (https://something.workers.dev) into
//      TRAINS_PROXY_URL near the top of index.html.
//
// Request:  GET /departures/MCO   ->   National Rail departure board JSON, next 60 minutes
// =====================================================================

const RDM_BOARD = 'https://api1.raildata.org.uk/1010-live-departure-board-dep/LDBWS/api/20220120/GetDepartureBoard/';
const CACHE_SECONDS = 30;          // everyone viewing the same station shares one lookup
const memo = new Map();            // crs -> { at, status, body }

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
    const allowOrigin = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : '');
    const cors = {
      'Access-Control-Allow-Origin': allowOrigin || 'null',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Vary': 'Origin'
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return reply({ error: 'Only GET is supported.' }, 405, cors);
    if (!allowOrigin) return reply({ error: 'This site is not allowed to use the trains proxy.' }, 403, cors);
    if (!env.RDM_KEY) return reply({ error: 'RDM_KEY is not set on the Worker.' }, 500, cors);

    const match = new URL(request.url).pathname.match(/^\/departures\/([A-Za-z]{3})\/?$/);
    if (!match) return reply({ error: 'Use /departures/ followed by a 3-letter station code.' }, 404, cors);
    const crs = match[1].toUpperCase();

    const hit = memo.get(crs);
    if (hit && Date.now() - hit.at < CACHE_SECONDS * 1000) {
      return new Response(hit.body, { status: hit.status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }

    let upstream;
    try {
      upstream = await fetch(`${RDM_BOARD}${crs}?numRows=60&timeOffset=0&timeWindow=60`, {
        headers: { 'x-apikey': env.RDM_KEY, 'Accept': 'application/json' }
      });
    } catch (e) {
      return reply({ error: 'Could not reach National Rail.' }, 502, cors);
    }

    const body = await upstream.text();
    const status = upstream.ok ? 200 : (upstream.status === 400 || upstream.status === 404 ? 404 : 502);
    if (upstream.ok) {
      memo.set(crs, { at: Date.now(), status, body });
      if (memo.size > 200) memo.delete(memo.keys().next().value);
    }
    return new Response(upstream.ok ? body : JSON.stringify({ error: `National Rail returned ${upstream.status}.` }), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }
};

function reply(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}
