import { createSHA256 } from 'hash-wasm';
import { describe, expect, it } from 'vitest';
import { sha256BlobFallback, updateSha256FromBlob } from './sha256_stream';

describe('streamed SHA-256', () => {
  it.each([0, 1, 63, 64, 65, 4096, 65_537])('matches Web Crypto for a %d-byte blob', async (size) => {
    const bytes = patternedBytes(size);
    const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

    await expect(sha256BlobFallback(new Blob([bytes]))).resolves.toEqual(expected);
  });

  it('feeds a blob incrementally into hash-wasm', async () => {
    const bytes = patternedBytes(3 * 1024 * 1024 + 17);
    const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const hasher = await createSHA256();

    await updateSha256FromBlob(new Blob([bytes]), hasher.init());

    expect(hasher.digest('binary')).toEqual(expected);
  });
});

function patternedBytes(size: number) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = (i * 131 + 17) & 0xff;
  }
  return bytes;
}
