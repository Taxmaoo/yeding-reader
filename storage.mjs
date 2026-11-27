const NAME = 'yeding-library';
const META_MIRROR_KEY = 'yeding-meta-mirror-v1';
let connection;

function database() {
  if (!connection) connection = new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('texts')) db.createObjectStore('texts');
    };
    request.onsuccess = () => {
      const db = request.result;
      // iOS 后台挂起或版本变更导致连接关闭时自动重置句柄，避免后续读写卡死
      db.onversionchange = () => {
        try { db.close(); } catch {}
        connection = null;
      };
      db.onclose = () => { connection = null; };
      resolve(db);
    };
    request.onerror = () => {
      connection = null;
      reject(request.error);
    };
    request.onblocked = () => {
      connection = null;
      reject(new Error('storage-blocked'));
    };
  });
  return connection;
}

async function transaction(stores, mode, work) {
  let db = await database();
  const runOnce = target => new Promise((resolve, reject) => {
    const tx = target.transaction(stores, mode);
    const result = work(tx);
    tx.oncomplete = () => resolve(result?.result);
    tx.onabort = () => reject(tx.error || new Error('storage-aborted'));
  });
  try {
    return await runOnce(db);
  } catch (err) {
    // 连接失效时重建一次重试
    connection = null;
    db = await database();
    return runOnce(db);
  }
}

export function saveMetaMirror(books) {
  try {
    const lite = (books || []).map(b => ({
      id: b.id,
      title: b.title,
      length: b.length,
      position: b.position,
      finished: Boolean(b.finished),
      lastRead: b.lastRead || 0,
      ttsProgress: b.ttsProgress || null,
      marksCount: b.marks?.length || 0,
    }));
    localStorage.setItem(META_MIRROR_KEY, JSON.stringify({ updatedAt: Date.now(), books: lite }));
  } catch {}
}

export function loadMetaMirror() {
  try {
    const raw = localStorage.getItem(META_MIRROR_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.books) ? parsed : null;
  } catch {
    return null;
  }
}

export async function requestPersistentStorage() {
  try {
    if (!navigator.storage) return { supported: false, persisted: false };
    let persisted = false;
    if (typeof navigator.storage.persisted === 'function') {
      persisted = await navigator.storage.persisted();
    }
    if (!persisted && typeof navigator.storage.persist === 'function') {
      persisted = await navigator.storage.persist();
    }
    let usage = 0;
    let quota = 0;
    if (typeof navigator.storage.estimate === 'function') {
      const est = await navigator.storage.estimate();
      usage = Number(est?.usage || 0);
      quota = Number(est?.quota || 0);
    }
    return { supported: true, persisted: Boolean(persisted), usage, quota };
  } catch {
    return { supported: false, persisted: false };
  }
}

export const listBooks = () => transaction('books', 'readonly', tx => tx.objectStore('books').getAll());
export const listTextIds = async () => {
  const keys = await transaction('texts', 'readonly', tx => tx.objectStore('texts').getAllKeys());
  return new Set(keys || []);
};
export const readText = id => transaction('texts', 'readonly', tx => tx.objectStore('texts').get(id));
export const saveBook = book => transaction('books', 'readwrite', tx => tx.objectStore('books').put(book));
export const addBook = (book, text) => transaction(['books', 'texts'], 'readwrite', tx => {
  tx.objectStore('books').put(book);
  tx.objectStore('texts').put(text, book.id);
});
export const putBook = addBook;
export const deleteBook = id => transaction(['books', 'texts'], 'readwrite', tx => {
  tx.objectStore('books').delete(id);
  tx.objectStore('texts').delete(id);
});
