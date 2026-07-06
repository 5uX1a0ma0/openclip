import { bytesToArrayBuffer, decryptChunkBytes, encryptChunkBytes } from './crypto';

type CryptoWorkerAction = 'encrypt-chunk' | 'decrypt-chunk';

type CryptoWorkerRequest = {
  id: number;
  action: CryptoWorkerAction;
  key: CryptoKey;
  data: ArrayBuffer;
  aad: ArrayBuffer;
};

type CryptoWorkerResponse =
  | { id: number; ok: true; data: ArrayBuffer }
  | { id: number; ok: false; error: string };

type PendingRequest = {
  resolve: (bytes: Uint8Array) => void;
  reject: (err: Error) => void;
  fallback: () => Promise<Uint8Array>;
  fallbackSafe: boolean;
};

type CryptoWorkerOptions = {
  transfer?: boolean;
};

let worker: Worker | null = null;
let nextRequestId = 1;
let workerDisabled = false;
let workerReady = false;
const pending = new Map<number, PendingRequest>();

export async function encryptChunkBytesFast(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad: Uint8Array,
  options: CryptoWorkerOptions = {}
): Promise<Uint8Array> {
  return runCryptoWorker('encrypt-chunk', key, plaintext, aad, options, () => encryptChunkBytes(key, plaintext, aad));
}

export async function decryptChunkBytesFast(
  key: CryptoKey,
  envelope: Uint8Array,
  aad: Uint8Array,
  options: CryptoWorkerOptions = {}
): Promise<Uint8Array> {
  return runCryptoWorker('decrypt-chunk', key, envelope, aad, options, () => decryptChunkBytes(key, envelope, aad));
}

export function closeCryptoWorker() {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  workerReady = false;
  for (const request of pending.values()) {
    request.reject(new Error('加解密任务已取消'));
  }
  pending.clear();
}

async function runCryptoWorker(
  action: CryptoWorkerAction,
  key: CryptoKey,
  input: Uint8Array,
  aad: Uint8Array,
  options: CryptoWorkerOptions,
  fallback: () => Promise<Uint8Array>
): Promise<Uint8Array> {
  const instance = ensureCryptoWorker();
  if (!instance) {
    return fallback();
  }

  const id = nextRequestId;
  nextRequestId += 1;
  const fallbackSafe = options.transfer !== true || !workerReady;
  const data = transferableBuffer(input, options.transfer === true && workerReady);
  const aadData = transferableBuffer(aad);
  const request: CryptoWorkerRequest = { id, action, key, data, aad: aadData };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, fallback, fallbackSafe });
    try {
      instance.postMessage(request, [data, aadData]);
    } catch {
      pending.delete(id);
      workerDisabled = true;
      fallbackPendingRequests();
      void fallback().then(resolve, reject);
    }
  });
}

function ensureCryptoWorker(): Worker | null {
  if (workerDisabled || typeof Worker === 'undefined') {
    return null;
  }
  if (worker) {
    return worker;
  }
  try {
    worker = new Worker(new URL('./crypto_worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', handleWorkerMessage);
    worker.addEventListener('error', handleWorkerFailure);
    worker.addEventListener('messageerror', handleWorkerFailure);
    return worker;
  } catch {
    workerDisabled = true;
    worker = null;
    return null;
  }
}

function handleWorkerMessage(event: MessageEvent<CryptoWorkerResponse>) {
  const response = event.data;
  const request = pending.get(response.id);
  if (!request) {
    return;
  }
  pending.delete(response.id);
  if (response.ok) {
    workerReady = true;
    request.resolve(new Uint8Array(response.data));
  } else if (isWorkerCapabilityError(response.error)) {
    workerDisabled = true;
    fallbackPendingRequests();
    if (request.fallbackSafe) {
      void request.fallback().then(request.resolve, request.reject);
    } else {
      request.reject(new Error('加解密 worker 不可用，请重试本次操作'));
    }
  } else {
    request.reject(new Error(response.error));
  }
}

function handleWorkerFailure() {
  workerDisabled = true;
  fallbackPendingRequests();
}

function fallbackPendingRequests() {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  workerReady = false;
  const requests = [...pending.values()];
  pending.clear();
  for (const request of requests) {
    if (request.fallbackSafe) {
      void request.fallback().then(request.resolve, request.reject);
    } else {
      request.reject(new Error('加解密 worker 中断，请重试本次操作'));
    }
  }
}

function isWorkerCapabilityError(message: string) {
  return /Web Crypto|SubtleCrypto|CryptoKey|could not be cloned|无法克隆|当前浏览器不支持 Web Crypto/i.test(message);
}

function transferableBuffer(bytes: Uint8Array, allowDetach = false): ArrayBuffer {
  if (!allowDetach && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer.slice(0);
  }
  return bytesToArrayBuffer(bytes);
}
