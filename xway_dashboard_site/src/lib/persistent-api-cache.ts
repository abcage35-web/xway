const DB_NAME = "xway-dashboard-api-cache";
const DB_VERSION = 1;
const STORE_NAME = "responses";

interface PersistentApiCacheRecord<T = unknown> {
  key: string;
  value: T;
  updatedAt: number;
}

let openDbPromise: Promise<IDBDatabase | null> | null = null;

function canUseIndexedDb() {
  return typeof globalThis !== "undefined" && "indexedDB" in globalThis && Boolean(globalThis.indexedDB);
}

function openPersistentCacheDb() {
  if (!canUseIndexedDb()) {
    return Promise.resolve(null);
  }
  if (openDbPromise) {
    return openDbPromise;
  }

  openDbPromise = new Promise<IDBDatabase | null>((resolve) => {
    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      openDbPromise = null;
      resolve(null);
    };

    request.onblocked = () => {
      openDbPromise = null;
      resolve(null);
    };
  });

  return openDbPromise;
}

export async function readPersistentApiCache<T>(key: string): Promise<T | null> {
  const db = await openPersistentCacheDb();
  if (!db) {
    return null;
  }

  return new Promise<T | null>((resolve) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(key);

    request.onsuccess = () => {
      const record = request.result as PersistentApiCacheRecord<T> | undefined;
      resolve(record ? record.value : null);
    };
    request.onerror = () => resolve(null);
    transaction.onerror = () => resolve(null);
  });
}

export async function writePersistentApiCache<T>(key: string, value: T): Promise<void> {
  const db = await openPersistentCacheDb();
  if (!db) {
    return;
  }

  await new Promise<void>((resolve) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({
      key,
      value,
      updatedAt: Date.now(),
    } satisfies PersistentApiCacheRecord<T>);

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
}

export async function deletePersistentApiCache(key: string): Promise<void> {
  const db = await openPersistentCacheDb();
  if (!db) {
    return;
  }

  await new Promise<void>((resolve) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(key);

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
}

export async function deletePersistentApiCacheWhere(shouldDelete: (key: string) => boolean): Promise<void> {
  const db = await openPersistentCacheDb();
  if (!db) {
    return;
  }

  await new Promise<void>((resolve) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const request = transaction.objectStore(STORE_NAME).openCursor();

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        return;
      }
      const record = cursor.value as PersistentApiCacheRecord;
      if (shouldDelete(record.key)) {
        cursor.delete();
      }
      cursor.continue();
    };

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
}
