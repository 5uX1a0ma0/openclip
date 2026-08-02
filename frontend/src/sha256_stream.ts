import { Sha256 } from './sha256';

const defaultReadChunkBytes = 4 * 1024 * 1024;

type IncrementalSha256 = {
  update(data: Uint8Array): unknown;
};

export async function updateSha256FromBlob(
  blob: Blob,
  hasher: IncrementalSha256,
  chunkSize = defaultReadChunkBytes
): Promise<void> {
  if (typeof blob.stream === 'function') {
    const reader = blob.stream().getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          return;
        }
        if (value?.byteLength) {
          hasher.update(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    const chunk = await blob.slice(offset, offset + chunkSize).arrayBuffer();
    hasher.update(new Uint8Array(chunk));
  }
}

export async function sha256BlobFallback(blob: Blob): Promise<Uint8Array> {
  const hasher = new Sha256();
  await updateSha256FromBlob(blob, hasher);
  return hasher.digest();
}
