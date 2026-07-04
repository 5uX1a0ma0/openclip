export type CachedEncryptedChunk = {
  index: number;
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
  chunks: CachedEncryptedChunk[];
  updatedAt: number;
};

const databaseName = 'openlist-clipboard-cache-v1';
const databaseVersion = 1;
const encryptedStoreName = 'encryptedChunks';
const maxCachedEncryptedClips = 8;
const encryptedCacheTTL = 7 * 24 * 60 * 60 * 1000;

export function encryptedCacheKey(groupId: string, contentHash: string, size: number, chunkSize: number): string {
  return `${groupId}:${contentHash}:${size}:${chunkSize}`;
}

export async function readEncryptedClipCache(key: string): Promise<CachedEncryptedClip | null> {
  try {
    const db = await openCacheDatabase();
    return await requestToPromise<CachedEncryptedClip | undefined>(
      db.transaction(encryptedStoreName, 'readonly').objectStore(encryptedStoreName).get(key)
    ).then((value) => value || null);
  } catch {
    return null;
  }
}

export async function writeEncryptedClipCache(entry: CachedEncryptedClip): Promise<void> {
  try {
    const db = await openCacheDatabase();
    await requestToPromise(
      db.transaction(encryptedStoreName, 'readwrite').objectStore(encryptedStoreName).put({
        ...entry,
        updatedAt: Date.now()
      })
    );
    await pruneEncryptedClipCache(db);
  } catch {
    // Cache failures must never block clipboard writes.
  }
}

async function pruneEncryptedClipCache(db: IDBDatabase): Promise<void> {
  const entries = await requestToPromise<CachedEncryptedClip[]>(
    db.transaction(encryptedStoreName, 'readonly').objectStore(encryptedStoreName).getAll()
  );
  const now = Date.now();
  const expired = entries.filter((entry) => now - entry.updatedAt > encryptedCacheTTL).map((entry) => entry.key);
  const retained = entries
    .filter((entry) => !expired.includes(entry.key))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const overflow = retained.slice(maxCachedEncryptedClips).map((entry) => entry.key);
  const keys = [...expired, ...overflow];
  if (keys.length === 0) {
    return;
  }
  const store = db.transaction(encryptedStoreName, 'readwrite').objectStore(encryptedStoreName);
  await Promise.all(keys.map((key) => requestToPromise(store.delete(key))));
}

function openCacheDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable'));
      return;
    }
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(encryptedStoreName)) {
        db.createObjectStore(encryptedStoreName, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
  });
}

function requestToPromise<T = unknown>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}
