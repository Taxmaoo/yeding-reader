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
  $('dialogBody').replaceChildren(...content);
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

/** 如果上一次下载还在跑，先停掉并等它收尾，避免 busy 卡住新操作。 */
async function ensureIdle() {
  if (!busy) return;
  activeRunCancel?.();
  for (let i = 0; i < 24 && busy; i += 1) await sleep(150);
}

// ---------- 面板：搜索 ----------
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
    element('p', '把番茄上的小说抓到本机书架。已在书架里的书再次打开会走「继续下载 / 更新」，只补新章和上次失败的章。', 'dl-hint'));
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
    await runDownload({
      bookId, catalog, existing: null, container: body,
      title, author: catalog.author, chapters: all.slice(0, limit), pace: PACE[pace.value],
    });
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
    limitRow, paceRow, actionRow(start), body);
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
        await runDownload({
          bookId, catalog, existing, container: body,
          title, author: catalog.author, chapters: catalog.chapters.slice(0, MAX_CHAPTERS),
          pace: PACE[pace.value], replace: true,
        });
      }, 'primary'), button('取消', () => openHome(), 'secondary')),
      body);
    return;
  }

  const uptoDate = missing.length === 0 && failed.length === 0;
  const start = button(uptoDate ? '已是最新（重新核对）' : `继续下载（${missing.length} 新章${failed.length ? ` + 补 ${failed.length} 章` : ''}）`, async () => {
    writeSetting(PACE_KEY, pace.value);
    await runDownload({
      bookId, catalog, existing, container: body,
      title, author: catalog.author,
      chapters: missing.slice(0, MAX_CHAPTERS),
      retryFailed: failed,
      pace: PACE[pace.value],
    });
  }, 'primary');

  const paceRow = element('div', null, 'dl-row');
  paceRow.append(element('span', '节奏', 'dl-row-label'), pace);

  openPanel('继续下载 / 更新',
    element('strong', title, 'dl-title'),
    element('span', meta, 'dl-meta'),
    statusLine(`已存 ${manifest.length} 章 · 目录共 ${catalog.chapters.length} 章 · 新增 ${missing.length} 章`
      + (failed.length ? ` · 上次失败 ${failed.length} 章` : '')
      + (uptoDate ? ' · 已经是最新' : ''),
    uptoDate ? 'is-ok' : ''),
    paceRow,
    actionRow(start, button('重新下载整本', () => {
      openPanel('重新下载整本？',
        statusLine('会用番茄上的最新内容替换这本书的正文，阅读进度和书签保留。', 'is-warn'),
        actionRow(button('确认替换', async () => {
          writeSetting(PACE_KEY, pace.value);
          await runDownload({
            bookId, catalog, existing, container: body,
            title, author: catalog.author, chapters: catalog.chapters.slice(0, MAX_CHAPTERS),
            pace: PACE[pace.value], replace: true,
          });
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
  bookId, catalog, existing, container, title, author, chapters, retryFailed = [], pace, replace = false,
}) {
  if (busy) return;
  busy = true;
  let cancelled = false;
  const indexOf = new Map(catalog.chapters.map((chapter, index) => [chapter.id, index]));
  container.replaceChildren();

  const bar = element('div', null, 'dl-bar');
  const fill = element('span');
  bar.append(fill);
  const log = statusLine('准备下载…');
  const cancel = button('停止', () => { cancelled = true; }, 'secondary dl-cancel');
  container.append(log, bar, actionRow(cancel));

  // 关掉面板 = 停止这次下载（已取到的章照常保存），避免 busy 一直挂着
  const dialogEl = $('dialog');
  const requestStop = () => { cancelled = true; };
  activeRunCancel = requestStop;
  dialogEl.addEventListener('close', requestStop);

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
          delay = Math.min(1600, Math.round(delay * 1.5));
          await sleep(1200);
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
    // 自检：写入的条目数应当等于这一轮请求的章数（模板章也算一条），否则说明有章被静默丢弃
    const expected = chapters.length;
    const overflow = expected - appended.entries.length;
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
      cancelled ? '（已按停止保存）' : '',
    ].filter(Boolean).join('，') + '。';
    log.className = 'dl-status is-ok';
    container.append(actionRow(button('开始阅读', () => { if (saved) hooks.openBook?.(saved); }, 'primary')));
  } catch (err) {
    log.textContent = err.message || '下载中断';
    log.className = 'dl-status is-warn';
  } finally {
    busy = false;
    if (activeRunCancel === requestStop) activeRunCancel = null;
    dialogEl.removeEventListener('close', requestStop);
    cancel.remove();
  }
}

// ---------- 对外入口 ----------
export function setupDownload(options = {}) {
  hooks = { ...hooks, ...options };
  const trigger = $('downloadBtn');
  const open = async () => {
    await ensureIdle();
    openHome();
  };
  if (trigger) trigger.onclick = open;
  return open;
}

/** 供书架「⋯ → 继续下载 / 更新」调用：按书籍 ID 直接走更新流程。 */
export async function openUpdateForBook(remoteId, fallbackTitle = '') {
  if (!remoteId) return hooks.toast?.('这本书没有番茄来源，无法更新');
  await ensureIdle();
  await openBookPanel(remoteId, { title: fallbackTitle });
}

export { openHome };
