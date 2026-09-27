// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from './App';
import { ApiError, downloadBlob, fetchIndex, joinRemoteGroup, openIndexEvents, saveIndex, uploadBlob } from './api';
import { bytesToBase64Url, decryptIndex, encryptBytes, encryptIndex } from './crypto';
import { loadSavedGroups, saveActiveGroupId, saveSavedGroups } from './groups';
import type { ClipEntry, SavedGroup } from './types';

const fixture = vi.hoisted(() => ({
  group: { id: 'group-a', name: '已有剪贴板', vaultKey: 'key', keyHash: 'hash', publicKeyJwk: {}, invite: 'olckey1.key', createdAt: 1, updatedAt: 1 },
  revision: 1,
  event: (_event: { hash: string }) => {},
  close: vi.fn()
}));

vi.mock('lucide-solid', () => {
  const Icon = () => null;
  return {
    Bell: Icon, Camera: Icon, Clipboard: Icon, Copy: Icon, Download: Icon, Eye: Icon,
    EyeOff: Icon, FileIcon: Icon, FileText: Icon, ImageIcon: Icon, Loader2: Icon,
    Maximize2: Icon, Pin: Icon, PinOff: Icon, Plus: Icon, QrCode: Icon, RefreshCw: Icon,
    Send: Icon, ToggleLeft: Icon, ToggleRight: Icon, Trash2: Icon, Upload: Icon, X: Icon
  };
});

vi.mock('./groups', async (load) => ({
  ...await load<typeof import('./groups')>(),
  activateGroup: vi.fn(async (group: SavedGroup) => ({ ...group, vaultCryptoKey: {}, signingKey: {} })),
  savedGroupFromInvite: vi.fn(async () => ({ ...fixture.group, updatedAt: 2 }))
}));
vi.mock('./crypto', async (load) => ({
  ...await load<typeof import('./crypto')>(),
  decryptIndex: vi.fn(async () => ({ version: 1, clips: [], deleted: [], updatedAt: 1 })),
  encryptBytes: vi.fn(async (_key, bytes: Uint8Array) => bytes),
  decryptBytes: vi.fn(async (_key, bytes: Uint8Array) => bytes),
  encryptIndex: vi.fn(async (_key, value) => JSON.stringify(value))
}));
vi.mock('./sha256_worker_client', async (load) => ({
  ...await load<typeof import('./sha256_worker_client')>(),
  sha256BlobFast: vi.fn(async () => new Uint8Array(32))
}));
vi.mock('./api', async (load) => ({
  ...await load<typeof import('./api')>(),
  fetchRuntimeConfig: vi.fn(async () => ({ chunkPlainBytes: 1024, maxBlobBytes: 4096, webPushEnabled: false, vapidPublicKey: '' })),
  fetchIndex: vi.fn(async () => ({ hash: String(fixture.revision), blob: '' })),
  uploadBlob: vi.fn(async () => ({ clipId: `clip-${Math.random()}` })),
  downloadBlob: vi.fn(),
  saveIndex: vi.fn(async () => ({ hash: String(++fixture.revision) })),
  joinRemoteGroup: vi.fn(async () => ({ name: fixture.group.name })),
  openIndexEvents: vi.fn((_group, onIndex, onState) => {
    fixture.event = onIndex;
    onState('live');
    return { close: fixture.close };
  })
}));

let dispose: () => void;
const clipboard = { read: vi.fn(), readText: vi.fn(), write: vi.fn(), writeText: vi.fn(), addEventListener: vi.fn() };
const button = (title: string) => document.querySelector<HTMLButtonElement>(`button[title="${title}"]`)!;
async function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(() => <App />, host);
  await vi.waitFor(() => expect(button('增加密钥')?.disabled).toBe(false));
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const method of Object.values(clipboard)) method.mockReset();
  fixture.revision = 1;
  vi.mocked(downloadBlob).mockReset();
  localStorage.clear();
  saveSavedGroups([fixture.group]);
  saveActiveGroupId(fixture.group.id);
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});
afterEach(() => { dispose?.(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('saved clipboard navigation', () => {
  it('reopens a saved key after adding a key without deleting local records', async () => {
    await mount();
    button('增加密钥').click();
    expect(document.querySelector('.composer')).toBeNull();
    expect(loadSavedGroups()).toEqual([fixture.group]);
    const open = document.querySelector<HTMLButtonElement>('.saved-group button')!;
    expect(open.textContent).toContain('打开');
    open.click();
    await vi.waitFor(() => expect(button('增加密钥')?.disabled).toBe(false));
    expect(document.querySelector<HTMLSelectElement>('.group-select')?.value).toBe(fixture.group.id);
    expect(document.querySelector('.composer')).not.toBeNull();
  });

  it('joining the same key again updates the existing entry', async () => {
    await mount();
    button('增加密钥').click();
    const input = document.querySelector<HTMLTextAreaElement>('.import-form textarea')!;
    input.value = fixture.group.invite;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.import-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(button('增加密钥')?.disabled).toBe(false));
    expect(joinRemoteGroup).toHaveBeenCalledOnce();
    expect(loadSavedGroups()).toHaveLength(1);
  });
});

describe('manual clipboard and live updates', () => {
  it('cleans old settings and never reads or writes the system clipboard on lifecycle or SSE events', async () => {
    localStorage.setItem('openlist-clipboard.sync.enabled.v1', '{"group-a":true}');
    localStorage.setItem('openlist-clipboard.sync.state.v1', '{}');
    await mount();
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
    fixture.revision = 2;
    fixture.event({ hash: '2' });
    await vi.waitFor(() => expect(fetchIndex).toHaveBeenCalledTimes(2));
    for (const method of Object.values(clipboard)) expect(method).not.toHaveBeenCalled();
    expect(localStorage.getItem('openlist-clipboard.sync.enabled.v1')).toBeNull();
    expect(localStorage.getItem('openlist-clipboard.sync.state.v1')).toBeNull();
    expect(button('刷新')).toBeNull();
    const switches = document.querySelectorAll('[role="switch"]');
    expect(switches).toHaveLength(2);
    expect(switches[0].closest('header')).not.toBeNull();
    expect(switches[1].getAttribute('aria-checked')).toBe('false');
    expect([...document.querySelectorAll('.composer-actions > *')].map((el) => el.textContent?.trim())).toEqual(['上传文件', '直接粘贴剪贴板', '发送']);
  });

  it('only reads the system clipboard after the explicit paste action', async () => {
    clipboard.read.mockResolvedValue([]);
    await mount();
    button('直接粘贴剪贴板').click();
    await vi.waitFor(() => expect(clipboard.read).toHaveBeenCalledOnce());
  });

  it('does not reconnect a fatally unavailable group on focus or network recovery', async () => {
    vi.mocked(fetchIndex).mockRejectedValueOnce(new ApiError(404, 'group not found'));
    await mount();
    expect(fixture.close).toHaveBeenCalled();
    const connections = vi.mocked(openIndexEvents).mock.calls.length;
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(openIndexEvents).toHaveBeenCalledTimes(connections);
    expect(document.querySelector('.status-strip')?.textContent).toContain('密钥已失效');
    expect(loadSavedGroups()).toHaveLength(1);
  });
});

describe('tracking link controls', () => {
  const source = '看看 https://example.com/?id=2&utm_source=feed#p';
  const cleaned = '看看 https://example.com/?id=2#p';
  const draft = () => document.querySelector<HTMLTextAreaElement>('#composer-text')!;
  const toggle = () => document.querySelector<HTMLButtonElement>('.clean-toggle')!;
  const setDraft = (value: string) => {
    draft().value = value;
    draft().dispatchEvent(new Event('input', { bubbles: true }));
  };
  const lastUploaded = () => new TextDecoder().decode(vi.mocked(encryptBytes).mock.lastCall?.[1]);

  it('defaults off, persists by browser, and cleans manual send before preview, size and hash', async () => {
    await mount();
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    toggle().click();
    expect(localStorage.getItem('openlist-clipboard.clean-before-upload.v1')).toBe('true');
    setDraft(source);
    button('发送').click();
    await vi.waitFor(() => expect(uploadBlob).toHaveBeenCalledOnce());
    expect(lastUploaded()).toBe(cleaned);
    expect(vi.mocked(encryptIndex).mock.lastCall?.[1].clips[0].preview).toBe(cleaned);
    expect(vi.mocked(encryptIndex).mock.lastCall?.[1].clips[0].size).toBe(new TextEncoder().encode(cleaned).byteLength);
    const expectedHash = bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cleaned))));
    expect(vi.mocked(encryptIndex).mock.lastCall?.[1].clips[0].contentHash).toBe(expectedHash);
    setDraft(source.replace('feed', 'other'));
    button('发送').click();
    await vi.waitFor(() => expect(draft().value).toBe(''));
    expect(uploadBlob).toHaveBeenCalledOnce();
    dispose();
    await mount();
    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });

  it('cleans direct clipboard read and page paste, while files stay unchanged', async () => {
    clipboard.read.mockRejectedValue(new Error('read unavailable'));
    clipboard.readText.mockResolvedValue(source);
    await mount();
    toggle().click();
    button('直接粘贴剪贴板').click();
    await vi.waitFor(() => expect(uploadBlob).toHaveBeenCalledOnce());
    expect(lastUploaded()).toBe(cleaned);
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(paste, 'clipboardData', { value: { files: [], items: [], types: [], getData: () => `${source}&page=3` } });
    window.dispatchEvent(paste);
    await vi.waitFor(() => expect(uploadBlob).toHaveBeenCalledTimes(2));
    expect(lastUploaded()).toBe(`${cleaned}&page=3`);
    const file = new File(['https://x.test/?utm_source=x'], 'note.txt', { type: 'text/plain' });
    const input = document.querySelector<HTMLInputElement>('.file-input')!;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(uploadBlob).toHaveBeenCalledTimes(3));
    expect(lastUploaded()).toBe('https://x.test/?utm_source=x');
  });

  it('copies cleaned text locally and keeps the draft when clipboard access fails', async () => {
    vi.stubGlobal('ClipboardItem', undefined);
    await mount();
    setDraft(source);
    const cleanButton = document.querySelector<HTMLButtonElement>('.composer-tools .text-tool')!;
    cleanButton.click();
    await vi.waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(cleaned));
    expect(draft().value).toBe(source);
    expect(uploadBlob).not.toHaveBeenCalled();
    clipboard.writeText.mockRejectedValueOnce(new Error('denied'));
    cleanButton.click();
    await vi.waitFor(() => expect(document.querySelector('.toast.error')?.textContent).toContain('请允许剪贴板写入后重试'));
    expect(draft().value).toBe(source);
  });

  it('reports unchanged clean copies and denied clipboard reads without uploading or clearing the draft', async () => {
    vi.stubGlobal('ClipboardItem', undefined);
    await mount();
    setDraft('https://x.test/?id=3#part');
    document.querySelector<HTMLButtonElement>('.text-tool')!.click();
    await vi.waitFor(() => expect(document.querySelector('.toast-stack')?.textContent).toContain('未发现跟踪参数，已复制原文'));
    clipboard.read.mockRejectedValue(new Error('clipboard denied'));
    clipboard.readText.mockRejectedValue(new Error('clipboard denied'));
    button('直接粘贴剪贴板').click();
    await vi.waitFor(() => expect(document.querySelector('.toast.error')?.textContent).toContain('clipboard denied'));
    expect(uploadBlob).not.toHaveBeenCalled();
    expect(draft().value).toBe('https://x.test/?id=3#part');
  });

  it('keeps the switch usable when browser storage is unavailable', async () => {
    await mount();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    toggle().click();
    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });

  it('leaves text unchanged with the default setting and leaves native images unchanged when enabled', async () => {
    await mount();
    setDraft(source);
    button('发送').click();
    await vi.waitFor(() => expect(draft().value).toBe(''));
    expect(lastUploaded()).toBe(source);
    toggle().click();
    clipboard.read.mockResolvedValue([{ types: ['image/png'], getType: async () => new Blob([`${source} image`], { type: 'image/png' }) }]);
    button('直接粘贴剪贴板').click();
    await vi.waitFor(() => expect(uploadBlob).toHaveBeenCalledTimes(2));
    expect(lastUploaded()).toBe(`${source} image`);
    expect(vi.mocked(encryptIndex).mock.lastCall?.[1].clips[0].kind).toBe('image');
  });

  it('downloads full history for clean copy, preserves the record and ordinary copy, and never uploads', async () => {
    vi.stubGlobal('ClipboardItem', undefined);
    const full = `${'内容'.repeat(90)} https://x.test/?id=2&utm_source=x`;
    const clip: ClipEntry = { id: 'history', blobId: 'history', kind: 'text', name: '文本', mime: 'text/plain', preview: full.slice(0, 160), size: new TextEncoder().encode(full).length, encryptedSize: 500, createdAt: 1, updatedAt: 1, expiresAt: null, pinned: true };
    vi.mocked(decryptIndex).mockResolvedValueOnce({ version: 1, clips: [clip], deleted: [], updatedAt: 1 });
    vi.mocked(downloadBlob).mockResolvedValue(new TextEncoder().encode(full));
    await mount();
    document.querySelector<HTMLButtonElement>('.clip-actions [title="净化复制"]')!.click();
    await vi.waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(full.replace('&utm_source=x', '')));
    expect(downloadBlob).toHaveBeenCalledOnce();
    expect(clip.preview).toBe(full.slice(0, 160));
    expect(uploadBlob).not.toHaveBeenCalled();
    expect(saveIndex).not.toHaveBeenCalled();
    button('复制').click();
    await vi.waitFor(() => expect(clipboard.writeText).toHaveBeenLastCalledWith(full));
    expect(downloadBlob).toHaveBeenCalledOnce();
  });
});

describe('dialog keyboard behavior', () => {
  it('traps focus in the QR dialog, closes with Escape and restores the opening control', async () => {
    await mount();
    const opener = button('密钥二维码');
    opener.focus();
    opener.click();
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('dialog'));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const buttons = dialog.querySelectorAll('button');
    buttons[buttons.length - 1].focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(buttons[0]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
    button('增加密钥').focus();
    expect(document.activeElement).toBe(dialog);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('closes the image dialog and restores the opening button', async () => {
    const clip: ClipEntry = { id: 'image', blobId: 'image', kind: 'image', name: '图片', mime: 'image/png', preview: '图片', size: 1, encryptedSize: 30, createdAt: 1, updatedAt: 1, expiresAt: null, pinned: true };
    vi.mocked(decryptIndex).mockResolvedValueOnce({ version: 1, clips: [clip], deleted: [], updatedAt: 1 });
    vi.mocked(downloadBlob).mockResolvedValue(new Uint8Array([1]));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    await mount();
    button('预览').click();
    await vi.waitFor(() => expect(button('查看大图')?.disabled).toBe(false));
    const opener = button('查看大图');
    opener.focus();
    opener.click();
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('data-modal')).toBe('image'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('releases a camera granted after Escape has already closed the scanner', async () => {
    let grant!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn(() => new Promise<MediaStream>((resolve) => { grant = resolve; }));
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    await mount();
    button('增加密钥').click();
    const opener = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('扫描'))!;
    opener.focus();
    opener.click();
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    expect(document.activeElement?.getAttribute('data-modal')).toBe('scanner');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const stop = vi.fn();
    grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
    expect(document.querySelector('.toast-stack')?.textContent).not.toContain('摄像头已打开');
  });
});
