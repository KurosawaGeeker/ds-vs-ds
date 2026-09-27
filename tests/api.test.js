import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../api/worker.js';

const origin = 'https://ds-vs-ds.win';
const allow = { async limit() { return { success: true }; } };

// Execute the production schema and SQL against real SQLite, with network validation stubbed.
test('validated votes are atomic, duplicate IDs and replayed tokens cannot add votes', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../api/schema.sql', import.meta.url), 'utf8'));
  function prepare(sql, params = []) {
    return {
      bind(...values) { return prepare(sql, values); },
      all() { return { results: db.prepare(sql).all(...params) }; },
      first() { return db.prepare(sql).get(...params) || null; },
      run() { return /^SELECT/.test(sql) ? this.all() : { results: [], ...db.prepare(sql).run(...params) }; },
    };
  }
  const env = {
    ALLOWED_ORIGINS: [origin, 'https://ds-vs-ds.pages.dev'],
    TURNSTILE_SECRET_KEY: 'test-only', VOTE_LIMIT: allow, VOTE_GLOBAL_LIMIT: allow,
    SELECTION_LIMIT: allow, DB_READ_LIMIT: allow,
    DB: { prepare, async batch(statements) {
      db.exec('BEGIN');
      try { const results = statements.map(s => s.run()); db.exec('COMMIT'); return results; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    } },
  };
  const id = crypto.randomUUID();
  const tokens = new Map();
  const used = new Set();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    const token = options.body.get('response');
    const success = tokens.has(token) && !used.has(token);
    used.add(token);
    return Response.json({ success, hostname: 'ds-vs-ds.win', action: 'vote', cdata: tokens.get(token) });
  };
  async function call(path, { voter = id, body, source = origin, method = body ? 'POST' : 'GET' } = {}) {
    return worker.fetch(new Request(`https://ds-vs-ds.win${path}`, {
      method, headers: { ...(source ? { Origin: source } : {}), 'X-Voter-ID': voter, 'CF-Connecting-IP': '192.0.2.2', 'Content-Type': 'application/json' }, body,
    }), env);
  }
  function ballot(voter, choice) {
    const token = crypto.randomUUID(); tokens.set(token, voter);
    return JSON.stringify({ choice, token });
  }
  try {
    assert.equal((await call('/vote', { method: 'OPTIONS' })).status, 204);
    assert.equal((await call('/vote', { body: ballot(id, 'left'), source: 'https://example.com' })).status, 403);
    for (const body of ['null', '{', '{"choice":"invalid"}']) assert.equal((await call('/vote', { body })).status, 400);
    assert.equal((await call('/vote', { body: 'x'.repeat(4097) })).status, 413);
    assert.equal((await call('/vote', { voter: 'bad', body: '{}' })).status, 400);
    const firstBody = ballot(id, 'left');
    const first = await (await call('/api/vote', { body: firstBody })).json();
    assert.equal(first.left, 1); assert.equal(first.right, 0); assert.equal(first.selected, 'left');
    assert.equal((await call('/vote', { body: firstBody })).status, 403);
    const duplicate = await (await call('/vote', { body: ballot(id, 'right') })).json();
    assert.equal(duplicate.left, 1); assert.equal(duplicate.right, 0); assert.equal(duplicate.selected, 'left');
    const other = crypto.randomUUID();
    const concurrent = await Promise.all(Array.from({ length: 12 }, () => call('/vote', { voter: other, body: ballot(other, 'right') })));
    assert.ok(concurrent.every(response => response.status === 200));
    assert.deepEqual(db.prepare('SELECT total FROM totals ORDER BY choice').all().map(row => row.total), [1, 1]);
    assert.deepEqual(await (await call('/selection')).json(), { selected: 'left' });
    // Same-origin browser GETs omit Origin; they must still restore the existing vote.
    assert.deepEqual(await (await call('/api/selection', { source: null })).json(), { selected: 'left' });
    assert.equal((await call('/vote', { source: null, body: ballot(id, 'left') })).status, 403);
    assert.equal((await call('/missing')).status, 404);
    assert.equal((await call('/results', { method: 'POST', body: '{}' })).status, 405);
  } finally { globalThis.fetch = originalFetch; db.close(); }
});
