// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import App from './App';
import { ApiError, fetchIndex, joinRemoteGroup, openIndexEvents } from './api';
import { loadSavedGroups, saveActiveGroupId, saveSavedGroups } from './groups';
import type { SavedGroup } from './types';

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
  decryptIndex: vi.fn(async () => ({ version: 1, clips: [], deleted: [], updatedAt: 1 }))
}));
vi.mock('./api', async (load) => ({
  ...await load<typeof import('./api')>(),
  fetchRuntimeConfig: vi.fn(async () => ({ chunkPlainBytes: 1024, maxBlobBytes: 4096, webPushEnabled: false, vapidPublicKey: '' })),
  fetchIndex: vi.fn(async () => ({ hash: String(fixture.revision), blob: '' })),
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
  fixture.revision = 1;
  localStorage.clear();
  saveSavedGroups([fixture.group]);
  saveActiveGroupId(fixture.group.id);
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});
afterEach(() => { dispose?.(); document.body.replaceChildren(); vi.restoreAllMocks(); });

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
    expect(switches).toHaveLength(1);
    expect(switches[0].closest('header')).not.toBeNull();
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
