import { DEFAULT_SETTINGS, SAMPLE, decodeTxt, indexText, sectionAt, progressAt, isLowSurrogate } from './reader-core.mjs';
import { listBooks, readText, saveBook, addBook, deleteBook } from './storage.mjs';

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

function renderShelf() {
  books.sort((a, b) => (b.lastRead || b.created) - (a.lastRead || a.created));
  $('bookList').replaceChildren(...books.map((book, i) => {
    const row = element('div', null, 'book-row');
    const open = button(null, () => openBook(book), 'book-open');
    const cover = element('span', Array.from(book.title)[0], 'book-cover');
    cover.dataset.tone = i % 4;
    cover.setAttribute('aria-hidden', 'true');
    const info = element('span', null, 'book-details');
    const percent = progressAt(book.position, book.length, book.finished);
    info.append(element('strong', book.title), element('small', book.finished ? '已读完' : `读到 ${percent}%`));
    open.append(cover, info);
    const actions = button('⋯', () => bookActions(book), 'icon-button');
    actions.setAttribute('aria-label', `${book.title}的管理选项`);
    row.append(open, actions);
    return row;
  }));
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
  openDialog(book.title, button('导出 TXT', () => exportTxt(book), 'dialog-item'), button('从书架删除', () => {
    openDialog('删除这本书？', element('p', `《${book.title}》及其阅读进度和书签将从这台设备移除。`), button('确认删除', async event => {
      event.currentTarget.disabled = true;
      try {
        await deleteBook(book.id);
        books = books.filter(item => item.id !== book.id);
        renderShelf();
        dialog.close();
      } catch {
        dialog.close();
        toast('删除失败。');
      }
    }, 'primary'));
  }, 'dialog-item'));
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

function jumpTo(offset, { keepFinished = false, endOfSection = false } = {}) {
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
$('tocBtn').onclick = toc;
$('bookmarksBtn').onclick = bookmarks;
$('markBtn').onclick = addMark;
$('settingsBtn').onclick = settings;
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
  if (document.hidden && scrollTimer) updateScrollPosition();
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
