import { sha256BlobFallback } from './sha256_stream';

type Sha256WorkerResponse =
  | { id: number; ok: true; digest: ArrayBuffer }
  | { id: number; ok: false; error: string };

type PendingRequest = {
  blob: Blob;
  resolve: (digest: Uint8Array) => void;
  reject: (err: Error) => void;
};

let worker: Worker | null = null;
let workerDisabled = false;
let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();

export async function sha256BlobFast(blob: Blob): Promise<Uint8Array> {
  const instance = ensureWorker();
  if (!instance) {
    return sha256BlobFallback(blob);
  }

  const id = nextRequestId;
  nextRequestId += 1;
  return new Promise((resolve, reject) => {
    pending.set(id, { blob, resolve, reject });
    try {
      instance.postMessage({ id, blob });
    } catch {
      pending.delete(id);
      disableWorker();
      void sha256BlobFallback(blob).then(resolve, reject);
    }
  });
}

export function closeSha256Worker() {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  for (const request of pending.values()) {
    request.reject(new Error('哈希任务已取消'));
  }
  pending.clear();
}

function ensureWorker(): Worker | null {
  if (workerDisabled || typeof Worker === 'undefined') {
    return null;
  }
  if (worker) {
    return worker;
  }
  try {
    worker = new Worker(new URL('./sha256_worker.ts', import.meta.url), { type: 'module' });
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

function handleWorkerMessage(event: MessageEvent<Sha256WorkerResponse>) {
  const response = event.data;
  const request = pending.get(response.id);
  if (!request) {
    return;
  }
  pending.delete(response.id);
  if (response.ok) {
    request.resolve(new Uint8Array(response.digest));
    return;
  }

  disableWorker();
  void sha256BlobFallback(request.blob).then(request.resolve, request.reject);
}

function handleWorkerFailure() {
  disableWorker();
}

function disableWorker() {
  workerDisabled = true;
  if (worker) {
    worker.terminate();
    worker = null;
  }
  const requests = [...pending.values()];
  pending.clear();
  for (const request of requests) {
    void sha256BlobFallback(request.blob).then(request.resolve, request.reject);
  }
}
