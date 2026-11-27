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
};
let busy = false;
let activeRunCancel = null;
let currentTaskId = null;

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
}

/** 同一本书只保留一个任务，避免队列里堆一地重复项。 */
function createTask({ remoteId, title, mode, pace, replace = false, limit = 0 }) {
  const running = loadTasks().find(item => item.remoteId === remoteId
    && ['queued', 'running', 'pausing'].includes(item.status));
  if (running) return running;
  const list = loadTasks().filter(item => item.remoteId !== remoteId);
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
    if (task.status === 'running' || task.status === 'pausing') {
      task.status = 'paused';
      task.message = '页面已关闭，已暂停（点继续接着下）';
      changed = true;
    }
  }
  if (changed) saveTasks(list);
}
normalizeTasksOnLoad();

function pendingCount() {
  return loadTasks().filter(task => task.status === 'queued' || task.status === 'running' || task.status === 'pausing').length;
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

function openPanel(title, ...content) {
  const dialog = $('dialog');
  dialog.classList.remove('toc-sheet');
  $('dialogTitle').textContent = title;
  $('dialogBody').replaceChildren(...content.filter(Boolean));
  $('dialogBody').scrollTop = 0;
  if (!dialog.open) dialog.showModal();
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
    throw new Error('下载服务不可用：需要部署 Cloudflare Pages Functions 或填写自建代理地址。');
  }
  if (!data.ok) throw new Error(data.error || '番茄接口返回异常');
  return data;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function statusLine(text, tone = '') {
  return element('p', text, `dl-status${tone ? ` ${tone}` : ''}`);
}

function actionRow(...buttons) {
  const row = element('div', null, 'dialog-actions');
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
  queued: '等待中', running: '下载中', pausing: '暂停中', paused: '已暂停',
  stopped: '已停止', done: '已完成', error: '失败',
};
let taskTimer = null;

function renderTaskList(box) {
  const tasks = loadTasks();
  if (!tasks.length) {
    box.replaceChildren(element('p', '还没有下载任务。下过的书会出现在这里，可暂停 / 继续。', 'dl-hint'));
    return;
  }
  box.replaceChildren(...tasks.map(task => {
    const pct = task.total ? Math.round(task.done * 100 / task.total) : 0;
    const status = STATUS_TEXT[task.status] || task.status;
    const row = element('div', null, 'dl-task');
    const info = element('div', null, 'dl-task-info');
    info.append(...[
      element('strong', task.title, 'dl-task-title'),
      element('span', `${status} · 已取 ${task.done}/${task.total || '?'} 章${task.total ? ` · ${pct}%` : ''}`,
        `dl-task-meta${task.status === 'done' ? ' is-ok' : task.status === 'error' ? ' is-warn' : ''}`),
      task.message && task.status !== 'running' ? element('span', task.message, 'dl-task-msg') : null,
    ].filter(Boolean));
    const bar = element('div', null, 'dl-bar');
    const fill = element('span');
    fill.style.width = `${pct}%`;
    bar.append(fill);

    const actions = element('div', null, 'dl-task-actions');
    if (task.status === 'running') {
      actions.append(button('暂停', () => { pauseTask(task.id); renderTaskList(box); }, 'secondary'));
    } else if (task.status === 'done' && task.missing > 0) {
      actions.append(button(`补漏（${task.missing} 章）`, async () => {
        await resumeTask(task.id, null);
        renderTaskList(box);
      }, 'secondary'));
    } else if (task.status === 'queued' || task.status === 'paused' || task.status === 'stopped' || task.status === 'error') {
      actions.append(button('继续', async () => {
        await resumeTask(task.id, null);
        renderTaskList(box);
      }, 'secondary'));
    } else if (task.status === 'pausing') {
      actions.append(button('暂停中…', () => {}, 'secondary'));
    }
    actions.append(button('移除', () => { removeTask(task.id); renderTaskList(box); }, 'secondary'));
    row.append(info, bar, actions);
    return row;
  }));
}

function mountTaskList(box) {
  renderTaskList(box);
  if (taskTimer) clearInterval(taskTimer);
  taskTimer = setInterval(() => {
    if (!$('dialog').open || !document.body.contains(box)) {
      clearInterval(taskTimer);
      taskTimer = null;
      return;
    }
    renderTaskList(box);
  }, 1500);
}

/** 打开一个带进度容器的面板再启动任务：避免进度写进已被替换掉的旧容器。 */
function startTaskPanel(title, taskLabel) {
  const box = element('div', null, 'dl-download');
  openPanel(taskLabel || '下载中', element('strong', title, 'dl-title'), box, actionRow(
    button('下载任务', () => openTasksPanel(), 'secondary'),
    button('关闭', () => { const d = $('dialog'); if (d.open) d.close(); }, 'secondary'),
  ));
  return box;
}

function openTasksPanel() {
  const box = element('div', null, 'dl-tasks');
  renderTaskList(box);
  mountTaskList(box);
  openPanel('下载任务', box, actionRow(
    button('去下载', () => openHome(), 'primary'),
    button('关闭', () => { const d = $('dialog'); if (d.open) d.close(); }, 'secondary'),
  ));
}

function openHome(message = '') {
  const input = element('input', null, 'dl-input');
  input.type = 'search';
  input.placeholder = '书名、作者，或 fanqienovel.com/page/ 链接';
  input.setAttribute('aria-label', '搜索番茄小说');

  const warn = statusLine(message, message ? 'is-warn' : '');
  const resultBox = element('div', null, 'dl-results');
  const actions = element('div', null, 'dialog-actions');

  const doSearch = async () => {
    const q = input.value.trim();
    if (!q) return input.focus();
    resultBox.replaceChildren(statusLine('正在搜索…'));
    actions.querySelectorAll('button').forEach(b => { b.disabled = true; });
    try {
      const idMatch = q.match(/(?:page|reader)\/(\d{6,})/) || q.match(/^(\d{6,})$/);
      if (idMatch) {
        await openBookPanel(idMatch[1]);
        return;
      }
      const data = await api(`search?q=${encodeURIComponent(q)}&count=12`);
      if (!data.items.length) {
        resultBox.replaceChildren(statusLine('没有搜到这本书，换关键词或直接粘贴书籍链接试试。', 'is-warn'));
      } else {
        resultBox.replaceChildren(...data.items.map(item => bookRow(item)));
      }
    } catch (err) {
      resultBox.replaceChildren(statusLine(err.message, 'is-warn'));
    } finally {
      actions.querySelectorAll('button').forEach(b => { b.disabled = false; });
    }
  };

  function bookRow(item) {
    const row = element('div', null, 'dl-book');
    const info = element('div', null, 'dl-book-info');
    const meta = [item.author && `作者 ${item.author}`, item.category, item.chapters && `${item.chapters} 章`, item.status]
      .filter(Boolean).join(' · ');
    info.append(
      element('strong', item.title, 'dl-book-title'),
      element('span', meta, 'dl-book-meta'),
      item.abstract ? element('span', item.abstract, 'dl-book-abstract') : element('span', '', 'dl-book-abstract'),
    );
    const pick = button('查看 →', () => openBookPanel(item.id, item), 'dl-book-pick');
    row.append(info, pick);
    return row;
  }

  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      doSearch();
    }
  });

  actions.append(
    button('搜索', doSearch, 'primary'),
    button('打开链接', () => {
      const q = input.value.trim();
      const idMatch = q.match(/(?:page|reader)\/(\d{6,})/) || q.match(/^(\d{6,})$/);
      if (!idMatch) {
        input.focus();
        warn.textContent = '先粘贴 fanqienovel.com/page/ 开头的书籍链接。';
        warn.className = 'dl-status is-warn';
        return;
      }
      openBookPanel(idMatch[1]);
    }),
    button('账号 Cookie / 代理', openAdvanced, 'secondary'),
  );

  openPanel('下载番茄小说', warn, input, actions, resultBox,
    element('p', '把番茄上的小说抓到本机书架。已在书架里的书再次打开会走「继续下载 / 更新」，只补新章和上次失败的章。', 'dl-hint'),
    actionRow(button(`下载任务（${pendingCount()}）`, () => openTasksPanel(), 'secondary')));
  input.focus({ preventScroll: true });
}

function openAdvanced() {
  const cookie = element('textarea', null, 'dl-input dl-textarea');
  cookie.value = readSetting(COOKIE_KEY);
  cookie.placeholder = '可选：从 fanqienovel.com 登录后复制整段 Cookie，含 sessionid / s_v_web_id';
  cookie.setAttribute('aria-label', '番茄账号 Cookie');

  const proxy = element('input', null, 'dl-input');
  proxy.type = 'url';
  proxy.value = readSetting(PROXY_KEY);
  proxy.placeholder = '可选：自建代理根地址，例如 https://fanqie.example.workers.dev';
  proxy.setAttribute('aria-label', '自建代理地址');

  const save = () => {
    writeSetting(COOKIE_KEY, cookie.value.trim());
    writeSetting(PROXY_KEY, proxy.value.trim());
    hooks.toast?.('下载设置已保存在本机');
    openHome();
  };

  openPanel('下载设置',
    element('label', '账号 Cookie（可选）', 'dl-label'),
    cookie,
    element('label', '自建代理地址（可选）', 'dl-label'),
    proxy,
    element('p', 'Cookie 只保存在这台设备的浏览器里，请求时以 X-Fanqie-Cookie 头转发给服务端，不写入仓库。', 'dl-hint'),
    actionRow(button('保存', save, 'primary'), button('返回', () => openHome(), 'secondary')));
}

// ---------- 面板：书籍 ----------
async function openBookPanel(bookId, seed = null) {
  openPanel('读取目录…', statusLine('正在拉取书籍信息与章节列表…'));
  let book;
  try {
    const data = await api(`book?id=${encodeURIComponent(bookId)}`);
    book = data.book;
  } catch (err) {
    openPanel('读取失败', statusLine(err.message, 'is-warn'), statusLine('确认书籍链接有效，或稍后重试。'));
    return;
  }
  if (!book.chapters.length) {
    openPanel('这本书没有目录', statusLine('番茄接口没有返回章节，可能链接指向的不是书籍页。', 'is-warn'));
    return;
  }

  const existing = hooks.findBookByRemote?.(bookId) || null;
  if (existing) {
    openResumePanel({ bookId, catalog: book, existing, seed });
    return;
  }
  openFreshPanel({ bookId, catalog: book, seed });
}

function openFreshPanel({ bookId, catalog, seed }) {
  const all = catalog.chapters;
  const cap = Math.min(all.length, MAX_CHAPTERS);
  const title = catalog.title || seed?.title || `书籍 ${bookId}`;
  const meta = [catalog.author && `作者 ${catalog.author}`, catalog.category, `${all.length} 章`].filter(Boolean).join(' · ');
  const pace = paceSelectElement();

  const limitInput = element('input', null, 'dl-limit');
  limitInput.type = 'number';
  limitInput.min = '1';
  limitInput.max = String(Math.max(1, cap));
  limitInput.value = String(cap);
  limitInput.setAttribute('aria-label', '下载章节数量');

  const minutes = Math.max(1, Math.round(cap / BATCH * (PACE[pace.value].delay + PAGE_OVERHEAD) / 1000 / 60));
  const body = element('div', null, 'dl-download');
  const start = button(`下载 ${cap} 章`, async () => {
    const limit = Math.max(1, Math.min(cap, Number(limitInput.value) || cap));
    writeSetting(PACE_KEY, pace.value);
    const task = createTask({ remoteId: bookId, title, mode: 'fresh', pace: pace.value, limit });
    await pumpQueue(body, task.id);
  }, 'primary');

  const limitRow = element('div', null, 'dl-row');
  limitRow.append(element('span', '只下载前', 'dl-row-label'), limitInput, element('span', '章（填全部章数即整本）', 'dl-row-label'));
  const paceRow = element('div', null, 'dl-row');
  paceRow.append(element('span', '节奏', 'dl-row-label'), pace);

  openPanel('下载到书架',
    element('strong', title, 'dl-title'),
    element('span', meta, 'dl-meta'),
    catalog.abstract ? element('p', catalog.abstract, 'dl-abstract') : null,
    statusLine(`共 ${all.length} 章，默认整本下载（约 ${minutes} 分钟）。被限流时会自动放慢并更换设备身份续抓；取不到的章节会在正文里标注，事后可「继续下载」补回。`),
    limitRow, paceRow, actionRow(start, button('下载任务', () => openTasksPanel(), 'secondary')), body);
}

function openResumePanel({ bookId, catalog, existing, seed }) {
  const dl = existing.dl || null;
  const manifest = dl?.manifest || [];
  const have = new Set(manifest.map(entry => entry.id));
  const missing = catalog.chapters.filter(chapter => !have.has(chapter.id));
  const failed = manifest.filter(entry => entry.ok === false);
  const title = catalog.title || existing.title || seed?.title || `书籍 ${bookId}`;
  const meta = [catalog.author && `作者 ${catalog.author}`, `${catalog.chapters.length} 章`].filter(Boolean).join(' · ');
  const pace = paceSelectElement();
  const body = element('div', null, 'dl-download');

  if (!dl) {
    // 旧版本下载的书没有章节清单，只能整本重下（覆盖正文，保留阅读进度与书签）
    openPanel('这本书是旧版下载的',
      statusLine('《' + title + '》没有章节清单，无法只补新章。可以让它重新拉取整本并替换正文（阅读进度、书签保留）。', 'is-warn'),
      actionRow(button('重新下载整本', async () => {
        writeSetting(PACE_KEY, pace.value);
        const box = startTaskPanel(title, '重新下载整本');
        const task = createTask({ remoteId: bookId, title, mode: 'replace', pace: pace.value, replace: true });
        await pumpQueue(box, task.id);
      }, 'primary'), button('取消', () => openHome(), 'secondary')));
    return;
  }

  // 章序自检：正文里第 i 条应当正好是目录第 i+1 章。
  // 只要出现「位置漂移」或「跳章」，说明这本书的正文是旧版本按错误偏移拼出来的，增量补只会越补越乱。
  const posById = new Map(catalog.chapters.map((chapter, index) => [chapter.id, index + 1]));
  let drift = 0;
  let jumps = 0;
  let unknown = 0;
  let prevPos = 0;
  manifest.forEach((entry, index) => {
    const pos = posById.get(entry.id) || 0;
    if (!pos) { unknown += 1; return; }
    if (pos !== index + 1) drift += 1;
    if (prevPos && pos !== prevPos + 1) jumps += 1;
    prevPos = pos;
  });
  const allUnknown = manifest.length > 0 && unknown === manifest.length;
  const broken = drift > 0 || jumps > 0 || allUnknown;

  const uptoDate = missing.length === 0 && failed.length === 0 && !broken;
  const start = button(
    broken
      ? '章序异常，先重新下载整本'
      : (uptoDate ? '已是最新（重新核对）' : `继续下载（${missing.length} 新章${failed.length ? ` + 补 ${failed.length} 章` : ''}）`),
    async () => {
      if (broken) {
        openPanel('先修复这本书',
          statusLine(`检测到 ${drift || jumps} 处章序异常：正文里的第 N 条不是目录第 N 章。继续增量补章会把它拼得更乱。`, 'is-warn'),
          statusLine('建议点「重新下载整本」：会按目录顺序重抓正文，阅读进度和书签保留。'),
          actionRow(button('重新下载整本', async () => {
            writeSetting(PACE_KEY, pace.value);
            const box = startTaskPanel(title, '重新下载整本');
            const fixTask = createTask({ remoteId: bookId, title, mode: 'replace', pace: pace.value, replace: true });
            await pumpQueue(box, fixTask.id);
          }, 'primary'), button('返回', () => openResumePanel({ bookId, catalog, existing: { ...existing }, seed }), 'secondary')));
        return;
      }
      writeSetting(PACE_KEY, pace.value);
      const task = createTask({ remoteId: bookId, title, mode: 'update', pace: pace.value });
      await pumpQueue(body, task.id);
    },
    broken ? 'secondary' : 'primary',
  );

  const paceRow = element('div', null, 'dl-row');
  paceRow.append(element('span', '节奏', 'dl-row-label'), pace);

  openPanel('继续下载 / 更新',
    element('strong', title, 'dl-title'),
    element('span', meta, 'dl-meta'),
    statusLine(`已存 ${manifest.length} 章 · 目录共 ${catalog.chapters.length} 章 · 新增 ${missing.length} 章`
      + (failed.length ? ` · 上次失败 ${failed.length} 章` : '')
      + (uptoDate ? ' · 已经是最新' : ''),
    uptoDate ? 'is-ok' : ''),
    broken
      ? statusLine(allUnknown
        ? `⚠ 这本书的章节清单与当前目录完全对不上（${unknown} 章全部失效），大概率是旧版本留下的残档。请点「重新下载整本」按目录顺序重抓。`
        : `⚠ 检测到章序异常 ${drift || jumps} 处${unknown ? `（另有 ${unknown} 章已不在目录里）` : ''}：正文第 N 条不是目录第 N 章，继续增量补只会更乱，请先「重新下载整本」。`, 'is-warn')
      : null,
    paceRow,
    actionRow(start, button('下载任务', () => openTasksPanel(), 'secondary'), button('重新下载整本', () => {
      openPanel('重新下载整本？',
        statusLine('会用番茄上的最新内容替换这本书的正文，阅读进度和书签保留。', 'is-warn'),
        actionRow(button('确认替换', async () => {
          writeSetting(PACE_KEY, pace.value);
          const box = startTaskPanel(title, '重新下载整本');
          const task = createTask({ remoteId: bookId, title, mode: 'replace', pace: pace.value, replace: true });
          await pumpQueue(box, task.id);
        }, 'primary'), button('取消', () => openHome(), 'secondary')));
    }, 'secondary')),
    body);
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
  bookId, catalog, existing, container, title, author, chapters, retryFailed = [], pace, replace = false, task = null,
}) {
  if (busy) return;
  busy = true;
  let cancelled = false;
  let stopReason = '';
  const requestStop = reason => {
    cancelled = true;
    if (reason && !stopReason) stopReason = reason;
  };
  const indexOf = new Map(catalog.chapters.map((chapter, index) => [chapter.id, index]));
  container = container || document.createElement('div');
  container.replaceChildren();

  const bar = element('div', null, 'dl-bar');
  const fill = element('span');
  bar.append(fill);
  const log = statusLine('准备下载…');
  const pauseBtn = button('暂停', () => requestStop('pause'), 'secondary dl-cancel');
  const cancel = button('停止', () => requestStop('stop'), 'secondary dl-cancel');
  container.append(log, bar, actionRow(pauseBtn, cancel));

  // 关掉面板 = 停止这次下载（已取到的章照常保存），避免 busy 一直挂着
  const dialogEl = $('dialog');
  const onDialogClose = () => requestStop('stop');
  activeRunCancel = reason => requestStop(reason || 'stop');
  currentTaskId = task?.id || null;
  dialogEl.addEventListener('close', onDialogClose);

  const rows = [];
  let failedCount = 0;
  let delay = pace.delay;
  let rotations = 0;
  const startedAt = Date.now();

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
    fill.style.width = `${total ? Math.round(done * 100 / total) : 0}%`;
    const elapsed = (Date.now() - startedAt) / 1000;
    const eta = done > 0 ? Math.round(elapsed / done * (total - done) / 60) : 0;
    const tail = [failedCount ? `${failedCount} 章被拒重试中` : '', rotations ? `换设备 ${rotations} 次` : ''].filter(Boolean).join('，');
    log.textContent = `已取 ${done} / ${total} 章${eta > 0 ? ` · 约剩 ${eta} 分钟` : ''}${tail ? ` · ${tail}` : ''}${extra ? ` · ${extra}` : ''}`;
    if (task) {
      task.done = done;
      task.total = total;
      task.message = log.textContent;
      updateTask(task.id, { done, total, message: task.message, status: 'running' });
    }
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
      tick('补旧章');
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
          rotations += 1;
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
      for (const row of ordered) {
        rows.push(row);
        if (!row.ok) failedCount += 1;
      }
      done += slice.length;
      tick();
      if (i + BATCH < chapters.length) await sleep(delay);
      if (pace.cooldownEvery && done % pace.cooldownEvery < BATCH) await sleep(pace.cooldown);
    }

    // ②½ 补漏：跑完后对仍失败的章做多轮延时重试，风控窗口通常几秒到几十秒
    if (!cancelled && rows.some(row => !row.ok)) {
      const waits = [2000, 5000, 12000, 25000];
      for (let round = 0; round < waits.length; round += 1) {
        const failed = rows.filter(row => !row.ok);
        if (!failed.length) break;
        log.textContent = `补漏第 ${round + 1}/${waits.length} 轮：${failed.length} 章待补，先等 ${Math.round(waits[round] / 1000)}s…`;
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
          await sleep(Math.max(600, Math.round(delay / 2)));
        }
        if (!rows.some(row => !row.ok)) break;
      }
      failedCount = rows.filter(row => !row.ok).length;
      tick('补漏完成');
    }

    if (total === 0) {
      log.textContent = '这本书已经是最新的了。';
      log.className = 'dl-status is-ok';
      return;
    }
    if (!rows.length) {
      log.textContent = cancelled ? '已停止，已取的章节会保留。' : '没有取到任何章节，稍后再试。';
      log.className = 'dl-status is-warn';
      return;
    }

    // ③ 组装：替换模式重排全书，否则在原文后面追加 + 就地补旧章
    log.textContent = '整理正文…';
    const byId = new Map(rows.map(row => [row.id, row]));
    const manifest = existing?.dl?.manifest && !replace ? existing.dl.manifest.map(entry => ({ ...entry })) : [];
    let text = existing && !replace ? await hooks.readText(existing.id) : '';
    if (typeof text !== 'string') text = '';

    let patched = 0;
    for (let i = 0; i < manifest.length; i += 1) {
      const entry = manifest[i];
      if (entry.ok !== false) continue;
      const row = byId.get(entry.id);
      if (!row?.ok) continue;
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

    const okCount = appended.entries.filter(entry => entry.ok && !entry.skipped).length;
    const skippedCount = appended.entries.filter(entry => entry.skipped).length;
    const stillMissing = manifest.filter(entry => entry.ok === false).length;
    // 自检：写入条目数应当等于「本轮真正取到的章数」（模板章也算一条），暂停/停止时不报警
    const expected = rows.length - patched;
    const overflow = Math.max(0, expected - appended.entries.length);
    const saved = await hooks.upsertBook({
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
    fill.style.width = '100%';
    log.textContent = [
      replace
        ? '已用最新内容替换全书'
        : (okCount ? `已加入书架：${okCount} 章正文` : '没有新增正文'),
      patched ? `补回旧章 ${patched} 章` : '',
      skippedCount ? `跳过模板章 ${skippedCount} 个` : '',
      stillMissing ? `${stillMissing} 章仍失败（可再次继续下载）` : '',
      overflow > 0 ? `⚠ ${overflow} 章未能写入（请再点一次继续下载）` : '',
      cancelled ? (stopReason === 'pause' ? '（已暂停，进度已保存）' : '（已按停止保存）') : '',
    ].filter(Boolean).join('，') + '。';
    log.className = 'dl-status is-ok';
    if (task) updateTask(task.id, { added: okCount, missing: stillMissing, message: log.textContent });
    container.append(actionRow(button('开始阅读', () => { if (saved) hooks.openBook?.(saved); }, 'primary')));
  } catch (err) {
    log.textContent = err.message || '下载中断';
    log.className = 'dl-status is-warn';
    if (task) updateTask(task.id, { status: 'error', message: log.textContent });
  } finally {
    busy = false;
    activeRunCancel = null;
    currentTaskId = null;
    dialogEl.removeEventListener('close', onDialogClose);
    cancel.remove();
    pauseBtn.remove();
    if (task) {
      const status = cancelled ? (stopReason === 'pause' ? 'paused' : 'stopped') : 'done';
      updateTask(task.id, { status });
    }
  }
}

// ---------- 任务执行 ----------
async function startTask(task, container = null) {
  updateTask(task.id, { status: 'running', message: '读取目录…' });
  let catalog;
  try {
    const data = await api(`book?id=${encodeURIComponent(task.remoteId)}`);
    catalog = data.book;
  } catch (err) {
    updateTask(task.id, { status: 'error', message: err.message || '目录读取失败' });
    return;
  }

  const existing = hooks.findBookByRemote?.(task.remoteId) || null;
  const manifest = existing?.dl?.manifest || [];
  const have = new Set(manifest.map(entry => entry.id));
  const retryFailed = manifest.filter(entry => entry.ok === false);

  let chapters;
  if (task.replace) {
    chapters = catalog.chapters.slice(0, MAX_CHAPTERS);
  } else {
    // 先把「这一轮的目标范围」定死（整本 / 前 N 章），再按清单做差集：
    // 暂停后继续只补这个范围里还没下的章，不会多取也不会从头重取
    const windowSize = task.mode === 'update'
      ? MAX_CHAPTERS
      : (task.limit || Math.min(catalog.chapters.length, MAX_CHAPTERS));
    chapters = catalog.chapters.slice(0, windowSize).filter(chapter => !have.has(chapter.id));
  }

  updateTask(task.id, { total: chapters.length + retryFailed.length });

  await runDownload({
    bookId: task.remoteId,
    catalog,
    existing,
    container,
    title: catalog.title || task.title,
    author: catalog.author,
    chapters,
    retryFailed,
    pace: PACE[task.pace] || PACE.normal,
    replace: Boolean(task.replace),
    task,
  });
}

let pumping = false;
async function pumpQueue(container = null, focusId = null) {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const next = loadTasks().find(task => task.status === 'queued');
      if (!next) break;
      const target = focusId && next.id === focusId ? container : null;
      await startTask(next, target);
      focusId = null;
    }
  } finally {
    pumping = false;
  }
}

export function pauseTask(id) {
  const task = loadTasks().find(item => item.id === id);
  if (!task) return;
  if (task.status === 'running' && currentTaskId === id) {
    activeRunCancel?.('pause');
    updateTask(id, { status: 'pausing', message: '正在暂停…' });
  } else {
    updateTask(id, { status: 'paused', message: '已暂停' });
  }
}

export async function resumeTask(id, container = null) {
  const task = loadTasks().find(item => item.id === id);
  if (!task) return;
  updateTask(id, { status: 'queued', message: '等待继续' });
  if (busy) {
    hooks.toast?.('已加入队列，等当前任务结束后自动开始');
    return;
  }
  await pumpQueue(container, id);
}

// ---------- 对外入口 ----------
export function setupDownload(options = {}) {
  hooks = { ...hooks, ...options };
  const trigger = $('downloadBtn');
  const open = async () => {
    openHome();
  };
  if (trigger) trigger.onclick = open;
  return open;
}

/** 供书架「⋯ → 继续下载 / 更新」调用：按书籍 ID 直接走更新流程。 */
export async function openUpdateForBook(remoteId, fallbackTitle = '') {
  if (!remoteId) return hooks.toast?.('这本书没有番茄来源，无法更新');
  await openBookPanel(remoteId, { title: fallbackTitle });
}

export { openHome };
