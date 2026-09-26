import { test } from 'node:test';
import assert from 'node:assert/strict';

const base = process.env.TEST_API || 'http://localhost:8787';
const origin = 'https://kurosawageeker.github.io';
const voter = crypto.randomUUID();
async function call(path, { id = voter, method = 'GET', body, source = origin } = {}) {
  return fetch(`${base}${path}`, { method, headers: { Origin: source, 'X-Voter-ID': id, 'Content-Type': 'application/json' }, body });
}

test('CORS, validation, atomic counts, duplicate and concurrent votes', async () => {
  const before = await (await call('/results')).json();
  const preflight = await call('/vote', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  assert.equal((await call('/vote', { method: 'POST', source: 'https://example.com', body: '{"choice":"left"}' })).status, 403);
  assert.equal((await call('/vote', { method: 'POST', body: '{"choice":"invalid"}' })).status, 400);
  assert.equal((await call('/vote', { method: 'POST', body: 'null' })).status, 400);
  assert.equal((await call('/vote', { method: 'POST', body: '{' })).status, 400);
  assert.equal((await call('/vote', { method: 'POST', body: 'x'.repeat(129) })).status, 413);
  assert.equal((await call('/vote', { method: 'POST', id: 'bad-id', body: '{"choice":"left"}' })).status, 400);
  const first = await (await call('/vote', { method: 'POST', body: '{"choice":"left"}' })).json();
  assert.equal(first.left, before.left + 1);
  assert.equal(first.right, before.right);
  assert.equal(first.selected, 'left');
  const duplicate = await (await call('/vote', { method: 'POST', body: '{"choice":"right"}' })).json();
  assert.deepEqual(duplicate, first);
  const other = crypto.randomUUID();
  const concurrent = await Promise.all(Array.from({ length: 12 }, () => call('/vote', { id: other, method: 'POST', body: '{"choice":"right"}' })));
  assert.ok(concurrent.every(response => response.status === 200));
  const final = await (await call('/results')).json();
  assert.equal(final.left, before.left + 1);
  assert.equal(final.right, before.right + 1);
  assert.equal(final.selected, 'left');
  assert.equal((await call('/missing')).status, 404);
  assert.equal((await call('/results', { method: 'POST', body: '{}' })).status, 405);
});
