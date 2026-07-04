import type { BlobResponse, GroupAuth, GroupMetadata, IndexEvent, IndexResponse, RuntimeConfig } from './types';
import { bytesToArrayBuffer, bytesToBase64Url } from './crypto';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const remoteClipboardUnavailableMessage = '远端剪贴板不存在或密钥已失效，请刷新、切换或忘记本机记录后重新加入。';

export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, message: string, detail = '') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError || (err instanceof Error && typeof (err as { status?: unknown }).status === 'number');
}

export function apiErrorStatus(err: unknown): number | undefined {
  return isApiError(err) ? err.status : undefined;
}

export function isFatalAuthOrGroupError(err: unknown): boolean {
  if (!isApiError(err)) {
    return false;
  }
  if (err.status === 401 || err.status === 403) {
    return true;
  }
  return err.status === 404 && /group|clipboard|剪贴板/i.test(`${err.message} ${err.detail}`);
}

export async function createRemoteGroup(
  groupId: string,
  name: string,
  keyHash: string,
  publicKeyJwk: JsonWebKey,
  createPassword: string
): Promise<GroupMetadata> {
  return apiFetch<GroupMetadata>('/api/v1/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupId, name, keyHash, publicKeyJwk, createPassword })
  });
}

export async function joinRemoteGroup(groupId: string, keyHash: string, publicKeyJwk: JsonWebKey): Promise<GroupMetadata> {
  return apiFetch<GroupMetadata>(`/api/v1/groups/${encodeURIComponent(groupId)}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyHash, publicKeyJwk })
  });
}

export async function fetchRuntimeConfig(): Promise<RuntimeConfig> {
  return apiFetch<RuntimeConfig>('/api/v1/runtime-config');
}

export async function fetchIndex(auth: GroupAuth): Promise<IndexResponse> {
  return signedJSON(auth, `/api/v1/groups/${encodeURIComponent(auth.id)}/index`, 'GET');
}

export async function saveIndex(auth: GroupAuth, baseHash: string, blob: string, clientId = ''): Promise<{ hash: string }> {
  return signedJSON(auth, `/api/v1/groups/${encodeURIComponent(auth.id)}/index`, 'PUT', { baseHash, blob, clientId });
}

export async function uploadBlob(auth: GroupAuth, blob: Uint8Array): Promise<BlobResponse> {
  return signedFetch(auth, `/api/v1/groups/${encodeURIComponent(auth.id)}/blobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytesToArrayBuffer(blob),
    bodyBytes: blob
  }).then((response) => response.json() as Promise<BlobResponse>);
}

export async function downloadBlob(auth: GroupAuth, clipId: string): Promise<Uint8Array> {
  const response = await signedFetch(auth, `/api/v1/groups/${encodeURIComponent(auth.id)}/blobs/${encodeURIComponent(clipId)}`, {
    method: 'GET'
  });
  return new Uint8Array(await response.arrayBuffer());
}

export async function deleteBlob(auth: GroupAuth, clipId: string): Promise<void> {
  await signedFetch(auth, `/api/v1/groups/${encodeURIComponent(auth.id)}/blobs/${encodeURIComponent(clipId)}`, {
    method: 'DELETE'
  });
}

export async function savePushSubscription(
  auth: GroupAuth,
  clientId: string,
  subscription: PushSubscriptionJSON
): Promise<void> {
  await signedJSON(auth, `/api/v1/groups/${encodeURIComponent(auth.id)}/push-subscriptions`, 'POST', {
    clientId,
    endpoint: subscription.endpoint,
    keys: subscription.keys
  });
}

export async function deletePushSubscription(auth: GroupAuth, clientId: string, endpoint: string): Promise<void> {
  await signedJSON(auth, `/api/v1/groups/${encodeURIComponent(auth.id)}/push-subscriptions`, 'DELETE', {
    clientId,
    endpoint
  });
}

export function openIndexEvents(
  auth: GroupAuth,
  onIndex: (event: IndexEvent) => void,
  onState: (state: 'connecting' | 'live' | 'offline') => void,
  onError: (message: string, terminal: boolean, error?: unknown) => void
): { close: () => void } {
  const controller = new AbortController();
  void (async () => {
    let retry = 0;
    while (!controller.signal.aborted) {
      onState('connecting');
      try {
        const response = await signedFetch(auth, `/api/v1/groups/${encodeURIComponent(auth.id)}/events`, {
          method: 'GET',
          signal: controller.signal
        });
        if (!response.body) {
          throw new Error('实时连接不可用');
        }
        retry = 0;
        onState('live');
        await readEventStream(response.body, onIndex, controller.signal);
        if (!controller.signal.aborted) {
          onState('offline');
          onError('实时连接已断开，正在重连', false);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          onState('offline');
          if (isFatalIndexEventError(err)) {
            onError(remoteClipboardUnavailableMessage, true, err);
            return;
          }
          onError(`${errorMessage(err)}，正在重连`, false, err);
        }
      }
      if (!controller.signal.aborted) {
        retry += 1;
        await delay(reconnectDelay(retry), controller.signal);
      }
    }
  })();
  return {
    close() {
      controller.abort();
      onState('offline');
    }
  };
}

function isFatalIndexEventError(err: unknown): boolean {
  if (!isApiError(err)) {
    return false;
  }
  return err.status === 400 || err.status === 401 || err.status === 403 || err.status === 404;
}

function reconnectDelay(retry: number) {
  const base = Math.min(30_000, 1_000 * 2 ** Math.min(retry - 1, 5));
  return base + Math.floor(Math.random() * 400);
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timeout = window.setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });
}

async function signedJSON<T>(auth: GroupAuth, path: string, method: string, payload?: unknown): Promise<T> {
  const bodyText = payload === undefined ? undefined : JSON.stringify(payload);
  const bodyBytes = bodyText === undefined ? undefined : textEncoder.encode(bodyText);
  const response = await signedFetch(auth, path, {
    method,
    headers: bodyText === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: bodyText,
    bodyBytes
  });
  return response.json() as Promise<T>;
}

async function signedFetch(
  auth: GroupAuth,
  path: string,
  init: RequestInit & { bodyBytes?: Uint8Array } = {}
): Promise<Response> {
  const method = (init.method || 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  const bodyBytes = init.bodyBytes || new Uint8Array();
  const signed = await signedHeaders(auth, method, path, bodyBytes);
  signed.forEach((value, key) => headers.set(key, value));
  const response = await fetch(path, {
    ...init,
    method,
    headers,
    credentials: 'same-origin'
  });
  if (!response.ok) {
    throw await apiErrorFromResponse(response);
  }
  return response;
}

async function signedHeaders(auth: GroupAuth, method: string, path: string, bodyBytes: Uint8Array): Promise<Headers> {
  const url = new URL(path, window.location.origin);
  const timestamp = `${Date.now()}`;
  const nonce = randomNonce();
  const bodyHash = await sha256Hex(bodyBytes);
  const canonical = [method, url.pathname, url.search.slice(1), bodyHash, timestamp, nonce].join('\n');
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      auth.signingKey,
      textEncoder.encode(canonical)
    )
  );
  return new Headers({
    'X-Group-ID': auth.id,
    'X-Request-Timestamp': timestamp,
    'X-Request-Nonce': nonce,
    'X-Request-Signature': bytesToBase64Url(signature)
  });
}

async function readEventStream(
  stream: ReadableStream<Uint8Array>,
  onIndex: (event: IndexEvent) => void,
  signal: AbortSignal
) {
  const reader = stream.getReader();
  let buffer = '';
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) {
        return;
      }
      buffer += textDecoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        handleRawEvent(rawEvent, onIndex);
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function handleRawEvent(rawEvent: string, onIndex: (event: IndexEvent) => void) {
  const lines = rawEvent.split(/\r?\n/);
  let event = 'message';
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    }
    if (line.startsWith('data:')) {
      data.push(line.slice(5).trimStart());
    }
  }
  if (event !== 'index' || data.length === 0) {
    return;
  }
  try {
    const parsed = JSON.parse(data.join('\n')) as IndexEvent;
    if (typeof parsed.hash === 'string') {
      onIndex(parsed);
    }
  } catch {
    // Ignore malformed stream events.
  }
}

function randomNonce(): string {
  const raw = new Uint8Array(18);
  crypto.getRandomValues(raw);
  return bytesToBase64Url(raw);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytesToArrayBuffer(bytes)));
  return [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin'
  });
  if (!response.ok) {
    throw await apiErrorFromResponse(response);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

async function apiErrorFromResponse(response: Response): Promise<ApiError> {
  const detail = await responseText(response);
  return new ApiError(response.status, detail || response.statusText || `HTTP ${response.status}`, detail);
}

async function responseText(response: Response): Promise<string> {
  try {
    const data = await response.json();
    if (typeof data?.error === 'string') {
      return data.error;
    }
    if (typeof data?.message === 'string') {
      return data.message;
    }
    return JSON.stringify(data);
  } catch {
    return response.statusText;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
