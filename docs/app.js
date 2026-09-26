const API = 'https://ds-vs-ds-api.crazycthun.workers.dev';
const buttons = [...document.querySelectorAll('[data-choice]')];
const status = document.querySelector('#status');
const numberFormat = new Intl.NumberFormat('zh-CN');
let voterId;
let selected = null;
let submitting = false;
let refreshing = false;
let ready = false;
let revision = -1;

function updateButtons() {
  for (const button of buttons) {
    const chosen = selected === button.dataset.choice;
    button.disabled = !ready || submitting || selected !== null;
    button.classList.toggle('selected', chosen);
    button.textContent = chosen ? '已投票' : submitting ? '提交中…' : '喜欢';
  }
}

function render(data) {
  if (!Number.isSafeInteger(data.left) || !Number.isSafeInteger(data.right) || data.left < 0 || data.right < 0) throw new Error('Invalid result');
  const total = data.left + data.right;
  // An older in-flight refresh must not undo the result of a successful vote.
  if (total < revision) return;
  revision = total;
  for (const side of ['left', 'right']) {
    document.querySelector(`#${side}-count`).textContent = numberFormat.format(data[side]);
    document.querySelector(`#${side}-bar`).style.width = `${total ? data[side] / total * 100 : 50}%`;
  }
  document.querySelector('.bar').setAttribute('aria-label', `左边 ${data.left} 票，右边 ${data.right} 票`);
  if (data.selected === 'left' || data.selected === 'right') selected = data.selected;
  ready = true;
  status.textContent = selected ? '已收到你的一票，谢谢参与。' : total ? '选一个你喜欢的形象。' : '还没有人投票，来投第一票吧。';
  updateButtons();
}

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'X-Voter-ID': voterId, ...options.headers },
    signal: AbortSignal.timeout(10000),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('Request failed');
  return response.json();
}

async function refresh() {
  if (refreshing || submitting || document.hidden) return;
  refreshing = true;
  try { render(await request('/results')); }
  catch {
    status.textContent = ready ? '连接暂时中断，显示上次票数，正在重试…' : '暂时无法获取票数，正在重试…';
  } finally { refreshing = false; }
}

async function vote(choice) {
  if (submitting || selected || !ready) return;
  submitting = true;
  updateButtons();
  status.textContent = '正在提交你的一票…';
  try {
    render(await request('/vote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choice }) }));
  } catch {
    status.textContent = '暂未确认投票结果，请重试；重复提交不会重复计票。';
  } finally {
    submitting = false;
    updateButtons();
  }
}

try {
  voterId = localStorage.getItem('ds-vs-ds-voter');
  if (!/^[0-9a-f-]{36}$/i.test(voterId || '')) {
    voterId = crypto.randomUUID();
    localStorage.setItem('ds-vs-ds-voter', voterId);
  }
  for (const button of buttons) button.addEventListener('click', () => { void vote(button.dataset.choice); });
  void refresh();
  setInterval(() => { void refresh(); }, 3000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  window.addEventListener('online', () => { void refresh(); });
} catch {
  status.textContent = '请允许此网站使用本地存储，再刷新页面参与投票。';
}
