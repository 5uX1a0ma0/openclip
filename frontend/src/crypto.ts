import type { ClipIndex } from './types';

const magic = new Uint8Array([0x4f, 0x4c, 0x43, 0x31]);
const groupIdDomain = 'openlist-clipboard-group-v1';
const keyHashDomain = 'openlist-clipboard-key-check-v1';
const signingKeyDomain = 'openlist-clipboard-signing-v1';

type P256Point = { x: bigint; y: bigint } | null;

const p256P = BigInt('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff');
const p256N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
const p256G: Exclude<P256Point, null> = {
  x: BigInt('0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'),
  y: BigInt('0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5')
};

export type SigningIdentity = {
  publicKeyJwk: JsonWebKey;
  signingKey: CryptoKey;
};

export function emptyIndex(): ClipIndex {
  return {
    version: 1,
    updatedAt: Date.now(),
    clips: [],
    deleted: []
  };
}

export function webCryptoUnavailableReason(): string | null {
  if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== 'function') {
    return 'Web Crypto is not available in this browser.';
  }
  if (!globalThis.crypto.subtle) {
    return 'Web Crypto requires HTTPS or localhost. Open this app with https:// or http://localhost, not http://server-ip.';
  }
  return null;
}

export function generateVaultKey(): string {
  const crypto = requireWebCrypto();
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  return bytesToBase64Url(raw);
}

export async function importVaultKey(encoded: string): Promise<CryptoKey> {
  const raw = vaultKeyBytes(encoded);
  if (raw.byteLength !== 32) {
    throw new Error('vault key must be 32 bytes');
  }
  return requireSubtleCrypto().importKey('raw', bytesToArrayBuffer(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export function vaultKeyBytes(encoded: string): Uint8Array {
  return base64UrlToBytes(encoded.trim());
}

export async function deriveGroupId(vaultKey: string): Promise<string> {
  const domain = new TextEncoder().encode(groupIdDomain);
  const rawKey = vaultKeyBytes(vaultKey);
  const input = new Uint8Array(domain.byteLength + rawKey.byteLength);
  input.set(domain, 0);
  input.set(rawKey, domain.byteLength);
  return bytesToBase64Url(new Uint8Array(await requireSubtleCrypto().digest('SHA-256', bytesToArrayBuffer(input))));
}

export async function deriveKeyHash(vaultKey: string): Promise<string> {
  const input = domainSeparatedBytes(keyHashDomain, vaultKeyBytes(vaultKey));
  return bytesToBase64Url(new Uint8Array(await requireSubtleCrypto().digest('SHA-256', bytesToArrayBuffer(input))));
}

export async function deriveSigningIdentity(vaultKey: string): Promise<SigningIdentity> {
  const seed = new Uint8Array(
    await requireSubtleCrypto().digest('SHA-256', bytesToArrayBuffer(domainSeparatedBytes(signingKeyDomain, vaultKeyBytes(vaultKey))))
  );
  const scalar = (bytesToBigInt(seed) % (p256N - 1n)) + 1n;
  const publicPoint = scalarBaseMult(scalar);
  if (!publicPoint) {
    throw new Error('无法从剪贴板密钥派生签名身份');
  }

  const d = bytesToBase64Url(bigIntToBytes(scalar));
  const x = bytesToBase64Url(bigIntToBytes(publicPoint.x));
  const y = bytesToBase64Url(bigIntToBytes(publicPoint.y));
  const publicKeyJwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x,
    y,
    ext: true,
    key_ops: ['verify']
  };
  const signingJwk: JsonWebKey = {
    ...publicKeyJwk,
    d,
    key_ops: ['sign']
  };
  const signingKey = await requireSubtleCrypto().importKey(
    'jwk',
    signingJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  return { publicKeyJwk, signingKey };
}

export async function encryptBytes(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const crypto = requireWebCrypto();
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  let encrypted: Uint8Array;
  try {
    encrypted = new Uint8Array(
      await requireSubtleCrypto().encrypt(
        { name: 'AES-GCM', iv: bytesToArrayBuffer(nonce) },
        key,
        bytesToArrayBuffer(plaintext)
      )
    );
  } catch (err) {
    throw new Error(`加密失败：内容可能过大，或当前浏览器无法完成本次加密。${errorDetail(err)}`);
  }
  const out = new Uint8Array(magic.length + nonce.length + encrypted.length);
  out.set(magic, 0);
  out.set(nonce, magic.length);
  out.set(encrypted, magic.length + nonce.length);
  return out;
}

export async function decryptBytes(key: CryptoKey, envelope: Uint8Array): Promise<Uint8Array> {
  if (envelope.length <= magic.length + 12) {
    throw new Error('ciphertext is too short');
  }
  for (let i = 0; i < magic.length; i += 1) {
    if (envelope[i] !== magic[i]) {
      throw new Error('unsupported ciphertext format');
    }
  }
  const nonce = envelope.slice(magic.length, magic.length + 12);
  const ciphertext = envelope.slice(magic.length + 12);
  try {
    return new Uint8Array(
      await requireSubtleCrypto().decrypt(
        { name: 'AES-GCM', iv: bytesToArrayBuffer(nonce) },
        key,
        bytesToArrayBuffer(ciphertext)
      )
    );
  } catch (err) {
    throw new Error(`解密失败：剪贴板密钥与当前数据不匹配，或远端数据已损坏。${errorDetail(err)}`);
  }
}

export async function encryptIndex(key: CryptoKey, index: ClipIndex): Promise<string> {
  const raw = new TextEncoder().encode(JSON.stringify(index));
  return bytesToBase64(await encryptBytes(key, raw));
}

export async function decryptIndex(key: CryptoKey, blob: string): Promise<ClipIndex> {
  if (!blob) {
    return emptyIndex();
  }
  const raw = await decryptBytes(key, base64ToBytes(blob));
  const parsed = JSON.parse(new TextDecoder().decode(raw)) as ClipIndex;
  return {
    version: 1,
    updatedAt: parsed.updatedAt || Date.now(),
    clips: Array.isArray(parsed.clips) ? parsed.clips : [],
    deleted: Array.isArray(parsed.deleted) ? parsed.deleted : []
  };
}

export function mergeIndexes(remote: ClipIndex, local: ClipIndex): ClipIndex {
  const deleted = new Map<string, number>();
  for (const tombstone of [...remote.deleted, ...local.deleted]) {
    deleted.set(tombstone.id, Math.max(deleted.get(tombstone.id) || 0, tombstone.deletedAt));
  }

  const clips = new Map<string, (typeof remote.clips)[number]>();
  for (const clip of [...remote.clips, ...local.clips]) {
    const deletedAt = deleted.get(clip.id) || 0;
    if (deletedAt >= clip.updatedAt) {
      continue;
    }
    const existing = clips.get(clip.id);
    if (!existing || clip.updatedAt >= existing.updatedAt) {
      clips.set(clip.id, clip);
    }
  }

  return {
    version: 1,
    updatedAt: Date.now(),
    clips: [...clips.values()].sort((a, b) => (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt)),
    deleted: [...deleted.entries()].map(([id, deletedAt]) => ({ id, deletedAt }))
  };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return base64ToBytes(padded);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function requireWebCrypto(): Crypto {
  const reason = webCryptoUnavailableReason();
  if (reason) {
    throw new Error(reason);
  }
  return globalThis.crypto;
}

function requireSubtleCrypto(): SubtleCrypto {
  const reason = webCryptoUnavailableReason();
  if (reason) {
    throw new Error(reason);
  }
  return globalThis.crypto.subtle;
}

function domainSeparatedBytes(domainText: string, bytes: Uint8Array): Uint8Array {
  const domain = new TextEncoder().encode(domainText);
  const input = new Uint8Array(domain.byteLength + bytes.byteLength);
  input.set(domain, 0);
  input.set(bytes, domain.byteLength);
  return input;
}

function mod(value: bigint, divisor = p256P): bigint {
  const result = value % divisor;
  return result >= 0n ? result : result + divisor;
}

function modInv(value: bigint, divisor = p256P): bigint {
  let low = mod(value, divisor);
  let high = divisor;
  let lm = 1n;
  let hm = 0n;
  while (low > 1n) {
    const ratio = high / low;
    const next = high - low * ratio;
    const nextM = hm - lm * ratio;
    high = low;
    hm = lm;
    low = next;
    lm = nextM;
  }
  return mod(lm, divisor);
}

function pointAdd(left: P256Point, right: P256Point): P256Point {
  if (!left) return right;
  if (!right) return left;
  if (left.x === right.x) {
    if (mod(left.y + right.y) === 0n) {
      return null;
    }
    return pointDouble(left);
  }
  const slope = mod((right.y - left.y) * modInv(right.x - left.x));
  const x = mod(slope * slope - left.x - right.x);
  const y = mod(slope * (left.x - x) - left.y);
  return { x, y };
}

function pointDouble(point: Exclude<P256Point, null>): P256Point {
  if (point.y === 0n) {
    return null;
  }
  const slope = mod((3n * point.x * point.x - 3n) * modInv(2n * point.y));
  const x = mod(slope * slope - 2n * point.x);
  const y = mod(slope * (point.x - x) - point.y);
  return { x, y };
}

function scalarBaseMult(scalar: bigint): P256Point {
  let n = scalar;
  let result: P256Point = null;
  let addend: P256Point = p256G;
  while (n > 0n) {
    if (n & 1n) {
      result = pointAdd(result, addend);
    }
    addend = addend ? pointDouble(addend) : null;
    n >>= 1n;
  }
  return result;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) + BigInt(byte);
  }
  return value;
}

function bigIntToBytes(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let current = value;
  for (let i = out.length - 1; i >= 0; i -= 1) {
    out[i] = Number(current & 0xffn);
    current >>= 8n;
  }
  return out;
}

function errorDetail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  if (!message || /operation failed for an operation-specific reason/i.test(message)) {
    return '';
  }
  return `(${message})`;
}
