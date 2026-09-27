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
    render(await request('/vote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choice, token }) }));
  } catch (error) {
    if (error.status === 429) {
      voteRetryAt = Date.now() + Math.max(60, error.retryAfter || 0) * 1000;
      status.textContent = '提交太频繁，请一分钟后再试。';
      setTimeout(updateButtons, voteRetryAt - Date.now());
    } else if (error.status === 403) {
      status.textContent = '请重新完成安全验证后再投票。';
    } else {
      status.textContent = '暂未确认投票结果，请重试；重复提交不会重复计票。';
      selectionChecked = false;
    }
    resetVerification();
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
