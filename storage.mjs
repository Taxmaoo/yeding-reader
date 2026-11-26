const NAME = 'yeding-library';
let connection;

function database() {
  if (!connection) connection = new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('books', { keyPath: 'id' });
      request.result.createObjectStore('texts');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('storage-blocked'));
  });
  return connection;
}

async function transaction(stores, mode, work) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const result = work(tx);
    tx.oncomplete = () => resolve(result?.result);
    tx.onabort = () => reject(tx.error || new Error('storage-aborted'));
  });
}

export const listBooks = () => transaction('books', 'readonly', tx => tx.objectStore('books').getAll());
export const readText = id => transaction('texts', 'readonly', tx => tx.objectStore('texts').get(id));
export const saveBook = book => transaction('books', 'readwrite', tx => tx.objectStore('books').put(book));
export const addBook = (book, text) => transaction(['books', 'texts'], 'readwrite', tx => {
  tx.objectStore('books').add(book);
  tx.objectStore('texts').add(text, book.id);
});
export const deleteBook = id => transaction(['books', 'texts'], 'readwrite', tx => {
  tx.objectStore('books').delete(id);
  tx.objectStore('texts').delete(id);
});
