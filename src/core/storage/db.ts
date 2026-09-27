// X-Ray's own storage lives in the browser's IndexedDB for this origin.
// Nothing is ever written into the analysed project folder.

const DB_NAME = 'xray-app';
const DB_VERSION = 1;

export const STORE_WORKSPACES = 'workspaces';
export const STORE_ANALYSES = 'analyses';
export const STORE_SETTINGS = 'settings';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_WORKSPACES)) db.createObjectStore(STORE_WORKSPACES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_ANALYSES)) db.createObjectStore(STORE_ANALYSES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open X-Ray storage'));
  });
  return dbPromise;
}

async function withStore<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = fn(tx.objectStore(store));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`Storage error in ${store}`));
  });
}

export function idbPut<T>(store: string, value: T): Promise<IDBValidKey> {
  return withStore(store, 'readwrite', (s) => s.put(value) as IDBRequest<IDBValidKey>);
}

export function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  return withStore<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
}

export function idbGetAll<T>(store: string): Promise<T[]> {
  return withStore<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
}

export function idbDelete(store: string, key: IDBValidKey): Promise<undefined> {
  return withStore<undefined>(store, 'readwrite', (s) => s.delete(key) as IDBRequest<undefined>);
}

export function storageAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}
