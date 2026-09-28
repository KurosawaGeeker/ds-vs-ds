const API = 'https://ds-vs-ds.win/api';
const SITEKEY = '0x4AAAAAAFE1X5V6Kk9jBT2l';
const buttons = [...document.querySelectorAll('[data-choice]')];
const status = document.querySelector('#status');
const verificationStatus = document.querySelector('#verification-status');
const numberFormat = new Intl.NumberFormat('zh-CN');
let voterId;
let selected = null;
let selectionChecked = false;
let submitting = false;
let refreshing = false;
let ready = false;
let revision = -1;
let token = '';
let widget;
let timer;
let failures = 0;
let nextRefreshAt = 0;
let voteRetryAt = 0;
let powDifficulty = 0;

// Client side of the vote proof of work: find a decimal nonce such that
// SHA-256(`${voterId}:${choice}:${token}:${nonce}`) has at least
// `powDifficulty` leading zero bits. Mirrors api/pow.js; tests cross-check
// both implementations against the platform WebCrypto digest.
const POW_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function powRotr(x, n) {
  return (x >>> n) | (x << (32 - n));
}

// Hot-path scratch state shared across hashes; the returned digest is valid
// until the next call and every caller consumes it immediately.
const powEncoder = new TextEncoder();
let powPaddedScratch = null;
const powDigestScratch = new Uint8Array(32);
const powDigestView = new DataView(powDigestScratch.buffer);

function powSha256(text) {
  const data = powEncoder.encode(text);
  const paddedLength = ((data.length + 8) >> 6 << 6) + 64;
  if (!powPaddedScratch || powPaddedScratch.length < paddedLength) powPaddedScratch = new Uint8Array(paddedLength);
  const padded = powPaddedScratch.subarray(0, paddedLength);
  padded.fill(0);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer, padded.byteOffset, paddedLength);
  view.setUint32(paddedLength - 8, Math.floor(data.length * 8 / 0x100000000));
  view.setUint32(paddedLength - 4, data.length * 8 >>> 0);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = powRotr(x, 7) ^ powRotr(x, 18) ^ (x >>> 3);
      const s1 = powRotr(y, 17) ^ powRotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = powRotr(e, 6) ^ powRotr(e, 11) ^ powRotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + POW_K[i] + w[i]) | 0;
      const S0 = powRotr(a, 2) ^ powRotr(a, 13) ^ powRotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((word, i) => powDigestView.setUint32(i * 4, word >>> 0));
  return powDigestScratch;
}

function powLeadingZeroBits(digest) {
  let bits = 0;
  for (let i = 0; i < digest.length; i++) {
    const byte = digest[i];
    if (byte === 0) { bits += 8; continue; }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

async function mineNonce(base, difficulty) {
  if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 64) throw new Error('Invalid difficulty');
  const prefix = `${base}:`;
  let lastYield = Date.now();
  for (let nonce = 0; ; nonce++) {
    if (powLeadingZeroBits(powSha256(prefix + nonce)) >= difficulty) return String(nonce);
    if ((nonce & 0xffff) === 0xffff && Date.now() - lastYield > 32) {
      lastYield = Date.now();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
}

function updateButtons() {
  for (const button of buttons) {
    const chosen = selected === button.dataset.choice;
    button.disabled = !ready || !selectionChecked || !token || submitting || selected !== null || Date.now() < voteRetryAt;
    button.classList.toggle('selected', chosen);
    button.textContent = chosen ? '已投票' : submitting ? '提交中…' : '喜欢';
  }
}

function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Counts remain readable when storage is full. */ }
}

function setSelection(choice) {
  if (choice !== 'left' && choice !== 'right') return;
  selected = choice;
  save(`ds-vs-ds-selection-${voterId}`, choice);
  document.querySelector('#verification').hidden = true;
  updateButtons();
}

function render(data) {
  if (!Number.isSafeInteger(data.left) || !Number.isSafeInteger(data.right) || data.left < 0 || data.right < 0) throw new Error('Invalid result');
  if (data.selected) setSelection(data.selected);
  const total = data.left + data.right;
  // A cached public count must not undo the more recent result of a successful vote.
  if (total < revision) return;
  revision = total;
  for (const side of ['left', 'right']) {
    document.querySelector(`#${side}-count`).textContent = numberFormat.format(data[side]);
    document.querySelector(`#${side}-bar`).style.width = `${total ? data[side] / total * 100 : 50}%`;
  }
  document.querySelector('.bar').setAttribute('aria-label', `左边 ${data.left} 票，右边 ${data.right} 票`);
  ready = true;
  save('ds-vs-ds-counts', { left: data.left, right: data.right, updatedAt: data.updatedAt });
  status.textContent = data.stale ? '显示上次票数，正在更新…' : selected ? '已收到你的一票，谢谢参与。' : total ? '选一个你喜欢的形象。' : '还没有人投票，来投第一票吧。';
  updateButtons();
}

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    // Public counts are shared; only personal operations send an identity.
    headers: { ...(path === '/results' ? {} : { 'X-Voter-ID': voterId }), ...options.headers },
    signal: AbortSignal.timeout(12000),
    cache: 'no-store',
  });
  if (!response.ok) {
    const error = new Error('Request failed');
    error.status = response.status;
    error.retryAfter = Number(response.headers.get('Retry-After')) || 0;
    error.body = await response.json().catch(() => null);
    throw error;
  }
  return response.json();
}

function schedule(delay) {
  clearTimeout(timer);
  timer = setTimeout(() => { void refresh(); }, delay);
}

async function checkSelection() {
  if (selectionChecked) return;
  try {
    const data = await request('/selection');
    if (data.pow && Number.isFinite(data.pow.difficulty)) powDifficulty = data.pow.difficulty;
    setSelection(data.selected);
    selectionChecked = true;
    if (selected) status.textContent = '已收到你的一票，谢谢参与。';
    else loadVerification();
    updateButtons();
  } catch (error) {
    verificationStatus.textContent = '暂时无法确认投票状态，正在重试…';
    nextRefreshAt = Math.max(nextRefreshAt, Date.now() + Math.max(10, error.retryAfter || 0) * 1000);
  }
}

async function refresh() {
  if (refreshing || submitting) return;
  if (document.hidden) { schedule(5000); return; }
  if (Date.now() < nextRefreshAt) { schedule(nextRefreshAt - Date.now()); return; }
  refreshing = true;
  let delay = 5000;
  try {
    render(await request('/results'));
    failures = 0;
    await checkSelection();
  } catch (error) {
    failures++;
    delay = Math.max(Math.min(60000, 5000 * 2 ** Math.min(failures, 4)), (error.retryAfter || 0) * 1000);
    nextRefreshAt = Date.now() + delay;
    status.textContent = ready ? '连接暂时中断，显示上次票数，正在重试…' : '暂时无法获取票数，正在重试…';
  } finally {
    refreshing = false;
    updateButtons();
    schedule(Math.max(delay, nextRefreshAt - Date.now()));
  }
}

function resetVerification() {
  token = '';
  if (widget !== undefined && window.turnstile) window.turnstile.reset(widget);
  updateButtons();
}

function loadVerification() {
  if (selected || document.querySelector('#turnstile-script')) return;
  verificationStatus.textContent = '正在进行安全验证…';
  window.onTurnstileReady = () => {
    widget = window.turnstile.render('#turnstile', {
      sitekey: SITEKEY, action: 'vote', cData: voterId, theme: 'light', size: 'flexible',
      callback(value) { token = value; verificationStatus.textContent = ''; updateButtons(); },
      'expired-callback'() { resetVerification(); },
      'error-callback'() { token = ''; verificationStatus.textContent = '安全验证未完成，请稍候或刷新页面重试。'; updateButtons(); },
      'timeout-callback'() { token = ''; verificationStatus.textContent = '请完成安全验证后投票。'; updateButtons(); },
    });
  };
  const script = document.createElement('script');
  script.id = 'turnstile-script';
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileReady&render=explicit';
  script.async = true;
  script.onerror = () => { verificationStatus.textContent = '安全验证加载失败，请刷新页面重试。'; };
  document.head.append(script);
}

async function vote(choice) {
  if (submitting || selected || !ready || !selectionChecked || !token || Date.now() < voteRetryAt) return;
  submitting = true;
  updateButtons();
  status.textContent = '正在提交你的一票…';
  try {
    let nonce;
    if (powDifficulty > 0) nonce = await mineNonce(`${voterId}:${choice}:${token}`, powDifficulty);
    render(await request('/vote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choice, token, ...(nonce ? { nonce } : {}) }) }));
  } catch (error) {
    if (error.status === 429) {
      voteRetryAt = Date.now() + Math.max(60, error.retryAfter || 0) * 1000;
      status.textContent = '提交太频繁，请一分钟后再试。';
      setTimeout(updateButtons, voteRetryAt - Date.now());
    } else if (error.status === 403 && error.body?.error === 'pow_failed') {
      // The token is still valid; adopt the server's difficulty and let the vote be retried.
      if (Number.isFinite(error.body.difficulty) && error.body.difficulty > 0) powDifficulty = error.body.difficulty;
      status.textContent = '安全验证未通过，请重新提交。';
    } else if (error.status === 403) {
      status.textContent = '请重新完成安全验证后再投票。';
    } else {
      status.textContent = '暂未确认投票结果，请重试；重复提交不会重复计票。';
      selectionChecked = false;
    }
    // A failed work check keeps the still-valid token; everything else re-challenges.
    if (!(error.status === 403 && error.body?.error === 'pow_failed')) resetVerification();
  } finally {
    submitting = false;
    updateButtons();
    schedule(5000);
  }
}

try {
  voterId = localStorage.getItem('ds-vs-ds-voter');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(voterId || '')) {
    voterId = crypto.randomUUID();
    localStorage.setItem('ds-vs-ds-voter', voterId);
  }
  try {
    setSelection(JSON.parse(localStorage.getItem(`ds-vs-ds-selection-${voterId}`)));
    selectionChecked = selected !== null;
    const cached = JSON.parse(localStorage.getItem('ds-vs-ds-counts'));
    if (cached && Number.isFinite(cached.updatedAt) && Date.now() - cached.updatedAt < 86400000) render({ ...cached, stale: true });
  } catch { /* Ignore an invalid local cache. */ }
  for (const button of buttons) button.addEventListener('click', () => { void vote(button.dataset.choice); });
  void refresh();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  window.addEventListener('online', () => { void refresh(); });
} catch {
  status.textContent = '请允许此网站使用本地存储，再刷新页面参与投票。';
}
