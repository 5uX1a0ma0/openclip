import { decryptChunkBytes, encryptChunkBytes } from './crypto';

type CryptoWorkerRequest = {
  id: number;
  action: 'encrypt-chunk' | 'decrypt-chunk';
  key: CryptoKey;
  data: ArrayBuffer;
  aad: ArrayBuffer;
};

type CryptoWorkerResponse =
  | { id: number; ok: true; data: ArrayBuffer }
  | { id: number; ok: false; error: string };

const workerScope = globalThis as unknown as {
  addEventListener(type: 'message', listener: (event: MessageEvent<CryptoWorkerRequest>) => void): void;
  postMessage(message: CryptoWorkerResponse, transfer?: Transferable[]): void;
};

workerScope.addEventListener('message', (event: MessageEvent<CryptoWorkerRequest>) => {
  const request = event.data;
  void handleRequest(request);
});

async function handleRequest(request: CryptoWorkerRequest) {
  try {
    const data = new Uint8Array(request.data);
    const aad = new Uint8Array(request.aad);
    const result =
      request.action === 'encrypt-chunk'
        ? await encryptChunkBytes(request.key, data, aad)
        : await decryptChunkBytes(request.key, data, aad);
    const response: CryptoWorkerResponse = { id: request.id, ok: true, data: result.buffer as ArrayBuffer };
    workerScope.postMessage(response, [response.data]);
  } catch (err) {
    const response: CryptoWorkerResponse = { id: request.id, ok: false, error: errorMessage(err) };
    workerScope.postMessage(response);
  }
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}
