import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function page({ failStorage = false } = {}) {
  const elements = new Map();
  function element(key) {
    if (!elements.has(key)) elements.set(key, { textContent: '', disabled: true, style: {}, dataset: { choice: key }, classList: { toggle() {} }, setAttribute() {}, addEventListener(name, handler) { this[name] = handler; } });
    return elements.get(key);
  }
  const counts = { left: 0, right: 0, selected: null };
  let failNetwork = false;
  let interval;
  const context = {
    document: { hidden: false, querySelector: element, querySelectorAll: () => [element('left'), element('right')], addEventListener() {} },
    window: { addEventListener() {} },
    localStorage: { getItem: () => null, setItem() { if (failStorage) throw new Error('blocked'); } },
    crypto, Intl, AbortSignal, setInterval(callback) { interval = callback; },
    async fetch(url, options) {
      if (failNetwork) throw new Error('offline');
      if (url.endsWith('/vote') && !counts.selected) { counts.selected = JSON.parse(options.body).choice; counts[counts.selected]++; }
      return { ok: true, async json() { return { ...counts }; } };
    },
  };
  vm.runInNewContext(source, context);
  return { element, counts, tick: () => interval(), disconnect: () => { failNetwork = true; } };
}

test('load results, vote, lock buttons and keep last counts on connection loss', async () => {
  const app = page();
  await settle();
  assert.equal(app.element('#left-count').textContent, '0');
  assert.equal(app.element('left').disabled, false);
  app.element('left').click();
  await settle();
  assert.equal(app.element('#left-count').textContent, '1');
  assert.equal(app.element('#left-bar').style.width, '100%');
  assert.equal(app.element('left').textContent, '已投给这个');
  assert.equal(app.element('left').disabled, true);
  assert.equal(app.element('right').disabled, true);
  app.element('right').click();
  await settle();
  assert.equal(app.counts.right, 0);
  app.counts.right = 1;
  app.tick();
  await settle();
  assert.equal(app.element('#right-count').textContent, '1');
  assert.equal(app.element('#left-bar').style.width, '50%');
  app.disconnect();
  app.tick();
  await settle();
  assert.equal(app.element('#right-count').textContent, '1');
  assert.match(app.element('#status').textContent, /显示上次票数/);
});

test('storage failure gives an actionable message and keeps voting disabled', () => {
  const app = page({ failStorage: true });
  assert.match(app.element('#status').textContent, /本地存储/);
  assert.equal(app.element('left').disabled, true);
});
