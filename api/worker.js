const VOTER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const headers = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Voter-ID',
      'Access-Control-Max-Age': '86400',
      'Cache-Control': 'no-store',
      'Vary': 'Origin',
      'X-Content-Type-Options': 'nosniff',
    };
    const reply = (body, status = 200) => Response.json(body, { status, headers });
    if (origin && origin !== env.ALLOWED_ORIGIN) return reply({ error: 'Origin not allowed' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const path = new URL(request.url).pathname;
    if (path !== '/results' && path !== '/vote') return reply({ error: 'Not found' }, 404);
    if ((path === '/results' && request.method !== 'GET') || (path === '/vote' && request.method !== 'POST')) return reply({ error: 'Method not allowed' }, 405);
    const voterId = request.headers.get('X-Voter-ID');
    if (voterId && !VOTER_ID.test(voterId)) return reply({ error: 'Invalid voter' }, 400);
    try {
      const statements = [];
      if (path === '/vote') {
        if (origin !== env.ALLOWED_ORIGIN || !voterId) return reply({ error: 'Invalid vote request' }, 403);
        if (!request.headers.get('Content-Type')?.startsWith('application/json')) return reply({ error: 'JSON required' }, 415);
        // Bound streamed bodies as well as declared Content-Length.
        if (Number(request.headers.get('Content-Length')) > 128) return reply({ error: 'Body too large' }, 413);
        const reader = request.body?.getReader();
        if (!reader) return reply({ error: 'Missing body' }, 400);
        let raw = '';
        let length = 0;
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 128) { await reader.cancel(); return reply({ error: 'Body too large' }, 413); }
          raw += decoder.decode(value, { stream: true });
        }
        raw += decoder.decode();
        let body;
        try { body = JSON.parse(raw); } catch { return reply({ error: 'Invalid JSON' }, 400); }
        if (body?.choice !== 'left' && body?.choice !== 'right') return reply({ error: 'Invalid choice' }, 400);
        statements.push(env.DB.prepare('INSERT INTO votes (voter_id, choice) VALUES (?, ?) ON CONFLICT(voter_id) DO NOTHING').bind(voterId, body.choice));
      }
      statements.push(env.DB.prepare('SELECT choice, total FROM totals ORDER BY choice'));
      statements.push(env.DB.prepare('SELECT choice FROM votes WHERE voter_id = ?').bind(voterId || ''));
      const result = await env.DB.batch(statements);
      const totals = result[result.length - 2].results;
      const selection = result[result.length - 1].results[0]?.choice ?? null;
      return reply({ left: totals.find(row => row.choice === 'left').total, right: totals.find(row => row.choice === 'right').total, selected: selection });
    } catch (error) {
      console.error(JSON.stringify({ event: 'vote_api_failure', name: error.name }));
      return reply({ error: 'Temporarily unavailable' }, 503);
    }
  },
};
