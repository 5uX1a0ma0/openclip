import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appClipboardPayloadClipboardType as custom,
  appClipboardPayloadBlobMime,
  buildAppClipboardPayload,
  clipboardFilesFromPaste,
  readAppClipboardPayload,
  readSystemClipboardInput,
  tryReadAppClipboardInput,
  writeBinaryClipToClipboard,
  writeTextClipToClipboard
} from './clipboard';
import type { ClipEntry } from './types';

class Item {
  static supports = vi.fn(() => true);
  types: string[];
  constructor(private data: Record<string, Blob | Promise<Blob>>) { this.types = Object.keys(data); }
  async getType(type: string) { return this.data[type]; }
}
const bytes = new Uint8Array([0, 255, 1, 2, 3]);
const file: ClipEntry = {
  id: 'clip', blobId: 'blob', kind: 'file', name: '原始文件.zip', mime: 'application/zip', preview: '文件',
  size: bytes.length, encryptedSize: 40, createdAt: 1, updatedAt: 1, expiresAt: null, pinned: true
};
const image: ClipEntry = { ...file, kind: 'image', name: 'photo.png', mime: 'image/png' };
const item = (data: Record<string, Blob | Promise<Blob>>) => new Item(data) as unknown as ClipboardItem;

beforeEach(() => { Item.supports.mockReturnValue(true); vi.stubGlobal('ClipboardItem', Item); });
afterEach(() => vi.unstubAllGlobals());

describe('text clipboard', () => {
  it('reserves user activation before a delayed text download completes', async () => {
    let resolve!: (text: string) => void;
    const loaded = new Promise<string>((done) => { resolve = done; });
    const write = vi.fn(async (items: ClipboardItem[]) => { expect(await (await items[0].getType('text/plain')).text()).toBe('complete text'); });
    const pending = writeTextClipToClipboard({ write }, () => loaded);
    expect(write).toHaveBeenCalledOnce();
    resolve('complete text');
    await pending;
  });

  it('supports writeText-only browsers and reports permission and decryption failures', async () => {
    const writeText = vi.fn(async () => {});
    await writeTextClipToClipboard({ writeText }, async () => 'text');
    expect(writeText).toHaveBeenCalledWith('text');
    await expect(writeTextClipToClipboard({ writeText: async () => { throw new Error('denied'); } }, async () => 'text')).rejects.toThrow('重试');
    await expect(writeTextClipToClipboard({ write: async () => { throw new Error('denied'); } }, async () => { throw new Error('decrypt failed'); })).rejects.toThrow('decrypt failed');
  });
});

describe('binary clipboard', () => {
  it.each([file, image])('writes original MIME and exact app data for $kind', async (clip) => {
    let written: ClipboardItem[] = [];
    const write = vi.fn(async (items: ClipboardItem[]) => { written = items; });
    expect(await writeBinaryClipToClipboard({ write }, clip, async () => bytes)).toBe('exact');
    expect(written[0].types).toEqual([clip.mime, custom]);
    expect(new Uint8Array(await (await written[0].getType(clip.mime)).arrayBuffer())).toEqual(bytes);
    const read = vi.fn(async () => written);
    const result = await readSystemClipboardInput({ read });
    expect(result).toMatchObject({ kind: clip.kind, name: clip.name, mime: clip.mime, size: bytes.length });
    expect(result?.source.bytes).toEqual(bytes);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('requests write before asynchronous decryption resolves', async () => {
    let resolve!: (value: Uint8Array) => void;
    const write = vi.fn(async (items: ClipboardItem[]) => { await items[0].getType(image.mime); });
    const result = writeBinaryClipToClipboard({ write }, image, () => new Promise((done) => { resolve = done; }));
    expect(write).toHaveBeenCalledTimes(1);
    resolve(bytes);
    await expect(result).resolves.toBe('exact');
  });

  it('falls back to app data when the native file MIME is rejected', async () => {
    const write = vi.fn(async (items: ClipboardItem[]) => {
      if (items[0].types.includes(file.mime)) throw new DOMException('unsupported', 'NotSupportedError');
    });
    expect(await writeBinaryClipToClipboard({ write }, file, async () => bytes)).toBe('app-only');
    expect(write.mock.calls.map(([items]) => items[0].types)).toEqual([[file.mime, custom], [custom]]);
  });

  it('falls back to a native image when custom formats are rejected', async () => {
    const write = vi.fn(async (items: ClipboardItem[]) => {
      if (items[0].types.includes(custom)) throw new Error('custom unsupported');
    });
    expect(await writeBinaryClipToClipboard({ write }, image, async () => bytes)).toBe('native');
    expect(write.mock.calls[1][0][0].types).toEqual([image.mime]);
  });

  it('retains exact JPEG bytes through custom-only fallback', async () => {
    const jpeg = { ...image, mime: 'image/jpeg' };
    const write = vi.fn(async (items: ClipboardItem[]) => {
      if (items[0].types.includes(jpeg.mime)) throw new Error('JPEG unsupported');
    });
    expect(await writeBinaryClipToClipboard({ write }, jpeg, async () => bytes)).toBe('app-only');
    const result = await readSystemClipboardInput({ read: async () => write.mock.calls.at(-1)![0] });
    expect(result?.source.bytes).toEqual(bytes);
  });

  it('does not lose activation trying known-unsupported custom types', async () => {
    Item.supports.mockImplementation((...args: unknown[]) => args[0] !== custom);
    const write = vi.fn(async () => {});
    expect(await writeBinaryClipToClipboard({ write }, image, async () => bytes)).toBe('native');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('reports browser rejection and missing APIs with a download option', async () => {
    await expect(writeBinaryClipToClipboard({}, file, async () => bytes)).rejects.toThrow('下载');
    const write = vi.fn(async () => { throw new DOMException('denied', 'NotAllowedError'); });
    await expect(writeBinaryClipToClipboard({ write }, image, async () => bytes)).rejects.toThrow('浏览器拒绝');
    vi.stubGlobal('ClipboardItem', undefined);
    await expect(writeBinaryClipToClipboard({ write }, file, async () => bytes)).rejects.toThrow('下载');
  });

  it('preserves download/decryption errors', async () => {
    const write = vi.fn(async (items: ClipboardItem[]) => { await items[0].getType(image.mime); });
    await expect(writeBinaryClipToClipboard({ write }, image, async () => { throw new Error('decrypt failed'); })).rejects.toThrow('decrypt failed');
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('manual reading and pasting', () => {
  it.each(['image/png', 'application/pdf', 'text/csv'])('reads ordinary %s data', async (mime) => {
    const result = await readSystemClipboardInput({ read: async () => [item({ [mime]: new Blob([bytes], { type: mime }) })] });
    expect(result?.mime).toBe(mime);
    expect(result?.kind).toBe(mime.startsWith('image/') ? 'image' : 'file');
    expect(result?.source.bytes).toEqual(bytes);
  });

  it('prefers plain text to HTML representations and supports readText-only browsers', async () => {
    const result = await readSystemClipboardInput({ read: async () => [item({ 'text/plain': new Blob(['hello']), 'text/html': new Blob(['<b>hello</b>']) })] });
    expect(result).toMatchObject({ kind: 'text', preview: 'hello' });
    expect(await readSystemClipboardInput({ readText: async () => 'hello' })).toMatchObject({ preview: 'hello' });
    expect(await readSystemClipboardInput({ readText: async () => '' })).toBeNull();
  });

  it('surfaces denied binary reads instead of falsely reporting an empty clipboard', async () => {
    await expect(readSystemClipboardInput({ read: async () => { throw new Error('denied'); }, readText: async () => '' })).rejects.toThrow('denied');
  });

  it('extracts non-image file items when the browser files list is empty', () => {
    const pdf = new File([bytes], 'report.pdf', { type: 'application/pdf' });
    const event = { clipboardData: { files: [], items: [{ kind: 'file', type: pdf.type, getAsFile: () => pdf }] } } as unknown as ClipboardEvent;
    expect(clipboardFilesFromPaste(event)).toEqual([pdf]);
  });

  it('reads custom paste file data without requiring clipboard read permission', async () => {
    const payload = new File([buildAppClipboardPayload(file, bytes)], 'payload', { type: appClipboardPayloadBlobMime });
    const read = vi.fn(async () => { throw new Error('denied'); });
    vi.stubGlobal('navigator', { clipboard: { read } });
    const input = await tryReadAppClipboardInput([payload]);
    expect(input?.source.bytes).toEqual(bytes);
    expect(input?.name).toBe(file.name);
    expect(read).not.toHaveBeenCalled();
  });

  it('ignores malformed payloads and falls back to native data', async () => {
    const bad = new Blob(['not a payload']);
    await expect(readAppClipboardPayload(bad)).resolves.toBeNull();
    const framed = buildAppClipboardPayload(file, bytes);
    await expect(readAppClipboardPayload(framed.slice(0, framed.size - 1))).resolves.toBeNull();
    const result = await readSystemClipboardInput({ read: async () => [item({ [custom]: bad, 'image/png': new Blob([bytes]) })] });
    expect(result?.kind).toBe('image');
  });
});
