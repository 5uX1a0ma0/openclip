import {
  Bell,
  Camera,
  Clipboard as ClipboardIcon,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileIcon,
  FileText,
  ImageIcon,
  Loader2,
  Maximize2,
  Pin,
  PinOff,
  Plus,
  QrCode,
  RefreshCw,
  Send,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Upload,
  X
} from 'lucide-solid';
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import {
  apiErrorStatus,
  createRemoteGroup,
  deleteBlob,
  downloadBlob,
  fetchIndex,
  isFatalAuthOrGroupError,
  deletePushSubscription,
  fetchRuntimeConfig,
  joinRemoteGroup,
  openIndexEvents,
  remoteClipboardUnavailableMessage,
  saveIndex,
  savePushSubscription,
  uploadBlob
} from './api';
import {
  type CachedEncryptedChunk,
  createEncryptedClipCache,
  encryptedCacheKey,
  readEncryptedClipCacheChunk,
  readEncryptedClipCache,
  writeEncryptedClipCacheChunk
} from './blob_cache';
import {
  type PlainClipInput,
  type RichClipboard,
  clipboardContainsAppPayload,
  clipboardFilesFromPaste,
  readAppClipboardInput,
  readSystemClipboardInput,
  tryReadAppClipboardInput,
  writeBinaryClipToClipboard,
  writeTextClipToClipboard
} from './clipboard';
import { clearAppBadge, setAppBadge, clearLegacySyncStorage } from './platform';
import { runOrderedChunkPipeline } from './chunk_pipeline';
import {
  base64UrlToBytes,
  bytesToArrayBuffer,
  bytesToBase64Url,
  decryptBytes,
  decryptIndex,
  emptyIndex,
  encryptBytes,
  encryptIndex,
  mergeIndexes,
  webCryptoUnavailableReason
} from './crypto';
import { closeCryptoWorker, decryptChunkBytesFast, encryptChunkBytesFast } from './crypto_worker_client';
import {
  activateGroup,
  activeGroupId,
  createSavedGroup,
  isInviteText,
  loadSavedGroups,
  removeGroup,
  saveActiveGroupId,
  saveSavedGroups,
  savedGroupFromInvite,
  upsertGroup
} from './groups';
import { decodeQRCodeFromCanvas, qrCodeDataURL } from './qr';
import { closeSha256Worker, sha256BlobFast } from './sha256_worker_client';
import { cleanTrackingLinks } from './tracking_links';
import type { ActiveGroup, ClipChunk, ClipEntry, ClipIndex, IndexEvent, RuntimeConfig, SavedGroup } from './types';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const retentionMs = 30 * 24 * 60 * 60 * 1000;
const maxClientPlainBytes = 512 * 1024 * 1024;
const defaultMaxBlobBytes = 50 * 1024 * 1024;
const legacyDedupeMaxBytes = 2 * 1024 * 1024;
const legacyDedupeMaxCandidates = 20;
const defaultChunkPlainBytes = 4 * 1024 * 1024;
const chunkedEncryption = 'aes-gcm-chunked-v1';
const cryptoUnavailable = webCryptoUnavailableReason();
const notificationEnabledStorageKey = 'openlist-clipboard.notify.enabled.v1';
const cleanBeforeUploadStorageKey = 'openlist-clipboard.clean-before-upload.v1';
const clientIdStorageKey = 'openlist-clipboard.client-id.v1';
const scannerMaxEdge = 640;
const scannerScanIntervalMs = 120;
const maxTextPreviewChars = 160;
const maxToastCount = 3;
const maxPlainCacheEntries = 8;
const maxPlainCacheBytes = 8 * 1024 * 1024;
const maxChunkCryptoConcurrency = 3;
const notificationTitle = 'OpenList Clipboard';
const updateNotificationBody = '剪贴板内容已更新';
type LiveState = 'offline' | 'connecting' | 'live';
type IndexStream = { close: () => void };
type NotificationSupportState = NotificationPermission | 'unsupported';
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};
type ToastKind = 'success' | 'error' | 'info';
type ToastMessage = {
  id: number;
  kind: ToastKind;
  message: string;
};
type PersistentNotice = {
  kind: 'info' | 'error';
  message: string;
};
type SaveOutcome = {
  clip: ClipEntry;
  contentHash: string;
  mode: 'created' | 'promoted' | 'unchanged';
};
type UploadedEncryptedInput = {
  id: string;
  blobId: string;
  encryptedSize: number;
  encryption?: ClipEntry['encryption'];
  chunkSetId?: string;
  chunkSize?: number;
  chunks?: ClipChunk[];
};
type ExpandedTextState = {
  loading?: boolean;
  text?: string;
  error?: string;
};
const clientId = loadClientId();

export default function App() {
  const [groups, setGroups] = createSignal<SavedGroup[]>([]);
  const [activeGroup, setActiveGroup] = createSignal<ActiveGroup | null>(null);
  const [groupName, setGroupName] = createSignal('');
  const [createPassword, setCreatePassword] = createSignal('');
  const [inviteInput, setInviteInput] = createSignal('');
  const [index, setIndex] = createSignal<ClipIndex>(emptyIndex());
  const [baseHash, setBaseHash] = createSignal('');
  const [textDraft, setTextDraft] = createSignal('');
  const [cleanBeforeUpload, setCleanBeforeUpload] = createSignal(loadCleanBeforeUpload());
  const [busy, setBusy] = createSignal(false);
  const [operationLabel, setOperationLabel] = createSignal('');
  const [persistentNotice, setPersistentNotice] = createSignal<PersistentNotice | null>(null);
  const [toasts, setToasts] = createSignal<ToastMessage[]>([]);
  const [runtimeConfig, setRuntimeConfig] = createSignal<RuntimeConfig>({
    chunkPlainBytes: defaultChunkPlainBytes,
    maxBlobBytes: defaultMaxBlobBytes,
    webPushEnabled: false,
    vapidPublicKey: ''
  });
  const [previewUrls, setPreviewUrls] = createSignal<Record<string, string>>({});
  const [expandedText, setExpandedText] = createSignal<Record<string, ExpandedTextState>>({});
  const [previewModalClipId, setPreviewModalClipId] = createSignal('');
  const [inviteQR, setInviteQR] = createSignal('');
  const [showInviteQR, setShowInviteQR] = createSignal(false);
  const [scannerOpen, setScannerOpen] = createSignal(false);
  const [scannedInvite, setScannedInvite] = createSignal('');
  const [liveState, setLiveState] = createSignal<LiveState>('offline');
  const [clipboardNotifyEnabled, setClipboardNotifyEnabled] = createSignal(false);
  const [notificationPermission, setNotificationPermission] = createSignal<NotificationSupportState>(notificationPermissionState());
  const [installPrompt, setInstallPrompt] = createSignal<BeforeInstallPromptEvent | null>(null);
  const [serviceWorkerUpdateReady, setServiceWorkerUpdateReady] = createSignal(false);

  let scannerVideo: HTMLVideoElement | undefined;
  let scannerCanvas: HTMLCanvasElement | undefined;
  let serviceWorkerRegistration: ServiceWorkerRegistration | null = null;
  let reloadingForServiceWorker = false;
  let scannerStream: MediaStream | null = null;
  let scannerFrame = 0;
  let scannerDone = false;
  let scannerLastScanAt = 0;
  let scannerRequestID = 0;
  let modalOpener: HTMLElement | null = null;
  let pendingModalFocus: HTMLElement | null = null;
  let indexStream: IndexStream | null = null;
  let indexEventsVersion = 0;
  let reconnectBlockedGroupID = '';
  let liveRefreshRunning = false;
  let queuedIndexHash = '';
  let activeUpdateNotification: Notification | null = null;
  let lastNotifiedGroupID = '';
  let lastNotifiedIndexHash = '';
  let toastID = 0;
  const toastTimers = new Map<number, number>();
  const plainCache = new Map<string, Uint8Array>();

  const unlocked = createMemo(() => activeGroup() !== null);
  const activeClips = createMemo(() =>
    index()
      .clips.filter((clip) => !isExpired(clip))
      .sort((a, b) => clipSortTime(b) - clipSortTime(a))
  );
  const textPreviewState = createMemo<Record<string, ExpandedTextState>>(() => {
    const expanded = expandedText();
    const visibleText: Record<string, ExpandedTextState> = {};
    for (const clip of activeClips()) {
      if (clip.kind !== 'text') {
        continue;
      }
      const current = expanded[clip.id];
      if (current) {
        visibleText[clip.id] = current;
        continue;
      }
      if (isCompleteTextPreview(clip)) {
        visibleText[clip.id] = { text: clip.preview };
      }
    }
    return visibleText;
  });
  const previewModalClip = createMemo(() => activeClips().find((clip) => clip.id === previewModalClipId()) || null);
  const activeModal = createMemo(() => showInviteQR() ? 'qr' : scannerOpen() ? 'scanner' : previewModalClip() ? 'image' : '');
  const createFormHint = createMemo(() => {
    if (cryptoUnavailable) {
      return '';
    }
    const missingName = groupName().trim().length === 0;
    const missingPassword = createPassword().trim().length === 0;
    if (missingName && missingPassword) {
      return '请输入剪贴板名称和创建密码。';
    }
    if (missingName) {
      return '请输入剪贴板名称。';
    }
    if (missingPassword) {
      return '请输入创建密码。';
    }
    return '';
  });
  const canCreateGroup = createMemo(() => !cryptoUnavailable && groupName().trim().length > 0 && createPassword().trim().length > 0);
  const notificationToggleTitle = createMemo(() => {
    if (!clipboardNotifyEnabled()) {
      return '远端更新通知';
    }
    const permission = notificationPermission();
    if (permission === 'granted') {
      const config = runtimeConfig();
      return config.webPushEnabled && config.vapidPublicKey && webPushAvailability().available
        ? '远端更新通知：后台推送'
        : '远端更新通知：打开页面时系统通知';
    }
    if (permission === 'denied') {
      return '远端更新通知：系统通知已被拒绝，将使用页内提示';
    }
    if (permission === 'unsupported') {
      return `远端更新通知：${notificationUnavailableMessage()}，将使用页内提示`;
    }
    return '远端更新通知：未授予系统通知权限，将使用页内提示';
  });

  onMount(async () => {
    void loadRuntimeConfig();
    void registerServiceWorker();
    clearLegacySyncStorage();
    void clearAppBadge();
    window.addEventListener('paste', handlePaste);
    window.addEventListener('dragover', preventDefault);
    window.addEventListener('drop', handleDrop);
    window.addEventListener('focus', handleWindowFocus);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    if (cryptoUnavailable) {
      setPersistentNotice({ kind: 'error', message: cryptoUnavailable });
    }
    const saved = loadSavedGroups();
    setGroups(saved);
    const initial = saved.find((group) => group.id === activeGroupId()) || saved[0];
    if (initial && !cryptoUnavailable) {
      await run(() => activateExistingGroup(initial), '已打开剪贴板');
    }
  });

  createEffect(() => {
    const group = activeGroup();
    if (!group) {
      closeIndexEvents();
      return;
    }
    connectIndexEvents(group);
  });

  createEffect(() => {
    const modal = activeModal();
    if (!modal) return;
    const opener = modalOpener || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    let closed = false;
    queueMicrotask(() => {
      if (!closed) document.querySelector<HTMLElement>(`.modal-panel[data-modal="${modal}"]`)?.focus();
    });
    function handleModalKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeModal(modal);
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = document.querySelector<HTMLElement>(`.modal-panel[data-modal="${modal}"]`);
      const items = [...(panel?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])') || [])];
      if (!items.length) { event.preventDefault(); panel?.focus(); return; }
      if (event.shiftKey && (document.activeElement === items[0] || document.activeElement === panel)) {
        event.preventDefault(); items[items.length - 1].focus();
      } else if (!event.shiftKey && document.activeElement === items[items.length - 1]) {
        event.preventDefault(); items[0].focus();
      }
    }
    function keepModalFocus(event: FocusEvent) {
      const panel = document.querySelector<HTMLElement>(`.modal-panel[data-modal="${modal}"]`);
      if (panel && event.target instanceof Node && !panel.contains(event.target)) panel.focus();
    }
    document.addEventListener('keydown', handleModalKeyDown);
    document.addEventListener('focusin', keepModalFocus);
    onCleanup(() => {
      closed = true;
      document.removeEventListener('keydown', handleModalKeyDown);
      document.removeEventListener('focusin', keepModalFocus);
      document.documentElement.style.overflow = previousOverflow;
      modalOpener = null;
      if (opener?.isConnected) {
        pendingModalFocus = opener;
        queueMicrotask(restoreModalFocus);
      }
    });
  });

  createEffect(() => {
    if (!busy()) queueMicrotask(restoreModalFocus);
  });

  function restoreModalFocus() {
    if (activeModal()) return;
    const target = pendingModalFocus;
    if (!target?.isConnected) {
      pendingModalFocus = null;
      return;
    }
    if (target.matches(':disabled')) return;
    pendingModalFocus = null;
    target.focus();
  }

  function closeModal(modal: string) {
    if (modal === 'qr') setShowInviteQR(false);
    if (modal === 'scanner') stopInviteScanner();
    if (modal === 'image') setPreviewModalClipId('');
  }

  function rememberModalOpener() {
    if (!activeModal()) modalOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  createEffect(() => {
    const group = activeGroup();
    const config = runtimeConfig();
    if (group && clipboardNotifyEnabled() && config.webPushEnabled && notificationPermissionState() === 'granted' && webPushAvailability().available) {
      void ensurePushSubscription(group);
    }
  });

  onCleanup(() => {
    window.removeEventListener('paste', handlePaste);
    window.removeEventListener('dragover', preventDefault);
    window.removeEventListener('drop', handleDrop);
    window.removeEventListener('focus', handleWindowFocus);
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
    window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.removeEventListener('appinstalled', handleAppInstalled);
    navigator.serviceWorker?.removeEventListener('controllerchange', handleServiceWorkerControllerChange);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    closeIndexEvents();
    closeUpdateNotification();
    stopInviteScanner();
    closeCryptoWorker();
    closeSha256Worker();
    plainCache.clear();
    Object.values(previewUrls()).forEach(URL.revokeObjectURL);
    toastTimers.forEach((timer) => window.clearTimeout(timer));
    toastTimers.clear();
  });

  async function loadRuntimeConfig() {
    try {
      const config = await fetchRuntimeConfig();
      const maxBlobBytes = config.maxBlobBytes;
      setRuntimeConfig({
        chunkPlainBytes: Number.isFinite(config.chunkPlainBytes) && config.chunkPlainBytes > 0 ? config.chunkPlainBytes : defaultChunkPlainBytes,
        maxBlobBytes: typeof maxBlobBytes === 'number' && Number.isFinite(maxBlobBytes) && maxBlobBytes > 0 ? maxBlobBytes : defaultMaxBlobBytes,
        webPushEnabled: config.webPushEnabled === true,
        vapidPublicKey: config.vapidPublicKey || ''
      });
    } catch {
      setRuntimeConfig({ chunkPlainBytes: defaultChunkPlainBytes, maxBlobBytes: defaultMaxBlobBytes, webPushEnabled: false, vapidPublicKey: '' });
    }
  }

  async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) {
      return null;
    }
    try {
      const registration = await navigator.serviceWorker.register('/sw.js');
      serviceWorkerRegistration = registration;
      watchServiceWorkerRegistration(registration);
      navigator.serviceWorker.addEventListener('controllerchange', handleServiceWorkerControllerChange);
      return registration;
    } catch {
      return null;
    }
  }

  function watchServiceWorkerRegistration(registration: ServiceWorkerRegistration) {
    if (registration.waiting) {
      setServiceWorkerUpdateReady(true);
    }
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      if (!worker) {
        return;
      }
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          setServiceWorkerUpdateReady(true);
        }
      });
    });
  }

  function handleBeforeInstallPrompt(event: Event) {
    event.preventDefault();
    if (!isStandaloneWebApp()) {
      setInstallPrompt(event as BeforeInstallPromptEvent);
    }
  }

  function handleAppInstalled() {
    setInstallPrompt(null);
  }

  async function installApp() {
    const prompt = installPrompt();
    if (!prompt) {
      return;
    }
    setInstallPrompt(null);
    await prompt.prompt();
    await prompt.userChoice;
  }

  function applyServiceWorkerUpdate() {
    const worker = serviceWorkerRegistration?.waiting;
    if (!worker) {
      setServiceWorkerUpdateReady(false);
      return;
    }
    worker.postMessage({ type: 'SKIP_WAITING' });
  }

  function handleServiceWorkerControllerChange() {
    if (reloadingForServiceWorker) {
      return;
    }
    reloadingForServiceWorker = true;
    window.location.reload();
  }

  async function createGroupAction(event: Event) {
    event.preventDefault();
    if (!canCreateGroup()) {
      showToast(createFormHint() || '请填写创建剪贴板所需信息。', 'error');
      return;
    }
    await run(async () => {
      const saved = await createSavedGroup(groupName());
      const remote = await createRemoteGroup(saved.id, saved.name, saved.keyHash, saved.publicKeyJwk, createPassword());
      const opened = { ...saved, name: remote.name, updatedAt: Date.now() };
      const next = upsertGroup(groups(), opened);
      setGroups(next);
      saveSavedGroups(next);
      setGroupName('');
      setCreatePassword('');
      await activateExistingGroup(opened);
    }, '剪贴板已创建');
  }

  async function importGroupAction(event?: Event) {
    event?.preventDefault();
    await run(async () => {
      const saved = await savedGroupFromInvite(inviteInput(), groupName());
      const remote = await joinRemoteGroup(saved.id, saved.keyHash, saved.publicKeyJwk);
      const joined = { ...saved, name: remote.name, updatedAt: Date.now() };
      const next = upsertGroup(groups(), joined);
      setGroups(next);
      saveSavedGroups(next);
      setGroupName('');
      setInviteInput('');
      setScannedInvite('');
      await activateExistingGroup(joined);
    }, '已加入剪贴板');
  }

  async function activateExistingGroup(saved: SavedGroup) {
    const opened = await activateGroup(saved);
    closeIndexEvents();
    clearPreviewUrls();
    clearExpandedText();
    plainCache.clear();
    closeUpdateNotification();
    reconnectBlockedGroupID = '';
    lastNotifiedGroupID = '';
    lastNotifiedIndexHash = '';
    setActiveGroup(opened);
    setClipboardNotifyEnabled(loadNotificationEnabled(opened.id));
    setNotificationPermission(notificationPermissionState());
    saveActiveGroupId(opened.id);
    setIndex(emptyIndex());
    setBaseHash('');
    await loadIndex(opened);
    void clearAppBadge();
    if (loadNotificationEnabled(opened.id) && webPushAvailability().available) {
      void ensurePushSubscription(opened);
    }
  }

  function leaveGroup() {
    closeIndexEvents();
    clearPreviewUrls();
    clearExpandedText();
    plainCache.clear();
    closeUpdateNotification();
    reconnectBlockedGroupID = '';
    lastNotifiedGroupID = '';
    lastNotifiedIndexHash = '';
    setActiveGroup(null);
    setClipboardNotifyEnabled(false);
    saveActiveGroupId('');
    setIndex(emptyIndex());
    setBaseHash('');
    setTextDraft('');
    setPreviewModalClipId('');
    setPersistentNotice(null);
    void clearAppBadge();
  }

  function removeActiveGroup() {
    const group = activeGroup();
    if (!group) {
      return;
    }
    if (!window.confirm(`忘记“${group.name}”在本机保存的剪贴板密钥？之后需要重新输入密钥才能加入。`)) {
      return;
    }
    const next = removeGroup(groups(), group.id);
    setGroups(next);
    saveSavedGroups(next);
    leaveGroup();
    showToast('已从本机移除此剪贴板', 'success');
  }

  async function switchGroup(groupID: string) {
    const saved = groups().find((group) => group.id === groupID);
    if (!saved) {
      return;
    }
    await run(() => activateExistingGroup(saved), '已切换剪贴板');
  }

  async function showInviteCodeQR() {
    rememberModalOpener();
    const group = requireGroup();
    await run(async () => {
      setInviteQR(await qrCodeDataURL(group.invite));
      setShowInviteQR(true);
    }, '二维码已生成');
  }

  async function copyInviteKey() {
    await run(async () => {
      const nav = requireClipboardAccess();
      if (typeof nav.writeText !== 'function') {
        throw new Error('当前浏览器不支持复制文本。');
      }
      await nav.writeText(requireGroup().invite);
    }, '剪贴板密钥已复制', '复制中');
  }

  async function startInviteScanner() {
    if (cryptoUnavailable) {
      showToast(cryptoUnavailable, 'error');
      return;
    }
    rememberModalOpener();
    const requestID = ++scannerRequestID;
    await run(async () => {
      stopInviteScannerStream();
      setScannedInvite('');
      setScannerOpen(true);
      try {
        await nextAnimationFrame();
        if (!scannerOpen() || requestID !== scannerRequestID) return false;
        if (!scannerVideo || !scannerCanvas) {
          throw new Error('二维码扫描器尚未就绪。');
        }
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('当前浏览器不能使用摄像头扫描。');
        }
        scannerDone = false;
        scannerLastScanAt = 0;
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false
        });
        if (!scannerOpen() || requestID !== scannerRequestID) {
          stream.getTracks().forEach((track) => track.stop());
          return false;
        }
        scannerStream = stream;
        scannerVideo.srcObject = scannerStream;
        await scannerVideo.play();
        scannerFrame = requestAnimationFrame(scanInviteFrame);
      } catch (err) {
        if (requestID !== scannerRequestID) return false;
        stopInviteScanner();
        throw err;
      }
    }, '摄像头已打开');
  }

  function scanInviteFrame(now = 0) {
    if (!scannerOpen() || scannerDone || !scannerVideo || !scannerCanvas) {
      return;
    }
    if (now - scannerLastScanAt < scannerScanIntervalMs) {
      scannerFrame = requestAnimationFrame(scanInviteFrame);
      return;
    }
    scannerLastScanAt = now;
    if (scannerVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && scannerVideo.videoWidth > 0) {
      const scale = Math.min(1, scannerMaxEdge / Math.max(scannerVideo.videoWidth, scannerVideo.videoHeight));
      scannerCanvas.width = Math.max(1, Math.round(scannerVideo.videoWidth * scale));
      scannerCanvas.height = Math.max(1, Math.round(scannerVideo.videoHeight * scale));
      const context = scannerCanvas.getContext('2d', { willReadFrequently: true });
      if (context) {
        context.drawImage(scannerVideo, 0, 0, scannerCanvas.width, scannerCanvas.height);
        const decoded = decodeQRCodeFromCanvas(scannerCanvas);
        if (decoded) {
          if (!isInviteText(decoded)) {
            scannerDone = true;
            stopInviteScanner();
            showToast('二维码不是有效的剪贴板密钥。', 'error');
            return;
          } else {
            scannerDone = true;
            stopInviteScannerStream();
            setInviteInput(decoded);
            setScannedInvite(decoded);
            showToast('已识别剪贴板密钥，请确认后加入。', 'info');
            return;
          }
        }
      }
    }
    scannerFrame = requestAnimationFrame(scanInviteFrame);
  }

  function stopInviteScanner() {
    scannerRequestID += 1;
    stopInviteScannerStream();
    setScannerOpen(false);
    setScannedInvite('');
  }

  function stopInviteScannerStream() {
    if (scannerFrame) {
      cancelAnimationFrame(scannerFrame);
      scannerFrame = 0;
    }
    if (scannerStream) {
      scannerStream.getTracks().forEach((track) => track.stop());
      scannerStream = null;
    }
    if (scannerVideo) {
      scannerVideo.srcObject = null;
    }
  }

  async function joinScannedInvite() {
    const decoded = scannedInvite();
    if (!decoded) {
      return;
    }
    setInviteInput(decoded);
    stopInviteScanner();
    await importGroupAction();
  }

  async function loadIndex(group = activeGroup()) {
    if (!group) {
      return;
    }
    await refreshIndex(group, true);
  }

  async function refreshIndex(group: ActiveGroup, forceCleanup = false): Promise<boolean> {
    try {
      const response = await fetchIndex(group);
      if (activeGroup()?.id !== group.id) return false;
      if (response.hash === baseHash()) {
        if (forceCleanup) {
          await cleanupExpired(index(), group, response.hash);
        }
        return false;
      }
      const decrypted = await decryptIndex(group.vaultCryptoKey, response.blob);
      if (activeGroup()?.id !== group.id) return false;
      setBaseHash(response.hash);
      setIndex(decrypted);
      await cleanupExpired(decrypted, group, response.hash);
      return true;
    } catch (err) {
      handleRemoteFatalError(err, group);
      throw err;
    }
  }

  function connectIndexEvents(group: ActiveGroup) {
    if (reconnectBlockedGroupID === group.id) {
      setLiveState('offline');
      setPersistentNotice({ kind: 'error', message: remoteClipboardUnavailableMessage });
      return;
    }
    closeIndexEvents();
    const version = indexEventsVersion + 1;
    indexEventsVersion = version;
    queuedIndexHash = '';
    liveRefreshRunning = false;

    indexStream = openIndexEvents(
      group,
      (event) => handleIndexEvent(event, group, version),
      (state) => {
        if (version === indexEventsVersion) {
          setLiveState(state);
          if (state === 'connecting') {
            setPersistentNotice({ kind: 'info', message: '正在连接实时更新' });
          } else if (state === 'live') {
            setPersistentNotice(null);
          }
        }
      },
      (message, terminal, err) => {
        if (version === indexEventsVersion) {
          if (terminal) {
            if (!handleRemoteFatalError(err, group, message)) {
              stopRemoteReconnect(group, message);
            }
            return;
          }
          setPersistentNotice({ kind: 'info', message });
        }
      }
    );
  }

  function closeIndexEvents() {
    indexEventsVersion += 1;
    queuedIndexHash = '';
    liveRefreshRunning = false;
    if (indexStream) {
      const stream = indexStream;
      indexStream = null;
      stream.close();
    }
    setLiveState('offline');
  }

  function handleIndexEvent(event: IndexEvent, group: ActiveGroup, version: number) {
    if (version !== indexEventsVersion || event.hash === baseHash()) {
      return;
    }
    queueIndexRefresh(group, event.hash, version);
  }

  function queueIndexRefresh(group: ActiveGroup, nextHash: string, version: number) {
    if (!nextHash || nextHash === baseHash()) {
      return;
    }
    queuedIndexHash = nextHash;
    if (liveRefreshRunning) {
      return;
    }
    liveRefreshRunning = true;
    void (async () => {
      let changed = false;
      try {
        while (version === indexEventsVersion && queuedIndexHash && queuedIndexHash !== baseHash()) {
          queuedIndexHash = '';
          changed = (await refreshIndex(group)) || changed;
        }
        if (changed) {
          notifyRemoteClipboardUpdated(group);
        }
      } catch (err) {
        if (version === indexEventsVersion) {
          if (handleRemoteFatalError(err, group)) {
            return;
          }
          showToast(displayError(err), 'error');
        }
      } finally {
        liveRefreshRunning = false;
        if (version === indexEventsVersion && queuedIndexHash && queuedIndexHash !== baseHash()) {
          queueIndexRefresh(group, queuedIndexHash, version);
        }
      }
    })();
  }

  async function persist(next: ClipIndex, group = activeGroup(), hash = baseHash()) {
    if (!group) {
      throw new Error('请先打开一个剪贴板');
    }
    const encrypted = await encryptIndex(group.vaultCryptoKey, next);
    try {
      const saved = await saveIndex(group, hash, encrypted, clientId);
      setIndex(next);
      setBaseHash(saved.hash);
      return;
    } catch (err) {
      if (apiErrorStatus(err) !== 409) {
        handleRemoteFatalError(err, group);
        throw err;
      }
    }

    try {
      const remote = await fetchIndex(group);
      const remoteIndex = await decryptIndex(group.vaultCryptoKey, remote.blob);
      const merged = mergeIndexes(remoteIndex, next);
      const mergedBlob = await encryptIndex(group.vaultCryptoKey, merged);
      const saved = await saveIndex(group, remote.hash, mergedBlob, clientId);
      setIndex(merged);
      setBaseHash(saved.hash);
    } catch (err) {
      handleRemoteFatalError(err, group);
      throw err;
    }
  }

  async function addText() {
    const value = textDraft();
    if (!value.trim()) {
      return;
    }
    await run(async () => {
      const bytes = textEncoder.encode(value);
      const outcome = await addPlainBytes({
        source: { bytes },
        size: bytes.byteLength,
        kind: 'text',
        name: '文本',
        mime: 'text/plain;charset=utf-8',
        preview: textPreview(value)
      });
      setTextDraft('');
      return saveOutcomeMessage(outcome, '已保存');
    }, '已保存', '保存中');
  }

  async function addFile(file: File) {
    await addFiles([file]);
  }

  async function addFiles(files: File[]) {
    if (files.length === 0) {
      return;
    }
    await run(() => saveFileInputs(files, '已上传'), files.length === 1 ? '已上传' : `已处理 ${files.length} 个文件`, '上传中');
  }

  async function pasteFiles(files: File[]) {
    await run(async () => {
      const appInput = await tryReadAppClipboardInput(files);
      if (appInput) {
        const outcome = await addPlainBytes(appInput);
        return saveOutcomeMessage(outcome, '已粘贴');
      }
      return saveFileInputs(files, '已粘贴');
    }, files.length === 1 ? '已粘贴' : `已处理 ${files.length} 个文件`, '粘贴中');
  }

  async function pasteAppClipboardPayload() {
    await run(async () => {
      const appInput = await readAppClipboardInput();
      const outcome = await addPlainBytes(appInput);
      return saveOutcomeMessage(outcome, '已粘贴');
    }, '已粘贴', '粘贴中');
  }

  async function saveFileInputs(files: File[], createdMessage: string): Promise<string> {
    const outcomes: SaveOutcome[] = [];
    for (const file of files) {
      outcomes.push(await addFileInput(file));
    }
    if (outcomes.length === 1) {
      const [outcome] = outcomes;
      return saveOutcomeMessage(outcome, createdMessage);
    }
    if (outcomes.every((outcome) => outcome.mode === 'unchanged')) {
      return '内容已是最新';
    }
    return `已处理 ${outcomes.length} 个文件`;
  }

  async function addFileInput(file: File): Promise<SaveOutcome> {
    if (file.size > maxClientPlainBytes) {
      throw new Error(`单条内容不能超过 ${formatSize(maxClientPlainBytes)}，请拆成更小的内容后再保存。`);
    }
    return addPlainBytes({
      source: { file },
      size: file.size,
      kind: file.type.startsWith('image/') ? 'image' : 'file',
      name: file.name || 'clipboard.bin',
      mime: file.type || 'application/octet-stream',
      preview: file.type.startsWith('image/') ? file.name || '图片' : file.name || '文件'
    });
  }

  function handleFileInputChange(input: HTMLInputElement) {
    const files = [...(input.files || [])];
    input.value = '';
    void addFiles(files);
  }

  function handleComposerKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || (!event.ctrlKey && !event.metaKey)) {
      return;
    }
    event.preventDefault();
    if (!busy() && textDraft().trim()) {
      void addText();
    }
  }

  async function addPlainBytes(input: PlainClipInput): Promise<SaveOutcome> {
    if (cleanBeforeUpload() && input.kind === 'text') {
      const original = textDecoder.decode(await readPlainInput(input));
      const cleaned = cleanTrackingLinks(original).text;
      if (cleaned !== original) {
        const bytes = textEncoder.encode(cleaned);
        input = { ...input, source: { bytes }, size: bytes.byteLength, preview: textPreview(cleaned), contentHash: undefined };
      }
    }
    return saveOrPromoteClip(input);
  }

  function toggleCleanBeforeUpload() {
    const enabled = !cleanBeforeUpload();
    setCleanBeforeUpload(enabled);
    try { localStorage.setItem(cleanBeforeUploadStorageKey, enabled ? 'true' : 'false'); } catch { /* Session state still works. */ }
  }

  async function copyCleanText(loadText: () => Promise<string>) {
    await run(async () => {
      const nav = requireClipboardAccess();
      let result = cleanTrackingLinks('');
      await writeTextClipToClipboard(nav, async () => {
        result = cleanTrackingLinks(await loadText());
        return result.text;
      });
      return result.removedParams
        ? `已净化复制：清理 ${result.changedLinks} 个链接、${result.removedParams} 个参数`
        : '未发现跟踪参数，已复制原文';
    }, '已复制', '复制中');
  }

  function normalizedChunkSize() {
    const configured = runtimeConfig().chunkPlainBytes;
    if (!Number.isFinite(configured) || configured <= 0) {
      return defaultChunkPlainBytes;
    }
    return Math.max(1, Math.min(Math.floor(configured), maxClientPlainBytes));
  }

  async function uploadEncryptedInput(group: ActiveGroup, input: PlainClipInput, contentHash: string): Promise<UploadedEncryptedInput> {
    const chunkSize = normalizedChunkSize();
    if (input.size <= chunkSize) {
      const plain = await readPlainInput(input);
      const encrypted = await encryptBytes(group.vaultCryptoKey, plain);
      const uploaded = await guardRemoteOperation(group, () => uploadBlob(group, encrypted));
      rememberPlainBytes(group.id, uploaded.clipId, plain);
      return {
        id: uploaded.clipId,
        blobId: uploaded.clipId,
        encryptedSize: encrypted.byteLength,
        encryption: 'aes-gcm-v1'
      };
    }

    const cacheKey = encryptedCacheKey(group.id, contentHash, input.size, chunkSize);
    const chunkCount = Math.ceil(input.size / chunkSize);
    const cached = await readEncryptedClipCache(cacheKey);
    const chunkSetId = cached?.chunkCount === chunkCount ? cached.chunkSetId : randomCacheToken();
    await createEncryptedClipCache({
      key: cacheKey,
      groupId: group.id,
      contentHash,
      size: input.size,
      chunkSize,
      chunkSetId,
      chunkCount
    });
    const uploadedBlobIds: string[] = [];
    let chunks: ClipChunk[];
    try {
      chunks = await runOrderedChunkPipeline(
        chunkCount,
        chunkCryptoConcurrency(),
        async (index) => prepareEncryptedChunk(group, input, cacheKey, chunkSetId, chunkSize, index),
        async (cachedChunk) => {
          const uploaded = await guardRemoteOperation(group, () => uploadBlob(group, cachedChunk.encrypted));
          uploadedBlobIds.push(uploaded.clipId);
          return {
            blobId: uploaded.clipId,
            size: cachedChunk.plainSize,
            encryptedSize: cachedChunk.encryptedSize
          };
        }
      );
    } catch (error) {
      await Promise.allSettled(uploadedBlobIds.map((blobId) => deleteBlob(group, blobId)));
      throw error;
    }
    const encryptedSize = chunks.reduce((sum, chunk) => sum + chunk.encryptedSize, 0);
    const first = chunks[0];
    if (!first) {
      throw new Error('分片上传没有生成任何内容。');
    }
    if (input.source.bytes) {
      rememberPlainBytes(group.id, first.blobId, input.source.bytes);
    }
    return {
      id: first.blobId,
      blobId: first.blobId,
      encryptedSize,
      encryption: chunkedEncryption,
      chunkSetId,
      chunkSize,
      chunks
    };
  }

  async function prepareEncryptedChunk(
    group: ActiveGroup,
    input: PlainClipInput,
    cacheKey: string,
    chunkSetId: string,
    chunkSize: number,
    index: number
  ): Promise<CachedEncryptedChunk> {
    const offset = index * chunkSize;
    const size = Math.min(chunkSize, input.size - offset);
    const cached = await readEncryptedClipCacheChunk(cacheKey, index);
    if (
      cached &&
      cached.index === index &&
      cached.chunkSetId === chunkSetId &&
      cached.plainSize === size &&
      cached.encryptedSize === cached.encrypted.byteLength
    ) {
      return cached;
    }
    const plain = await readPlainInputChunk(input, offset, size);
    const plainSize = plain.byteLength;
    const encrypted = await encryptChunkBytesFast(group.vaultCryptoKey, plain, chunkAAD(chunkSetId, index, plainSize), { transfer: true });
    const prepared = {
      index,
      chunkSetId,
      plainSize,
      encryptedSize: encrypted.byteLength,
      encrypted
    };
    await writeEncryptedClipCacheChunk(cacheKey, prepared);
    return prepared;
  }

  async function saveOrPromoteClip(input: PlainClipInput): Promise<SaveOutcome> {
    const group = requireGroup();
    if (input.size > maxClientPlainBytes) {
      throw new Error(`单条内容不能超过 ${formatSize(maxClientPlainBytes)}，请拆成更小的内容后再保存。`);
    }
    const contentHash = input.contentHash || (await sha256Input(input));
    const duplicate = await findDuplicateClip(input, contentHash);
    if (duplicate) {
      return promoteDuplicateClip(duplicate, contentHash, group);
    }
    const saved = await uploadEncryptedInput(group, input, contentHash);
    const now = Date.now();
    const clip: ClipEntry = {
      id: saved.id,
      blobId: saved.blobId,
      kind: input.kind,
      name: input.name,
      mime: input.mime,
      preview: input.preview,
      size: input.size,
      encryptedSize: saved.encryptedSize,
      encryption: saved.encryption,
      chunkSetId: saved.chunkSetId,
      chunkSize: saved.chunkSize,
      chunks: saved.chunks,
      contentHash,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
      expiresAt: now + retentionMs,
      pinned: false
    };
    await persist({
      ...index(),
      updatedAt: now,
      clips: [clip, ...index().clips]
    }, group);
    return { clip, contentHash, mode: 'created' };
  }

  async function findDuplicateClip(input: PlainClipInput, contentHash: string): Promise<ClipEntry | null> {
    const clips = activeClips();
    const hashed = clips.find((clip) => clip.contentHash === contentHash);
    if (hashed) {
      return hashed;
    }

    if (input.size > legacyDedupeMaxBytes || !input.source.bytes) {
      return null;
    }

    const candidates = clips
      .filter((clip) => !clip.contentHash && clip.kind === input.kind && clip.size === input.size)
      .slice(0, legacyDedupeMaxCandidates);
    for (const clip of candidates) {
      try {
        if ((await clipPlainHash(clip)) === contentHash) {
          return clip;
        }
      } catch {
        // Ignore unreadable legacy candidates; the normal upload path still works.
      }
    }
    return null;
  }

  async function promoteDuplicateClip(clip: ClipEntry, contentHash: string, group: ActiveGroup): Promise<SaveOutcome> {
    const latest = activeClips()[0];
    const latestMatch = latest?.id === clip.id;
    const needsHashBackfill = clip.contentHash !== contentHash;
    if (latestMatch && !needsHashBackfill) {
      return { clip, contentHash, mode: 'unchanged' };
    }

    const now = Date.now();
    let promoted = clip;
    const nextClips = index().clips.map((item) => {
      if (item.id !== clip.id) {
        return item;
      }
      promoted = {
        ...item,
        contentHash,
        updatedAt: now,
        lastUsedAt: latestMatch ? item.lastUsedAt ?? item.createdAt : now,
        expiresAt: item.pinned ? null : now + retentionMs
      };
      return promoted;
    });
    await persist({
      ...index(),
      updatedAt: now,
      clips: nextClips
    }, group);
    return { clip: promoted, contentHash, mode: latestMatch ? 'unchanged' : 'promoted' };
  }

  async function readClipboard() {
    await run(async () => {
      const input = await readSystemClipboardInput(requireClipboardAccess());
      if (!input) return '系统剪贴板为空';
      return saveOutcomeMessage(await addPlainBytes(input), '已粘贴');
    }, '已粘贴', '读取中');
  }

  async function copyClip(clip: ClipEntry) {
    await run(async () => {
      const nav = requireClipboardAccess();
      if (clip.kind === 'text') {
        await writeTextClipToClipboard(nav, async () => textDecoder.decode(await plainBytes(clip)));
        return;
      }
      const mode = await writeBinaryClipToClipboard(nav, clip, () => plainBytes(clip));
      if (mode === 'app-only') return '已复制，可在本应用内直接粘贴剪贴板';
      if (mode === 'native') return '已复制；浏览器未保留应用内精确回粘数据';
    }, '已复制', '复制中');
  }

  async function toggleClipboardNotification(enabled: boolean) {
    const group = activeGroup();
    if (!group) {
      return;
    }
    setClipboardNotifyEnabled(enabled);
    saveNotificationEnabled(group.id, enabled);
    if (!enabled) {
      closeUpdateNotification();
      await removePushSubscription(group);
      void clearAppBadge();
      showToast('剪贴板更新通知已关闭', 'info');
      return;
    }

    const groupID = group.id;
    const permission = await requestSystemNotificationPermission();
    setNotificationPermission(permission);
    if (activeGroup()?.id !== groupID || !clipboardNotifyEnabled()) {
      return;
    }
    if (permission === 'granted') {
      const pushReady = await ensurePushSubscription(group);
      if (activeGroup()?.id !== groupID || !clipboardNotifyEnabled()) {
        return;
      }
      showToast(pushReady ? '后台通知已开启' : '剪贴板更新通知已开启', 'info');
      return;
    }
    if (permission === 'denied') {
      showToast('浏览器系统通知已被拒绝，将使用页内提示', 'info');
      return;
    }
    if (permission === 'unsupported') {
      showToast(`${notificationUnavailableMessage()}，将使用页内提示`, 'info');
      return;
    }
    showToast('未授予系统通知权限，将使用页内提示', 'info');
  }

  async function ensurePushSubscription(group: ActiveGroup): Promise<boolean> {
    const config = runtimeConfig();
    const availability = webPushAvailability();
    if (!config.webPushEnabled || !config.vapidPublicKey || notificationPermissionState() !== 'granted' || !availability.available) {
      return false;
    }
    const registration = await registerServiceWorker();
    if (!registration) {
      showToast('后台通知注册失败，将使用打开页面通知', 'info');
      return false;
    }
    try {
      const subscription =
        (await registration.pushManager.getSubscription()) ||
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: bytesToArrayBuffer(base64UrlToBytes(config.vapidPublicKey))
        }));
      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
        throw new Error('浏览器返回了不完整的推送订阅。');
      }
      await guardRemoteOperation(group, () => savePushSubscription(group, clientId, json));
      return true;
    } catch (err) {
      if (isFatalAuthOrGroupError(err)) {
        throw err;
      }
      showToast(`后台推送不可用：${displayError(err)}。打开页面时仍会通知`, 'info');
      return false;
    }
  }

  async function removePushSubscription(group: ActiveGroup) {
    if (!('serviceWorker' in navigator)) {
      try {
        await guardRemoteOperation(group, () => deletePushSubscription(group, clientId, 'client-only'));
      } catch {
        // Best-effort cleanup.
      }
      return;
    }
    const registration = (await navigator.serviceWorker.getRegistration()) as
      | (ServiceWorkerRegistration & { pushManager?: PushManager })
      | undefined;
    const subscription = await registration?.pushManager?.getSubscription();
    const endpoint = subscription?.endpoint;
    if (endpoint) {
      try {
        await guardRemoteOperation(group, () => deletePushSubscription(group, clientId, endpoint));
      } catch {
        // Local opt-out should still proceed if the server is temporarily unavailable.
      }
      await subscription.unsubscribe();
    } else {
      try {
        await guardRemoteOperation(group, () => deletePushSubscription(group, clientId, 'client-only'));
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  function notifyRemoteClipboardUpdated(group: ActiveGroup) {
    if (activeGroup()?.id !== group.id || !clipboardNotifyEnabled()) {
      return;
    }
    const hash = baseHash();
    if (!hash || (lastNotifiedGroupID === group.id && lastNotifiedIndexHash === hash)) {
      return;
    }
    lastNotifiedGroupID = group.id;
    lastNotifiedIndexHash = hash;

    void setAppBadge(1);
    void showUpdateNotification(group).then((shown) => {
      if (!shown) {
        showToast(updateNotificationBody, 'info');
      }
    });
  }

  async function showUpdateNotification(group: ActiveGroup): Promise<boolean> {
    const permission = notificationPermissionState();
    setNotificationPermission(permission);
    if (permission !== 'granted') {
      return false;
    }
    closeUpdateNotification();
    try {
      const registration = await registerServiceWorker();
      if (registration && typeof registration.showNotification === 'function') {
        await registration.showNotification(notificationTitle, {
          body: updateNotificationBody,
          tag: 'openlist-clipboard-update',
          icon: '/icon-192.png',
          badge: '/badge-96.png',
          renotify: true,
          data: { url: '/' }
        } as NotificationOptions & { renotify: boolean });
        return true;
      }
    } catch {
      // Fall through to the page Notification API.
    }
    try {
      const notification = new Notification(notificationTitle, {
        body: updateNotificationBody,
        tag: 'openlist-clipboard-update',
          icon: '/icon-192.png',
          badge: '/badge-96.png'
      });
      activeUpdateNotification = notification;
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
      notification.onclose = () => {
        if (activeUpdateNotification === notification) {
          activeUpdateNotification = null;
        }
      };
      notification.onerror = () => {
        if (activeUpdateNotification === notification) {
          activeUpdateNotification = null;
        }
        showToast(updateNotificationBody, 'info');
      };
      return true;
    } catch {
      setNotificationPermission(notificationPermissionState());
      return false;
    }
  }

  function closeUpdateNotification() {
    if (!activeUpdateNotification) {
      return;
    }
    const notification = activeUpdateNotification;
    activeUpdateNotification = null;
    notification.onclick = null;
    notification.onclose = null;
    notification.onerror = null;
    notification.close();
  }

  function handleWindowFocus() {
    recoverForeground();
  }

  function handleVisibilityChange() {
    if (document.visibilityState === 'visible') {
      recoverForeground();
    }
  }

  function handleOnline() {
    recoverForeground();
  }

  function handleOffline() {
    const group = activeGroup();
    if (group && reconnectBlockedGroupID === group.id) {
      return;
    }
    setLiveState('offline');
    setPersistentNotice({ kind: 'error', message: '网络已离线，恢复后会重新连接' });
  }

  function recoverForeground() {
    const group = activeGroup();
    if (!group || cryptoUnavailable || navigator.onLine === false) {
      return;
    }
    void clearAppBadge();
    if (reconnectBlockedGroupID === group.id) {
      setPersistentNotice({ kind: 'error', message: remoteClipboardUnavailableMessage });
      return;
    }
    if (clipboardNotifyEnabled() && webPushAvailability().available && notificationPermissionState() === 'granted') {
      void ensurePushSubscription(group);
    }
    if (liveState() !== 'live') {
      connectIndexEvents(group);
    }
    if (liveState() !== 'live') {
      void refreshIndex(group)
        .then((changed) => {
          setPersistentNotice(null);
          showToast(changed ? '已刷新远端内容' : '已连接，内容已是最新', 'info');
        })
        .catch((err) => showToast(displayError(err), 'error'));
    }
  }

  async function clipPlainHash(clip: ClipEntry) {
    return sha256Base64Url(await plainBytes(clip));
  }

  async function downloadClip(clip: ClipEntry) {
    await run(async () => {
      downloadPlain(clip, await plainBytes(clip));
    }, '已下载');
  }

  async function previewClip(clip: ClipEntry) {
    if (clip.kind !== 'image') {
      return;
    }
    await run(async () => {
      await ensurePreviewUrl(clip);
    }, '已解密预览');
  }

  async function toggleTextExpansion(clip: ClipEntry) {
    if (clip.kind !== 'text') {
      return;
    }
    const current = expandedText()[clip.id];
    if (current?.text || current?.loading || current?.error) {
      clearExpandedText(clip.id);
      return;
    }
    setExpandedText((items) => ({ ...items, [clip.id]: { loading: true } }));
    try {
      const text = textDecoder.decode(await plainBytes(clip));
      setExpandedText((items) => ({ ...items, [clip.id]: { text } }));
    } catch (err) {
      setExpandedText((items) => ({ ...items, [clip.id]: { error: displayError(err) } }));
    }
  }

  async function openPreviewModal(clip: ClipEntry) {
    if (clip.kind !== 'image') {
      return;
    }
    rememberModalOpener();
    await run(async () => {
      await ensurePreviewUrl(clip);
      setPreviewModalClipId(clip.id);
    }, previewUrls()[clip.id] ? '已打开大图' : '已解密预览');
  }

  async function ensurePreviewUrl(clip: ClipEntry): Promise<string> {
    const existing = previewUrls()[clip.id];
    if (existing) {
      return existing;
    }
    const plain = await plainBytes(clip);
    const url = URL.createObjectURL(new Blob([bytesToArrayBuffer(plain)], { type: clip.mime || 'image/png' }));
    setPreviewUrls((current) => {
      if (current[clip.id]) {
        URL.revokeObjectURL(current[clip.id]);
      }
      return { ...current, [clip.id]: url };
    });
    return url;
  }

  function collapsePreview(clip: ClipEntry) {
    setPreviewModalClipId((current) => (current === clip.id ? '' : current));
    setPreviewUrls((current) => {
      const url = current[clip.id];
      if (!url) {
        return current;
      }
      URL.revokeObjectURL(url);
      const next = { ...current };
      delete next[clip.id];
      return next;
    });
  }

  async function plainBytes(clip: ClipEntry): Promise<Uint8Array> {
    const group = requireGroup();
    const cached = recallPlainBytes(group.id, clip);
    if (cached) {
      return cached;
    }
    let plain: Uint8Array;
    if (isChunkedClip(clip)) {
      const chunks = await mapConcurrent(clip.chunks, chunkCryptoConcurrency(), async (chunk, index) => {
        const envelope = await guardRemoteOperation(group, () => downloadBlob(group, chunk.blobId));
        return decryptChunkBytesFast(group.vaultCryptoKey, envelope, chunkAAD(clip.chunkSetId, index, chunk.size), { transfer: true });
      });
      const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      plain = concatBytes(chunks, total);
    } else {
      plain = await decryptBytes(group.vaultCryptoKey, await guardRemoteOperation(group, () => downloadBlob(group, clip.blobId)));
    }
    rememberPlainBytes(group.id, clip.id, plain);
    return plain;
  }

  async function deleteClipBlobs(group: ActiveGroup, clip: ClipEntry) {
    const blobIds = isChunkedClip(clip) ? clip.chunks.map((chunk) => chunk.blobId) : [clip.blobId];
    const results = await Promise.allSettled(blobIds.map((blobId) => guardRemoteOperation(group, () => deleteBlob(group, blobId))));
    const fatal = results.find((result) => result.status === 'rejected' && isFatalAuthOrGroupError(result.reason));
    if (fatal?.status === 'rejected') {
      throw fatal.reason;
    }
  }

  async function removeClip(clip: ClipEntry) {
    await run(async () => {
      const group = requireGroup();
      await deleteClipBlobs(group, clip);
      const now = Date.now();
      const next = {
        ...index(),
        updatedAt: now,
        clips: index().clips.filter((item) => item.id !== clip.id),
        deleted: [...index().deleted, { id: clip.id, deletedAt: now }]
      };
      await persist(next, group);
      setPreviewUrls((current) => {
        const copy = { ...current };
        if (copy[clip.id]) {
          URL.revokeObjectURL(copy[clip.id]);
          delete copy[clip.id];
        }
        return copy;
      });
      setPreviewModalClipId((current) => (current === clip.id ? '' : current));
      clearExpandedText(clip.id);
      forgetPlainBytes(group.id, clip.id);
    }, '已删除');
  }

  async function togglePin(clip: ClipEntry) {
    await run(async () => {
      const now = Date.now();
      const next = {
        ...index(),
        updatedAt: now,
        clips: index().clips.map((item) =>
          item.id === clip.id
            ? {
                ...item,
                pinned: !item.pinned,
                expiresAt: item.pinned ? now + retentionMs : null,
                updatedAt: now
              }
            : item
        )
      };
      await persist(next);
    }, '已更新');
  }

  async function cleanupExpired(currentIndex: ClipIndex, group: ActiveGroup, hash: string) {
    const now = Date.now();
    const expired = currentIndex.clips.filter((clip) => isExpired(clip, now));
    if (expired.length === 0) {
      setIndex(currentIndex);
      return;
    }
    const deleteResults = await Promise.allSettled(expired.map((clip) => deleteClipBlobs(group, clip)));
    const fatalDelete = deleteResults.find((result) => result.status === 'rejected' && isFatalAuthOrGroupError(result.reason));
    if (fatalDelete?.status === 'rejected') {
      throw fatalDelete.reason;
    }
    const next: ClipIndex = {
      ...currentIndex,
      updatedAt: now,
      clips: currentIndex.clips.filter((clip) => !isExpired(clip, now)),
      deleted: [...currentIndex.deleted, ...expired.map((clip) => ({ id: clip.id, deletedAt: now }))]
    };
    await persist(next, group, hash);
  }

  async function guardRemoteOperation<T>(group: ActiveGroup, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (err) {
      handleRemoteFatalError(err, group);
      throw err;
    }
  }

  function handleRemoteFatalError(err: unknown, group: ActiveGroup, message = remoteClipboardUnavailableMessage): boolean {
    if (!isFatalAuthOrGroupError(err)) {
      return false;
    }
    if (activeGroup()?.id !== group.id) {
      return true;
    }
    stopRemoteReconnect(group, message);
    return true;
  }

  function stopRemoteReconnect(group: ActiveGroup, message: string) {
    if (activeGroup()?.id !== group.id) {
      return;
    }
    reconnectBlockedGroupID = group.id;
    closeIndexEvents();
    setPersistentNotice({ kind: 'error', message });
  }

  function displayOperationError(err: unknown) {
    const group = activeGroup();
    if (group && reconnectBlockedGroupID === group.id && isFatalAuthOrGroupError(err)) {
      return remoteClipboardUnavailableMessage;
    }
    return displayError(err);
  }

  function handlePaste(event: ClipboardEvent) {
    if (!unlocked()) {
      return;
    }
    const files = clipboardFilesFromPaste(event);
    if (files.length > 0 || clipboardContainsAppPayload(event.clipboardData)) {
      event.preventDefault();
      if (files.length > 0) {
        void pasteFiles(files);
      } else {
        void pasteAppClipboardPayload();
      }
      return;
    }
    if (isTyping()) {
      return;
    }
    const text = event.clipboardData?.getData('text/plain');
    if (text?.trim()) {
      event.preventDefault();
      void run(async () => {
        const bytes = textEncoder.encode(text);
        const outcome = await addPlainBytes({
          source: { bytes },
          size: bytes.byteLength,
          kind: 'text',
          name: '文本',
          mime: 'text/plain;charset=utf-8',
          preview: textPreview(text)
        });
        return saveOutcomeMessage(outcome, '已保存');
      }, '已保存', '保存中');
    }
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    if (!unlocked()) {
      return;
    }
    void addFiles([...(event.dataTransfer?.files || [])]);
  }

  function preventDefault(event: Event) {
    event.preventDefault();
  }

  async function run(action: () => Promise<string | false | void>, ok: string, label = '处理中') {
    setBusy(true);
    setOperationLabel(label);
    try {
      const result = await action();
      if (result !== false) showToast(result || ok, 'success');
    } catch (err) {
      showToast(displayOperationError(err), 'error');
    } finally {
      setBusy(false);
      setOperationLabel('');
    }
  }

  function showToast(message: string, kind: ToastKind = 'success') {
    const id = toastID + 1;
    toastID = id;
    setToasts((current) => [...current, { id, kind, message }].slice(-maxToastCount));
    const timeout = kind === 'error' ? 6500 : 2800;
    const timer = window.setTimeout(() => dismissToast(id), timeout);
    toastTimers.set(id, timer);
  }

  function dismissToast(id: number) {
    const timer = toastTimers.get(id);
    if (timer) {
      window.clearTimeout(timer);
      toastTimers.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }

  function requireGroup(): ActiveGroup {
    const group = activeGroup();
    if (!group) {
      throw new Error('请先创建或加入一个剪贴板');
    }
    return group;
  }

  function clearPreviewUrls() {
    Object.values(previewUrls()).forEach(URL.revokeObjectURL);
    setPreviewUrls({});
    setPreviewModalClipId('');
  }

  function clearExpandedText(clipId?: string) {
    if (!clipId) {
      setExpandedText({});
      return;
    }
    setExpandedText((current) => {
      if (!current[clipId]) {
        return current;
      }
      const next = { ...current };
      delete next[clipId];
      return next;
    });
  }

  function rememberPlainBytes(groupID: string, clipID: string, bytes: Uint8Array) {
    if (bytes.byteLength > maxPlainCacheBytes) {
      return;
    }
    const key = plainCacheKey(groupID, clipID);
    plainCache.delete(key);
    plainCache.set(key, bytes);
    while (plainCache.size > maxPlainCacheEntries) {
      const oldest = plainCache.keys().next().value;
      if (!oldest) {
        break;
      }
      plainCache.delete(oldest);
    }
  }

  function recallPlainBytes(groupID: string, clip: ClipEntry): Uint8Array | null {
    const key = plainCacheKey(groupID, clip.id);
    const cached = plainCache.get(key);
    if (!cached) {
      return null;
    }
    plainCache.delete(key);
    plainCache.set(key, cached);
    return cached;
  }

  function forgetPlainBytes(groupID: string, clipID: string) {
    plainCache.delete(plainCacheKey(groupID, clipID));
  }

  return (
    <main class="app" id="main-content">
      <a class="skip-link" href="#workspace">跳到工作区</a>
      <header class="app-header">
        <div class="header-main">
          <h1><ClipboardIcon aria-hidden="true" size={24} />OpenList Clipboard</h1>
          <Show when={unlocked()}>
            <div class="current-group">
              <select class="group-select" value={activeGroup()?.id || ''} disabled={busy()} aria-label="选择剪贴板" onChange={(event) => void switchGroup(event.currentTarget.value)}>
                <For each={groups()}>{(group) => <option value={group.id}>{group.name}</option>}</For>
              </select>
              <span class="live-status"><span class={`live-indicator ${liveState()}`} />{liveStateLabel(liveState())}</span>
            </div>
          </Show>
        </div>
        <Show when={unlocked()}>
          <div class="notification-actions" role="group" aria-label="通知开关">
            <button class={`icon-toggle ${clipboardNotifyEnabled() ? 'enabled' : ''}`} role="switch"
              aria-checked={clipboardNotifyEnabled()} title={notificationToggleTitle()}
              onClick={() => void toggleClipboardNotification(!clipboardNotifyEnabled())}>
              <Bell aria-hidden="true" size={18} /><span>{notificationToggleTitle()}</span>
              <Show when={clipboardNotifyEnabled()} fallback={<ToggleLeft aria-hidden="true" size={24} />}><ToggleRight aria-hidden="true" size={24} /></Show>
            </button>
          </div>
        </Show>
        <Show when={busy()}>
          <span class="busy-indicator" role="status"><Loader2 aria-hidden="true" class="spin" size={18} />{operationLabel() || '处理中'}</span>
        </Show>
        <Show when={persistentNotice()}>
          <div class={`status-strip ${persistentNotice()!.kind}`} role="status">{persistentNotice()!.message}</div>
        </Show>
      </header>

      <section class="workspace-toolbar" aria-label="剪贴板工具栏">
        <Show when={unlocked()}>
          <div class="toolbar-actions" role="group" aria-label="密钥">
            <button class="icon-button" title="复制密钥" disabled={busy()} onClick={() => void copyInviteKey()}><Copy aria-hidden="true" size={17} />复制密钥</button>
            <button class="icon-button" title="密钥二维码" disabled={busy()} onClick={() => void showInviteCodeQR()}><QrCode aria-hidden="true" size={17} />密钥二维码</button>
            <button class="icon-button" title="增加密钥" disabled={busy()} onClick={leaveGroup}><Plus aria-hidden="true" size={18} />增加密钥</button>
            <button class="icon-button danger" title="忘记密钥" disabled={busy()} onClick={removeActiveGroup}><Trash2 aria-hidden="true" size={17} />忘记密钥</button>
          </div>
        </Show>
        <Show when={installPrompt() || serviceWorkerUpdateReady()}>
          <div class="toolbar-actions app-actions" role="group" aria-label="应用">
            <Show when={installPrompt()}>
              <button class="icon-button" title="安装应用" onClick={() => void installApp()}><Download aria-hidden="true" size={18} />安装应用</button>
            </Show>
            <Show when={serviceWorkerUpdateReady()}>
              <button class="icon-button update-ready" title="更新应用" onClick={applyServiceWorkerUpdate}><RefreshCw aria-hidden="true" size={18} />更新应用</button>
            </Show>
          </div>
        </Show>
      </section>

      <Show when={!unlocked()}>
        <section class="key-panel" id="workspace" tabIndex={-1}>
          <Show when={groups().length > 0}>
            <section class="saved-groups" aria-label="已保存剪贴板">
              <h2>已保存剪贴板</h2>
              <For each={groups()}>{(group) => (
                <div class="saved-group">
                  <strong>{group.name}</strong>
                  <button class="secondary-button" disabled={busy() || !!cryptoUnavailable} onClick={() => void switchGroup(group.id)}>
                    <ClipboardIcon aria-hidden="true" size={17} />打开
                  </button>
                </div>
              )}</For>
            </section>
          </Show>
          <Show when={cryptoUnavailable}>
            <p class="notice">{cryptoUnavailable}</p>
          </Show>
          <form class="group-form" onSubmit={createGroupAction}>
            <div class="form-title">创建剪贴板</div>
            <input
              aria-label="剪贴板名称" name="group-name"
              value={groupName()}
              onInput={(event) => setGroupName(event.currentTarget.value)}
              placeholder="剪贴板名称"
              autocomplete="off"
              required
            />
            <input
              aria-label="创建密码" name="create-password"
              type="password"
              value={createPassword()}
              onInput={(event) => setCreatePassword(event.currentTarget.value)}
              placeholder="创建密码（必填）"
              autocomplete="current-password"
              required
            />
            <button type="submit" disabled={busy() || !canCreateGroup()}>
              <Plus aria-hidden="true" size={17} />
              创建剪贴板
            </button>
            <Show when={createFormHint()}>
              <p class="form-hint">{createFormHint()}</p>
            </Show>
          </form>
          <form class="group-form import-form" onSubmit={importGroupAction}>
            <div class="form-title">加入已有剪贴板</div>
            <textarea
              aria-label="剪贴板密钥" name="invite-key" autocomplete="off"
              value={inviteInput()}
              onInput={(event) => setInviteInput(event.currentTarget.value)}
              placeholder="粘贴 olckey1 剪贴板密钥"
              rows={4}
              spellcheck={false}
            />
            <div class="composer-actions">
              <button type="button" onClick={() => void startInviteScanner()} disabled={busy() || !!cryptoUnavailable}>
                <Camera aria-hidden="true" size={17} />
                扫描
              </button>
              <button type="submit" disabled={busy() || !!cryptoUnavailable || inviteInput().trim().length === 0}>
                <Upload aria-hidden="true" size={17} />
                加入剪贴板
              </button>
            </div>
          </form>
        </section>
      </Show>

      <Show when={unlocked()}>
        <section class="composer" id="workspace" tabIndex={-1}>
          <textarea
            id="composer-text"
            aria-label="要发送的文本" name="clip-text" autocomplete="off"
            value={textDraft()}
            onInput={(event) => setTextDraft(event.currentTarget.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder="粘贴文本"
            rows={4}
          />
          <div class="composer-tools" role="group" aria-label="链接清理">
            <button class="text-tool" type="button" title="净化复制" disabled={busy() || !textDraft()}
              onClick={() => void copyCleanText(async () => textDraft())}>
              <Copy aria-hidden="true" size={16} />净化复制
            </button>
            <button class={`clean-toggle ${cleanBeforeUpload() ? 'enabled' : ''}`} type="button" role="switch"
              aria-checked={cleanBeforeUpload()} title="上传前清理链接" onClick={toggleCleanBeforeUpload}>
              <span>上传前清理链接</span>
              <Show when={cleanBeforeUpload()} fallback={<ToggleLeft aria-hidden="true" size={23} />}><ToggleRight aria-hidden="true" size={23} /></Show>
            </button>
          </div>
          <div class="composer-actions">
            <label class={`file-button secondary-button ${busy() ? 'disabled' : ''}`} title="上传文件">
              <Upload aria-hidden="true" size={17} />上传文件
              <input
                class="file-input"
                type="file"
                accept="*/*"
                multiple
                disabled={busy()}
                aria-label="上传文件"
                onChange={(event) => handleFileInputChange(event.currentTarget)}
              />
            </label>
            <button class="secondary-button" title="直接粘贴剪贴板" disabled={busy()} onClick={() => void readClipboard()}>
              <ClipboardIcon aria-hidden="true" size={18} />直接粘贴剪贴板
            </button>
            <button class="send-button" title="发送" aria-label="发送" onClick={() => void addText()} disabled={busy() || textDraft().trim().length === 0}>
              <Send aria-hidden="true" size={18} />发送
            </button>
          </div>
        </section>

        <section class="clip-list">
          <Show when={activeClips().length > 0} fallback={<div class="empty">暂无内容</div>}>
            <For each={activeClips()}>
              {(clip) => (
                <article class="clip-card">
                  <div class="clip-icon">
                    <Show
                      when={clip.kind === 'text'}
                      fallback={<Show when={clip.kind === 'image'} fallback={<FileIcon aria-hidden="true" size={19} />}><ImageIcon aria-hidden="true" size={19} /></Show>}
                    >
                      <FileText aria-hidden="true" size={19} />
                    </Show>
                  </div>
                  <div class="clip-main">
                    <div class="clip-head">
                      <Show when={clip.kind !== 'text'}>
                        <strong>{clip.name}</strong>
                      </Show>
                      <span class="clip-meta">
                        <span>{formatSize(clip.size)}</span>
                        <time>{formatTime(clipSortTime(clip))}</time>
                      </span>
                    </div>
                    <Show when={clip.kind === 'text'}>
                      <Show when={!textPreviewState()[clip.id]?.text}>
                        <p class="text-preview">{clip.preview || '文本'}</p>
                      </Show>
                      <Show when={textPreviewState()[clip.id]?.loading}>
                        <div class="text-expanded-state">
                          <Loader2 aria-hidden="true" class="spin" size={14} />
                          解密中
                        </div>
                      </Show>
                      <Show when={textPreviewState()[clip.id]?.error}>
                        <div class="text-expanded-state error">{textPreviewState()[clip.id]?.error}</div>
                      </Show>
                      <Show when={textPreviewState()[clip.id]?.text}>
                        <pre class="text-expanded">{textPreviewState()[clip.id]?.text}</pre>
                      </Show>
                    </Show>
                    <Show when={clip.kind === 'image' && previewUrls()[clip.id]}>
                      <button class="preview-button" type="button" title="查看大图" disabled={busy()} onClick={() => void openPreviewModal(clip)}>
                        <img class="preview" src={previewUrls()[clip.id]} alt={clip.name} width="360" height="260" /><span class="preview-caption"><Maximize2 aria-hidden="true" size={17} />查看大图</span>
                      </button>
                    </Show>
                  </div>
                  <div class="clip-actions">
                    <button class="icon-button" title="复制" disabled={busy()} onClick={() => void copyClip(clip)}>
                      <Copy aria-hidden="true" size={17} />复制
                    </button>
                    <Show when={clip.kind === 'text'}>
                      <button class="icon-button" title="净化复制" disabled={busy()}
                        onClick={() => void copyCleanText(async () => textDecoder.decode(await plainBytes(clip)))}>
                        <Copy aria-hidden="true" size={17} />净化复制
                      </button>
                    </Show>
                    <Show when={clip.kind === 'image'}>
                      <Show
                        when={previewUrls()[clip.id]}
                        fallback={
                          <button class="icon-button" title="预览" disabled={busy()} onClick={() => void previewClip(clip)}>
                            <Eye aria-hidden="true" size={17} />预览
                          </button>
                        }
                      >
                        <button class="icon-button" title="查看大图" disabled={busy()} onClick={() => void openPreviewModal(clip)}>
                          <Maximize2 aria-hidden="true" size={17} />查看大图
                        </button>
                        <button class="icon-button" title="收起预览" disabled={busy()} onClick={() => collapsePreview(clip)}>
                          <EyeOff aria-hidden="true" size={17} />收起预览
                        </button>
                      </Show>
                    </Show>
                    <Show when={clip.kind === 'text' && !isCompleteTextPreview(clip)}>
                      <button
                        class="icon-button"
                        title={expandedText()[clip.id] ? '收起全文' : '展开全文'}
                        disabled={busy()}
                        onClick={() => void toggleTextExpansion(clip)}
                      >
                        <Show when={expandedText()[clip.id]} fallback={<Eye aria-hidden="true" size={17} />}><EyeOff aria-hidden="true" size={17} /></Show>{expandedText()[clip.id] ? '收起全文' : '展开全文'}
                      </button>
                    </Show>
                    <Show when={clip.kind !== 'text'}>
                      <button class="icon-button" title="下载" disabled={busy()} onClick={() => void downloadClip(clip)}>
                        <Download aria-hidden="true" size={17} />下载
                      </button>
                    </Show>
                    <button class="icon-button" title={clip.pinned ? '取消置顶' : '置顶'} disabled={busy()} onClick={() => void togglePin(clip)}>
                      <Show when={clip.pinned} fallback={<Pin aria-hidden="true" size={17} />}><PinOff aria-hidden="true" size={17} /></Show>{clip.pinned ? '取消置顶' : '置顶'}
                    </button>
                    <button class="icon-button danger" title="删除" disabled={busy()} onClick={() => void removeClip(clip)}>
                      <Trash2 aria-hidden="true" size={17} />删除
                    </button>
                  </div>
                </article>
              )}
            </For>
          </Show>
        </section>
      </Show>

      <Show when={showInviteQR()}>
        <div class="modal-backdrop" onClick={() => closeModal('qr')}>
          <section class="modal-panel qr-panel" data-modal="qr" role="dialog" aria-modal="true" aria-labelledby="qr-title" tabIndex={-1} onClick={(event) => event.stopPropagation()}>
            <div class="modal-head">
              <h2 id="qr-title">剪贴板密钥二维码</h2>
              <button class="icon-button" title="关闭" onClick={() => closeModal('qr')}>
                <X aria-hidden="true" size={17} />关闭
              </button>
            </div>
            <Show when={inviteQR()}>
              <img class="qr-image" src={inviteQR()} alt="剪贴板密钥二维码" width="320" height="320" />
            </Show>
            <div class="qr-actions">
              <button onClick={() => void copyInviteKey()}>
                <Copy aria-hidden="true" size={17} />
                复制密钥
              </button>
            </div>
          </section>
        </div>
      </Show>

      <Show when={scannerOpen()}>
        <div class="modal-backdrop" onClick={() => closeModal('scanner')}>
          <section class="modal-panel scanner-panel" data-modal="scanner" role="dialog" aria-modal="true" aria-labelledby="scanner-title" tabIndex={-1} onClick={(event) => event.stopPropagation()}>
            <div class="modal-head">
              <h2 id="scanner-title">扫描剪贴板密钥</h2>
              <button class="icon-button" title="关闭" onClick={() => closeModal('scanner')}>
                <X aria-hidden="true" size={17} />关闭
              </button>
            </div>
            <Show
              when={scannedInvite()}
              fallback={
                <>
                  <video class="scanner-video" ref={(el) => (scannerVideo = el)} muted playsinline />
                  <canvas ref={(el) => (scannerCanvas = el)} hidden />
                </>
              }
            >
              <div class="scanner-result">
                <div class="scanner-key mono">{scannedInvite()}</div>
                <div class="qr-actions">
                  <button type="button" disabled={busy()} onClick={() => void joinScannedInvite()}>
                    <Upload aria-hidden="true" size={17} />
                    加入剪贴板
                  </button>
                  <button type="button" class="secondary-button" disabled={busy()} onClick={() => void startInviteScanner()}>
                    <Camera aria-hidden="true" size={17} />
                    重新扫描
                  </button>
                </div>
              </div>
            </Show>
          </section>
        </div>
      </Show>

      <Show when={previewModalClip()}>
        <div class="modal-backdrop image-backdrop" onClick={() => closeModal('image')}>
          <section class="modal-panel image-panel" data-modal="image" role="dialog" aria-modal="true" aria-labelledby="image-title" tabIndex={-1} onClick={(event) => event.stopPropagation()}>
            <div class="modal-head">
              <h2 id="image-title">{previewModalClip()!.name || '图片预览'}</h2>
              <button class="icon-button" title="关闭" onClick={() => closeModal('image')}>
                <X aria-hidden="true" size={17} />关闭
              </button>
            </div>
            <Show when={previewUrls()[previewModalClip()!.id]}>
              <img class="image-preview-large" src={previewUrls()[previewModalClip()!.id]} alt={previewModalClip()!.name || '图片预览'} width="960" height="720" />
            </Show>
          </section>
        </div>
      </Show>

      <div class="toast-stack" aria-live="polite" aria-atomic="false">
        <For each={toasts()}>
          {(toast) => (
            <div class={`toast ${toast.kind}`}>
              <span>{toast.message}</span>
              <button class="toast-close" title="关闭提示" onClick={() => dismissToast(toast.id)}>
                <X aria-hidden="true" size={14} />关闭提示
              </button>
            </div>
          )}
        </For>
      </div>
    </main>
  );
}

async function readPlainInput(input: PlainClipInput): Promise<Uint8Array> {
  if (input.source.bytes) {
    return input.source.bytes;
  }
  if (!input.source.file) {
    throw new Error('没有可读取的内容。');
  }
  try {
    return new Uint8Array(await input.source.file.arrayBuffer());
  } catch {
    throw new Error(`无法读取文件：${input.name || '未命名文件'}。请确认文件仍在本机且未被占用。`);
  }
}

async function readPlainInputChunk(input: PlainClipInput, offset: number, size: number): Promise<Uint8Array> {
  if (input.source.bytes) {
    return input.source.bytes.subarray(offset, offset + size);
  }
  if (!input.source.file) {
    throw new Error('没有可读取的内容。');
  }
  try {
    return new Uint8Array(await input.source.file.slice(offset, offset + size).arrayBuffer());
  } catch {
    throw new Error(`无法读取文件分片：${input.name || '未命名文件'}。请确认文件仍在本机且未被占用。`);
  }
}

async function sha256Input(input: PlainClipInput): Promise<string> {
  if (input.source.bytes) {
    return sha256Base64Url(input.source.bytes);
  }
  const file = input.source.file;
  if (!file) {
    throw new Error('没有可读取的内容。');
  }
  return bytesToBase64Url(await sha256BlobFast(file));
}

function isChunkedClip(clip: ClipEntry): clip is ClipEntry & { chunkSetId: string; chunks: ClipChunk[] } {
  return clip.encryption === chunkedEncryption && !!clip.chunkSetId && Array.isArray(clip.chunks) && clip.chunks.length > 0;
}

function chunkAAD(chunkSetId: string, chunkIndex: number, plainSize: number): Uint8Array {
  return textEncoder.encode(`${chunkedEncryption}\n${chunkSetId}\n${chunkIndex}\n${plainSize}`);
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(Math.floor(concurrency), items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) {
          return;
        }
        results[index] = await mapper(items[index], index);
      }
    })
  );
  return results;
}

function chunkCryptoConcurrency() {
  const cores = typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency || 2;
  return Math.max(1, Math.min(maxChunkCryptoConcurrency, cores - 1 || 1));
}

function randomCacheToken(): string {
  const raw = new Uint8Array(16);
  crypto.getRandomValues(raw);
  return bytesToBase64Url(raw);
}

function plainCacheKey(groupID: string, clipID: string) {
  return `${groupID}:${clipID}`;
}

function loadClientId() {
  try {
    const existing = localStorage.getItem(clientIdStorageKey);
    if (existing) {
      return existing;
    }
    const created = randomCacheToken();
    localStorage.setItem(clientIdStorageKey, created);
    return created;
  } catch {
    return randomCacheToken();
  }
}

function loadCleanBeforeUpload() {
  try { return localStorage.getItem(cleanBeforeUploadStorageKey) === 'true'; } catch { return false; }
}

function saveOutcomeMessage(outcome: SaveOutcome, createdMessage: string) {
  if (outcome.mode === 'unchanged') {
    return '内容已是最新';
  }
  if (outcome.mode === 'promoted') {
    return '已将已有内容移到最新';
  }
  return createdMessage;
}

function clipSortTime(clip: ClipEntry) {
  return clip.lastUsedAt ?? clip.createdAt;
}

function isExpired(clip: ClipEntry, now = Date.now()) {
  return !clip.pinned && clip.expiresAt !== null && clip.expiresAt <= now;
}

function isTyping() {
  const element = document.activeElement;
  if (!element) {
    return false;
  }
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || (element as HTMLElement).isContentEditable;
}

function textPreview(text: string) {
  return text.slice(0, maxTextPreviewChars);
}

function isCompleteTextPreview(clip: ClipEntry) {
  return clip.kind === 'text' && clip.size <= textEncoder.encode(clip.preview || '').byteLength;
}

function requireClipboardAccess(): RichClipboard {
  if (!navigator.clipboard) {
    throw new Error('当前浏览器未开放剪贴板能力，请使用 HTTPS 或 localhost 访问。');
  }
  return navigator.clipboard;
}

async function sha256Base64Url(bytes: Uint8Array) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytesToArrayBuffer(bytes)));
  return bytesToBase64Url(hash);
}

function notificationPermissionState(): NotificationSupportState {
  if (typeof window === 'undefined' || !window.isSecureContext || typeof Notification === 'undefined') {
    return 'unsupported';
  }
  if (isIOSSafari() && !isStandaloneWebApp()) {
    return 'unsupported';
  }
  return Notification.permission;
}

function notificationUnavailableMessage() {
  if (typeof window === 'undefined' || !window.isSecureContext) {
    return '系统通知需要 HTTPS 或 localhost';
  }
  if (typeof Notification === 'undefined') {
    return isIOSSafari() && !isStandaloneWebApp()
      ? 'iOS Safari 需要先从 Safari 分享菜单添加到主屏幕，并从主屏幕重新打开后才能使用系统通知'
      : '当前浏览器不支持系统通知';
  }
  return '当前浏览器不支持系统通知';
}

function webPushAvailability(): { available: boolean; reason?: string } {
  if (typeof window === 'undefined' || !window.isSecureContext) {
    return { available: false, reason: '后台通知需要 HTTPS 或 localhost' };
  }
  if (!('serviceWorker' in navigator)) {
    return { available: false, reason: '当前浏览器不支持 Service Worker' };
  }
  if (isIOSSafari() && !isStandaloneWebApp()) {
    return { available: false, reason: 'iOS Safari 需要先从 Safari 分享菜单添加到主屏幕，并从主屏幕重新打开后才能使用后台通知' };
  }
  if (!('PushManager' in window)) {
    return {
      available: false,
      reason: isIOSSafari()
        ? 'iOS Safari 需要先从 Safari 分享菜单添加到主屏幕，并从主屏幕重新打开后才能使用后台通知'
        : '当前浏览器不支持后台推送'
    };
  }
  return { available: true };
}

function isIOSSafari() {
  const platform = navigator.platform || '';
  const userAgent = navigator.userAgent || '';
  const isiOS = /iPad|iPhone|iPod/.test(platform) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return isiOS && /Safari/i.test(userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(userAgent);
}

function isStandaloneWebApp() {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function requestSystemNotificationPermission(): Promise<NotificationSupportState> {
  if (notificationPermissionState() !== 'default') {
    return Promise.resolve(notificationPermissionState());
  }
  return new Promise((resolve) => {
    let settled = false;
    let fallback = 0;
    const settle = (permission: NotificationSupportState) => {
      if (settled) {
        return;
      }
      settled = true;
      if (fallback) {
        window.clearTimeout(fallback);
      }
      resolve(permission);
    };
    fallback = window.setTimeout(() => settle(notificationPermissionState()), 1200);
    try {
      const result = (Notification.requestPermission as (
        callback?: (permission: NotificationPermission) => void
      ) => Promise<NotificationPermission> | void)(settle);
      if (result && typeof result.then === 'function') {
        result.then(settle, () => settle(notificationPermissionState()));
      }
    } catch {
      settle(notificationPermissionState());
    }
  });
}

function loadNotificationEnabled(groupID: string) {
  return loadGroupFlag(notificationEnabledStorageKey, groupID);
}

function saveNotificationEnabled(groupID: string, enabled: boolean) {
  saveGroupFlag(notificationEnabledStorageKey, groupID, enabled);
}

function loadGroupFlag(storageKey: string, groupID: string) {
  return readStorageObject(storageKey)[groupID] === true;
}

function saveGroupFlag(storageKey: string, groupID: string, enabled: boolean) {
  const current = readStorageObject(storageKey);
  if (enabled) {
    current[groupID] = true;
  } else {
    delete current[groupID];
  }
  writeStorageObject(storageKey, current);
}

function readStorageObject(key: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeStorageObject(key: string, value: Record<string, unknown>) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Local storage can be unavailable in private browsing or strict site settings.
  }
}

function displayError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
    return '浏览器拒绝本次剪贴板操作。请确认页面在前台，并允许此站点读写剪贴板。';
  }
  if (err instanceof DOMException && err.name === 'OperationError') {
    return '操作失败：浏览器加密、签名或文件读取没有返回具体原因。请确认剪贴板密钥匹配，并把过大的内容拆小后重试。';
  }
  if (/operation failed for an operation-specific reason/i.test(message)) {
    return '操作失败：浏览器加密、签名或文件读取没有返回具体原因。请确认剪贴板密钥匹配，并把过大的内容拆小后重试。';
  }
  return message;
}

function downloadPlain(clip: ClipEntry, bytes: Uint8Array) {
  const url = URL.createObjectURL(new Blob([bytesToArrayBuffer(bytes)], { type: clip.mime || 'application/octet-stream' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = clip.name || `${clip.id}.bin`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function liveStateLabel(state: LiveState) {
  if (state === 'live') return '实时';
  if (state === 'connecting') return '连接中';
  return '离线';
}

function formatSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(time: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(time));
}
