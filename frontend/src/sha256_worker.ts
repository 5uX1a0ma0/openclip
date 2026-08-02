import { createSHA256, type IHasher } from 'hash-wasm';
import { updateSha256FromBlob } from './sha256_stream';

type Sha256WorkerRequest = {
  id: number;
  blob: Blob;
};

type Sha256WorkerResponse =
  | { id: number; ok: true; digest: ArrayBuffer }
  | { id: number; ok: false; error: string };

const workerScope = globalThis as unknown as {
  addEventListener(type: 'message', listener: (event: MessageEvent<Sha256WorkerRequest>) => void): void;
  postMessage(message: Sha256WorkerResponse, transfer?: Transferable[]): void;
};

let hasherPromise: Promise<IHasher> | null = null;
let queue = Promise.resolve();

workerScope.addEventListener('message', (event) => {
  const request = event.data;
  queue = queue.then(() => handleRequest(request), () => handleRequest(request));
});

async function handleRequest(request: Sha256WorkerRequest) {
  try {
    hasherPromise ||= createSHA256();
    const hasher = (await hasherPromise).init();
    await updateSha256FromBlob(request.blob, hasher);
    const digest = hasher.digest('binary');
    const response: Sha256WorkerResponse = { id: request.id, ok: true, digest: digest.buffer as ArrayBuffer };
    workerScope.postMessage(response, [response.digest]);
  } catch (err) {
    hasherPromise = null;
    const response: Sha256WorkerResponse = { id: request.id, ok: false, error: errorMessage(err) };
    workerScope.postMessage(response);
  }
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}
