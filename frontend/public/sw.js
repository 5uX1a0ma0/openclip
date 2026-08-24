self.addEventListener('install', (event) => {
  event.waitUntil(cacheApplicationShell());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      removeOldCaches(),
      self.clients.claim()
    ])
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(request));
    return;
  }
  if (isCacheableAsset(url.pathname)) {
    event.respondWith(assetResponse(request));
  }
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

self.addEventListener('push', (event) => {
  const payload = parsePushPayload(event.data);
  const title = textValue(payload.title, 'OpenList Clipboard');
  const body = textValue(payload.body, '剪贴板内容已更新');
  const targetUrl = notificationTargetUrl(payload);
  try {
    if (self.navigator?.setAppBadge) {
      event.waitUntil(self.navigator.setAppBadge(1).catch(() => undefined));
    }
  } catch {
    // Badging is best effort and not required for notification delivery.
  }
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: 'openlist-clipboard-update',
      renotify: true,
      icon: '/icon-192.png',
      badge: '/badge-96.png',
      data: {
        url: targetUrl,
        groupId: textValue(payload.groupId, ''),
        hash: textValue(payload.hash, '')
      }
    })
  );
});

const cacheName = 'openclip-shell-v2';
const shellFiles = [
  '/',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/badge.svg',
  '/badge-96.png'
];

async function cacheApplicationShell() {
  const cache = await caches.open(cacheName);
  await Promise.allSettled(shellFiles.map((path) => cache.add(new Request(path, { cache: 'reload' }))));
  try {
    const response = await fetch(new Request('/', { cache: 'reload' }));
    if (!response.ok) {
      return;
    }
    const html = await response.clone().text();
    await cache.put('/', response);
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map((match) => match[1]);
    await Promise.allSettled(assets.map((path) => cache.add(new Request(path, { cache: 'reload' }))));
  } catch {
    // A previous cache can still keep the app available during a failed update.
  }
}

async function removeOldCaches() {
  const names = await caches.keys();
  await Promise.all(names.filter((name) => name.startsWith('openclip-shell-') && name !== cacheName).map((name) => caches.delete(name)));
}

async function navigationResponse(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      void cache.put('/', response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match('/');
    return cached || Response.error();
  }
}

async function assetResponse(request) {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(cacheName);
    void cache.put(request, response.clone());
  }
  return response;
}

function isCacheableAsset(pathname) {
  return pathname.startsWith('/assets/') ||
    pathname === '/manifest.webmanifest' ||
    pathname === '/icon.svg' ||
    pathname === '/badge.svg' ||
    pathname.endsWith('.png');
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return undefined;
    })
  );
});

function parsePushPayload(data) {
  if (!data) {
    return {};
  }
  try {
    const parsed = data.json();
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    try {
      const text = data.text();
      return text ? { body: text } : {};
    } catch {
      return {};
    }
  }
}

function textValue(value, fallback) {
  return typeof value === 'string' && value ? value : fallback;
}

function notificationTargetUrl(payload) {
  const url = textValue(payload.url, '/');
  try {
    const target = new URL(url, self.location.origin);
    return target.origin === self.location.origin ? target.href : new URL('/', self.location.origin).href;
  } catch {
    return new URL('/', self.location.origin).href;
  }
}
