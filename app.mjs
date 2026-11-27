import { DEFAULT_SETTINGS, SAMPLE, decodeTxt, indexText, sectionAt, progressAt, isLowSurrogate } from './reader-core.mjs';
import { listBooks, readText, saveBook, addBook, deleteBook } from './storage.mjs';
import {
  TtsController, EDGE_VOICES, SLEEP_OPTIONS,
  testTtsEndpoint, resolveApiEndpoint, loadLastListened, saveLastListened,
} from './tts.mjs';

const $ = id => document.getElementById(id);
const viewport = $('viewport');
const passage = $('passage');
const dialog = $('dialog');
const GAP = 28;
let books = [];
let active;
let toastTimer;
let scrollTimer;
let resizeFrame;
let importBusy = false;
let touch;
let lastSwipe = 0;

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

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  toastTimer = setTimeout(() => { $('toast').textContent = ''; }, 3000);
}

function store(book) {
  return saveBook(book).catch(() => toast('保存阅读进度失败。'));
}

const SHELF_VIEW_KEY = 'yeding-shelf-view-v1';
let shelfView = (() => {
  try { return localStorage.getItem(SHELF_VIEW_KEY) === 'list' ? 'list' : 'grid'; } catch { return 'grid'; }
})();
let shelfFilter = 'all';
let shelfQuery = '';

function formatTimeAgo(ts) {
  if (!ts) return '';
  const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
  return `${Math.floor(diff / 86400)}天前`;
}

function renderResumeCard() {
  const card = $('resumeListenCard');
  const saved = loadLastListened();
  let targetBook = saved ? books.find(b => b.id === saved.bookId) : null;
  if (!targetBook) {
    targetBook = books
      .filter(b => b.ttsProgress?.offset != null)
      .sort((a, b) => (b.ttsProgress.updatedAt || 0) - (a.ttsProgress.updatedAt || 0))[0] || null;
  }
  if (!targetBook) {
    card.hidden = true;
    card.replaceChildren();
    return;
  }
  const prog = targetBook.ttsProgress || saved;
  const percent = prog?.percent ?? progressAt(prog?.offset ?? targetBook.position, targetBook.length, targetBook.finished);
  const tone = books.indexOf(targetBook) % 6;

  const cover = element('div', Array.from(targetBook.title)[0] || '书', 'resume-cover');
  cover.dataset.tone = String(tone < 0 ? 0 : tone);
  const info = element('div', null, 'resume-info');
  const ago = formatTimeAgo(prog?.updatedAt);
  const chapterText = prog?.chapterTitle ? `${prog.chapterTitle} · ` : '';
  info.append(
    element('span', `🎧 上次听书${ago ? ` · ${ago}` : ''}`, 'resume-label'),
    element('strong', targetBook.title, 'resume-title'),
    element('span', `${chapterText}听到 ${percent}%`, 'resume-meta'),
  );
  const btn = button('▶ 继续听', () => openBookAndListen(targetBook), 'resume-btn');
  card.replaceChildren(cover, info, btn);
  card.hidden = false;
}

function renderShelf() {
  books.sort((a, b) => Math.max(b.lastRead || 0, b.ttsProgress?.updatedAt || 0, b.created || 0)
    - Math.max(a.lastRead || 0, a.ttsProgress?.updatedAt || 0, a.created || 0));

  $('shelfCount').textContent = books.length ? `共 ${books.length} 本 · 本机私密书库` : '本地私密书库';
  $('viewToggle').textContent = shelfView === 'grid' ? '列表' : '宫格';
  $('shelfTools').hidden = books.length === 0;
  renderResumeCard();

  const query = shelfQuery.trim().toLowerCase();
  const filtered = books.filter(book => {
    if (query && !book.title.toLowerCase().includes(query)) return false;
    if (shelfFilter === 'listened') return Boolean(book.ttsProgress);
    if (shelfFilter === 'finished') return Boolean(book.finished);
    return true;
  });

  const list = $('bookList');
  list.dataset.view = shelfView;

  if (books.length && !filtered.length) {
    list.replaceChildren(element('p', '没有符合条件的书籍。', 'shelf-empty-filter'));
  } else if (shelfView === 'grid') {
    const cards = filtered.map((book, i) => {
      const card = element('div', null, 'book-card');
      const open = button(null, () => openBook(book), 'book-card-open');
      const tone = i % 6;
      const hasAudio = Boolean(book.ttsProgress);
      const readPct = progressAt(book.position, book.length, book.finished);
      const displayPct = hasAudio ? (book.ttsProgress.percent ?? readPct) : readPct;

      const cover = element('div', null, 'book-cover-3d');
      cover.dataset.tone = String(tone);
      cover.append(
        element('span', book.title, 'book-cover-title'),
        element('span', hasAudio ? '🎧 听书' : 'TXT', `book-cover-tag${hasAudio ? ' is-audio' : ''}`),
      );
      const name = element('span', book.title, 'book-card-name');
      const bar = element('span', null, 'book-mini-bar');
      const fill = element('span');
      fill.style.width = `${displayPct}%`;
      bar.append(fill);

      const metaText = book.finished
        ? '已读完'
        : hasAudio
          ? `听到 ${displayPct}%`
          : readPct > 0 ? `读到 ${readPct}%` : '未读';
      const meta = element('span', metaText, `book-card-meta${hasAudio && !book.finished ? ' is-audio' : ''}`);
      open.append(cover, name, bar, meta);

      const more = button('⋯', event => {
        event.stopPropagation();
        bookActions(book);
      }, 'book-card-more');
      more.setAttribute('aria-label', `${book.title}的管理选项`);
      card.append(open, more);
      return card;
    });

    const addCard = button(null, () => $('fileInput').click(), 'add-book-card');
    addCard.append(element('span', '＋'), element('span', '导入 TXT'));
    cards.push(addCard);
    list.replaceChildren(...cards);
  } else {
    list.replaceChildren(...filtered.map((book, i) => {
      const row = element('div', null, 'book-row');
      const open = button(null, () => openBook(book), 'book-open');
      const cover = element('span', Array.from(book.title)[0] || '书', 'book-cover');
      cover.dataset.tone = String(i % 6);
      cover.setAttribute('aria-hidden', 'true');
      const info = element('span', null, 'book-details');
      const hasAudio = Boolean(book.ttsProgress);
      const readPct = progressAt(book.position, book.length, book.finished);
      const metaText = book.finished
        ? '已读完'
        : hasAudio
          ? `🎧 ${book.ttsProgress.chapterTitle ? `${book.ttsProgress.chapterTitle} · ` : ''}听到 ${book.ttsProgress.percent ?? readPct}%`
          : `读到 ${readPct}%`;
      const meta = element('small', metaText, hasAudio && !book.finished ? 'is-audio' : '');
      const bar = element('span', null, 'book-mini-bar');
      const fill = element('span');
      fill.style.width = `${hasAudio ? (book.ttsProgress.percent ?? readPct) : readPct}%`;
      bar.append(fill);
      info.append(element('strong', book.title), meta, bar);
      open.append(cover, info);

      const children = [open];
      if (hasAudio) {
        children.push(button('🎧 续听', () => openBookAndListen(book), 'row-listen-btn'));
      }
      const actions = button('⋯', () => bookActions(book), 'icon-button');
      actions.setAttribute('aria-label', `${book.title}的管理选项`);
      children.push(actions);
      row.append(...children);
      return row;
    }));
  }
  $('empty').hidden = books.some(book => book.id === SAMPLE.id);
}

function openDialog(title, ...content) {
  $('dialogTitle').textContent = title;
  $('dialogBody').replaceChildren(...content);
  $('dialogBody').scrollTop = 0;
  if (!dialog.open) dialog.showModal();
}

async function exportTxt(book) {
  try {
    const text = await readText(book.id);
    if (text == null) throw new Error('missing book');
    const url = URL.createObjectURL(new Blob(['\ufeff', text], { type: 'text/plain;charset=utf-8' }));
    const link = element('a');
    link.href = url;
    link.download = `${book.title}.txt`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    dialog.close();
  } catch {
    dialog.close();
    toast('暂时无法导出这本书。');
  }
}

function bookActions(book) {
  const items = [];
  if (book.ttsProgress) {
    const pct = book.ttsProgress.percent ?? progressAt(book.ttsProgress.offset, book.length, book.finished);
    items.push(button(`🎧 继续听书（${book.ttsProgress.chapterTitle || '上次位置'} · ${pct}%）`, () => {
      dialog.close();
      openBookAndListen(book);
    }, 'dialog-item'));
  } else {
    items.push(button('🎧 开始听这本书', () => {
      dialog.close();
      openBookAndListen(book);
    }, 'dialog-item'));
  }
  items.push(
    button('导出 TXT', () => exportTxt(book), 'dialog-item'),
    button('从书架删除', () => {
      openDialog('删除这本书？', element('p', `《${book.title}》及其阅读进度和书签将从这台设备移除。`), button('确认删除', async event => {
        event.currentTarget.disabled = true;
        try {
          await deleteBook(book.id);
          books = books.filter(item => item.id !== book.id);
          if (loadLastListened()?.bookId === book.id) saveLastListened(null);
          renderShelf();
          dialog.close();
        } catch {
          dialog.close();
          toast('删除失败。');
        }
      }, 'primary'));
    }, 'dialog-item'),
  );
  openDialog(book.title, ...items);
}

function makeBook(id, title, text) {
  return { id, title, length: text.length, position: 0, finished: false, marks: [], settings: { ...DEFAULT_SETTINGS }, created: Date.now() };
}

async function importBuffer(file, buffer, encoding) {
  let text;
  try {
    text = decodeTxt(buffer, encoding);
  } catch {
    const choices = element('select', null, 'encoding-select');
    choices.setAttribute('aria-label', 'TXT 编码');
    for (const [key, label] of [['utf-8', 'UTF-8'], ['gb18030', 'GB18030 / GBK'], ['utf-16le', 'UTF-16 LE'], ['utf-16be', 'UTF-16 BE']]) {
      const option = element('option', label);
      option.value = key;
      choices.append(option);
    }
    openDialog('选择 TXT 编码', element('p', '请确认文件有正文，再选择编码重新打开。'), choices,
      button('按此编码导入', () => importBuffer(file, buffer, choices.value), 'primary'));
    return;
  }
  const id = globalThis.crypto?.randomUUID?.() ?? `book-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const book = makeBook(id, file.name.replace(/\.txt$/i, '').trim() || '未命名小说', text);
  if (dialog.open) dialog.close();
  try {
    await addBook(book, text);
    books.push(book);
    renderShelf();
    await openBook(book, text);
  } catch {
    toast('导入失败，请检查本机储存空间。');
  }
}

async function importFile(file) {
  if (!file || importBusy) return;
  if (file.size > 30 * 1024 * 1024) return toast('单本 TXT 最大 30 MB。');
  importBusy = true;
  $('importBtn').disabled = true;
  try {
    await importBuffer(file, await file.arrayBuffer(), 'auto');
  } catch {
    toast('无法读取这个文件。');
  } finally {
    importBusy = false;
    $('importBtn').disabled = false;
  }
}

let opening = false;
async function openBook(book, supplied) {
  if (opening || active) return;
  opening = true;
  try {
    const text = supplied ?? await readText(book.id);
    if (!text) throw new Error('missing text');
    const { chapters, sections, hasHeadings } = indexText(text);
    active = { book, text, chapters, sections, hasHeadings, sectionIndex: -1, spans: [], page: 0 };
    book.lastRead = Date.now();
    book.settings = { ...DEFAULT_SETTINGS, ...book.settings };
    $('library').hidden = true;
    $('reader').hidden = false;
    document.body.classList.add('reading');
    $('bookLabel').textContent = $('toolbarTitle').textContent = book.title;
    applySettings();
    jumpTo(book.position, { keepFinished: book.finished });
    viewport.focus({ preventScroll: true });
  } catch {
    if (active) closeReader();
    toast('这本书暂时无法打开。');
  } finally {
    opening = false;
  }
}

function closeReader() {
  if (!active) return;
  tts.stop();
  if (active.book.settings.mode === 'scroll' && scrollTimer) updateScrollPosition();
  clearTimeout(scrollTimer);
  scrollTimer = null;
  store(active.book);
  active = null;
  if (dialog.open) dialog.close();
  setMenu(false);
  $('reader').hidden = true;
  $('library').hidden = false;
  document.body.classList.remove('reading');
  delete document.body.dataset.theme;
  setThemeColor();
  passage.replaceChildren();
  renderShelf();
  $('importBtn').focus({ preventScroll: true });
}

function setThemeColor() {
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.body).getPropertyValue('--paper').trim();
}

function applySettings() {
  const { size, leading, margin, theme, mode, font } = active.book.settings;
  const style = $('reader').style;
  style.setProperty('--reader-size', `${size}px`);
  style.setProperty('--reader-leading', leading);
  style.setProperty('--reader-gutter', `${margin}px`);
  style.setProperty('--reader-font', font === 'serif' ? 'var(--serif)' : 'system-ui, sans-serif');
  document.body.dataset.theme = theme;
  setThemeColor();
  viewport.dataset.mode = mode;
}

function renderSection(index) {
  const { start, end, title, headingEnd, chapter } = active.sections[index];
  const text = active.text;
  active.sectionIndex = index;
  active.spans = [];
  const fragment = document.createDocumentFragment();
  const append = (kind, value, from, continued = false) => {
    if (!value) return;
    const node = element(kind, value);
    if (continued) node.classList.add('continued');
    fragment.append(node);
    active.spans.push({ node, start: from, end: from + value.length });
  };
  if (headingEnd > start) {
    append('h1', title, start);
    active.spans[0].end = headingEnd;
  }
  let position = headingEnd;
  for (const line of text.slice(headingEnd, end).split('\n')) {
    const stripped = line.trimStart();
    const from = position + line.length - stripped.length;
    if (stripped.trim()) append('p', stripped, from, position === start && start > 0 && text[start - 1] !== '\n');
    position += line.length + 1;
  }
  if (!active.spans.length) append('p', '\u00a0', start);
  passage.replaceChildren(fragment);
  const previous = active.sections[index - 1];
  const next = active.sections[index + 1];
  $('prevSection').disabled = !previous;
  $('prevSection').textContent = previous?.chapter === chapter ? '上一段' : '上一章';
  if (!next) $('nextSection').textContent = '读完本书';
  else $('nextSection').textContent = next.chapter === chapter ? '下一段' : '下一章';
  syncTtsHighlight();
}

function spanAt(offset) {
  return active.spans.find(span => offset < span.end) ?? active.spans.at(-1);
}

function charRect(span, index) {
  const node = span.node.firstChild;
  const text = node.data;
  let at = Math.min(text.length - 1, Math.max(0, index));
  if (isLowSurrogate(text.charCodeAt(at)) && at > 0) at--;
  const range = document.createRange();
  range.setStart(node, at);
  range.setEnd(node, Math.min(text.length, at + (text.codePointAt(at) > 0xffff ? 2 : 1)));
  return range.getBoundingClientRect();
}

function columnOf(rect) {
  return Math.max(0, Math.floor((rect.left - viewport.getBoundingClientRect().left + viewport.scrollLeft + 1) / (viewport.clientWidth + GAP)));
}

function pageCount() {
  return columnOf(charRect(active.spans.at(-1), Infinity)) + 1;
}

function firstVisibleOffset(test) {
  const section = active.sections[active.sectionIndex];
  let low = 0;
  let high = active.spans.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (test(charRect(active.spans[mid], Infinity))) high = mid;
    else low = mid + 1;
  }
  const span = active.spans[low];
  if (!span) return section.end - 1;
  if (span.node.tagName === 'H1') return span.start;
  low = 0;
  high = span.node.textContent.length - 1;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (test(charRect(span, mid))) high = mid;
    else low = mid + 1;
  }
  if (isLowSurrogate(span.node.textContent.charCodeAt(low))) low--;
  return Math.max(section.start, span.start + low);
}

function currentChapterIndex() {
  return active.sections[active.sectionIndex].chapter;
}

function isChapterEndVisible() {
  const next = active.sections[active.sectionIndex + 1];
  if (next?.chapter === currentChapterIndex()) return false;
  if (active.book.settings.mode === 'page') return active.page >= pageCount() - 1;
  const lastParagraph = active.spans.at(-1).node.getBoundingClientRect();
  const viewportBounds = viewport.getBoundingClientRect();
  return lastParagraph.bottom <= viewportBounds.bottom + 2
    && lastParagraph.right <= viewportBounds.right + 2;
}

function recordChapterProgress(complete = false) {
  const { book, chapters, text } = active;
  book.chapterProgress ??= [];
  const index = currentChapterIndex();
  const { start } = chapters[index];
  const end = chapters[index + 1]?.start ?? text.length;
  const progress = complete || (book.finished && index === chapters.length - 1)
    ? 100
    : progressAt(book.position - start, end - start);
  book.chapterProgress[index] = Math.max(book.chapterProgress[index] || 0, progress);
}

function completeChapterIfSeenToEnd() {
  if (active && isChapterEndVisible()) recordChapterProgress(true);
}

function updateChapterRow(row, index, currentIndex) {
  const progress = active.book.chapterProgress?.[index] || 0;
  const isCurrent = index === currentIndex;
  row.dataset.state = progress === 100 ? 'read' : progress > 0 ? 'partial' : 'unread';
  if (isCurrent) row.setAttribute('aria-current', 'location');
  else row.removeAttribute('aria-current');
  const label = progress === 100 ? '已读' : isCurrent ? '正在读' : progress > 0 ? '读到' : '未读';
  row.querySelector('.chapter-progress').textContent = `${label} ${progress}%`;
  row.querySelector('.chapter-progress-fill').style.width = `${progress}%`;
}

function syncChapterUI() {
  const index = currentChapterIndex();
  const { title } = active.chapters[index];
  $('chapterLabel').textContent = $('jumpChapterTitle').textContent = title;
  $('prevChapter').disabled = index === 0;
  $('nextChapterMenu').disabled = index === active.chapters.length - 1;
  if (!dialog.open) return;
  const list = $('chapterList');
  if (!list) return;
  for (const row of list.children) updateChapterRow(row, Number(row.dataset.chapter), index);
}

function updateProgress() {
  const { position, length, finished } = active.book;
  const percent = progressAt(position, length, finished);
  $('readPercent').textContent = $('jumpValue').textContent = `${percent}%`;
  $('progress').value = finished ? 1000 : Math.min(999, Math.round(position / Math.max(1, length) * 1000));
  syncChapterUI();
}

function jumpTo(offset, { keepFinished = false, endOfSection = false, fromTts = false } = {}) {
  if (!active) return;
  clearTimeout(scrollTimer);
  scrollTimer = null;
  const { text, sections, book } = active;
  const position = Math.max(0, Math.min(text.length - 1, offset));
  const index = sectionAt(sections, position);
  if (index !== active.sectionIndex) renderSection(index);
  const span = spanAt(position);
  if (book.settings.mode === 'page') {
    viewport.scrollTop = 0;
    const page = endOfSection ? pageCount() - 1 : position === sections[index].start ? 0 : columnOf(charRect(span, position - span.start));
    active.page = Math.min(page, pageCount() - 1);
    viewport.scrollLeft = active.page * (viewport.clientWidth + GAP);
  } else {
    viewport.scrollLeft = 0;
    const top = position === sections[index].start ? 0 : viewport.scrollTop + charRect(span, position - span.start).top - viewport.getBoundingClientRect().top;
    viewport.scrollTop = endOfSection ? viewport.scrollHeight : top;
    active.programmaticTop = viewport.scrollTop;
  }
  book.position = endOfSection && book.settings.mode === 'page' && active.page > 0
    ? firstVisibleOffset(rect => columnOf(rect) >= active.page)
    : position;
  book.finished = keepFinished;
  recordChapterProgress();
  updateProgress();
  store(book);
  if (!fromTts && tts.active) tts.seekToOffset(book.position);
}

function updateScrollPosition() {
  clearTimeout(scrollTimer);
  scrollTimer = null;
  if (!active || active.book.settings.mode !== 'scroll') return;
  const section = active.sections[active.sectionIndex];
  const top = viewport.getBoundingClientRect().top;
  active.book.position = viewport.scrollTop < 2 ? section.start : firstVisibleOffset(rect => rect.bottom > top + 1);
  active.book.finished = false;
  recordChapterProgress(isChapterEndVisible());
  updateProgress();
  store(active.book);
}

function scrollHandler() {
  if (!active || active.book.settings.mode !== 'scroll') return;
  if (active.programmaticTop != null && Math.abs(viewport.scrollTop - active.programmaticTop) < 1) return;
  active.programmaticTop = null;
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(updateScrollPosition, 150);
}

function finishBook() {
  if (scrollTimer) updateScrollPosition();
  if (active.book.finished) return toast('已经读到最后一页。');
  active.book.finished = true;
  recordChapterProgress(true);
  updateProgress();
  store(active.book);
  toast('已读完全书。');
}

function turn(direction) {
  if (!active || active.book.settings.mode !== 'page') return;
  const { sections, sectionIndex, book } = active;
  const page = active.page + direction;
  if (page >= 0 && page < pageCount()) {
    active.page = page;
    viewport.scrollLeft = page * (viewport.clientWidth + GAP);
    book.position = page === 0 ? sections[sectionIndex].start : firstVisibleOffset(rect => columnOf(rect) >= page);
    book.finished = false;
    recordChapterProgress(isChapterEndVisible());
    updateProgress();
    store(book);
  } else if (direction > 0 && sectionIndex + 1 < sections.length) {
    const next = sections[sectionIndex + 1];
    if (next.chapter !== currentChapterIndex()) recordChapterProgress(true);
    jumpTo(next.start);
  } else if (direction < 0 && sectionIndex > 0) {
    jumpTo(sections[sectionIndex - 1].end - 1, { endOfSection: true });
  } else if (direction > 0) {
    finishBook();
  }
}

function setMenu(open) {
  $('readerMenus').hidden = !open;
  $('menuToggle').setAttribute('aria-expanded', open);
}

function toc() {
  if (scrollTimer) updateScrollPosition();
  const search = element('input', null, 'search-input');
  search.type = 'search';
  search.placeholder = '搜索正文';
  search.setAttribute('aria-label', '搜索正文');
  const results = element('div');
  const chapterList = element('div');
  chapterList.id = 'chapterList';
  const go = position => {
    completeChapterIfSeenToEnd();
    dialog.close();
    setMenu(false);
    jumpTo(position);
    viewport.focus({ preventScroll: true });
  };
  const currentIndex = currentChapterIndex();
  chapterList.append(...active.chapters.map(({ title, start }, index) => {
    const row = element('button', null, 'chapter-row');
    row.type = 'button';
    row.dataset.chapter = index;
    row.onclick = () => go(start);
    const name = element('span', title, 'chapter-name');
    const percent = element('span', null, 'chapter-progress');
    const progress = element('span', null, 'chapter-progress-bar');
    progress.setAttribute('aria-hidden', 'true');
    progress.append(element('span', null, 'chapter-progress-fill'));
    row.append(name, percent, progress);
    updateChapterRow(row, index, currentIndex);
    return row;
  }));
  search.oninput = () => {
    const query = search.value.trim();
    results.replaceChildren();
    chapterList.hidden = Boolean(query);
    if (!query) return;
    const text = active.text;
    let pos = text.indexOf(query);
    let count = 0;
    while (pos !== -1 && count < 40) {
      const hit = pos;
      const snippet = text.slice(Math.max(0, pos - 8), pos + query.length + 24).replace(/\s+/g, ' ');
      results.append(button(snippet, () => go(hit), 'dialog-item'));
      count++;
      pos = text.indexOf(query, pos + query.length);
    }
    if (!count) results.append(element('p', '未找到匹配的正文。'));
    if (pos !== -1) results.append(element('p', '显示前 40 条结果。'));
  };
  openDialog('目录', ...(!active.hasHeadings ? [element('p', '未识别到常见章节标题，可搜索正文跳转。')] : []), search, results, chapterList);
  chapterList.querySelector('[aria-current="location"]')?.scrollIntoView({ block: 'nearest' });
}

function addMark() {
  if (scrollTimer) updateScrollPosition();
  const { book, text, sections, sectionIndex } = active;
  if (book.marks.some(mark => mark.position === book.position)) return toast('这个位置已有书签。');
  const snippet = text.slice(book.position, book.position + 54).replace(/\s+/g, ' ').trim();
  book.marks.push({ position: book.position, label: sections[sectionIndex].title, snippet });
  book.marks.sort((a, b) => a.position - b.position);
  store(book);
  toast('已添加书签。');
}

function bookmarks() {
  const { book } = active;
  if (!book.marks.length) return openDialog('书签', element('p', '还没有书签。可从阅读菜单添加。'));
  openDialog('书签', ...book.marks.map(mark => {
    const row = element('div', null, 'dialog-row');
    const remove = button('×', () => {
      book.marks = book.marks.filter(item => item !== mark);
      store(book);
      bookmarks();
    }, 'icon-button');
    remove.setAttribute('aria-label', `删除书签 ${mark.label} ${mark.snippet}`);
    row.append(button(`${mark.label} · ${mark.snippet}`, () => {
      dialog.close();
      setMenu(false);
      jumpTo(mark.position);
    }), remove);
    return row;
  }));
}

function settings() {
  const { book } = active;
  function change(key, value) {
    if (scrollTimer) updateScrollPosition();
    book.settings[key] = value;
    applySettings();
    jumpTo(book.position, { keepFinished: book.finished });
  }
  function range(label, key, min, max, step, unit) {
    const row = element('div', null, 'settings-row');
    const wrap = element('label', null, 'setting-label');
    const display = element('output', `${book.settings[key]}${unit}`);
    const input = element('input');
    input.id = `setting-${key}`;
    wrap.htmlFor = input.id;
    wrap.append(element('span', label), display);
    Object.assign(input, { type: 'range', min, max, step, value: book.settings[key] });
    input.oninput = () => {
      const value = Number(input.value);
      display.value = `${value}${unit}`;
      change(key, value);
    };
    row.append(wrap, input);
    return row;
  }
  function choices(label, key, options) {
    const row = element('div', null, 'settings-row');
    const items = element('div', null, 'choices');
    items.setAttribute('role', 'group');
    items.setAttribute('aria-label', label);
    for (const [value, caption] of options) {
      const item = button(caption, () => {
        change(key, value);
        for (const entry of items.children) entry.setAttribute('aria-pressed', entry === item);
      });
      item.setAttribute('aria-pressed', book.settings[key] === value);
      items.append(item);
    }
    row.append(element('p', label), items);
    return row;
  }
  openDialog('阅读设置', choices('翻页方式', 'mode', [['page', '左右翻页'], ['scroll', '上下滚动']]),
    choices('背景', 'theme', [['white', '纸白'], ['paper', '暖纸'], ['green', '护眼'], ['night', '夜间']]),
    choices('字体', 'font', [['serif', '宋体'], ['sans', '系统字体']]), range('字号', 'size', 16, 32, 1, ' px'),
    range('行距', 'leading', 1.4, 2.4, .1, ''), range('页边距', 'margin', 14, 40, 2, ' px'));
}

$('importBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = event => {
  const file = event.currentTarget.files?.[0];
  event.currentTarget.value = '';
  importFile(file);
};
$('sampleBtn').onclick = async event => {
  const trigger = event.currentTarget;
  trigger.disabled = true;
  try {
    let book = books.find(item => item.id === SAMPLE.id);
    if (!book) {
      book = makeBook(SAMPLE.id, SAMPLE.title, SAMPLE.text);
      await addBook(book, SAMPLE.text);
      books.push(book);
      renderShelf();
    }
    await openBook(book, SAMPLE.text);
  } catch {
    toast('本机存储暂时不可用。');
  } finally {
    trigger.disabled = false;
  }
};
$('backShelf').onclick = closeReader;
$('hideMenu').onclick = () => setMenu(false);
$('menuToggle').onclick = () => setMenu($('readerMenus').hidden);
async function openBookAndListen(book) {
  const resumeOffset = book.ttsProgress?.offset ?? book.position ?? 0;
  const resumeTime = book.ttsProgress?.audioTime ?? 0;
  await openBook(book);
  if (!active || active.book.id !== book.id) return;
  ttsBarCollapsed = false;
  await tts.start(active.book.id, active.book.title, active.text, active.chapters, resumeOffset, resumeTime);
}

$('viewToggle').onclick = () => {
  shelfView = shelfView === 'grid' ? 'list' : 'grid';
  try { localStorage.setItem(SHELF_VIEW_KEY, shelfView); } catch {}
  renderShelf();
};
$('shelfSearch').oninput = event => {
  shelfQuery = event.target.value;
  renderShelf();
};
for (const btn of $('shelfFilter').querySelectorAll('button')) {
  btn.onclick = () => {
    shelfFilter = btn.dataset.filter;
    for (const item of $('shelfFilter').querySelectorAll('button')) {
      item.setAttribute('aria-selected', String(item === btn));
    }
    renderShelf();
  };
}

$('tocBtn').onclick = toc;
function startOrToggleListen({ preferSaved = false } = {}) {
  if (!active) return;
  setMenu(false);
  if (tts.active) {
    if (ttsBarCollapsed) {
      ttsBarCollapsed = false;
      $('ttsBar').hidden = false;
    } else {
      tts.togglePlay();
    }
    return;
  }
  ttsBarCollapsed = false;
  const saved = active.book.ttsProgress;
  const useSaved = Boolean(preferSaved && saved?.offset != null);
  const startAt = useSaved ? saved.offset : active.book.position;
  const resumeTime = useSaved ? (saved.audioTime || 0) : 0;
  tts.start(active.book.id, active.book.title, active.text, active.chapters, startAt, resumeTime);
  if (!useSaved && saved?.offset != null && Math.abs(saved.offset - active.book.position) > 200) {
    toast('已从当前页首段开始听（点「定时」可回到上次听书点）');
  }
}

$('listenBtn').onclick = () => startOrToggleListen();
$('quickListenBtn').onclick = () => {
  if (!active) return;
  if (tts.active) {
    ttsBarCollapsed = !ttsBarCollapsed;
    $('ttsBar').hidden = ttsBarCollapsed;
    requestAnimationFrame(() => {
      if (active) jumpTo(active.book.position, { keepFinished: active.book.finished, fromTts: true });
    });
    return;
  }
  const hasSaved = active.book.ttsProgress?.offset != null;
  const closeToSaved = hasSaved && Math.abs(active.book.ttsProgress.offset - active.book.position) <= 200;
  startOrToggleListen({ preferSaved: closeToSaved });
};
$('bookmarksBtn').onclick = bookmarks;
$('markBtn').onclick = addMark;
$('settingsBtn').onclick = settings;

const RATE_STEPS = [1.0, 1.25, 1.5, 1.75, 2.0, 0.85];
let highlightedChunk = null;
let ttsBarCollapsed = false;

function persistListeningProgress(chunk, audioTime = 0) {
  if (!active || !chunk) return;
  const { book } = active;
  const percent = progressAt(chunk.start, book.length, book.finished);
  const record = {
    bookId: book.id,
    bookTitle: book.title,
    offset: chunk.start,
    audioTime: Number(audioTime) || 0,
    chapterTitle: chunk.chapterTitle || '',
    snippet: chunk.text.replace(/\s+/g, ' ').slice(0, 36),
    percent,
    updatedAt: Date.now(),
  };
  book.ttsProgress = {
    offset: record.offset,
    audioTime: record.audioTime,
    chapterTitle: record.chapterTitle,
    snippet: record.snippet,
    percent: record.percent,
    updatedAt: record.updatedAt,
  };
  saveLastListened(record);
  store(book);
}

function followTtsChunk(chunk) {
  if (!active || !chunk) return;
  const { book, sections } = active;
  const targetSection = sectionAt(sections, chunk.start);
  if (targetSection !== active.sectionIndex) {
    jumpTo(chunk.start, { fromTts: true });
    return;
  }
  const span = spanAt(chunk.start);
  if (!span) {
    jumpTo(chunk.start, { fromTts: true });
    return;
  }
  if (book.settings.mode === 'page') {
    const col = columnOf(charRect(span, chunk.start - span.start));
    if (col !== active.page) {
      jumpTo(chunk.start, { fromTts: true });
      return;
    }
  } else {
    const rect = span.node.getBoundingClientRect();
    const vp = viewport.getBoundingClientRect();
    if (rect.top < vp.top + 16 || rect.bottom > vp.bottom - 36) {
      span.node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      active.programmaticTop = viewport.scrollTop;
    }
  }
  book.position = chunk.start;
  book.finished = false;
  recordChapterProgress();
  updateProgress();
  store(book);
}

function syncTtsHighlight(chunk = highlightedChunk) {
  highlightedChunk = chunk;
  if (!active) return;
  for (const span of active.spans) {
    const hit = Boolean(chunk && span.end > chunk.start && span.start < chunk.end);
    span.node.classList.toggle('tts-reading', hit);
  }
}

function renderTtsBar(state) {
  const bar = $('ttsBar');
  const quickBtn = $('quickListenBtn');
  const wasHidden = bar.hidden;
  if (!state.active) {
    ttsBarCollapsed = false;
    bar.hidden = true;
    quickBtn.textContent = '🎧 听书';
    quickBtn.dataset.listening = 'false';
    return;
  }

  bar.hidden = ttsBarCollapsed;
  quickBtn.dataset.listening = 'true';
  quickBtn.textContent = state.loading ? '🎧 缓冲…' : state.playing ? '🎧 听书中' : '🎧 已暂停';

  const snippet = state.chunk?.text?.replace(/\s+/g, ' ').slice(0, 22) || '';
  const chapter = state.chunk?.chapterTitle || '';
  const prefix = state.loading ? '合成中… ' : state.playing ? `${state.voiceName || '听书中'} · ` : '已暂停 · ';
  $('ttsStatus').textContent = `${prefix}${chapter ? `${chapter} · ` : ''}${snippet}`;

  $('ttsPlay').textContent = state.loading ? '缓冲…' : state.playing ? '暂停' : '播放';
  $('ttsRate').textContent = `${Number(state.rate).toFixed(2).replace(/\.?0+$/, '')}x`;
  $('ttsSleep').textContent = state.sleepLabel;
  $('ttsSleep').dataset.active = String(state.sleepMode !== 'off');
  $('ttsPrev').disabled = state.chunkIndex <= 0;
  $('ttsNext').disabled = state.chunkIndex >= state.totalChunks - 1;

  if (wasHidden && !bar.hidden && active) {
    requestAnimationFrame(() => {
      if (active) jumpTo(active.book.position, { keepFinished: active.book.finished, fromTts: true });
    });
  }
}

const tts = new TtsController({
  onChunkChange(chunk) {
    if (!active) return;
    persistListeningProgress(chunk, 0);
    followTtsChunk(chunk);
  },
  onPauseProgress(chunk, audioTime) {
    if (!active) return;
    persistListeningProgress(chunk, audioTime);
  },
  onHighlight(chunk) {
    syncTtsHighlight(chunk);
  },
  onStateChange(state) {
    renderTtsBar(state);
  },
  onBookEnd() {
    if (active) finishBook();
  },
  onToast(message) {
    toast(message);
  },
  onNeedConfig() {
    if (!dialog.open) openTtsSettings();
  },
});

function openSleepDialog() {
  const wrap = element('div', null, 'settings-row');
  const items = element('div', null, 'choices');
  items.style.flexWrap = 'wrap';
  for (const opt of SLEEP_OPTIONS) {
    const btn = button(opt.label, () => {
      tts.setSleepMode(opt.value);
      dialog.close();
      toast(opt.value === 'off' ? '已关闭定时。' : `已设置定时：${opt.label}`);
    });
    btn.setAttribute('aria-pressed', String(tts.sleepMode === opt.value));
    items.append(btn);
  }
  wrap.append(element('p', '定时暂停播放'), items);

  const extra = [];
  const saved = active?.book?.ttsProgress;
  if (saved?.offset != null) {
    const pct = saved.percent ?? progressAt(saved.offset, active.book.length, active.book.finished);
    const backBtn = button(`回到上次听书位置（${saved.chapterTitle || '断点'} · ${pct}%）`, () => {
      dialog.close();
      if (active) tts.start(active.book.id, active.book.title, active.text, active.chapters, saved.offset, saved.audioTime || 0);
    }, 'primary');
    backBtn.style.width = '100%';
    backBtn.style.marginTop = '12px';
    extra.push(backBtn);
  }

  const reread = button('从当前阅读页重新开始朗读', () => {
    dialog.close();
    if (active) tts.start(active.book.id, active.book.title, active.text, active.chapters, active.book.position);
  }, 'secondary');
  reread.style.width = '100%';
  reread.style.marginTop = '8px';
  extra.push(reread);

  openDialog('定时与续听', wrap, ...extra);
}

function openTtsSettings() {
  const cfg = tts.settings;

  const engineRow = element('div', null, 'settings-row');
  const engineChoices = element('div', null, 'choices');
  const apiFields = element('div');
  const webFields = element('div');

  const syncEngineVisibility = mode => {
    apiFields.hidden = mode !== 'api';
    webFields.hidden = mode !== 'web';
  };

  for (const [value, label] of [['api', '智能朗读（锁屏连播）'], ['web', '离线原生朗读']]) {
    const item = button(label, () => {
      tts.updateSettings({ engine: value });
      for (const entry of engineChoices.children) entry.setAttribute('aria-pressed', String(entry === item));
      syncEngineVisibility(value);
    });
    item.setAttribute('aria-pressed', String(cfg.engine === value));
    engineChoices.append(item);
  }
  engineRow.append(element('p', '朗读模式'), engineChoices);

  // 番茄风格 2 列音色卡片
  const voiceRow = element('div', null, 'settings-row');
  const voiceGrid = element('div', null, 'voice-grid');
  for (const v of EDGE_VOICES) {
    const card = button(null, () => {
      tts.updateSettings({ voice: v.id, customVoice: '' });
      for (const entry of voiceGrid.children) entry.setAttribute('aria-pressed', String(entry === card));
      toast(`已切换音色：${v.name}`);
    }, 'voice-card');
    card.setAttribute('aria-pressed', String(!cfg.customVoice && cfg.voice === v.id));
    if (v.badge) card.append(element('span', v.badge, 'voice-badge'));
    card.append(element('strong', v.name), element('small', v.desc));
    voiceGrid.append(card);
  }
  voiceRow.append(element('p', '音色设置'), voiceGrid);

  // 语速调节
  const rateRow = element('div', null, 'settings-row');
  const rateLabel = element('label', null, 'setting-label');
  const rateOutput = element('output', `${cfg.rate}x`);
  const rateInput = element('input');
  rateInput.id = 'tts-rate-range';
  rateLabel.htmlFor = rateInput.id;
  rateLabel.append(element('span', '朗读语速'), rateOutput);
  Object.assign(rateInput, { type: 'range', min: 0.75, max: 2.0, step: 0.05, value: cfg.rate });
  rateInput.oninput = () => {
    const value = Number(rateInput.value);
    rateOutput.value = `${value}x`;
    tts.updateSettings({ rate: value });
  };
  rateRow.append(rateLabel, rateInput);

  // 高级自定义接口折叠区（默认同源免配置，保持界面像番茄一样清爽）
  const adv = element('details', null, 'tts-advanced');
  adv.append(element('summary', '高级设置（自定义接口 / 试听测试）'));

  const customVoiceInput = element('input', null, 'tts-url-input');
  customVoiceInput.type = 'text';
  customVoiceInput.placeholder = '可选：自定义音色 ID（留空用上方卡片）';
  customVoiceInput.value = cfg.customVoice || '';
  customVoiceInput.onchange = () => tts.updateSettings({ customVoice: customVoiceInput.value.trim() });

  const urlInput = element('input', null, 'tts-url-input');
  urlInput.type = 'url';
  urlInput.placeholder = '留空默认用本站免费接口 /api/tts';
  urlInput.value = cfg.apiUrl || '';
  urlInput.onchange = () => tts.updateSettings({ apiUrl: urlInput.value.trim() });

  const keyInput = element('input', null, 'tts-url-input');
  keyInput.type = 'password';
  keyInput.placeholder = '可选：访问密钥 API Key';
  keyInput.value = cfg.apiKey || '';
  keyInput.onchange = () => tts.updateSettings({ apiKey: keyInput.value.trim() });

  const testRow = element('div', null, 'tts-test-row');
  const testBtn = button('测试连接并试听', async () => {
    tts.updateSettings({
      apiUrl: urlInput.value.trim(),
      apiKey: keyInput.value.trim(),
      customVoice: customVoiceInput.value.trim(),
    });
    testBtn.disabled = true;
    testBtn.textContent = '试听合成中…';
    try {
      const { blob } = await testTtsEndpoint(tts.settings);
      const previewUrl = URL.createObjectURL(blob);
      const preview = new Audio(previewUrl);
      preview.onended = () => URL.revokeObjectURL(previewUrl);
      await preview.play();
      toast('连接成功，正在播放试听。');
    } catch (err) {
      toast(`连接失败：${err?.message || '请检查网络'}`);
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = '测试连接并试听';
    }
  }, 'primary');
  const startNowBtn = button('立即开始听书', () => {
    tts.updateSettings({
      apiUrl: urlInput.value.trim(),
      apiKey: keyInput.value.trim(),
      customVoice: customVoiceInput.value.trim(),
    });
    dialog.close();
    if (active) tts.start(active.book.id, active.book.title, active.text, active.chapters, active.book.position);
  }, 'secondary');
  testRow.append(testBtn, startNowBtn);

  adv.append(
    element('p', `当前语音接口：${resolveApiEndpoint(cfg.apiUrl)}`, 'tts-hint'),
    urlInput,
    keyInput,
    customVoiceInput,
    testRow,
  );
  apiFields.append(voiceRow, adv);

  // 浏览器原生朗读配置区
  const webRow = element('div', null, 'settings-row');
  const webVoiceSelect = element('select', null, 'encoding-select');
  webVoiceSelect.setAttribute('aria-label', '系统朗读声音');
  const fillWebVoices = () => {
    webVoiceSelect.replaceChildren();
    const autoOpt = element('option', '自动选择中文语音');
    autoOpt.value = '';
    webVoiceSelect.append(autoOpt);
    const voices = (window.speechSynthesis?.getVoices?.() || []).filter(v => /^zh/i.test(v.lang));
    for (const v of voices) {
      const opt = element('option', `${v.name} (${v.lang})`);
      opt.value = v.voiceURI;
      if (v.voiceURI === tts.settings.webVoice) opt.selected = true;
      webVoiceSelect.append(opt);
    }
  };
  fillWebVoices();
  if ('speechSynthesis' in window) window.speechSynthesis.onvoiceschanged = fillWebVoices;
  webVoiceSelect.onchange = () => tts.updateSettings({ webVoice: webVoiceSelect.value });
  webRow.append(
    element('p', '系统语音（无需网络、可离线）'),
    webVoiceSelect,
    element('p', '提示：浏览器原生朗读在 iPhone 锁屏后可能被系统暂停；锁屏连播建议使用「智能朗读」。', 'tts-hint'),
  );
  webFields.append(webRow);

  syncEngineVisibility(cfg.engine);
  openDialog('音色设置', apiFields, webFields, rateRow, engineRow);
}

$('ttsPlay').onclick = () => tts.togglePlay();
$('ttsPrev').onclick = () => tts.stepChunk(-1);
$('ttsNext').onclick = () => tts.stepChunk(1);
$('ttsCollapse').onclick = () => {
  ttsBarCollapsed = true;
  $('ttsBar').hidden = true;
  requestAnimationFrame(() => {
    if (active) jumpTo(active.book.position, { keepFinished: active.book.finished, fromTts: true });
  });
};
$('ttsClose').onclick = () => tts.stop();
$('ttsRate').onclick = () => {
  const idx = RATE_STEPS.indexOf(Number(tts.settings.rate));
  const next = RATE_STEPS[(idx + 1) % RATE_STEPS.length];
  tts.updateSettings({ rate: next });
  toast(`语速已切至 ${next}x`);
};
$('ttsSleep').onclick = openSleepDialog;
$('ttsConfig').onclick = openTtsSettings;
$('closeDialog').onclick = () => dialog.close();
dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (event.clientY < bounds.top || event.clientX < bounds.left || event.clientX > bounds.right) dialog.close();
});
let chapterNavAt = 0;
function stepChapter(direction) {
  const now = Date.now();
  if (now - chapterNavAt < 350) return;
  chapterNavAt = now;
  const index = currentChapterIndex() + direction;
  if (index < 0 || index >= active.chapters.length) return;
  if (direction > 0) completeChapterIfSeenToEnd();
  jumpTo(active.chapters[index].start);
}

$('prevChapter').onclick = () => {
  if (active) stepChapter(-1);
};
$('nextChapterMenu').onclick = () => {
  if (active) stepChapter(1);
};
$('progress').oninput = event => { $('jumpValue').textContent = `${Math.floor(event.target.value / 10)}%`; };
$('progress').onchange = event => {
  const value = Number(event.target.value);
  const { text } = active;
  jumpTo(Math.floor(value / 1000 * (text.length - 1)), { endOfSection: value === 1000 });
};
$('prevSection').onclick = () => {
  if (active.sectionIndex > 0) jumpTo(active.sections[active.sectionIndex - 1].start, { endOfSection: true });
};
$('nextSection').onclick = () => {
  if (active.sectionIndex + 1 < active.sections.length) {
    const next = active.sections[active.sectionIndex + 1];
    if (next.chapter !== currentChapterIndex()) recordChapterProgress(true);
    jumpTo(next.start);
  } else finishBook();
};
viewport.addEventListener('scroll', scrollHandler, { passive: true });
viewport.addEventListener('click', event => {
  if (!active || event.target.closest('button') || performance.now() - lastSwipe < 350 || getSelection()?.toString()) return;
  if (!$('readerMenus').hidden) return setMenu(false);
  const bounds = viewport.getBoundingClientRect();
  const zone = (event.clientX - bounds.left) / bounds.width;
  if (active.book.settings.mode === 'scroll' || (zone >= .25 && zone <= .75)) setMenu(true);
  else turn(zone < .25 ? -1 : 1);
});
viewport.addEventListener('touchstart', event => {
  touch = null;
  if (event.touches.length !== 1 || active?.book.settings.mode !== 'page' || !$('readerMenus').hidden) return;
  const { clientX: x, clientY: y } = event.touches[0];
  if (x > 26 && x < innerWidth - 26) touch = { x, y };
}, { passive: true });
viewport.addEventListener('touchend', event => {
  if (!touch) return;
  const { clientX: x, clientY: y } = event.changedTouches[0];
  const distance = x - touch.x;
  if (Math.abs(distance) > 48 && Math.abs(distance) > Math.abs(y - touch.y) * 1.5 && !getSelection()?.toString()) {
    lastSwipe = performance.now();
    turn(distance < 0 ? 1 : -1);
  }
  touch = null;
}, { passive: true });
viewport.addEventListener('touchcancel', () => { touch = null; }, { passive: true });
document.addEventListener('keydown', event => {
  if (!active || dialog.open || event.altKey || event.metaKey || event.ctrlKey || /INPUT|BUTTON/.test(event.target.tagName)) return;
  if (event.key === 'Escape') {
    if ($('readerMenus').hidden) setMenu(true);
    else setMenu(false);
  }
  if (active.book.settings.mode === 'page' && ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(event.key)) {
    event.preventDefault();
    turn(['ArrowLeft', 'PageUp'].includes(event.key) ? -1 : 1);
  }
});
let measured;
if (globalThis.ResizeObserver) new ResizeObserver(([entry]) => {
  const dimensions = `${entry.contentRect.width}:${entry.contentRect.height}`;
  if (measured === dimensions) return;
  measured = dimensions;
  cancelAnimationFrame(resizeFrame);
  if (active && viewport.clientHeight) resizeFrame = requestAnimationFrame(() => {
    if (active) jumpTo(active.book.position, { keepFinished: active.book.finished });
  });
}).observe(viewport);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (scrollTimer) updateScrollPosition();
    if (tts.active) {
      const chunk = tts.getCurrentChunk();
      if (chunk) persistListeningProgress(chunk, tts.getCurrentAudioTime());
    }
  }
});

// 手机上不需要双指缩放或双击放大，字号由阅读设置控制。
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, event => event.preventDefault(), { passive: false });
}
document.addEventListener('touchmove', event => {
  if (event.touches.length > 1) event.preventDefault();
}, { passive: false });
document.addEventListener('dblclick', event => event.preventDefault(), { passive: false });

try {
  books = await listBooks();
  renderShelf();
} catch {
  $('importBtn').disabled = $('sampleBtn').disabled = true;
  $('bookList').textContent = '本机存储不可用。请使用 Safari 正常浏览模式打开此网页。';
}

const offlineStatus = $('offlineStatus');
offlineStatus.hidden = false;
if ('serviceWorker' in navigator && window.isSecureContext) {
  const workers = navigator.serviceWorker;
  const unavailable = () => {
    if (!workers.controller) offlineStatus.textContent = '离线缓存暂时不可用。可继续在线阅读。';
  };
  offlineStatus.textContent = '正在准备离线阅读…';
  workers.ready.then(() => { offlineStatus.textContent = '✓ 已可离线阅读'; });
  workers.register('./sw.js').then(({ installing }) => {
    if (!installing) return;
    const check = () => { if (installing.state === 'redundant') unavailable(); };
    installing.addEventListener('statechange', check);
    check();
  }).catch(unavailable);
} else {
  offlineStatus.textContent = '请用 HTTPS 网站地址安装并开启离线阅读。';
}
