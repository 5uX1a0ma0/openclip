export type CachedEncryptedChunk = {
  index: number;
  chunkSetId: string;
  plainSize: number;
  encryptedSize: number;
  encrypted: Uint8Array;
};

export type CachedEncryptedClip = {
  key: string;
  groupId: string;
  contentHash: string;
  size: number;
  chunkSize: number;
  chunkSetId: string;
  chunkCount: number;
  updatedAt: number;
};

type StoredEncryptedChunk = CachedEncryptedChunk & {
  cacheKey: string;
};

const databaseName = 'openlist-clipboard-cache-v1';
const databaseVersion = 2;
const legacyEncryptedStoreName = 'encryptedChunks';
const encryptedClipStoreName = 'encryptedClips';
const encryptedChunkStoreName = 'encryptedClipChunks';
const encryptedChunkCacheKeyIndex = 'cacheKey';
const encryptedClipUpdatedAtIndex = 'updatedAt';
const maxCachedEncryptedClips = 8;
const encryptedCacheTTL = 7 * 24 * 60 * 60 * 1000;
let databasePromise: Promise<IDBDatabase> | null = null;
let cacheDisabled = false;

export function encryptedCacheKey(groupId: string, contentHash: string, size: number, chunkSize: number): string {
  return `${groupId}:${contentHash}:${size}:${chunkSize}`;
}

export async function readEncryptedClipCache(key: string): Promise<CachedEncryptedClip | null> {
  try {
    const db = await openCacheDatabase();
    const entry = await requestToPromise<CachedEncryptedClip | undefined>(
      db.transaction(encryptedClipStoreName, 'readonly').objectStore(encryptedClipStoreName).get(key)
    );
    if (!entry) {
      return null;
    }
    void touchEncryptedClipCache(db, entry);
    return entry;
  } catch {
    return null;
  }
}

export async function readEncryptedClipCacheChunk(key: string, index: number): Promise<CachedEncryptedChunk | null> {
  try {
    const db = await openCacheDatabase();
    const chunk = await requestToPromise<StoredEncryptedChunk | undefined>(
      db.transaction(encryptedChunkStoreName, 'readonly').objectStore(encryptedChunkStoreName).get([key, index])
    );
    return chunk ? toCachedChunk(chunk) : null;
  } catch {
    return null;
  }
}

export async function createEncryptedClipCache(entry: Omit<CachedEncryptedClip, 'updatedAt'>): Promise<void> {
  try {
    const db = await openCacheDatabase();
    await requestToPromise(
      db.transaction(encryptedClipStoreName, 'readwrite').objectStore(encryptedClipStoreName).put({
        ...entry,
        updatedAt: Date.now()
      })
    );
    await pruneEncryptedClipCache(db);
  } catch {
    // Cache failures must never block clipboard writes.
  }
}

export async function writeEncryptedClipCacheChunk(key: string, chunk: CachedEncryptedChunk): Promise<void> {
  try {
    const db = await openCacheDatabase();
    await putEncryptedClipCacheChunk(db, key, chunk);
  } catch {
    // Cache failures must never block clipboard writes.
  }
}

export async function deleteEncryptedClipCache(key: string): Promise<void> {
  try {
    const db = await openCacheDatabase();
    await deleteEncryptedClipCacheEntry(db, key);
  } catch {
    // Cache failures must never block clipboard writes.
  }
}

async function touchEncryptedClipCache(db: IDBDatabase, entry: CachedEncryptedClip): Promise<void> {
  try {
    await requestToPromise(
      db.transaction(encryptedClipStoreName, 'readwrite').objectStore(encryptedClipStoreName).put({
        ...entry,
        updatedAt: Date.now()
      })
    );
  } catch {
    // The cached value is still usable when its timestamp cannot be updated.
  }
}

async function putEncryptedClipCacheChunk(db: IDBDatabase, key: string, chunk: CachedEncryptedChunk): Promise<void> {
  const transaction = db.transaction([encryptedClipStoreName, encryptedChunkStoreName], 'readwrite');
  const clipStore = transaction.objectStore(encryptedClipStoreName);
  const chunkStore = transaction.objectStore(encryptedChunkStoreName);
  const entryRequest = clipStore.get(key);
  entryRequest.onsuccess = () => {
    const entry = entryRequest.result as CachedEncryptedClip | undefined;
    if (!entry) {
      transaction.abort();
      return;
    }
    chunkStore.put({ ...chunk, cacheKey: key });
    clipStore.put({ ...entry, updatedAt: Date.now() });
  };
  entryRequest.onerror = () => transaction.abort();
  await transactionToPromise(transaction);
}

async function pruneEncryptedClipCache(db: IDBDatabase): Promise<void> {
  const entries = await requestToPromise<CachedEncryptedClip[]>(
    db.transaction(encryptedClipStoreName, 'readonly').objectStore(encryptedClipStoreName).getAll()
  );
  const now = Date.now();
  const expired = entries.filter((entry) => now - entry.updatedAt > encryptedCacheTTL).map((entry) => entry.key);
  const retained = entries
    .filter((entry) => !expired.includes(entry.key))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const overflow = retained.slice(maxCachedEncryptedClips).map((entry) => entry.key);
  for (const key of [...expired, ...overflow]) {
    await deleteEncryptedClipCacheEntry(db, key);
  }
}

async function deleteEncryptedClipCacheEntry(db: IDBDatabase, key: string): Promise<void> {
  const transaction = db.transaction([encryptedClipStoreName, encryptedChunkStoreName], 'readwrite');
  const chunkStore = transaction.objectStore(encryptedChunkStoreName);
  transaction.objectStore(encryptedClipStoreName).delete(key);
  const request = chunkStore.index(encryptedChunkCacheKeyIndex).openKeyCursor(IDBKeyRange.only(key));
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) {
      return;
    }
    chunkStore.delete(cursor.primaryKey);
    cursor.continue();
  };
  request.onerror = () => transaction.abort();
  await transactionToPromise(transaction);
}

function openCacheDatabase(): Promise<IDBDatabase> {
  if (cacheDisabled) {
    return Promise.reject(new Error('IndexedDB cache is disabled'));
  }
  if (databasePromise) {
    return databasePromise;
  }
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is unavailable'));
  }
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    let blocked = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(legacyEncryptedStoreName)) {
        db.deleteObjectStore(legacyEncryptedStoreName);
      }
      if (!db.objectStoreNames.contains(encryptedClipStoreName)) {
        const store = db.createObjectStore(encryptedClipStoreName, { keyPath: 'key' });
        store.createIndex(encryptedClipUpdatedAtIndex, 'updatedAt');
      }
      if (!db.objectStoreNames.contains(encryptedChunkStoreName)) {
        const store = db.createObjectStore(encryptedChunkStoreName, { keyPath: ['cacheKey', 'index'] });
        store.createIndex(encryptedChunkCacheKeyIndex, 'cacheKey');
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) {
        db.close();
        return;
      }
      db.onversionchange = () => {
        db.close();
        databasePromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error || new Error('IndexedDB open failed'));
    };
    request.onblocked = () => {
      blocked = true;
      cacheDisabled = true;
      databasePromise = null;
      reject(new Error('IndexedDB upgrade is blocked by another tab'));
    };
  });
  return databasePromise;
}

function toCachedChunk(chunk: StoredEncryptedChunk): CachedEncryptedChunk {
  return {
    index: chunk.index,
    chunkSetId: chunk.chunkSetId,
    plainSize: chunk.plainSize,
    encryptedSize: chunk.encryptedSize,
    encrypted: chunk.encrypted
  };
}

function requestToPromise<T = unknown>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
  });
}
