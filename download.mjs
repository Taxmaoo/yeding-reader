/**
 * 番茄小说下载（前端部分）：
 * 服务端 /api/fanqie/* 负责搜索、目录和正文解密，这里负责交互、进度与入库。
 *
 * 两种模式共用一套抓取流程：
 *   1) 新书下载：把整本（或前 N 章）拼成 TXT 交给 app.mjs 入库；
 *   2) 继续下载 / 更新：读回书架里这本书已有的章节清单，只补「没下过的章」和「上次失败的章」，
 *      追加到原文末尾、就地替换失败段落，避免整本重下。
 */
const COOKIE_KEY = 'yeding-fanqie-cookie-v1';
const PROXY_KEY = 'yeding-fanqie-proxy-v1';
const PACE_KEY = 'yeding-fanqie-pace-v1';
const BATCH = 6;
const MAX_CHAPTERS = 6000;
const PAGE_OVERHEAD = 1700;
const MISSING_NOTE = '（本章未能获取：可能需要会员或已被平台锁定。）';
const PACE = {
  fast: { delay: 380, cooldownEvery: 0, cooldown: 0 },
  normal: { delay: 1200, cooldownEvery: 150, cooldown: 3000 },
  safe: { delay: 2600, cooldownEvery: 60, cooldown: 6000 },
};
const HEADING = /^(?:第\s*[零〇○一二三四五六七八九十百千万亿两壹贰叁肆伍陆柒捌玖拾\d０-９]+\s*[章回节卷部篇集]|序章|序言|楔子|引子|前言|后记|尾声|终章|番外(?:篇)?|chapter\s+\d+\b)/i;
const BOILERPLATE = /^(版权(信息|声明)?页?|目录|免责声明|作者的话|关于本书)$/;

let hooks = {
  upsertBook: null, readText: null, findBookByRemote: null, openBook: null, toast: null,
  readDownloadRows: null, saveDownloadRows: null, clearDownloadRows: null,
};
let busy = false;
let activeRunCancel = null;
let currentTaskId = null;
let notifyTasks = () => {};

// ---------- 下载任务队列（本地持久化） ----------
const TASKS_KEY = 'yeding-dl-tasks-v1';
const TASK_KEEP = 20;

function loadTasks() {
  try {
    const raw = localStorage.getItem(TASKS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveTasks(list) {
  try {
    localStorage.setItem(TASKS_KEY, JSON.stringify(list.slice(0, TASK_KEEP)));
  } catch {}
  notifyTasks();
}

function updateTask(id, patch) {
  const list = loadTasks();
  const task = list.find(item => item.id === id);
  if (!task) return null;
  Object.assign(task, patch, { updatedAt: Date.now() });
  saveTasks(list);
  return task;
}

function removeTask(id) {
  saveTasks(loadTasks().filter(item => item.id !== id));
  hooks.clearDownloadRows?.(id).catch(() => {});
}

/** 同一本书只保留一个任务，避免队列里堆一地重复项。 */
function createTask({ remoteId, title, mode, pace, replace = false, limit = 0 }) {
  const running = loadTasks().find(item => item.remoteId === remoteId
    && ['queued', 'running', 'pausing'].includes(item.status));
  if (running) return running;
  const prior = loadTasks();
  const list = prior.filter(item => item.remoteId !== remoteId);
  for (const item of prior) {
    if (item.remoteId === remoteId && item.replace) hooks.clearDownloadRows?.(item.id).catch(() => {});
  }
  const task = {
    id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    remoteId,
    title: title || `书籍 ${remoteId}`,
    mode, // fresh | update | replace
    pace: pace || 'normal',
    replace: Boolean(replace),
    limit: Number(limit) || 0,
    status: 'queued',
    done: 0,
    total: 0,
    added: 0,
    message: '等待开始',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  list.unshift(task);
  saveTasks(list);
  return task;
}

// 页面一刷新，之前标记为「下载中」的任务其实已经不在跑了，统一归位成「已暂停」
function normalizeTasksOnLoad() {
  const list = loadTasks();
  let changed = false;
  for (const task of list) {
    if (task.status === 'running' || task.status === 'pausing' || task.status === 'queued') {
      task.status = 'paused';
      task.message = '页面已关闭，已暂停（点继续接着下）';
      changed = true;
    }
  }
  if (changed) saveTasks(list);
}
normalizeTasksOnLoad();

function pendingCount() {
  return loadTasks().filter(task => taskGroup(task) !== 'completed').length;
}

const $ = id => document.getElementById(id);

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, action, className) {
  const node = element('button', text, className);
  node.type = 'button';
  node.onclick = action;
  return node;
}

let panelRevision = 0;
let downloadOpener;

function openPanel(title, ...content) {
  const page = $('downloadPage');
  if (page.hidden) {
    downloadOpener = document.activeElement;
    page.hidden = false;
    hooks.onShow?.();
  }
  taskList = null;
  const heading = element('h1', title, 'download-heading');
  heading.tabIndex = -1;
  $('downloadContent').replaceChildren(heading, ...content.filter(Boolean));
  $('downloadExploreTab').setAttribute('aria-pressed', 'true');
  $('downloadTasksTab').setAttribute('aria-pressed', 'false');
  window.scrollTo(0, 0);
  heading.focus({ preventScroll: true });
  return ++panelRevision;
}

function closeDownload() {
  const page = $('downloadPage');
  if (page.hidden) return;
  panelRevision++;
  taskList = null;
  page.hidden = true;
  $('downloadContent').replaceChildren();
  hooks.onClose?.();
  const opener = downloadOpener && $('library').contains(downloadOpener) ? downloadOpener : $('downloadBtn');
  opener?.focus({ preventScroll: true });
}

function readSetting(key, fallback = '') {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function writeSetting(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {}
}

function apiBase() {
  const base = readSetting(PROXY_KEY).trim().replace(/\/+$/, '');
  return base ? `${base}/api/fanqie` : './api/fanqie';
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const cookie = readSetting(COOKIE_KEY).trim();
  if (cookie) headers['X-Fanqie-Cookie'] = cookie;
  if (options.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${apiBase()}/${path}`, { ...options, headers });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('下载服务暂不可用，请稍后重试或检查下载设置。');
  }
  if (!res.ok || !data?.ok) throw new Error(data?.error || '番茄接口返回异常');
  return data;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function statusLine(text, tone = '') {
  return element('p', text, `dl-status${tone ? ` ${tone}` : ''}`);
}

function actionRow(...buttons) {
  const row = element('div', null, 'dl-actions');
  row.append(...buttons);
  return row;
}

function paceSelectElement() {
  const select = element('select', null, 'dl-pace');
  select.setAttribute('aria-label', '抓取节奏');
  for (const [key, label] of [['normal', '标准（推荐）'], ['safe', '稳妥（更慢，整本更稳）'], ['fast', '极速（最快，容易被拒）']]) {
    const option = element('option', label);
    option.value = key;
    select.append(option);
  }
  select.value = readSetting(PACE_KEY, 'normal');
  return select;
}

// ---------- 面板：搜索 ----------
const STATUS_TEXT = {
  queued: '等待中', running: '下载中', pausing: '正在处理', paused: '已暂停', stopped: '已停止', done: '已完成', error: '失败',
};
const TASK_FILTERS = [['all', '全部'], ['active', '进行中'], ['attention', '待处理'], ['completed', '已完成']];
const search = { input: '', items: null, error: '', pending: false, request: 0 };
let taskList;
let taskFilter = 'all';

function taskGroup(task) {
  if (task.status === 'queued' || task.status === 'running' || task.status === 'pausing') return 'active';
  if (task.status === 'done' && !task.missing) return 'completed';
  return 'attention';
}

function taskRow(task) {
  const row = element('article', null, 'dl-task');
  row.dataset.taskId = task.id;
  const head = element('div', null, 'dl-task-head');
  const title = element('strong', null, 'dl-task-title');
  const badge = element('span', null, 'dl-task-badge');
  head.append(title, badge);
  const bar = element('div', null, 'dl-bar');
  const fill = element('span');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', '下载进度');
  bar.append(fill);
  const meta = element('span', null, 'dl-task-meta');
  const message = element('p', null, 'dl-task-msg');
  const actions = element('div', null, 'dl-task-actions');
  row.append(head, bar, meta, message, actions);

  let actionState;
  const update = next => {
    const group = taskGroup(next);
    const pct = next.total ? Math.max(0, Math.min(100, Math.round((next.done || 0) * 100 / next.total))) : 0;
    row.dataset.group = group;
    title.textContent = next.title;
    badge.textContent = next.status === 'done' && next.missing ? '待补齐' : STATUS_TEXT[next.status] || next.status;
    bar.hidden = !next.total;
    fill.style.width = `${pct}%`;
    bar.setAttribute('aria-valuenow', String(pct));
    meta.textContent = next.total ? `${next.done || 0} / ${next.total} 章 · ${pct}%` : '';
    meta.hidden = !next.total;
    message.textContent = next.message || '';
    message.hidden = !next.message;

    const nextActionState = `${next.status}:${next.missing || 0}`;
    if (actionState === nextActionState) return;
    actionState = nextActionState;
    const controls = [];
    if (next.status === 'running' || next.status === 'queued') {
      controls.push(button('暂停', () => pauseTask(next.id), 'secondary'), button('停止', () => stopTask(next.id), 'dl-quiet'));
    } else if (next.status === 'done' && next.missing) {
      controls.push(button(`补齐 ${next.missing} 章`, () => resumeTask(next.id), 'primary'));
    } else if (group === 'attention') {
      controls.push(button(next.status === 'error' ? '重试' : '继续下载', () => resumeTask(next.id), 'primary'));
    } else if (group === 'completed' && hooks.findBookByRemote?.(next.remoteId)) {
      controls.push(button('开始阅读', () => {
        const book = hooks.findBookByRemote(next.remoteId);
        if (!book) return;
        closeDownload();
        hooks.openBook?.(book);
      }, 'secondary'));
    }
    if (group !== 'active') {
      const remove = button('移除任务', () => removeTask(next.id), 'dl-quiet');
      remove.setAttribute('aria-label', `移除《${next.title}》的下载任务`);
      controls.push(remove);
    }
    actions.replaceChildren(...controls);
    actions.hidden = controls.length === 0;
  };
  update(task);
  return { row, update };
}

function openTasksPanel() {
  const filters = element('div', null, 'dl-task-filters');
  filters.setAttribute('aria-label', '筛选下载任务');
  const box = element('div', null, 'dl-tasks');
  const rows = new Map();
  const empty = element('div', null, 'dl-empty');
  const emptyText = element('p');
  empty.append(emptyText, button('去找小说', () => openHome(), 'secondary'));
  const render = () => {
    const tasks = loadTasks();
    const selected = tasks.filter(task => taskFilter === 'all' || taskGroup(task) === taskFilter);
    const nodes = selected.map(task => {
      if (!rows.has(task.id)) rows.set(task.id, taskRow(task));
      else rows.get(task.id).update(task);
      return rows.get(task.id).row;
    });
    if (!nodes.length) {
      emptyText.textContent = tasks.length ? '这个分类暂无任务。' : '还没有下载任务。';
      nodes.push(empty);
    }
    if (nodes.length !== box.children.length || nodes.some((node, index) => node !== box.children[index])) {
      box.replaceChildren(...nodes);
    }
  };
  for (const [key, label] of TASK_FILTERS) {
    const filter = button(label, () => {
      taskFilter = key;
      for (const child of filters.children) child.setAttribute('aria-pressed', String(child === filter));
      render();
    });
    filter.setAttribute('aria-pressed', String(taskFilter === key));
    filters.append(filter);
  }
  openPanel('下载任务', filters, box);
  $('downloadExploreTab').setAttribute('aria-pressed', 'false');
  $('downloadTasksTab').setAttribute('aria-pressed', 'true');
  taskList = { box, render };
  render();
}

function bookSummary(title, meta, abstract, headingTag = 'h2') {
  const summary = element('div', null, 'dl-book-summary');
  const cover = element('div', Array.from(title)[0] || '书', 'dl-book-cover');
  cover.setAttribute('aria-hidden', 'true');
  const info = element('div', null, 'dl-book-info');
  info.append(element(headingTag, title, 'dl-book-title'));
  if (meta) info.append(element('p', meta, 'dl-book-meta'));
  if (abstract) info.append(element('p', abstract, 'dl-book-abstract'));
  summary.append(cover, info);
  return summary;
}

function renderSearchResults(box) {
  if (search.pending) return box.replaceChildren(statusLine('正在搜索…'));
  if (search.error) return box.replaceChildren(statusLine(search.error, 'is-warn'));
  if (!search.items) return box.replaceChildren();
  if (!search.items.length) return box.replaceChildren(statusLine('没有找到小说。换个关键词，或直接输入书籍链接。'));
  const rows = search.items.map(item => {
    const row = element('article', null, 'dl-book');
    const title = item.title || `书籍 ${item.id}`;
    const meta = [item.author, item.category, item.chapters && `${item.chapters} 章`, item.status].filter(Boolean).join(' · ');
    const pick = button('看目录', () => openBookPanel(item.id, item), 'dl-book-pick');
    pick.setAttribute('aria-label', `查看《${title}》的目录`);
    row.append(bookSummary(title, meta, item.abstract, 'h3'), pick);
    return row;
  });
  box.replaceChildren(element('h2', `搜索结果（${rows.length}）`, 'dl-results-title'), ...rows);
}

function openHome() {
  const intro = element('div', null, 'dl-search-card');
  const form = element('form', null, 'dl-search-form');
  form.setAttribute('role', 'search');
  const input = element('input', null, 'dl-input');
  input.type = 'search';
  input.placeholder = '书名、作者、番茄链接或书籍 ID';
  input.setAttribute('aria-label', '搜索番茄小说');
  input.value = search.input;
  const submit = element('button', '搜索', 'primary');
  submit.type = 'submit';
  const results = element('div', null, 'dl-results');
  results.setAttribute('aria-live', 'polite');
  input.addEventListener('input', () => { search.input = input.value; });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const query = input.value.trim();
    if (!query) return input.focus();
    const id = (query.match(/(?:page|reader)\/(\d{6,})/) || query.match(/^(\d{6,})$/))?.[1];
    if (id) { await openBookPanel(id); return; }
    const revision = ++search.request;
    search.pending = true;
    search.error = '';
    renderSearchResults(results);
    try {
      const data = await api(`search?q=${encodeURIComponent(query)}&count=12`);
      if (revision === search.request) search.items = Array.isArray(data.items) ? data.items : [];
    } catch (error) {
      if (revision === search.request) search.error = error.message;
    } finally {
      if (revision === search.request) {
        search.pending = false;
        renderSearchResults($('downloadSearchResults') || results);
      }
    }
  });
  results.id = 'downloadSearchResults';
  form.append(input, submit);
  intro.append(element('p', '在番茄找小说，下载后可以离线阅读。'), form);
  renderSearchResults(results);
  openPanel('找小说', intro, results);
}

function openAdvanced() {
  const settings = element('div', null, 'dl-section');
  const cookie = element('textarea', null, 'dl-input dl-textarea');
  cookie.id = 'downloadCookie';
  cookie.value = readSetting(COOKIE_KEY);
  cookie.spellcheck = false;
  const proxy = element('input', null, 'dl-input');
  proxy.id = 'downloadProxy';
  proxy.type = 'url';
  proxy.value = readSetting(PROXY_KEY);
  proxy.placeholder = 'https://你的代理地址';
  const cookieLabel = element('label', '账号 Cookie（可选）', 'dl-label');
  cookieLabel.htmlFor = cookie.id;
  const proxyLabel = element('label', '自建代理地址（可选）', 'dl-label');
  proxyLabel.htmlFor = proxy.id;
  const save = () => {
    if (!proxy.reportValidity()) return;
    writeSetting(COOKIE_KEY, cookie.value.trim());
    writeSetting(PROXY_KEY, proxy.value.trim());
    hooks.toast?.('下载设置已保存');
    openHome();
  };
  settings.append(cookieLabel, element('p', 'Cookie 保存在本机，下载请求会交给当前使用的服务。', 'dl-hint'), cookie, proxyLabel, proxy,
    actionRow(button('保存设置', save, 'primary'), button('取消', () => openHome(), 'secondary')));
  openPanel('下载设置', settings);
}

async function openBookPanel(bookId, seed = null) {
  const requested = openPanel(seed?.title || '书籍详情', statusLine('正在读取目录…'));
  let catalog;
  try {
    const data = await api(`book?id=${encodeURIComponent(bookId)}`);
    catalog = data.book;
  } catch (error) {
    if (requested === panelRevision) openPanel('目录读取失败', statusLine(error.message, 'is-warn'),
      actionRow(button('重试', () => openBookPanel(bookId, seed), 'primary'), button('返回搜索', () => openHome(), 'secondary')));
    return;
  }
  if (requested !== panelRevision) return;
  if (!catalog?.chapters?.length) {
    openPanel('没有找到目录', statusLine('请确认书籍链接，或从搜索结果中选择另一本。'), button('返回搜索', () => openHome(), 'secondary'));
    return;
  }
  const existing = hooks.findBookByRemote?.(bookId) || null;
  if (existing) openResumePanel({ bookId, catalog, existing, seed });
  else openFreshPanel({ bookId, catalog, seed });
}

function enqueueDownload(options) {
  writeSetting(PACE_KEY, options.pace);
  createTask(options);
  taskFilter = 'all';
  openTasksPanel();
  return pumpQueue();
}

function controlRow(label, input) {
  const row = element('label', null, 'dl-row');
  row.append(element('span', label, 'dl-row-label'), input);
  return row;
}

function openFreshPanel({ bookId, catalog, seed }) {
  const cap = Math.min(catalog.chapters.length, MAX_CHAPTERS);
  const title = catalog.title || seed?.title || `书籍 ${bookId}`;
  const meta = [catalog.author || seed?.author, catalog.category, `${catalog.chapters.length} 章`].filter(Boolean).join(' · ');
  const pace = paceSelectElement();
  const limitInput = element('input', null, 'dl-limit');
  Object.assign(limitInput, { type: 'number', min: '1', max: String(cap), step: '1', value: String(cap), inputMode: 'numeric' });
  const limit = () => Math.max(1, Math.min(cap, Math.floor(Number(limitInput.value) || cap)));
  const estimate = element('p', null, 'dl-hint');
  const start = button('', () => enqueueDownload({ remoteId: bookId, title, mode: 'fresh', pace: pace.value, limit: limit() }), 'primary');
  const update = () => {
    const minutes = Math.max(1, Math.round(limit() / BATCH * (PACE[pace.value].delay + PAGE_OVERHEAD) / 60000));
    start.textContent = limit() === catalog.chapters.length ? '下载整本' : `下载前 ${limit()} 章`;
    estimate.textContent = `预计约 ${minutes} 分钟。下载任务可以随时暂停和继续。`;
  };
  limitInput.oninput = update;
  pace.onchange = update;
  update();
  const details = element('div', null, 'dl-detail');
  details.append(bookSummary(title, meta, catalog.abstract || seed?.abstract));
  const options = element('div', null, 'dl-section');
  options.append(controlRow('下载前多少章', limitInput), controlRow('下载节奏', pace), estimate,
    actionRow(start, button('返回搜索', () => openHome(), 'secondary')));
  openPanel('下载到书架', details, options);
}

function countManifestDrift(manifest, chapters) {
  return manifest.filter((entry, index) => entry?.id !== chapters[index]?.id).length;
}

function openResumePanel({ bookId, catalog, existing, seed }) {
  const hasManifest = Array.isArray(existing.dl?.manifest);
  const manifest = hasManifest ? existing.dl.manifest : [];
  const have = new Set(manifest.map(entry => entry.id));
  const newCount = catalog.chapters.filter(chapter => !have.has(chapter.id)).length;
  const failedCount = manifest.filter(entry => entry.ok === false).length;
  const drift = countManifestDrift(manifest, catalog.chapters);
  const title = catalog.title || existing.title || seed?.title || `书籍 ${bookId}`;
  const meta = [catalog.author || existing.author, `目录 ${catalog.chapters.length} 章`].filter(Boolean).join(' · ');
  const pace = paceSelectElement();
  const details = element('div', null, 'dl-detail');
  details.append(bookSummary(title, meta));
  const options = element('div', null, 'dl-section');
  if (hasManifest) {
    const stats = element('dl', null, 'dl-stats');
    const saved = manifest.filter(entry => entry.ok !== false && !entry.skipped).length;
    for (const [label, count] of [['已下载', saved], ['新章节', newCount], ['待补齐', failedCount]]) {
      const stat = element('div');
      stat.append(element('dt', label), element('dd', String(count)));
      stats.append(stat);
    }
    details.append(stats);
  }
  if (!hasManifest || drift) {
    options.append(statusLine(hasManifest ? '目录次序有变，请重新下载整本。' : '这本书的旧版本缺少章节清单，需要重新下载整本。', 'is-warn'));
  }
  const replace = button('重新下载整本', () => {
    openPanel('重新下载整本', statusLine(`《${title}》的新正文下载完整后才会替换原书。`),
      actionRow(button('确认下载', () => enqueueDownload({ remoteId: bookId, title, mode: 'replace', pace: pace.value, replace: true }), 'primary'),
        button('返回', () => openResumePanel({ bookId, catalog, existing, seed }), 'secondary')));
  }, hasManifest && !drift ? 'secondary' : 'primary');
  const controls = [replace];
  if (hasManifest && !drift && (newCount || failedCount)) {
    controls.unshift(button(newCount ? '下载更新' : '补齐缺章', () => enqueueDownload({ remoteId: bookId, title, mode: 'update', pace: pace.value }), 'primary'));
  } else if (hasManifest && !drift) {
    options.append(statusLine('已经是最新。', 'is-ok'));
  }
  controls.push(button('返回搜索', () => openHome(), 'dl-quiet'));
  options.append(controlRow('下载节奏', pace), actionRow(...controls));
  openPanel('继续下载 / 更新', details, options);
}

// ---------- 下载 ----------
function normalizeHeading(index, title) {
  const clean = String(title || '').replace(/\s+/g, ' ').trim();
  if (clean && HEADING.test(clean) && clean.length <= 70) return clean;
  return `第${index + 1}章${clean ? ` ${clean}` : ''}`;
}

function appendEntries(text, items) {
  let out = text;
  const entries = [];
  for (const item of items) {
    // 版权页/目录页这类模板章不写进正文，但仍要记入清单，避免每次更新都重复抓取
    if (BOILERPLATE.test(String(item.title || '').trim())) {
      entries.push({ id: item.id, title: item.title, start: out.length, end: out.length, ok: true, skipped: true });
      continue;
    }
    if (out.length) out += out.endsWith('\n\n') ? '' : (out.endsWith('\n') ? '\n' : '\n\n');
    const start = out.length;
    out += item.block;
    entries.push({ id: item.id, title: item.title, start, end: out.length, ok: item.ok });
  }
  return { text: out, entries };
}

function patchEntry(text, manifest, index, block, ok) {
  const entry = manifest[index];
  const delta = block.length - (entry.end - entry.start);
  const next = text.slice(0, entry.start) + block + text.slice(entry.end);
  entry.end = entry.start + block.length;
  entry.ok = ok;
  for (let i = index + 1; i < manifest.length; i += 1) {
    manifest[i].start += delta;
    manifest[i].end += delta;
  }
  return next;
}

async function runDownload({
  bookId, catalog, existing, textBefore, title, author, chapters, retryFailed, pace, replacement, task, already,
}) {
  if (busy) return;
  busy = true;
  let cancelled = false;
  let status = 'done';
  let stopReason = '';
  const requestStop = reason => {
    cancelled = true;
    if (reason && !stopReason) stopReason = reason;
  };
  const indexOf = new Map(catalog.chapters.map((chapter, index) => [chapter.id, index]));
  activeRunCancel = requestStop;
  currentTaskId = task.id;

  const rows = [];
  let delay = pace.delay;
  const startedAt = Date.now();
  const saveReplacementRows = async page => {
    if (!replacement) return;
    const complete = page.filter(row => row && replacement.ids.has(row.id)
      && ((row.ok && row.text) || BOILERPLATE.test(String(row.title || '').trim())));
    if (!complete.length) return;
    await hooks.saveDownloadRows(task.id, complete);
    for (const row of complete) replacement.rows.set(row.id, row);
  };

  const requestPage = async (slice, fresh) => {
    const data = await api('chapters', {
      method: 'POST',
      body: JSON.stringify({ book: bookId, fresh: fresh ? 1 : 0, items: slice.map(chapter => chapter.id) }),
    });
    return data.chapters;
  };

  const total = chapters.length + retryFailed.length;
  let done = 0;
  const tick = extra => {
    const elapsed = (Date.now() - startedAt) / 1000;
    const eta = done > 0 ? Math.round(elapsed / done * (total - done) / 60) : 0;
    const ready = replacement ? replacement.rows.size : already + rows.filter(row => row.ok || BOILERPLATE.test(row.title || '')).length;
    const message = cancelled ? '正在保存已取章节…' : [extra, eta > 0 ? `预计还需 ${eta} 分钟` : ''].filter(Boolean).join(' · ');
    updateTask(task.id, { done: ready, message });
  };

  try {
    // ① 补上次失败的章（单独取，便于就地替换）
    for (const entry of retryFailed) {
      if (cancelled) break;
      try {
        const [row] = await requestPage([{ id: entry.id, title: entry.title }], false);
        rows.push(row || { id: entry.id, ok: false, reason: 'network', title: entry.title, text: '' });
      } catch {
        rows.push({ id: entry.id, ok: false, reason: 'network', title: entry.title, text: '' });
      }
      done += 1;
      tick('正在补齐缺章');
      await sleep(Math.min(delay, 500));
    }

    // ② 取新增章节：按 id 累积结果，只补失败的，任何一轮都不会覆盖已取到的章
    let pageNo = 0;
    let lastRotatePage = -99;
    for (let i = 0; i < chapters.length; i += BATCH) {
      if (cancelled) break;
      const slice = chapters.slice(i, i + BATCH);
      const got = new Map();
      pageNo += 1;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (cancelled) break;
        const pending = slice.filter(chapter => {
          const row = got.get(chapter.id);
          return !row || !row.ok;
        });
        if (!pending.length) break;

        // 只有连续两轮都拿不全、且距上次换设备足够久，才换身份，避免频繁注册新设备
        const wantFresh = attempt >= 2 && pageNo - lastRotatePage >= 10;
        if (wantFresh) {
          lastRotatePage = pageNo;
        }

        let page = [];
        try {
          page = await requestPage(pending, wantFresh);
        } catch {
          page = [];
        }
        for (const row of page) {
          if (!row) continue;
          const prev = got.get(row.id);
          if (!prev || (!prev.ok && row.ok)) got.set(row.id, row);
        }

        const stillBad = slice.some(chapter => {
          const row = got.get(chapter.id);
          return !row || !row.ok;
        });
        if (!stillBad) break;
        if (attempt === 0) await sleep(900);
        else {
          delay = Math.min(2500, Math.round(delay * 1.6));
          await sleep(Math.max(1500, delay));
        }
      }

      // 兜底：缺的章补占位行，宁可标注「未获取」也不会静默丢章
      const ordered = slice.map(chapter => got.get(chapter.id) || {
        id: chapter.id, title: chapter.title, ok: false, reason: 'network', text: '',
      });
      rows.push(...ordered);
      await saveReplacementRows(ordered);
      done += slice.length;
      tick();
      if (i + BATCH < chapters.length) await sleep(delay);
      if (pace.cooldownEvery && done % pace.cooldownEvery < BATCH) await sleep(pace.cooldown);
    }

    // ②½ 补漏：跑完后对仍失败的章做多轮延时重试，风控窗口通常几秒到几十秒
    if (!cancelled && rows.some(row => !row.ok)) {
      const waits = [2000, 5000, 12000, 25000];
      for (let round = 0; round < waits.length && !cancelled; round += 1) {
        const failed = rows.filter(row => !row.ok);
        if (!failed.length) break;
        updateTask(task.id, { message: `正在重试 ${failed.length} 个缺章，稍候…` });
        await sleep(waits[round]);
        for (let i = 0; i < failed.length; i += BATCH) {
          if (cancelled) break;
          const slice = failed.slice(i, i + BATCH);
          let page = [];
          try {
            // 第 2 轮起换设备身份，绕开单设备的风控窗口
            page = await requestPage(slice.map(row => ({ id: row.id, title: row.title })), round >= 1);
          } catch {
            page = [];
          }
          for (const row of page) {
            if (!row?.ok) continue;
            const index = rows.findIndex(item => item.id === row.id);
            if (index >= 0) rows[index] = row;
          }
          await saveReplacementRows(page);
          await sleep(Math.max(600, Math.round(delay / 2)));
        }
        if (!rows.some(row => !row.ok)) break;
      }
      tick('重试结束');
    }

    if (replacement) {
      const missing = replacement.ids.size - replacement.rows.size;
      if (cancelled || missing) {
        updateTask(task.id, { missing, message: '已保存重下进度，原正文保留。' });
        return;
      }
      rows.splice(0, rows.length, ...replacement.chapters.map(chapter => replacement.rows.get(chapter.id)));
    } else if (total === 0) {
      updateTask(task.id, { missing: 0, message: '这本书已经是最新。' });
      return;
    }
    if (!rows.length) {
      updateTask(task.id, { message: cancelled ? '已保留现有下载进度。' : '没有取到任何章节，请稍后重试。' });
      return;
    }

    // ③ 组装：替换模式重排全书，否则在原文后面追加 + 就地补旧章
    updateTask(task.id, { message: '正在保存到书架…' });
    const byId = new Map(rows.map(row => [row.id, row]));
    const manifest = replacement ? [] : (existing?.dl?.manifest || []).map(entry => ({ ...entry }));
    let text = textBefore;

    let patched = 0;
    for (let i = 0; i < manifest.length; i += 1) {
      const entry = manifest[i];
      if (entry.ok !== false) continue;
      const row = byId.get(entry.id);
      if (!row?.ok || !row.text) continue;
      const index = indexOf.get(entry.id) ?? 0;
      text = patchEntry(text, manifest, i, `${normalizeHeading(index, row.title || entry.title)}\n\n${row.text}`, true);
      patched += 1;
      byId.delete(entry.id);
    }

    const freshRows = rows.filter(row => byId.has(row.id) && row.id !== undefined && !manifest.some(entry => entry.id === row.id));
    const items = freshRows.map(row => {
      const index = indexOf.get(row.id) ?? 0;
      const heading = normalizeHeading(index, row.title);
      const ok = Boolean(row.ok && row.text);
      return { id: row.id, title: row.title || heading, block: `${heading}\n\n${ok ? row.text : MISSING_NOTE}`, ok };
    }).filter(item => item.block);
    const appended = appendEntries(text, items);
    text = appended.text;
    manifest.push(...appended.entries);
    if (!text.trim()) throw new Error('没有取到可保存的正文');

    const okCount = appended.entries.filter(entry => entry.ok && !entry.skipped).length;
    const skippedCount = appended.entries.filter(entry => entry.skipped).length;
    const stillMissing = manifest.filter(entry => entry.ok === false).length;
    // 自检：写入条目数应当等于「本轮真正取到的章数」（模板章也算一条），暂停/停止时不报警
    const expected = rows.length - patched;
    const overflow = Math.max(0, expected - appended.entries.length);
    await hooks.upsertBook({
      title,
      author: author || catalog.author,
      remoteId: bookId,
      text,
      dl: {
        remoteId: bookId,
        manifest,
        total: catalog.chapters.length,
        updatedAt: Date.now(),
      },
    });
    if (replacement) await hooks.clearDownloadRows(task.id).catch(() => {});
    const message = [
      replacement
        ? '已用最新内容替换全书'
        : (okCount || patched ? '已保存到书架' : '没有新增正文'),
      task.mode === 'update' && okCount ? `新增 ${okCount} 章` : '',
      patched ? `补回旧章 ${patched} 章` : '',
      skippedCount ? `跳过模板章 ${skippedCount} 个` : '',
      stillMissing ? `${stillMissing} 章仍失败（可再次继续下载）` : '',
      overflow > 0 ? `⚠ ${overflow} 章未能写入（请再点一次继续下载）` : '',
      cancelled ? (stopReason === 'pause' ? '（已暂停，进度已保存）' : '（已按停止保存）') : '',
    ].filter(Boolean).join('，') + '。';
    updateTask(task.id, { added: okCount, missing: stillMissing, message });
  } catch (err) {
    status = 'error';
    updateTask(task.id, { message: err.message || '下载中断' });
  } finally {
    busy = false;
    activeRunCancel = null;
    currentTaskId = null;
    if (status !== 'error' && cancelled) status = stopReason === 'pause' ? 'paused' : 'stopped';
    updateTask(task.id, { status });
  }
}

// ---------- 任务执行 ----------
async function startTask(task) {
  updateTask(task.id, { status: 'running', message: '正在读取目录…' });
  try {
    const { book: catalog } = await api(`book?id=${encodeURIComponent(task.remoteId)}`);
    if (!catalog?.chapters?.length) throw new Error('目录为空，请稍后重试');
    const existing = hooks.findBookByRemote?.(task.remoteId) || null;
    const manifest = existing?.dl?.manifest || [];
    const limit = task.replace || task.mode === 'update' ? MAX_CHAPTERS : (task.limit || MAX_CHAPTERS);
    const target = catalog.chapters.slice(0, limit);
    let replacement = null;
    let textBefore = '';
    let have;
    let retryFailed = [];
    if (task.replace) {
      const ids = new Set(target.map(chapter => chapter.id));
      const rows = new Map((await hooks.readDownloadRows(task.id)).filter(row => ids.has(row.id)).map(row => [row.id, row]));
      replacement = { chapters: target, ids, rows };
      have = rows;
    } else {
      if (existing) {
        if (!Array.isArray(existing.dl?.manifest) || countManifestDrift(manifest, catalog.chapters)) {
          throw new Error('章节清单与当前目录不一致，请从书架重新下载整本。');
        }
        textBefore = await hooks.readText(existing.id);
        if (typeof textBefore !== 'string' || !textBefore.trim() || manifest.some(entry => entry.end > textBefore.length)) {
          throw new Error('本机正文缺失或不完整。请先从云备份恢复，或重新下载整本。');
        }
      }
      have = new Set(manifest.map(entry => entry.id));
      retryFailed = manifest.filter(entry => entry.ok === false);
    }
    if (loadTasks().find(item => item.id === task.id)?.status !== 'running') return;
    const chapters = target.filter(chapter => !have.has(chapter.id));
    const retryIds = new Set(retryFailed.map(entry => entry.id));
    const already = target.filter(chapter => have.has(chapter.id) && !retryIds.has(chapter.id)).length;
    updateTask(task.id, { total: already + chapters.length + retryFailed.length, done: already, message: '' });
    await runDownload({
      bookId: task.remoteId,
      catalog,
      existing,
      textBefore,
      title: catalog.title || task.title,
      author: catalog.author,
      chapters,
      retryFailed,
      pace: PACE[task.pace] || PACE.normal,
      replacement,
      task,
      already,
    });
  } catch (err) {
    const message = err.message || '下载准备失败';
    if (loadTasks().find(item => item.id === task.id)?.status === 'running') updateTask(task.id, { status: 'error', message });
  }
}

let pumping = false;
async function pumpQueue() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const next = loadTasks().find(task => task.status === 'queued');
      if (!next) break;
      await startTask(next);
    }
  } finally {
    pumping = false;
  }
}

export function pauseTask(id) {
  interruptTask(id, 'pause');
}

function stopTask(id) {
  interruptTask(id, 'stop');
}

function interruptTask(id, reason) {
  const task = loadTasks().find(item => item.id === id);
  if (!task) return;
  const isPause = reason === 'pause';
  if (task.status === 'running' && currentTaskId === id) {
    activeRunCancel?.(reason);
    updateTask(id, { status: 'pausing', message: isPause ? '正在暂停…' : '正在停止…' });
  } else {
    updateTask(id, { status: isPause ? 'paused' : 'stopped', message: isPause ? '已暂停' : '已停止' });
  }
}

export async function resumeTask(id) {
  const task = loadTasks().find(item => item.id === id);
  if (!task) return;
  updateTask(id, { status: 'queued', message: '等待继续' });
  if (busy) {
    hooks.toast?.('已加入队列，等当前任务结束后自动开始');
    return;
  }
  await pumpQueue();
}

// ---------- 对外入口 ----------
export function setupDownload(options = {}) {
  hooks = { ...hooks, ...options };
  for (const [id, handler] of Object.entries({
    downloadBtn: openHome, downloadExploreTab: openHome, downloadTasksBtn: openTasksPanel, downloadTasksTab: openTasksPanel,
    downloadBack: closeDownload, downloadSettingsBtn: openAdvanced,
  })) {
    const control = $(id);
    if (control) control.onclick = handler;
  }
  $('downloadPage')?.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented) closeDownload();
  });
  notifyTasks = () => {
    const count = pendingCount();
    for (const id of ['shelfTaskCount', 'downloadTaskCount']) {
      const badge = $(id);
      if (!badge) continue;
      badge.textContent = String(count);
      badge.setAttribute('aria-label', `${count} 项未完成`);
      badge.hidden = count === 0;
    }
    if (taskList?.box.isConnected) taskList.render();
  };
  notifyTasks();
  return openHome;
}

/** 供书架「⋯ → 继续下载 / 更新」调用：按书籍 ID 直接走更新流程。 */
export async function openUpdateForBook(remoteId, fallbackTitle = '') {
  if (!remoteId) return hooks.toast?.('这本书没有番茄来源，无法更新');
  await openBookPanel(remoteId, { title: fallbackTitle });
}

export { openHome };
