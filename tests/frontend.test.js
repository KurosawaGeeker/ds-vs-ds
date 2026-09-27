import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
function page({ failStorage = false } = {}) {
  const elements = new Map();
  function element(key) {
    if (!elements.has(key)) elements.set(key, { textContent: '', disabled: true, hidden: false, style: {}, dataset: { choice: key }, classList: { toggle() {} }, setAttribute() {}, addEventListener(name, handler) { this[name] = handler; } });
    return elements.get(key);
  }
  const counts = { left: 0, right: 0, selected: null, updatedAt: 100000 };
  const calls = [];
  let failNetwork = false;
  let voteStatus = 200;
  let clock = 100000;
  let timer;
  let challenge;
  let script;
  let resets = 0;
  const context = {
    document: { hidden: false, querySelector: key => key === '#turnstile-script' ? script || null : element(key), querySelectorAll: () => [element('left'), element('right')], addEventListener() {}, createElement() { return {}; }, head: { append(value) { script = value; context.window.onTurnstileReady(); } } },
    window: { addEventListener() {}, turnstile: { render(_, options) { challenge = options; return 0; }, reset() { resets++; } } },
    localStorage: { getItem: () => null, setItem() { if (failStorage) throw new Error('blocked'); } },
    crypto, Intl, AbortSignal, Date: { now: () => clock },
    setTimeout(callback, delay) { timer = { callback, delay }; return 1; }, clearTimeout() {},
    async fetch(url, options) {
      calls.push({ url, options });
      if (failNetwork) throw new Error('offline');
      const code = url.endsWith('/vote') ? voteStatus : 200;
      if (url.endsWith('/vote') && code === 200 && !counts.selected) { counts.selected = JSON.parse(options.body).choice; counts[counts.selected]++; }
      const data = url.endsWith('/selection') ? { selected: counts.selected } : url.endsWith('/results') ? { left: counts.left, right: counts.right, updatedAt: clock } : { ...counts };
      return { ok: code === 200, status: code, headers: { get: () => code === 429 ? '60' : null }, async json() { return data; } };
    },
  };
  vm.runInNewContext(source, context);
  return { element, counts, calls, verify: () => challenge.callback('valid-token'), expire: () => challenge['expired-callback'](), get resets() { return resets; }, tick: () => { clock += timer.delay; timer.callback(); }, get delay() { return timer.delay; }, disconnect: () => { failNetwork = true; }, rejectVote(code) { voteStatus = code; } };
}

test('public counts, verification gate, vote once, and offline backoff preserving counts', async () => {
  const app = page(); await settle();
  assert.equal(app.element('#left-count').textContent, '0');
  assert.equal(app.element('left').disabled, true);
  assert.equal(app.calls[0].options.headers['X-Voter-ID'], undefined);
  app.verify(); assert.equal(app.element('left').disabled, false);
  app.element('left').click(); await settle();
  assert.equal(app.element('#left-count').textContent, '1');
  assert.equal(app.element('left').textContent, '已投票');
  assert.equal(app.element('right').disabled, true);
  assert.equal(app.element('#verification').hidden, true);
  app.element('right').click(); await settle(); assert.equal(app.counts.right, 0);
  app.counts.right = 1; app.tick(); await settle();
  assert.equal(app.element('#left-bar').style.width, '50%');
  assert.equal(app.calls.filter(call => call.url.endsWith('/selection')).length, 1);
  app.disconnect(); app.tick(); await settle();
  assert.equal(app.element('#right-count').textContent, '1');
  assert.match(app.element('#status').textContent, /显示上次票数/);
  assert.equal(app.delay, 10000);
  app.tick(); await settle(); assert.equal(app.delay, 20000);
});

test('expired verification disables voting and a rejected token requires a new challenge', async () => {
  const app = page(); await settle(); app.verify(); app.expire();
  assert.equal(app.element('left').disabled, true);
  app.verify(); app.rejectVote(403); app.element('left').click(); await settle();
  assert.equal(app.counts.left, 0);
  assert.equal(app.element('left').disabled, true);
  assert.match(app.element('#status').textContent, /重新完成安全验证/);
  assert.equal(app.resets, 2);
});

test('429 prevents immediate resubmission even with a fresh token', async () => {
  const app = page(); await settle(); app.verify(); app.rejectVote(429);
  app.element('left').click(); await settle(); app.verify();
  app.element('left').click(); await settle();
  assert.equal(app.calls.filter(call => call.url.endsWith('/vote')).length, 1);
  assert.equal(app.element('left').disabled, true);
});

test('storage failure gives actionable feedback and keeps voting disabled', () => {
  const app = page({ failStorage: true });
  assert.match(app.element('#status').textContent, /本地存储/);
  assert.equal(app.element('left').disabled, true);
});
