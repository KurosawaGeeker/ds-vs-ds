import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../api/worker.js';
import { sha256Bytes, leadingZeroBits, mine, powDifficulty } from '../api/pow.js';

const id = crypto.randomUUID();
const allow = { async limit() { return { success: true }; } };
const hex = bytes => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

function environment(overrides = {}) {
  return { ALLOWED_ORIGINS: ['https://ds-vs-ds.win'], VOTE_LIMIT: allow, VOTE_GLOBAL_LIMIT: allow, RESULTS_REFRESH: allow, SELECTION_LIMIT: allow, DB_READ_LIMIT: allow, TURNSTILE_SECRET_KEY: 'test-only', POW_DIFFICULTY: '8', DB: { prepare() { throw new Error('Database must not be reached'); } }, ...overrides };
}

function makeRequest(body) {
  return new Request('https://ds-vs-ds.win/api/vote', {
    method: 'POST',
    headers: { Origin: 'https://ds-vs-ds.win', 'X-Voter-ID': id, 'CF-Connecting-IP': '192.0.2.1', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

// D1 stub: the vote insert is recorded, totals and personal state are canned.
function makeDb() {
  const state = { inserted: null };
  function prepare(sql) {
    let bound = [];
    const statement = {
      bind(...values) { bound = values; return statement; },
      async run() {
        if (sql.startsWith('INSERT')) { state.inserted = bound; return { results: [] }; }
        return statement.all();
      },
      async all() {
        return /FROM totals/.test(sql)
          ? { results: [{ choice: 'left', total: 1 }, { choice: 'right', total: 0 }] }
          : { results: [{ choice: 'left' }] };
      },
      async first() { return null; },
    };
    return statement;
  }
  return { state, async batch(statements) { const results = []; for (const statement of statements) results.push(await statement.run()); return results; }, prepare };
}

// Any token verifies as this voter, mirroring a solved Turnstile challenge.
async function withTurnstileStub(run) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ success: true, hostname: 'ds-vs-ds.win', action: 'vote', cdata: id });
  try { return await run(); } finally { globalThis.fetch = original; }
}

test('difficulty parsing: unset defaults to 18, only explicit zero disables, junk falls back', () => {
  assert.equal(powDifficulty({}), 18);
  assert.equal(powDifficulty({ POW_DIFFICULTY: '20' }), 20);
  assert.equal(powDifficulty({ POW_DIFFICULTY: '0' }), 0);
  assert.equal(powDifficulty({ POW_DIFFICULTY: 0 }), 0);
  assert.equal(powDifficulty({ POW_DIFFICULTY: '' }), 18);
  assert.equal(powDifficulty({ POW_DIFFICULTY: '-3' }), 18);
  assert.equal(powDifficulty({ POW_DIFFICULTY: 'abc' }), 18);
  assert.equal(powDifficulty({ POW_DIFFICULTY: '18bits' }), 18);
  assert.equal(powDifficulty({ POW_DIFFICULTY: '0.5' }), 18);
  assert.equal(powDifficulty({ POW_DIFFICULTY: '99' }), 32);
  assert.equal(powDifficulty({ POW_DIFFICULTY: '2.7' }), 2);
});

test('leading zero bits and sha256 match the platform WebCrypto implementation', async () => {
  assert.equal(leadingZeroBits(new Uint8Array([0x00, 0x00, 0xff])), 16);
  assert.equal(leadingZeroBits(new Uint8Array([0xff])), 0);
  assert.equal(leadingZeroBits(new Uint8Array([0x40])), 1);
  assert.equal(leadingZeroBits(new Uint8Array([0x00, 0x40])), 9);
  assert.equal(leadingZeroBits(new Uint8Array([0x00, 0x00])), 16);
  const texts = ['', 'abc', '投票验证', 'x'.repeat(200), 'a'.repeat(55), 'b'.repeat(56), 'c'.repeat(63), 'd'.repeat(64)];
  for (let i = 0; i < 40; i++) texts.push(String(Math.random()) + crypto.randomUUID());
  for (const text of texts) {
    const expected = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
    assert.equal(hex(sha256Bytes(text)), expected, `sha256 mismatch for ${text.length}-char input`);
  }
});

test('mine returns nonces whose WebCrypto digest meets the difficulty', async () => {
  for (const base of [`${id}:left:token-a`, `${crypto.randomUUID()}:right:token-b`]) {
    const nonce = await mine(base, 12);
    assert.match(nonce, /^\d+$/);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${base}:${nonce}`)));
    assert.ok(leadingZeroBits(digest) >= 12);
  }
});

// A nonce that provably fails difficulty 8: constant guesses like '0' could
// theoretically satisfy it, so pick the first candidate with measured work
// below the difficulty and assert the precondition.
function weakNonce(base) {
  const nonce = [0, 1, 2, 3, 4].find(n => leadingZeroBits(sha256Bytes(`${base}:${n}`)) < 8);
  assert.ok(nonce !== undefined, 'no weak nonce found in the first five candidates');
  return String(nonce);
}

test('ballots without a nonce, with worthless work, or malformed nonces fail closed before D1', async () => {
  await withTurnstileStub(async () => {
    const weak = weakNonce(`${id}:left:solved`);
    for (const nonce of [undefined, '', weak, weak.padStart(3, '0'), '-1', '12a', '1'.repeat(49), 12, null]) {
      const body = { choice: 'left', token: 'solved' };
      if (nonce !== undefined) body.nonce = nonce;
      const response = await worker.fetch(makeRequest(body), environment());
      assert.equal(response.status, 403, `nonce ${JSON.stringify(nonce)} must be rejected`);
      const payload = await response.json();
      assert.deepEqual(payload, { error: 'pow_failed', difficulty: 8 });
    }
  });
});

test('a failed proof of work does not consume the one-use Turnstile token', async () => {
  const original = globalThis.fetch;
  let siteverifyCalls = 0;
  globalThis.fetch = async () => {
    siteverifyCalls++;
    return Response.json({ success: true, hostname: 'ds-vs-ds.win', action: 'vote', cdata: id });
  };
  try {
    const db = makeDb();
    // Worthless work is rejected locally; the token must remain usable.
    const bad = await worker.fetch(makeRequest({ choice: 'left', token: 'solved', nonce: weakNonce(`${id}:left:solved`) }), environment({ DB: db }));
    assert.equal(bad.status, 403);
    const payload = await bad.json();
    assert.deepEqual(payload, { error: 'pow_failed', difficulty: 8 });
    assert.equal(siteverifyCalls, 0);
    const good = await worker.fetch(makeRequest({ choice: 'left', token: 'solved', nonce: await mine(`${id}:left:solved`, 8) }), environment({ DB: db }));
    assert.equal(good.status, 200);
    assert.equal(siteverifyCalls, 1);
  } finally { globalThis.fetch = original; }
});

test('a ballot with sufficient work is accepted and recorded, and difficulty 0 skips the check', async () => {
  await withTurnstileStub(async () => {
    const db = makeDb();
    const nonce = await mine(`${id}:left:solved`, 8);
    const response = await worker.fetch(makeRequest({ choice: 'left', token: 'solved', nonce }), environment({ DB: db }));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.left, 1); assert.equal(payload.right, 0); assert.equal(payload.selected, 'left');
    assert.deepEqual(db.state.inserted, [id, 'left']);
    // The same work must not satisfy a higher difficulty.
    const low = await mine(`${id}:right:solved`, 8);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${id}:right:solved:${low}`)));
    assert.ok(leadingZeroBits(digest) < 24, 'precondition: the low-work nonce must not reach difficulty 24');
    const harder = await worker.fetch(makeRequest({ choice: 'right', token: 'solved', nonce: low }), environment({ DB: db, POW_DIFFICULTY: '24' }));
    assert.equal(harder.status, 403);
    // Disabled PoW accepts ballots without a nonce.
    const open = await worker.fetch(makeRequest({ choice: 'right', token: 'solved' }), environment({ DB: db, POW_DIFFICULTY: '0' }));
    assert.equal(open.status, 200);
  });
});
