import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAppBadge, clearLegacySyncStorage, isWindows, setAppBadge } from './platform';

afterEach(() => vi.unstubAllGlobals());

describe('application badges', () => {
  it.each([
    { userAgentData: { platform: 'Windows' } },
    { platform: 'Win32' },
    { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  ])('disables new Windows badges and clears old ones: %j', async (platform) => {
    const nav = { ...platform, setAppBadge: vi.fn(), clearAppBadge: vi.fn() };
    expect(isWindows(nav)).toBe(true);
    await setAppBadge(1, nav);
    await clearAppBadge(nav);
    expect(nav.setAppBadge).not.toHaveBeenCalled();
    expect(nav.clearAppBadge).toHaveBeenCalledOnce();
  });

  it('keeps setting and clearing badges on other platforms', async () => {
    const nav = { platform: 'Linux', setAppBadge: vi.fn(), clearAppBadge: vi.fn() };
    await setAppBadge(1, nav);
    await clearAppBadge(nav);
    expect(nav.setAppBadge).toHaveBeenCalledWith(1);
    expect(nav.clearAppBadge).toHaveBeenCalledOnce();
    await expect(setAppBadge(1, {})).resolves.toBeUndefined();
    await expect(clearAppBadge({ clearAppBadge: async () => { throw new Error('denied'); } })).resolves.toBeUndefined();
  });

  it('removes only legacy synchronization storage', () => {
    const entries = new Map([
      ['openlist-clipboard.sync.enabled.v1', '{}'], ['openlist-clipboard.sync.state.v1', '{}'],
      ['openlist.clipboard.groups.v1', 'saved keys'], ['openlist-clipboard.notify.enabled.v1', '{}']
    ]);
    vi.stubGlobal('localStorage', { removeItem: (key: string) => entries.delete(key) });
    clearLegacySyncStorage();
    expect([...entries.keys()]).toEqual(['openlist.clipboard.groups.v1', 'openlist-clipboard.notify.enabled.v1']);
  });

  it.each(['Windows', 'Linux'])('applies the same policy in the service worker on %s', async (platform) => {
    const handlers = new Map<string, (event: unknown) => void>();
    const nav = { userAgentData: { platform }, setAppBadge: vi.fn(async () => {}), clearAppBadge: vi.fn(async () => {}) };
    const showNotification = vi.fn(async () => {});
    const self = {
      navigator: nav, location: { origin: 'https://clipboard.example' },
      addEventListener: (type: string, handler: (event: unknown) => void) => handlers.set(type, handler),
      clients: { claim: async () => {} }, registration: { showNotification }
    };
    runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), {
      self, URL, caches: { keys: async () => [], delete: async () => {} }
    });
    const waits: Promise<unknown>[] = [];
    handlers.get('activate')!({ waitUntil: (task: Promise<unknown>) => waits.push(task) });
    handlers.get('push')!({ data: { json: () => ({ body: 'update' }) }, waitUntil: (task: Promise<unknown>) => waits.push(task) });
    await Promise.all(waits);
    expect(nav.setAppBadge).toHaveBeenCalledTimes(platform === 'Windows' ? 0 : 1);
    expect(nav.clearAppBadge).toHaveBeenCalledTimes(platform === 'Windows' ? 1 : 0);
    expect(showNotification).toHaveBeenCalledWith('OpenList Clipboard', expect.objectContaining({ badge: '/badge-96.png', body: 'update' }));
  });
});
