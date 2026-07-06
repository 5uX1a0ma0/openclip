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
      icon: '/icon.svg',
      badge: '/icon.svg',
      data: {
        url: targetUrl,
        groupId: textValue(payload.groupId, ''),
        hash: textValue(payload.hash, '')
      }
    })
  );
});

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
