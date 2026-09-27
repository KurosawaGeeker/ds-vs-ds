import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../api/worker.js';

const id = crypto.randomUUID();
const allow = { async limit() { return { success: true }; } };
const deny = { async limit() { return { success: false }; } };
const request = (body, path = '/api/vote') => new Request(`https://ds-vs-ds.win${path}`, {
  method: path.endsWith('vote') ? 'POST' : 'GET',
  headers: { Origin: 'https://ds-vs-ds.win', 'X-Voter-ID': id, 'CF-Connecting-IP': '192.0.2.1', 'Content-Type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
function environment(overrides = {}) {
  return { ALLOWED_ORIGINS: ['https://ds-vs-ds.win'], VOTE_LIMIT: allow, VOTE_GLOBAL_LIMIT: allow, RESULTS_REFRESH: allow, SELECTION_LIMIT: allow, DB_READ_LIMIT: allow, TURNSTILE_SECRET_KEY: 'test-only', DB: { prepare() { throw new Error('Database must not be reached'); } }, ...overrides };
}

test('missing verification and rate-limited requests never reach D1', async () => {
  assert.equal((await worker.fetch(request({ choice: 'left' }), environment())).status, 403);
  const blocked = await worker.fetch(request({ choice: 'left', token: 'test' }), environment({ VOTE_LIMIT: deny }));
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('Retry-After'), '60');
});

test('failed, wrong-host, wrong-action and wrong-voter tokens fail closed', async () => {
  const original = globalThis.fetch;
  try {
    for (const override of [{ success: false }, { hostname: 'other.example' }, { action: 'other' }, { cdata: crypto.randomUUID() }]) {
      globalThis.fetch = async () => Response.json({ success: true, hostname: 'ds-vs-ds.win', action: 'vote', cdata: id, ...override });
      assert.equal((await worker.fetch(request({ choice: 'left', token: 'test' }), environment())).status, 403);
    }
  } finally { globalThis.fetch = original; }
});

test('cached counts are public, and stale counts survive D1 failure or refresh throttling', async () => {
  const original = globalThis.caches;
  const totals = { left: 10, right: 20, updatedAt: Date.now() - 30000 };
  globalThis.caches = { default: { async match() { return Response.json(totals); } } };
  try {
    for (const limiter of [allow, deny]) {
      const response = await worker.fetch(request(null, '/api/results?bypass=1'), environment({ RESULTS_REFRESH: limiter }));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ...totals, stale: true });
    }
  } finally { globalThis.caches = original; }
});
