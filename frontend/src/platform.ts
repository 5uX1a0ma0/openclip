type BadgeNavigator = {
  userAgent?: string;
  platform?: string;
  userAgentData?: { platform?: string };
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

export function isWindows(nav: BadgeNavigator = navigator): boolean {
  return /Windows|Win32|Win64|WinCE/i.test(`${nav.userAgentData?.platform || ''} ${nav.platform || ''} ${nav.userAgent || ''}`);
}

export async function setAppBadge(count: number, nav: BadgeNavigator = navigator) {
  if (isWindows(nav) || typeof nav.setAppBadge !== 'function') return;
  try {
    await nav.setAppBadge(count);
  } catch {
    // Badging is optional and must not prevent notification delivery.
  }
}

export async function clearAppBadge(nav: BadgeNavigator = navigator) {
  try {
    await nav.clearAppBadge?.();
  } catch {
    // Also clear legacy badges on Windows, where new badges are disabled.
  }
}

export function clearLegacySyncStorage() {
  for (const key of ['openlist-clipboard.sync.enabled.v1', 'openlist-clipboard.sync.state.v1']) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Storage may be disabled by site settings.
    }
  }
}
