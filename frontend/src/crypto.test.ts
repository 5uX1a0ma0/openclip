import { describe, expect, it } from 'vitest';
import { encryptedCacheKey } from './blob_cache';
import { bytesToBase64Url, decryptBytes, decryptChunkBytes, encryptBytes, encryptChunkBytes, generateVaultKey, importVaultKey } from './crypto';

const encoder = new TextEncoder();

describe('crypto envelopes', () => {
  it('keeps legacy AES-GCM envelopes readable', async () => {
    const key = await importVaultKey(generateVaultKey());
    const plain = encoder.encode('legacy payload');
    const encrypted = await encryptBytes(key, plain);

    await expect(decryptBytes(key, encrypted)).resolves.toEqual(plain);
  });

  it('round-trips chunked AES-GCM envelopes with AAD', async () => {
    const key = await importVaultKey(generateVaultKey());
    const first = encoder.encode('chunk one');
    const second = encoder.encode('chunk two');
    const aad = (index: number, size: number) => encoder.encode(`aes-gcm-chunked-v1\nset-1\n${index}\n${size}`);

    const encryptedFirst = await encryptChunkBytes(key, first, aad(0, first.byteLength));
    const encryptedSecond = await encryptChunkBytes(key, second, aad(1, second.byteLength));

    await expect(decryptChunkBytes(key, encryptedFirst, aad(0, first.byteLength))).resolves.toEqual(first);
    await expect(decryptChunkBytes(key, encryptedSecond, aad(1, second.byteLength))).resolves.toEqual(second);
  });

  it('rejects chunked envelopes when AAD changes', async () => {
    const key = await importVaultKey(generateVaultKey());
    const plain = encoder.encode('protected chunk');
    const encrypted = await encryptChunkBytes(key, plain, encoder.encode('aad:0'));

    await expect(decryptChunkBytes(key, encrypted, encoder.encode('aad:1'))).rejects.toThrow();
  });
});

describe('encrypted cache keys', () => {
  it('are stable and include group, hash, size, and chunk size', () => {
    const hash = bytesToBase64Url(encoder.encode('hash-value-32-byte-ish'));

    expect(encryptedCacheKey('group-a', hash, 1024, 256)).toBe(encryptedCacheKey('group-a', hash, 1024, 256));
    expect(encryptedCacheKey('group-a', hash, 1024, 256)).not.toBe(encryptedCacheKey('group-a', hash, 2048, 256));
  });
});
