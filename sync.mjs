// 私人云书库同步 + 一键整库离线备份模块
// 每个用户使用独立高强度同步码，服务端按 SHA-256 哈希严格隔离，朋友之间绝不串书。

const SYNC_KEY_STORAGE = 'yeding-sync-key-v1';
const LAST_SYNC_STORAGE = 'yeding-last-sync-v1';
const DELETED_BOOKS_STORAGE = 'yeding-deleted-books-v1';
const RAW_CHUNK_BYTES = 420 * 1024; // 压缩后每片 420KB（Base64 约 560KB，远低于 D1 1MB 单行上限）

const KEY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateSyncKey() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, b => KEY_ALPHABET[b % KEY_ALPHABET.length]).join('');
  return `YD-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

export function validateSyncKey(raw) {
  const key = String(raw || '').trim();
  if (key.length < 10) return { ok: false, error: '同步码至少需要 10 位字符。' };
  if (/^\d+$/.test(key)) return { ok: false, error: '为避免与朋友撞码，同步码不能为纯数字，请包含字母。' };
  return { ok: true, key };
}

export function loadSyncKey() {
  try {
    return localStorage.getItem(SYNC_KEY_STORAGE) || '';
  } catch {
    return '';
  }
}

export function saveSyncKey(key) {
  try {
    if (key) localStorage.setItem(SYNC_KEY_STORAGE, key.trim());
    else localStorage.removeItem(SYNC_KEY_STORAGE);
  } catch {}
}

export function loadLastSyncTime() {
  try {
    return Number(localStorage.getItem(LAST_SYNC_STORAGE) || 0);
  } catch {
    return 0;
  }
}

function saveLastSyncTime(ts = Date.now()) {
  try { localStorage.setItem(LAST_SYNC_STORAGE, String(ts)); } catch {}
}

function loadDeletedMap() {
  try {
    const raw = localStorage.getItem(DELETED_BOOKS_STORAGE);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function saveDeletedMap(map) {
  try { localStorage.setItem(DELETED_BOOKS_STORAGE, JSON.stringify(map)); } catch {}
}

export function markLocalDeleted(bookId, ts = Date.now()) {
  const map = loadDeletedMap();
  map[bookId] = ts;
  saveDeletedMap(map);
}

export function clearLocalDeleted(bookId) {
  const map = loadDeletedMap();
  if (bookId in map) {
    delete map[bookId];
    saveDeletedMap(map);
  }
}

function bytesToBase64(bytes) {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

async function gzipCompressBytes(bytes) {
  if (typeof CompressionStream !== 'function') {
    return { encoding: 'utf8', bytes };
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  const ab = await new Response(stream).arrayBuffer();
  return { encoding: 'gzip', bytes: new Uint8Array(ab) };
}

async function gzipDecompressBytes(bytes, encoding) {
  if (encoding !== 'gzip') return bytes;
  if (typeof DecompressionStream !== 'function') throw new Error('当前浏览器不支持解压书籍备份');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

export function bookUpdatedAt(book) {
  return Math.max(
    Number(book?.lastRead || 0),
    Number(book?.ttsProgress?.updatedAt || 0),
    bookTextUpdatedAt(book),
    Number(book?.created || 0),
    1,
  );
}

function bookTextUpdatedAt(book) {
  return Number(book?.textUpdatedAt || book?.dl?.updatedAt || book?.created) || 1;
}

function useTextMeta(book, source, length, updatedAt = bookTextUpdatedAt(source)) {
  book.length = length;
  book.textUpdatedAt = updatedAt;
  if (source?.dl) book.dl = source.dl;
  else delete book.dl;
  if (source?.textHash) book.textHash = source.textHash;
  else delete book.textHash;
  if (Number.isFinite(book.position)) book.position = Math.min(book.position, Math.max(0, length - 1));
  return book;
}

export function mergeBookMeta(local, remote) {
  if (!local) return { ...remote };
  if (!remote) return { ...local };
  const localReadTs = Number(local.lastRead || 0);
  const remoteReadTs = Number(remote.lastRead || 0);
  const newerRead = remoteReadTs > localReadTs ? remote : local;

  const localTtsTs = Number(local.ttsProgress?.updatedAt || 0);
  const remoteTtsTs = Number(remote.ttsProgress?.updatedAt || 0);
  const ttsProgress = remoteTtsTs > localTtsTs
    ? (remote.ttsProgress || local.ttsProgress || null)
    : (local.ttsProgress || remote.ttsProgress || null);

  // 合并书签，删除记录随书同步。旧版本书签的修改时间按 0 处理。
  const markDeletes = { ...(remote.markDeletes || {}) };
  for (const [position, ts] of Object.entries(local.markDeletes || {})) {
    markDeletes[position] = Math.max(Number(markDeletes[position]) || 0, Number(ts) || 0);
  }
  const markMap = new Map();
  for (const m of [...(remote.marks || []), ...(local.marks || [])]) {
    if (!m || typeof m.position !== 'number') continue;
    const time = Number(m.updatedAt) || 0;
    if (markDeletes[m.position] && markDeletes[m.position] >= time) continue;
    if (!markMap.has(m.position) || time >= (Number(markMap.get(m.position).updatedAt) || 0)) markMap.set(m.position, m);
  }
  const marks = [...markMap.values()].sort((a, b) => a.position - b.position);

  // 合并分章进度取最大值
  const maxLen = Math.max(local.chapterProgress?.length || 0, remote.chapterProgress?.length || 0);
  const chapterProgress = Array.from({ length: maxLen }, (_, i) => (
    Math.max(local.chapterProgress?.[i] || 0, remote.chapterProgress?.[i] || 0)
  ));

  return {
    ...remote,
    ...local,
    title: newerRead.title || local.title || remote.title,
    length: local.length || remote.length,
    position: newerRead.position ?? local.position ?? 0,
    finished: Boolean(newerRead.finished),
    lastRead: Math.max(localReadTs, remoteReadTs),
    created: Math.min(local.created || Date.now(), remote.created || Date.now()),
    settings: { ...(remote.settings || {}), ...(newerRead.settings || {}) },
    marks,
    ...(Object.keys(markDeletes).length ? { markDeletes } : {}),
    chapterProgress,
    ttsProgress,
  };
}

async function syncFetch(path, key, options = {}) {
  const headers = {
    'X-Sync-Key': key,
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {}),
  };
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.ok !== true) {
    throw new Error(data?.error || `云同步请求失败（HTTP ${res.status}）`);
  }
  return data;
}

export async function checkCloudStatus(key) {
  return syncFetch('/api/sync/status', key, { method: 'GET' });
}

export async function pushBookMeta(book, { deleted = false, keepalive = false, key = loadSyncKey() } = {}) {
  if (!key || !book?.id) return false;
  const updatedAt = deleted ? Date.now() : bookUpdatedAt(book);
  const path = `/api/sync/books/${encodeURIComponent(book.id)}/meta`;
  await syncFetch(path, key, {
    method: 'PUT',
    keepalive,
    body: JSON.stringify({ meta: book, updatedAt, deleted }),
  });
  saveLastSyncTime();
  return true;
}

export async function uploadBookFull(book, text, onChunkProgress, key = loadSyncKey()) {
  if (!key || !book?.id || typeof text !== 'string') return false;
  const rawBytes = new TextEncoder().encode(text);
  const textHash = await sha256Hex(rawBytes);
  const { encoding, bytes } = await gzipCompressBytes(rawBytes);

  const chunkCount = Math.max(1, Math.ceil(bytes.length / RAW_CHUNK_BYTES));
  const idEnc = encodeURIComponent(book.id);
  const uploadId = crypto.randomUUID();

  for (let i = 0; i < chunkCount; i++) {
    const slice = bytes.subarray(i * RAW_CHUNK_BYTES, Math.min(bytes.length, (i + 1) * RAW_CHUNK_BYTES));
    await syncFetch(`/api/sync/books/${idEnc}/chunk/${i}`, key, {
      method: 'PUT',
      body: JSON.stringify({ uploadId, dataB64: bytesToBase64(slice) }),
    });
    onChunkProgress?.(i + 1, chunkCount);
  }

  await syncFetch(`/api/sync/books/${idEnc}/commit`, key, {
    method: 'POST',
    body: JSON.stringify({
      meta: book,
      uploadId,
      textHash,
      encoding,
      chunkCount,
      updatedAt: bookUpdatedAt(book),
      textUpdatedAt: bookTextUpdatedAt(book),
    }),
  });
  saveLastSyncTime();
  return { textHash, chunkCount };
}

export async function downloadBookText(bookId, chunkCount, encoding = 'gzip', { key = loadSyncKey(), revision, textHash } = {}) {
  if (!key || !bookId || !chunkCount) throw new Error('云端缺少书籍正文');
  const idEnc = encodeURIComponent(bookId);
  const parts = [];
  const suffix = revision ? `?revision=${encodeURIComponent(revision)}` : '';
  let totalLen = 0;
  for (let i = 0; i < chunkCount; i++) {
    const data = await syncFetch(`/api/sync/books/${idEnc}/chunk/${i}${suffix}`, key, { method: 'GET', cache: 'no-store' });
    const bytes = base64ToBytes(data.dataB64);
    parts.push(bytes);
    totalLen += bytes.length;
  }
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  const plainBytes = await gzipDecompressBytes(merged, encoding);
  if (textHash && await sha256Hex(plainBytes) !== textHash) throw new Error('云端正文校验失败，请重新同步');
  return new TextDecoder('utf-8').decode(plainBytes);
}

function readRemoteText(remote, key) {
  return downloadBookText(remote.bookId, remote.chunkCount, remote.encoding, {
    key, revision: remote.textRevision, textHash: remote.textHash,
  });
}

export async function recoverBookFromCloud(local) {
  const key = loadSyncKey();
  if (!key || !local?.id) return null;
  const remoteRes = await syncFetch('/api/sync/books', key, { method: 'GET' });
  const remote = (remoteRes.books || []).find(r => r.bookId === local.id && !r.deleted && r.hasText && r.chunkCount > 0);
  if (!remote) return null;
  const text = await readRemoteText(remote, key);
  if (loadSyncKey() !== key) return null;
  const book = useTextMeta(mergeBookMeta(local, remote.meta), { ...remote.meta, textHash: remote.textHash },
    text.length, remote.textUpdatedAt);
  return { book, text };
}

let syncInFlight = null;

export async function syncAllBooks({
  books,
  readText,
  listTextIds,
  putBook,
  saveBook,
  deleteLocalBook,
  onStatus,
}) {
  const key = loadSyncKey();
  if (!key) return { skipped: true };
  if (syncInFlight) return syncInFlight;
  const ensureActiveKey = () => {
    if (loadSyncKey() !== key) throw new Error('同步码已变更，请重新同步');
  };

  syncInFlight = (async () => {
    const summary = { downloaded: 0, uploaded: 0, merged: 0, deleted: 0 };
    onStatus?.('正在连接私人云书库…');
    const [remoteRes, localTextIds] = await Promise.all([
      syncFetch('/api/sync/books', key, { method: 'GET' }),
      typeof listTextIds === 'function' ? listTextIds().catch(() => null) : Promise.resolve(null),
    ]);
    const remoteList = Array.isArray(remoteRes.books) ? remoteRes.books : [];
    const remoteMap = new Map(remoteList.map(r => [r.bookId, r]));
    const localMap = new Map(books.map(b => [b.id, b]));
    const deletedMap = loadDeletedMap();

    // 1) 处理云端书籍：拉取本机缺失的书/缺失正文、同步增量更新的正文、合并进度、执行删除
    for (const remote of remoteList) {
      ensureActiveKey();
      const local = localMap.get(remote.bookId);
      const localDelTs = Number(deletedMap[remote.bookId] || 0);

      if (remote.deleted) {
        if (local && remote.updatedAt >= bookUpdatedAt(local)) {
          await deleteLocalBook(local.id);
          localMap.delete(local.id);
          summary.deleted++;
        }
        continue;
      }

      if (localDelTs && localDelTs > remote.updatedAt && !local) {
        // 本机较新地删除了该书 -> 同步删除云端
        await pushBookMeta({ id: remote.bookId }, { deleted: true, key });
        summary.deleted++;
        continue;
      }

      if (!local) {
        if (!remote.hasText || !remote.chunkCount || !remote.meta) continue;
        onStatus?.(`正在恢复《${remote.meta.title || '书籍'}》…`);
        const text = await readRemoteText(remote, key);
        ensureActiveKey();
        const restored = useTextMeta({ ...remote.meta, id: remote.bookId },
          { ...remote.meta, textHash: remote.textHash }, text.length, remote.textUpdatedAt);
        await putBook(restored, text);
        localMap.set(restored.id, restored);
        clearLocalDeleted(restored.id);
        summary.downloaded++;
      } else {
        const merged = mergeBookMeta(local, remote.meta);
        const localTextAt = bookTextUpdatedAt(local);
        const remoteTextAt = Number(remote.textUpdatedAt) || bookTextUpdatedAt(remote.meta);
        const remoteHasText = remote.hasText && remote.chunkCount > 0;
        let text = localTextIds ? undefined : await readText(local.id);
        const localHasText = localTextIds ? localTextIds.has(local.id) : typeof text === 'string' && text.length > 0;
        let localHash = local.textHash;
        if (remoteHasText && localHasText && localTextAt === remoteTextAt && remote.textHash && !localHash) {
          text ??= await readText(local.id);
          if (typeof text === 'string') localHash = await sha256Hex(new TextEncoder().encode(text));
        }
        const differentAtSameTime = localTextAt === remoteTextAt && localHash && remote.textHash && localHash !== remote.textHash;
        if (remoteHasText && (!localHasText || remoteTextAt > localTextAt || differentAtSameTime)) {
          onStatus?.(`正在补全《${merged.title}》正文…`);
          const downloaded = await readRemoteText(remote, key);
          ensureActiveKey();
          useTextMeta(merged, { ...remote.meta, textHash: remote.textHash }, downloaded.length, remoteTextAt);
          await putBook(merged, downloaded);
          localMap.set(merged.id, merged);
          summary.downloaded++;
          continue;
        }

        useTextMeta(merged, { ...local, textHash: localHash }, local.length, localTextAt);
        const uploadText = localHasText && (!remoteHasText || localTextAt > remoteTextAt);
        if (uploadText) {
          text ??= await readText(local.id);
          if (typeof text === 'string' && text.length) {
            ensureActiveKey();
            onStatus?.(`正在备份《${merged.title}》…`);
            merged.length = text.length;
            const uploaded = await uploadBookFull(merged, text, null, key);
            merged.textHash = uploaded.textHash;
            summary.uploaded++;
          }
        } else if (remoteHasText && JSON.stringify(merged) !== JSON.stringify(remote.meta)) {
          ensureActiveKey();
          await pushBookMeta(merged, { key });
          summary.merged++;
        }
        if (JSON.stringify(merged) !== JSON.stringify(local)) {
          ensureActiveKey();
          await saveBook(merged);
          localMap.set(merged.id, merged);
          summary.merged++;
        }

      }
    }

    // 2) 上传云端尚未保存的本机书籍
    for (const local of localMap.values()) {
      const remote = remoteMap.get(local.id);
      if (remote && !remote.deleted) continue;
      if (remote && remote.deleted && remote.updatedAt >= bookUpdatedAt(local)) continue;
      const text = await readText(local.id);
      if (typeof text !== 'string' || !text.length) continue;
      ensureActiveKey();
      onStatus?.(`正在备份《${local.title}》…`);
      await uploadBookFull(local, text, null, key);
      summary.uploaded++;
    }

    saveLastSyncTime();
    return summary;
  })();

  try {
    return await syncInFlight;
  } finally {
    syncInFlight = null;
  }
}

// 节流同步书籍元数据（阅读进度 / 听书断点 / 书签 / 设置）
const pendingMeta = new Map();
let metaTimer = null;

export function scheduleMetaSync(book) {
  const key = loadSyncKey();
  if (!key || !book?.id) return;
  pendingMeta.set(book.id, { key, book: structuredClone(book) });
  clearTimeout(metaTimer);
  metaTimer = setTimeout(() => { flushMetaSync(false); }, 10000);
}

export function flushMetaSync(keepalive = false) {
  clearTimeout(metaTimer);
  metaTimer = null;
  const key = loadSyncKey();
  if (!pendingMeta.size) return;
  const items = [...pendingMeta.values()];
  pendingMeta.clear();
  for (const item of items) {
    if (item.key === key) pushBookMeta(item.book, { keepalive, key }).catch(() => {});
  }
}

// 一键导出本机整库离线备份文件（可存入 iPhone 文件 / iCloud 云盘）
export async function exportLibraryBackup(books, readText) {
  const payload = {
    format: 'yeding-backup-v1',
    exportedAt: Date.now(),
    books: [],
  };
  for (const book of books) {
    const text = await readText(book.id);
    if (typeof text !== 'string') continue;
    payload.books.push({ meta: book, text });
  }
  const rawBytes = new TextEncoder().encode(JSON.stringify(payload));
  const { encoding, bytes } = await gzipCompressBytes(rawBytes);
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const ext = encoding === 'gzip' ? 'yeding.gz' : 'yeding.json';
  const mime = encoding === 'gzip' ? 'application/gzip' : 'application/json';
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `小说阅读与听书-整库备份-${dateStr}.${ext}`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return payload.books.length;
}

export async function importLibraryBackup(file, existingBooks, putBook, readText) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  const plainBytes = await gzipDecompressBytes(buf, isGzip ? 'gzip' : 'utf8');
  const parsed = JSON.parse(new TextDecoder('utf-8').decode(plainBytes));
  if (parsed?.format !== 'yeding-backup-v1' || !Array.isArray(parsed.books)) {
    throw new Error('不是有效的整库备份文件');
  }
  const localMap = new Map(existingBooks.map(b => [b.id, b]));
  let restoredCount = 0;
  for (const item of parsed.books) {
    if (!item?.meta?.id || typeof item.text !== 'string') continue;
    const local = localMap.get(item.meta.id);
    const merged = mergeBookMeta(local, item.meta);
    const localText = local && typeof readText === 'function' && bookTextUpdatedAt(local) >= bookTextUpdatedAt(item.meta)
      ? await readText(local.id) : null;
    const keepLocal = typeof localText === 'string' && localText.length > 0;
    const text = keepLocal ? localText : item.text;
    useTextMeta(merged, keepLocal ? local : item.meta, text.length);
    await putBook(merged, text);
    localMap.set(merged.id, merged);
    clearLocalDeleted(merged.id);
    restoredCount++;
  }
  return restoredCount;
}
