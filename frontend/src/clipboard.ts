import { bytesToArrayBuffer, bytesToBase64Url } from './crypto';
import type { ClipEntry } from './types';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
export const appClipboardPayloadBlobMime = 'application/vnd.openlist-clipboard.clip';
export const appClipboardPayloadClipboardType = `web ${appClipboardPayloadBlobMime}`;
const appClipboardPayloadMagic = 'OLC_CLIP_V1\n';
const appClipboardPayloadMagicBytes = new TextEncoder().encode(appClipboardPayloadMagic);


type PlainSource = {
  bytes?: Uint8Array;
  file?: File;
};
export type PlainClipInput = {
  source: PlainSource;
  size: number;
  kind: ClipEntry['kind'];
  name: string;
  mime: string;
  preview: string;
  contentHash?: string;
};

export type RichClipboard = Partial<Pick<Clipboard, 'read' | 'write' | 'readText' | 'writeText'>>;
type AppClipboardPayloadHeader = {
  app: 'openlist-clipboard';
  version: 1;
  kind: 'image' | 'file';
  name: string;
  mime: string;
  size: number;
  contentHash?: string;
};


export function clipboardFilesFromPaste(event: ClipboardEvent): File[] {
  const data = event.clipboardData;
  if (!data) {
    return [];
  }
  const files = [...data.files].map((file) => normalizePastedFile(file));
  if (files.length > 0) {
    return files;
  }
  return [...data.items]
    .filter((item) => item.kind === 'file')
    .map((item) => {
      const file = item.getAsFile();
      if (!file) {
        return null;
      }
      if (file.name) {
        return file;
      }
      return normalizePastedFile(file, item.type);
    })
    .filter((file): file is File => file !== null);
}


export function clipboardContainsAppPayload(data: DataTransfer | null | undefined) {
  if (!data) {
    return false;
  }
  return [...data.types].some((type) => isAppClipboardPayloadType(type));
}

function isAppClipboardPayloadType(type: string) {
  return type === appClipboardPayloadClipboardType || type === appClipboardPayloadBlobMime;
}

function normalizePastedFile(file: File, itemMime = ''): File {
  if (file.name) {
    return file;
  }
  const mime = file.type || itemMime || 'application/octet-stream';
  const name = mime.startsWith('image/')
    ? `clipboard-${Date.now()}.${imageExtension(mime)}`
    : `clipboard-${Date.now()}.bin`;
  return new File([file], name, {
    type: mime,
    lastModified: file.lastModified || Date.now()
  });
}


export async function tryReadAppClipboardInput(files: File[] = []): Promise<PlainClipInput | null> {
  for (const file of files) {
    if (isAppClipboardPayloadType(file.type)) {
      const input = await readAppClipboardPayload(file);
      if (input) return input;
    }
  }
  const nav = navigator.clipboard as RichClipboard | undefined;
  if (!nav || typeof nav.read !== 'function') {
    return null;
  }
  try {
    return await readAppClipboardInputFromItems(await nav.read());
  } catch {
    return null;
  }
}

export async function readAppClipboardInput(): Promise<PlainClipInput> {
  const input = await tryReadAppClipboardInput();
  if (!input) {
    throw new Error('当前剪贴板不是本应用复制的数据。');
  }
  return input;
}

export async function readAppClipboardInputFromItems(items: ClipboardItem[]): Promise<PlainClipInput | null> {
  for (const item of items) {
    const type = item.types.find((value) => isAppClipboardPayloadType(value));
    if (!type) {
      continue;
    }
    try {
      const payload = await item.getType(type);
      const input = await readAppClipboardPayload(payload);
      if (input) {
        return input;
      }
    } catch {
      // Ignore unreadable custom formats and fall back to the browser-provided data.
    }
  }
  return null;
}

export async function readAppClipboardPayload(payload: Blob): Promise<PlainClipInput | null> {
  const bytes = new Uint8Array(await payload.arrayBuffer());
  const magicLength = appClipboardPayloadMagicBytes.byteLength;
  if (bytes.byteLength < magicLength + 4) {
    return null;
  }
  for (let i = 0; i < magicLength; i += 1) {
    if (bytes[i] !== appClipboardPayloadMagicBytes[i]) {
      return null;
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(magicLength, false);
  const headerStart = magicLength + 4;
  const headerEnd = headerStart + headerLength;
  if (headerEnd > bytes.byteLength) {
    return null;
  }
  let header: Partial<AppClipboardPayloadHeader>;
  try {
    header = JSON.parse(textDecoder.decode(bytes.subarray(headerStart, headerEnd))) as Partial<AppClipboardPayloadHeader>;
  } catch {
    return null;
  }
  if (!header || header.app !== 'openlist-clipboard' || header.version !== 1 || (header.kind !== 'image' && header.kind !== 'file')) {
    return null;
  }
  const plain = bytes.subarray(headerEnd);
  if (header.size !== plain.byteLength) {
    return null;
  }
  const name = typeof header.name === 'string' && header.name ? header.name : header.kind === 'image' ? '图片' : '文件';
  const mime = typeof header.mime === 'string' && header.mime ? header.mime : header.kind === 'image' ? 'image/png' : 'application/octet-stream';
  const contentHash = await sha256Base64Url(plain);
  return {
    source: { bytes: plain.slice() },
    size: plain.byteLength,
    kind: header.kind,
    name,
    mime,
    preview: header.kind === 'image' ? '图片' : '文件',
    contentHash
  };
}

export function buildAppClipboardPayload(clip: ClipEntry, plain: Uint8Array, contentHash = ''): Blob {
  const header: AppClipboardPayloadHeader = {
    app: 'openlist-clipboard',
    version: 1,
    kind: clip.kind === 'image' ? 'image' : 'file',
    name: clip.name || (clip.kind === 'image' ? '图片' : '文件'),
    mime: clip.mime || (clip.kind === 'image' ? 'image/png' : 'application/octet-stream'),
    size: plain.byteLength,
    contentHash
  };
  const headerBytes = textEncoder.encode(JSON.stringify(header));
  const framed = new Uint8Array(appClipboardPayloadMagicBytes.byteLength + 4 + headerBytes.byteLength + plain.byteLength);
  framed.set(appClipboardPayloadMagicBytes, 0);
  new DataView(framed.buffer).setUint32(appClipboardPayloadMagicBytes.byteLength, headerBytes.byteLength, false);
  framed.set(headerBytes, appClipboardPayloadMagicBytes.byteLength + 4);
  framed.set(plain, appClipboardPayloadMagicBytes.byteLength + 4 + headerBytes.byteLength);
  return new Blob([bytesToArrayBuffer(framed)], { type: appClipboardPayloadBlobMime });
}

export async function readSystemClipboardInput(nav: RichClipboard): Promise<PlainClipInput | null> {
  let readError: unknown;
  if (nav.read) {
    try {
      const items = await nav.read();
      const exact = await readAppClipboardInputFromItems(items);
      if (exact) return exact;
      for (const item of items) {
        // HTML/plain text are alternative representations of copied text.
        const mime = item.types.find((type) => type.startsWith('image/')) ||
          item.types.find((type) => !isAppClipboardPayloadType(type) && !type.startsWith('web ') &&
            type !== 'text/plain' && type !== 'text/html');
        if (!mime) continue;
        const blob = await item.getType(mime);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const kind = mime.startsWith('image/') ? 'image' : 'file';
        return {
          source: { bytes }, size: bytes.byteLength, kind, mime,
          name: (blob as File).name || `clipboard-${Date.now()}.${kind === 'image' ? imageExtension(mime) : 'bin'}`,
          preview: kind === 'image' ? '图片' : '文件'
        };
      }
      for (const item of items) {
        if (item.types.includes('text/plain')) {
          return textInput(await (await item.getType('text/plain')).text());
        }
      }
      if (items.length) throw new Error('当前剪贴板格式无法读取，请使用上传文件。');
      return null;
    } catch (err) {
      readError = err;
    }
  }
  if (nav.readText) {
    const input = textInput(await nav.readText());
    if (input || !readError) return input;
  }
  throw readError || new Error('当前浏览器不支持读取剪贴板，请使用粘贴或上传文件。');
}

function textInput(text: string): PlainClipInput | null {
  if (!text.trim()) return null;
  const bytes = textEncoder.encode(text);
  return { source: { bytes }, size: bytes.byteLength, kind: 'text', name: '文本', mime: 'text/plain;charset=utf-8', preview: text.slice(0, 160) };
}

export async function writeBinaryClipToClipboard(
  nav: RichClipboard,
  clip: ClipEntry,
  loadPlain: () => Promise<Uint8Array>
): Promise<'exact' | 'native' | 'app-only'> {
  const label = clip.kind === 'image' ? '图片' : '文件';
  if (!nav.write || typeof ClipboardItem === 'undefined') {
    throw new Error(`当前浏览器不支持复制${label}到系统剪贴板，请使用下载。`);
  }
  const mime = clip.mime || (clip.kind === 'image' ? 'image/png' : 'application/octet-stream');
  // Start the write in the click handler, before downloads/decryption consume user activation.
  const plain = loadPlain();
  const native = plain.then((bytes) => new Blob([bytesToArrayBuffer(bytes)], { type: mime }));
  const payload = plain.then((bytes) => buildAppClipboardPayload(clip, bytes, clip.contentHash));
  // Constructors can reject unsupported formats before consuming these promises.
  void native.catch(() => undefined);
  void payload.catch(() => undefined);
  const supports = (type: string) => typeof ClipboardItem.supports !== 'function' || ClipboardItem.supports(type);
  const attempts: { data: Record<string, Promise<Blob>>; mode: 'exact' | 'native' | 'app-only' }[] = [];
  if (supports(mime) && supports(appClipboardPayloadClipboardType)) {
    attempts.push({ data: { [mime]: native, [appClipboardPayloadClipboardType]: payload }, mode: 'exact' });
  }
  // Images should stay usable outside the app; files need the exact custom fallback.
  const nativeAttempt = { data: { [mime]: native }, mode: 'native' as const };
  const appAttempt = { data: { [appClipboardPayloadClipboardType]: payload }, mode: 'app-only' as const };
  attempts.push(...(clip.kind === 'image' ? [nativeAttempt, appAttempt] : [appAttempt, nativeAttempt]));
  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      await nav.write([new ClipboardItem(attempt.data)]);
      return attempt.mode;
    } catch (err) {
      lastError = err;
      // Surface download/decryption errors instead of disguising them as MIME failures.
      await plain;
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`复制${label}失败：浏览器拒绝剪贴板写入或不支持此格式。请允许此站点读写剪贴板，或使用下载。${detail ? `（${detail}）` : ''}`);
}


function imageExtension(mime: string) {
  const subtype = mime.split('/')[1]?.split('+')[0]?.replace(/[^A-Za-z0-9_-]/g, '');
  return subtype || 'png';
}


async function sha256Base64Url(bytes: Uint8Array) {
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytesToArrayBuffer(bytes))));
}
