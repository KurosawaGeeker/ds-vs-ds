import { leadingZeroBits, powDifficulty } from './pow.js';

const VOTER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FRESH_MS = 10000;

function logFailure(event, error) {
  // Never log request bodies, tokens or voter identities.
  console.error(JSON.stringify({ event, message: String(error?.message || error).slice(0, 300) }));
}

// Validated ballots must carry fresh proof of work: one hash to verify here,
// about 2^difficulty hashes to mint, which scripted farms pay per attempt.
async function challengeMet(env, voterId, choice, token, nonce) {
  const difficulty = powDifficulty(env);
  if (difficulty < 1) return true;
  if (typeof nonce !== 'string' || !/^\d{1,48}$/.test(nonce)) return false;
  const message = new TextEncoder().encode(`${voterId}:${choice}:${token}:${nonce}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', message));
  return leadingZeroBits(digest) >= difficulty;
}

async function readTotals(env) {
  const { results } = await env.DB.prepare('SELECT choice, total FROM totals ORDER BY choice').all();
  return { left: results.find(row => row.choice === 'left').total, right: results.find(row => row.choice === 'right').total, updatedAt: Date.now() };
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    const allowed = origin !== null && env.ALLOWED_ORIGINS.includes(origin);
    const headers = {
      'Access-Control-Allow-Origin': allowed ? origin : env.ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Voter-ID',
      'Access-Control-Expose-Headers': 'Retry-After',
      'Access-Control-Max-Age': '86400',
      'Cache-Control': 'no-store',
      'Vary': 'Origin',
      'X-Content-Type-Options': 'nosniff',
    };
    const reply = (body, status = 200, extra = {}) => Response.json(body, { status, headers: { ...headers, ...extra } });
    const busy = () => reply({ error: 'rate_limited' }, 429, { 'Retry-After': '60' });
    if (origin && !allowed) return reply({ error: 'Origin not allowed' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\//, '/');
    if (!['/results', '/selection', '/vote'].includes(path)) return reply({ error: 'Not found' }, 404);
    if (request.method !== (path === '/vote' ? 'POST' : 'GET')) return reply({ error: 'Method not allowed' }, 405);
    const voterId = request.headers.get('X-Voter-ID');
    if (voterId && !VOTER_ID.test(voterId)) return reply({ error: 'Invalid voter' }, 400);
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) return reply({ error: 'Missing client address' }, 403);
    try {
      if (path === '/results') {
        // Query strings and client IDs cannot bypass this shared public cache.
        const key = new Request(`${url.origin}/__public_totals_v2`);
        const cachedResponse = await caches.default.match(key);
        const cached = cachedResponse ? await cachedResponse.json() : null;
        if (cached && Date.now() - cached.updatedAt < FRESH_MS) return reply({ ...cached, stale: false });
        if (!(await env.RESULTS_REFRESH.limit({ key: 'totals' })).success) {
          return cached ? reply({ ...cached, stale: true }) : reply({ error: 'Results warming up' }, 503, { 'Retry-After': '10' });
        }
        try {
          const totals = await readTotals(env);
          ctx.waitUntil(caches.default.put(key, Response.json(totals, { headers: { 'Cache-Control': 'public, max-age=86400' } })).catch(error => logFailure('results_cache_failure', error)));
          return reply({ ...totals, stale: false });
        } catch (error) {
          if (!cached) throw error;
          logFailure('results_refresh_failure', error);
          return reply({ ...cached, stale: true });
        }
      }
      if (!voterId) return reply({ error: 'Invalid vote request' }, 403);
      if (path === '/selection') {
        if (!(await env.SELECTION_LIMIT.limit({ key: ip })).success || !(await env.DB_READ_LIMIT.limit({ key: 'selection' })).success) return busy();
        const row = await env.DB.prepare('SELECT choice FROM votes WHERE voter_id = ?').bind(voterId).first();
        return reply({ selected: row?.choice ?? null, pow: { difficulty: powDifficulty(env) } });
      }
      if (!allowed) return reply({ error: 'Invalid vote request' }, 403);
      if (!(await env.VOTE_LIMIT.limit({ key: ip })).success) return busy();
      if (!request.headers.get('Content-Type')?.startsWith('application/json')) return reply({ error: 'JSON required' }, 415);
      if (Number(request.headers.get('Content-Length')) > 4096) return reply({ error: 'Body too large' }, 413);
      const reader = request.body?.getReader();
      if (!reader) return reply({ error: 'Missing body' }, 400);
      let raw = '';
      let length = 0;
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 4096) { await reader.cancel(); return reply({ error: 'Body too large' }, 413); }
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
      let body;
      try { body = JSON.parse(raw); } catch { return reply({ error: 'Invalid JSON' }, 400); }
      if (body?.choice !== 'left' && body?.choice !== 'right') return reply({ error: 'Invalid choice' }, 400);
      if (typeof body.token !== 'string' || !body.token || body.token.length > 2048) return reply({ error: 'verification_required' }, 403);
      // Cheap local check first: siteverify is a one-use-token call, so a
      // failed proof here must not burn the token the client may retry with.
      if (!(await challengeMet(env, voterId, body.choice, body.token, body.nonce))) {
        return reply({ error: 'pow_failed', difficulty: powDifficulty(env) }, 403);
      }
      if (!env.TURNSTILE_SECRET_KEY) return reply({ error: 'Verification unavailable' }, 503);
      const verification = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: body.token, remoteip: ip }),
        signal: AbortSignal.timeout(8000),
      });
      if (!verification.ok) throw new Error('Turnstile verification service unavailable');
      const verified = await verification.json();
      if (!verified.success || !env.ALLOWED_ORIGINS.some(value => new URL(value).hostname === verified.hostname) || verified.action !== 'vote' || verified.cdata !== voterId) {
        return reply({ error: 'verification_failed' }, 403);
      }
      // Invalid bot submissions must not consume the shared database write budget.
      if (!(await env.VOTE_GLOBAL_LIMIT.limit({ key: 'vote' })).success) return busy();
      // One-use Turnstile tokens plus UUID uniqueness protect against replay and retries.
      const result = await env.DB.batch([
        env.DB.prepare('INSERT INTO votes (voter_id, choice) VALUES (?, ?) ON CONFLICT(voter_id) DO NOTHING').bind(voterId, body.choice),
        env.DB.prepare('SELECT choice, total FROM totals ORDER BY choice'),
        env.DB.prepare('SELECT choice FROM votes WHERE voter_id = ?').bind(voterId),
      ]);
      const totals = result[1].results;
      return reply({ left: totals.find(row => row.choice === 'left').total, right: totals.find(row => row.choice === 'right').total, selected: result[2].results[0].choice, updatedAt: Date.now(), stale: false });
    } catch (error) {
      logFailure('vote_api_failure', error);
      return reply({ error: 'Temporarily unavailable' }, 503, { 'Retry-After': '10' });
    }
  },
};
