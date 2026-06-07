import {
  Camera,
  Clipboard as ClipboardIcon,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileIcon,
  FileText,
  ImageIcon,
  KeyRound,
  Loader2,
  LogOut,
  Maximize2,
  Pin,
  PinOff,
  Plus,
  QrCode,
  RefreshCw,
  Trash2,
  Upload,
  Users,
  X
} from 'lucide-solid';
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import {
  createRemoteGroup,
  deleteBlob,
  downloadBlob,
  fetchIndex,
  joinRemoteGroup,
  openIndexEvents,
  saveIndex,
  uploadBlob
} from './api';
import {
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
import type { ActiveGroup, ClipEntry, ClipIndex, IndexEvent, SavedGroup } from './types';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const retentionMs = 30 * 24 * 60 * 60 * 1000;
const maxClientPlainBytes = 50 * 1024 * 1024 - 64;
const legacyDedupeMaxBytes = 2 * 1024 * 1024;
const legacyDedupeMaxCandidates = 20;
const cryptoUnavailable = webCryptoUnavailableReason();
const syncEnabledStorageKey = 'openlist-clipboard.sync.enabled.v1';
const syncStateStorageKey = 'openlist-clipboard.sync.state.v1';
const scannerMaxEdge = 640;
const scannerScanIntervalMs = 120;
const maxToastCount = 3;

type LiveState = 'offline' | 'connecting' | 'live';
type IndexStream = { close: () => void };
type SyncReason = 'enable' | 'focus' | 'visibility' | 'remote' | 'clipboardchange' | 'online';
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
type ClipboardSnapshot = {
  kind: 'text' | 'image';
  bytes: Uint8Array;
  name: string;
  mime: string;
  preview: string;
  hash: string;
};
type PlainClipInput = {
  bytes: Uint8Array;
  kind: ClipEntry['kind'];
  name: string;
  mime: string;
  preview: string;
  contentHash?: string;
};
type SaveOutcome = {
  clip: ClipEntry;
  contentHash: string;
  mode: 'created' | 'promoted' | 'unchanged';
};
type StoredSyncState = {
  localHash?: string;
  localObservedAt?: number;
  remoteClipId?: string;
  remoteHash?: string;
  remoteCopiedAt?: number;
};

export default function App() {
  const [groups, setGroups] = createSignal<SavedGroup[]>([]);
  const [activeGroup, setActiveGroup] = createSignal<ActiveGroup | null>(null);
  const [groupName, setGroupName] = createSignal('');
  const [createPassword, setCreatePassword] = createSignal('');
  const [inviteInput, setInviteInput] = createSignal('');
  const [index, setIndex] = createSignal<ClipIndex>(emptyIndex());
  const [baseHash, setBaseHash] = createSignal('');
  const [textDraft, setTextDraft] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [syncing, setSyncing] = createSignal(false);
  const [operationLabel, setOperationLabel] = createSignal('');
  const [persistentNotice, setPersistentNotice] = createSignal<PersistentNotice | null>(null);
  const [toasts, setToasts] = createSignal<ToastMessage[]>([]);
  const [previewUrls, setPreviewUrls] = createSignal<Record<string, string>>({});
  const [previewModalClipId, setPreviewModalClipId] = createSignal('');
  const [inviteQR, setInviteQR] = createSignal('');
  const [showInviteQR, setShowInviteQR] = createSignal(false);
  const [scannerOpen, setScannerOpen] = createSignal(false);
  const [scannedInvite, setScannedInvite] = createSignal('');
  const [liveState, setLiveState] = createSignal<LiveState>('offline');
  const [clipboardSyncEnabled, setClipboardSyncEnabled] = createSignal(false);

  let scannerVideo: HTMLVideoElement | undefined;
  let scannerCanvas: HTMLCanvasElement | undefined;
  let scannerStream: MediaStream | null = null;
  let scannerFrame = 0;
  let scannerDone = false;
  let scannerLastScanAt = 0;
  let indexStream: IndexStream | null = null;
  let indexEventsVersion = 0;
  let liveRefreshRunning = false;
  let queuedIndexHash = '';
  let clipboardSyncRunning = false;
  let queuedClipboardSyncReason: SyncReason | null = null;
  let toastID = 0;
  const toastTimers = new Map<number, number>();

  const unlocked = createMemo(() => activeGroup() !== null);
  const activeClips = createMemo(() =>
    index()
      .clips.filter((clip) => !isExpired(clip))
      .sort((a, b) => clipSortTime(b) - clipSortTime(a))
  );
  const previewModalClip = createMemo(() => activeClips().find((clip) => clip.id === previewModalClipId()) || null);
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

  onMount(async () => {
    window.addEventListener('paste', handlePaste);
    window.addEventListener('dragover', preventDefault);
    window.addEventListener('drop', handleDrop);
    window.addEventListener('focus', handleWindowFocus);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    clipboardEventTarget()?.addEventListener('clipboardchange', handleClipboardChange);
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

  onCleanup(() => {
    window.removeEventListener('paste', handlePaste);
    window.removeEventListener('dragover', preventDefault);
    window.removeEventListener('drop', handleDrop);
    window.removeEventListener('focus', handleWindowFocus);
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    clipboardEventTarget()?.removeEventListener('clipboardchange', handleClipboardChange);
    closeIndexEvents();
    stopInviteScanner();
    Object.values(previewUrls()).forEach(URL.revokeObjectURL);
    toastTimers.forEach((timer) => window.clearTimeout(timer));
    toastTimers.clear();
  });

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
    clearQueuedClipboardSync();
    setActiveGroup(opened);
    setClipboardSyncEnabled(loadSyncEnabled(opened.id));
    saveActiveGroupId(opened.id);
    setIndex(emptyIndex());
    setBaseHash('');
    await loadIndex(opened);
    requestClipboardSync('focus');
  }

  function leaveGroup() {
    closeIndexEvents();
    clearPreviewUrls();
    clearQueuedClipboardSync();
    setActiveGroup(null);
    setClipboardSyncEnabled(false);
    saveActiveGroupId('');
    setIndex(emptyIndex());
    setBaseHash('');
    setTextDraft('');
    setPreviewModalClipId('');
    setPersistentNotice(null);
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
    await run(async () => {
      setScannedInvite('');
      setScannerOpen(true);
      try {
        await nextAnimationFrame();
        if (!scannerVideo || !scannerCanvas) {
          throw new Error('二维码扫描器尚未就绪。');
        }
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('当前浏览器不能使用摄像头扫描。');
        }
        scannerDone = false;
        scannerLastScanAt = 0;
        scannerStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false
        });
        scannerVideo.srcObject = scannerStream;
        await scannerVideo.play();
        scannerFrame = requestAnimationFrame(scanInviteFrame);
      } catch (err) {
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

  async function refreshAndReconnect() {
    await run(async () => {
      const group = requireGroup();
      const changed = await refreshIndex(group, true);
      if (liveState() !== 'live') {
        connectIndexEvents(group);
      }
      if (clipboardSyncEnabled()) {
        requestClipboardSync('focus');
      }
      return changed ? '已刷新并更新列表' : '已刷新，内容已是最新';
    }, '已刷新', '刷新中');
  }

  async function refreshIndex(group: ActiveGroup, forceCleanup = false): Promise<boolean> {
    const response = await fetchIndex(group);
    if (response.hash === baseHash()) {
      if (forceCleanup) {
        await cleanupExpired(index(), group, response.hash);
      }
      return false;
    }
    const decrypted = await decryptIndex(group.vaultCryptoKey, response.blob);
    setBaseHash(response.hash);
    setIndex(decrypted);
    await cleanupExpired(decrypted, group, response.hash);
    return true;
  }

  function connectIndexEvents(group: ActiveGroup) {
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
      (message) => {
        if (version === indexEventsVersion) {
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
          showToast('已实时更新', 'info');
          requestClipboardSync('remote');
        }
      } catch (err) {
        if (version === indexEventsVersion) {
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
      const saved = await saveIndex(group, hash, encrypted);
      setIndex(next);
      setBaseHash(saved.hash);
      return;
    } catch (err) {
      if ((err as Error & { status?: number }).status !== 409) {
        throw err;
      }
    }

    const remote = await fetchIndex(group);
    const remoteIndex = await decryptIndex(group.vaultCryptoKey, remote.blob);
    const merged = mergeIndexes(remoteIndex, next);
    const mergedBlob = await encryptIndex(group.vaultCryptoKey, merged);
    const saved = await saveIndex(group, remote.hash, mergedBlob);
    setIndex(merged);
    setBaseHash(saved.hash);
  }

  async function addText() {
    const value = textDraft();
    if (!value.trim()) {
      return;
    }
    await run(async () => {
      const outcome = await addPlainBytes({
        bytes: textEncoder.encode(value),
        kind: 'text',
        name: '文本',
        mime: 'text/plain;charset=utf-8',
        preview: value.slice(0, 160)
      });
      setTextDraft('');
      return saveOutcomeMessage(outcome, '已保存');
    }, '已保存', '保存中');
  }

  async function addFile(file: File) {
    await run(async () => {
      if (file.size > maxClientPlainBytes) {
        throw new Error(`单条内容不能超过 ${formatSize(maxClientPlainBytes)}，请拆成更小的内容后再保存。`);
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await file.arrayBuffer());
      } catch {
        throw new Error(`无法读取文件：${file.name || '未命名文件'}。请确认文件仍在本机且未被占用。`);
      }
      const outcome = await addPlainBytes({
        bytes,
        kind: file.type.startsWith('image/') ? 'image' : 'file',
        name: file.name || 'clipboard.bin',
        mime: file.type || 'application/octet-stream',
        preview: file.type.startsWith('image/') ? file.name || '图片' : file.name || '文件'
      });
      return saveOutcomeMessage(outcome, '已上传');
    }, '已上传', '上传中');
  }

  async function addPlainBytes(input: PlainClipInput): Promise<SaveOutcome> {
    return saveOrPromoteClip(input);
  }

  async function saveOrPromoteClip(input: PlainClipInput): Promise<SaveOutcome> {
    const group = requireGroup();
    if (input.bytes.byteLength > maxClientPlainBytes) {
      throw new Error(`单条内容不能超过 ${formatSize(maxClientPlainBytes)}，请拆成更小的内容后再保存。`);
    }
    const contentHash = input.contentHash || (await sha256Base64Url(input.bytes));
    const duplicate = await findDuplicateClip(input, contentHash);
    if (duplicate) {
      return promoteDuplicateClip(duplicate, contentHash, group);
    }
    const encrypted = await encryptBytes(group.vaultCryptoKey, input.bytes);
    const uploaded = await uploadBlob(group, encrypted);
    const now = Date.now();
    const clip: ClipEntry = {
      id: uploaded.clipId,
      blobId: uploaded.clipId,
      kind: input.kind,
      name: input.name,
      mime: input.mime,
      preview: input.preview,
      size: input.bytes.byteLength,
      encryptedSize: encrypted.byteLength,
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

    if (input.bytes.byteLength > legacyDedupeMaxBytes) {
      return null;
    }

    const candidates = clips
      .filter((clip) => !clip.contentHash && clip.kind === input.kind && clip.size === input.bytes.byteLength)
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
      const nav = requireClipboardAccess();
      if (typeof nav.read === 'function') {
        const items = await nav.read();
        for (const item of items) {
          const imageType = item.types.find((type) => type.startsWith('image/'));
          if (imageType) {
            const blob = await item.getType(imageType);
            const bytes = new Uint8Array(await blob.arrayBuffer());
            const outcome = await addPlainBytes({
              bytes,
              kind: 'image',
              name: `clipboard-${Date.now()}.${imageExtension(imageType)}`,
              mime: imageType,
              preview: '图片'
            });
            return saveOutcomeMessage(outcome, '已读取');
          }
        }
      }
      if (typeof nav.readText !== 'function') {
        throw new Error('当前浏览器不支持读取文本剪贴板。');
      }
      const text = await nav.readText();
      if (text.trim()) {
        const outcome = await addPlainBytes({
          bytes: textEncoder.encode(text),
          kind: 'text',
          name: '文本',
          mime: 'text/plain;charset=utf-8',
          preview: text.slice(0, 160)
        });
        return saveOutcomeMessage(outcome, '已读取');
      }
      return '系统剪贴板为空';
    }, '已读取', '读取中');
  }

  async function copyClip(clip: ClipEntry) {
    await run(async () => {
      if (!canCopyClip(clip)) {
        throw new Error(clip.kind === 'image' ? '当前浏览器不支持复制图片到系统剪贴板。' : '文件不能复制到系统剪贴板，请使用下载。');
      }
      const nav = requireClipboardAccess();
      const plain = await plainBytes(clip);
      if (clip.kind === 'text') {
        if (typeof nav.writeText !== 'function') {
          throw new Error('当前浏览器不支持复制文本。');
        }
        await nav.writeText(textDecoder.decode(plain));
        return;
      }
      if (clip.kind === 'image' && canWriteImageClipboard()) {
        const blob = new Blob([bytesToArrayBuffer(plain)], { type: clip.mime || 'image/png' });
        await nav.write([new ClipboardItem({ [blob.type]: blob })]);
        return;
      }
      throw new Error('文件不能复制到系统剪贴板，请使用下载。');
    }, '已复制');
  }

  function toggleClipboardSync(enabled: boolean) {
    const group = activeGroup();
    if (!group) {
      return;
    }
    if (enabled && (!navigator.clipboard || !canWriteTextClipboard())) {
      showToast('当前浏览器未开放剪贴板写入能力，请使用 HTTPS 或 localhost 访问。', 'error');
      return;
    }
    setClipboardSyncEnabled(enabled);
    saveSyncEnabled(group.id, enabled);
    clearQueuedClipboardSync();
    if (enabled) {
      showToast('剪贴板前台同步已开启', 'info');
      requestClipboardSync('enable');
    } else {
      setPersistentNotice(null);
      showToast('剪贴板前台同步已关闭', 'info');
    }
  }

  function handleWindowFocus() {
    recoverForeground('focus');
  }

  function handleVisibilityChange() {
    if (document.visibilityState === 'visible') {
      recoverForeground('visibility');
    }
  }

  function handleOnline() {
    recoverForeground('online');
  }

  function handleOffline() {
    setLiveState('offline');
    setPersistentNotice({ kind: 'error', message: '网络已离线，恢复后会重新连接' });
  }

  function handleClipboardChange() {
    requestClipboardSync('clipboardchange');
  }

  function recoverForeground(reason: SyncReason) {
    const group = activeGroup();
    if (!group || cryptoUnavailable || !canAttemptForegroundSync()) {
      return;
    }
    if (liveState() !== 'live') {
      connectIndexEvents(group);
    }
    if (clipboardSyncEnabled()) {
      requestClipboardSync(reason);
      return;
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

  function requestClipboardSync(reason: SyncReason) {
    const group = activeGroup();
    if (!group || !clipboardSyncEnabled() || cryptoUnavailable || !canAttemptForegroundSync()) {
      return;
    }
    if (clipboardSyncRunning) {
      queuedClipboardSyncReason = reason;
      return;
    }
    clipboardSyncRunning = true;
    setSyncing(true);
    const groupID = group.id;
    void (async () => {
      try {
        await syncClipboardNow(reason, groupID);
      } catch (err) {
        if (activeGroup()?.id === groupID && clipboardSyncEnabled()) {
          showToast(clipboardSyncError(err), 'error');
        }
      } finally {
        clipboardSyncRunning = false;
        setSyncing(false);
        const queued = queuedClipboardSyncReason;
        queuedClipboardSyncReason = null;
        if (queued && activeGroup()?.id === groupID && clipboardSyncEnabled()) {
          requestClipboardSync(queued);
        }
      }
    })();
  }

  function clearQueuedClipboardSync() {
    queuedClipboardSyncReason = null;
    setSyncing(false);
  }

  async function syncClipboardNow(reason: SyncReason, groupID: string) {
    const group = activeGroup();
    if (!group || group.id !== groupID) {
      return;
    }
    if (reason !== 'remote') {
      const changed = await refreshIndex(group);
      if (changed) {
        setPersistentNotice({ kind: 'info', message: '已刷新远端内容' });
      }
    }

    const latest = activeClips()[0];
    if (reason === 'remote') {
      if (latest) {
        await copyRemoteClipToClipboard(latest, groupID);
      }
      return;
    }

    const state = loadSyncState(groupID);
    let snapshot: ClipboardSnapshot | null;
    try {
      snapshot = await readClipboardSnapshot();
    } catch (err) {
      if (latest) {
        await copyRemoteClipToClipboard(latest, groupID);
        return;
      }
      throw err;
    }

    if (snapshot) {
      saveSyncState(groupID, {
        ...state,
        localHash: snapshot.hash,
        localObservedAt: Date.now()
      });
    }

    if (!latest) {
      if (snapshot) {
        await uploadClipboardSnapshot(snapshot, groupID);
      }
      return;
    }

    if (snapshot) {
      const latestHash = await knownClipHash(latest);
      if (latestHash && snapshot.hash === latestHash) {
        saveSyncState(groupID, {
          ...state,
          localHash: snapshot.hash,
          localObservedAt: Date.now(),
          remoteClipId: latest.id,
          remoteHash: latestHash
        });
        setPersistentNotice({ kind: 'info', message: '剪贴板内容已是最新' });
        return;
      }

      const localChanged = !!state.localHash && snapshot.hash !== state.localHash;
      if (localChanged) {
        const duplicate = await findDuplicateClip(snapshot, snapshot.hash);
        if (duplicate) {
          const outcome = await promoteDuplicateClip(duplicate, snapshot.hash, group);
          saveSyncState(groupID, {
            ...state,
            localHash: snapshot.hash,
            localObservedAt: Date.now(),
            remoteClipId: outcome.clip.id,
            remoteHash: snapshot.hash
          });
          setPersistentNotice({ kind: 'info', message: saveOutcomeMessage(outcome, '剪贴板内容已同步') });
          return;
        }
        await uploadClipboardSnapshot(snapshot, groupID);
        return;
      }
    }

    await copyRemoteClipToClipboard(latest, groupID);
  }

  async function uploadClipboardSnapshot(snapshot: ClipboardSnapshot, groupID: string) {
    const group = activeGroup();
    if (!group || group.id !== groupID) {
      return;
    }
    const outcome = await addPlainBytes({
      bytes: snapshot.bytes,
      kind: snapshot.kind,
      name: snapshot.name,
      mime: snapshot.mime,
      preview: snapshot.preview,
      contentHash: snapshot.hash
    });
    const state = loadSyncState(groupID);
    saveSyncState(groupID, {
      ...state,
      localHash: snapshot.hash,
      localObservedAt: Date.now(),
      remoteClipId: outcome.clip.id,
      remoteHash: snapshot.hash
    });
    setPersistentNotice({ kind: 'info', message: saveOutcomeMessage(outcome, '已同步本机剪贴板') });
  }

  async function copyRemoteClipToClipboard(clip: ClipEntry, groupID: string) {
    const group = activeGroup();
    if (!group || group.id !== groupID) {
      return;
    }
    if (clip.kind === 'file') {
      setPersistentNotice({ kind: 'info', message: '最新内容是文件，浏览器不能自动写入系统剪贴板' });
      return;
    }
    if (clip.kind === 'text' && !canWriteTextClipboard()) {
      setPersistentNotice({ kind: 'error', message: '当前浏览器不支持自动写入文本剪贴板' });
      return;
    }
    if (clip.kind === 'image' && !canWriteImageClipboard()) {
      setPersistentNotice({ kind: 'info', message: '当前浏览器不支持自动写入图片剪贴板' });
      return;
    }
    const state = loadSyncState(groupID);
    const knownHash = clip.contentHash || (state.remoteClipId === clip.id ? state.remoteHash : undefined);
    if (knownHash && state.remoteClipId === clip.id && state.localHash === knownHash) {
      return;
    }

    const plain = await plainBytes(clip);
    const hash = await sha256Base64Url(plain);
    if (state.remoteClipId === clip.id && state.localHash === hash) {
      return;
    }
    const nav = requireClipboardAccess();
    if (clip.kind === 'text') {
      await nav.writeText(textDecoder.decode(plain));
    } else if (clip.kind === 'image' && 'ClipboardItem' in window && typeof nav.write === 'function') {
      const blob = new Blob([bytesToArrayBuffer(plain)], { type: clip.mime || 'image/png' });
      await nav.write([new ClipboardItem({ [blob.type]: blob })]);
    } else {
      setPersistentNotice({ kind: 'info', message: '当前浏览器不能自动写入图片剪贴板' });
      return;
    }

    saveSyncState(groupID, {
      ...state,
      localHash: hash,
      localObservedAt: clip.createdAt,
      remoteClipId: clip.id,
      remoteHash: hash,
      remoteCopiedAt: Date.now()
    });
    setPersistentNotice({ kind: 'info', message: '已同步到系统剪贴板' });
  }

  async function clipPlainHash(clip: ClipEntry) {
    return sha256Base64Url(await plainBytes(clip));
  }

  async function knownClipHash(clip: ClipEntry): Promise<string | null> {
    if (clip.contentHash) {
      return clip.contentHash;
    }
    if (clip.kind === 'file' || clip.size > legacyDedupeMaxBytes) {
      return null;
    }
    try {
      const contentHash = await clipPlainHash(clip);
      const group = activeGroup();
      if (group) {
        await promoteDuplicateClip(clip, contentHash, group);
      }
      return contentHash;
    } catch {
      return null;
    }
  }

  async function readClipboardSnapshot(): Promise<ClipboardSnapshot | null> {
    const nav = requireClipboardAccess();
    let richReadError: unknown;
    if (typeof nav.read === 'function') {
      try {
        const items = await nav.read();
        for (const item of items) {
          const imageType = item.types.find((type) => type.startsWith('image/'));
          if (imageType) {
            const blob = await item.getType(imageType);
            const bytes = new Uint8Array(await blob.arrayBuffer());
            return {
              kind: 'image',
              bytes,
              name: `clipboard-${Date.now()}.${imageExtension(imageType)}`,
              mime: imageType,
              preview: '图片',
              hash: await sha256Base64Url(bytes)
            };
          }
        }
        for (const item of items) {
          if (item.types.includes('text/plain')) {
            const blob = await item.getType('text/plain');
            const text = await blob.text();
            if (text.trim()) {
              const bytes = textEncoder.encode(text);
              return {
                kind: 'text',
                bytes,
                name: '文本',
                mime: 'text/plain;charset=utf-8',
                preview: text.slice(0, 160),
                hash: await sha256Base64Url(bytes)
              };
            }
          }
        }
      } catch (err) {
        richReadError = err;
      }
    }

    if (typeof nav.readText !== 'function') {
      if (richReadError) {
        throw richReadError;
      }
      throw new Error('当前浏览器不支持读取剪贴板');
    }
    const text = await nav.readText();
    if (!text.trim()) {
      return null;
    }
    const bytes = textEncoder.encode(text);
    return {
      kind: 'text',
      bytes,
      name: '文本',
      mime: 'text/plain;charset=utf-8',
      preview: text.slice(0, 160),
      hash: await sha256Base64Url(bytes)
    };
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

  async function openPreviewModal(clip: ClipEntry) {
    if (clip.kind !== 'image') {
      return;
    }
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
    return decryptBytes(group.vaultCryptoKey, await downloadBlob(group, clip.blobId));
  }

  async function removeClip(clip: ClipEntry) {
    await run(async () => {
      const group = requireGroup();
      await deleteBlob(group, clip.blobId);
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
    await Promise.allSettled(expired.map((clip) => deleteBlob(group, clip.blobId)));
    const next: ClipIndex = {
      ...currentIndex,
      updatedAt: now,
      clips: currentIndex.clips.filter((clip) => !isExpired(clip, now)),
      deleted: [...currentIndex.deleted, ...expired.map((clip) => ({ id: clip.id, deletedAt: now }))]
    };
    await persist(next, group, hash);
  }

  function handlePaste(event: ClipboardEvent) {
    if (!unlocked()) {
      return;
    }
    const files = clipboardFilesFromPaste(event);
    if (files.length > 0) {
      event.preventDefault();
      files.forEach((file) => void addFile(file));
      return;
    }
    if (isTyping()) {
      return;
    }
    const text = event.clipboardData?.getData('text/plain');
    if (text?.trim()) {
      event.preventDefault();
      void run(async () => {
        const outcome = await addPlainBytes({
          bytes: textEncoder.encode(text),
          kind: 'text',
          name: '文本',
          mime: 'text/plain;charset=utf-8',
          preview: text.slice(0, 160)
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
    [...(event.dataTransfer?.files || [])].forEach((file) => void addFile(file));
  }

  function preventDefault(event: Event) {
    event.preventDefault();
  }

  async function run(action: () => Promise<string | void>, ok: string, label = '处理中') {
    setBusy(true);
    setOperationLabel(label);
    try {
      const result = await action();
      showToast(result || ok, 'success');
    } catch (err) {
      showToast(displayError(err), 'error');
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

  function canCopyClip(clip: ClipEntry) {
    if (clip.kind === 'text') {
      return canWriteTextClipboard();
    }
    if (clip.kind === 'image') {
      return canWriteImageClipboard();
    }
    return false;
  }

  return (
    <main class="app">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark"><Users size={18} /></div>
          <div>
            <h1>OpenList Clipboard</h1>
            <span>{activeGroup() ? `${activeGroup()!.name} · ${activeClips().length} 条` : '未打开剪贴板'}</span>
          </div>
        </div>
        <div class="top-actions">
          <Show when={groups().length > 0}>
            <select class="group-select" value={activeGroup()?.id || ''} disabled={busy()} onChange={(event) => void switchGroup(event.currentTarget.value)}>
              <option value="" disabled>选择剪贴板</option>
              <For each={groups()}>{(group) => <option value={group.id}>{group.name}</option>}</For>
            </select>
          </Show>
          <Show when={unlocked()}>
            <button class="icon-button" title="读取剪贴板" disabled={busy()} onClick={() => void readClipboard()}>
              <ClipboardIcon size={18} />
            </button>
            <button class="icon-button" title="刷新/重连" disabled={busy()} onClick={() => void refreshAndReconnect()}>
              <RefreshCw size={18} />
            </button>
            <label class={`sync-toggle ${clipboardSyncEnabled() ? 'enabled' : ''}`} title="前台剪贴板同步">
              <input
                type="checkbox"
                checked={clipboardSyncEnabled()}
                onChange={(event) => toggleClipboardSync(event.currentTarget.checked)}
              />
              <span class="sync-switch" />
              <span>同步</span>
            </label>
            <span class={`live-pill ${liveState()}`}>{liveStateLabel(liveState())}</span>
            <Show when={busy() || syncing()}>
              <span class="busy-pill">
                <Loader2 class="spin" size={14} />
                {busy() ? operationLabel() || '处理中' : '同步中'}
              </span>
            </Show>
            <button class="icon-button" title="关闭当前剪贴板" disabled={busy()} onClick={leaveGroup}>
              <LogOut size={18} />
            </button>
          </Show>
        </div>
      </header>

      <Show when={persistentNotice()}>
        <div class={`status-strip ${persistentNotice()!.kind}`}>{persistentNotice()!.message}</div>
      </Show>

      <Show when={!unlocked()}>
        <section class="key-panel">
          <div class="panel-title">
            <KeyRound size={18} />
            <h2>剪贴板</h2>
          </div>
          <Show when={cryptoUnavailable}>
            <p class="notice">{cryptoUnavailable}</p>
          </Show>
          <form class="group-form" onSubmit={createGroupAction}>
            <div class="form-title">创建剪贴板</div>
            <input
              value={groupName()}
              onInput={(event) => setGroupName(event.currentTarget.value)}
              placeholder="剪贴板名称"
              autocomplete="off"
              required
            />
            <input
              type="password"
              value={createPassword()}
              onInput={(event) => setCreatePassword(event.currentTarget.value)}
              placeholder="创建密码（必填）"
              autocomplete="current-password"
              required
            />
            <button type="submit" disabled={busy() || !canCreateGroup()}>
              <Plus size={17} />
              创建剪贴板
            </button>
            <Show when={createFormHint()}>
              <p class="form-hint">{createFormHint()}</p>
            </Show>
          </form>
          <form class="group-form import-form" onSubmit={importGroupAction}>
            <div class="form-title">加入已有剪贴板</div>
            <textarea
              value={inviteInput()}
              onInput={(event) => setInviteInput(event.currentTarget.value)}
              placeholder="粘贴 olckey1 剪贴板密钥"
              rows={4}
              spellcheck={false}
            />
            <div class="composer-actions">
              <button type="button" onClick={() => void startInviteScanner()} disabled={busy() || !!cryptoUnavailable}>
                <Camera size={17} />
                扫描
              </button>
              <button type="submit" disabled={busy() || !!cryptoUnavailable || inviteInput().trim().length === 0}>
                <Upload size={17} />
                加入剪贴板
              </button>
            </div>
          </form>
        </section>
      </Show>

      <Show when={unlocked()}>
        <section class="composer">
          <textarea
            value={textDraft()}
            onInput={(event) => setTextDraft(event.currentTarget.value)}
            placeholder="粘贴文本"
            rows={4}
          />
          <div class="composer-actions">
            <label class="file-button" title="上传文件">
              <Upload size={17} />
              文件
              <input type="file" multiple onChange={(event) => [...(event.currentTarget.files || [])].forEach((file) => void addFile(file))} />
            </label>
            <button onClick={() => void addText()} disabled={busy() || textDraft().trim().length === 0}>
              <FileText size={17} />
              保存
            </button>
          </div>
        </section>

        <section class="vault-strip">
          <span class="mono">{activeGroup()?.invite}</span>
          <button class="icon-button" title="复制剪贴板密钥" disabled={busy()} onClick={() => void copyInviteKey()}>
            <Copy size={17} />
          </button>
          <button class="icon-button" title="生成剪贴板密钥二维码" onClick={() => void showInviteCodeQR()}>
            <QrCode size={17} />
          </button>
          <button class="icon-button danger" title="忘记本机密钥" onClick={removeActiveGroup}>
            <Trash2 size={17} />
          </button>
        </section>

        <section class="clip-list">
          <Show when={activeClips().length > 0} fallback={<div class="empty">暂无内容</div>}>
            <For each={activeClips()}>
              {(clip) => (
                <article class="clip-card">
                  <div class="clip-icon">
                    <Show
                      when={clip.kind === 'text'}
                      fallback={<Show when={clip.kind === 'image'} fallback={<FileIcon size={19} />}><ImageIcon size={19} /></Show>}
                    >
                      <FileText size={19} />
                    </Show>
                  </div>
                  <div class="clip-main">
                    <div class="clip-head">
                      <Show when={clip.kind !== 'text'}>
                        <strong>{clip.name}</strong>
                      </Show>
                      <span>{formatSize(clip.size)} · {formatTime(clipSortTime(clip))}</span>
                    </div>
                    <Show when={clip.kind === 'text'}>
                      <p class="text-preview">{clip.preview || '文本'}</p>
                    </Show>
                    <Show when={clip.kind === 'image' && previewUrls()[clip.id]}>
                      <button class="preview-button" type="button" title="查看大图" disabled={busy()} onClick={() => void openPreviewModal(clip)}>
                        <img class="preview" src={previewUrls()[clip.id]} alt={clip.name} />
                      </button>
                    </Show>
                  </div>
                  <div class="clip-actions">
                    <Show when={canCopyClip(clip)}>
                      <button class="icon-button" title="复制" disabled={busy()} onClick={() => void copyClip(clip)}>
                        <Copy size={17} />
                      </button>
                    </Show>
                    <Show when={clip.kind === 'image'}>
                      <Show
                        when={previewUrls()[clip.id]}
                        fallback={
                          <button class="icon-button" title="预览" disabled={busy()} onClick={() => void previewClip(clip)}>
                            <Eye size={17} />
                          </button>
                        }
                      >
                        <button class="icon-button" title="查看大图" disabled={busy()} onClick={() => void openPreviewModal(clip)}>
                          <Maximize2 size={17} />
                        </button>
                        <button class="icon-button" title="收起预览" disabled={busy()} onClick={() => collapsePreview(clip)}>
                          <EyeOff size={17} />
                        </button>
                      </Show>
                    </Show>
                    <Show when={clip.kind !== 'text'}>
                      <button class="icon-button" title="下载" disabled={busy()} onClick={() => void downloadClip(clip)}>
                        <Download size={17} />
                      </button>
                    </Show>
                    <button class="icon-button" title={clip.pinned ? '取消置顶' : '置顶'} disabled={busy()} onClick={() => void togglePin(clip)}>
                      <Show when={clip.pinned} fallback={<Pin size={17} />}><PinOff size={17} /></Show>
                    </button>
                    <button class="icon-button danger" title="删除" disabled={busy()} onClick={() => void removeClip(clip)}>
                      <Trash2 size={17} />
                    </button>
                  </div>
                </article>
              )}
            </For>
          </Show>
        </section>
      </Show>

      <Show when={showInviteQR()}>
        <div class="modal-backdrop" onClick={() => setShowInviteQR(false)}>
          <section class="modal-panel qr-panel" onClick={(event) => event.stopPropagation()}>
            <div class="modal-head">
              <h2>剪贴板密钥二维码</h2>
              <button class="icon-button" title="关闭" onClick={() => setShowInviteQR(false)}>
                <X size={17} />
              </button>
            </div>
            <p class="notice">剪贴板密钥包含完整访问权限，只分享给可信设备。</p>
            <Show when={inviteQR()}>
              <img class="qr-image" src={inviteQR()} alt="剪贴板密钥二维码" />
            </Show>
            <div class="qr-actions">
              <button onClick={() => void copyInviteKey()}>
                <Copy size={17} />
                复制密钥
              </button>
            </div>
          </section>
        </div>
      </Show>

      <Show when={scannerOpen()}>
        <div class="modal-backdrop" onClick={stopInviteScanner}>
          <section class="modal-panel scanner-panel" onClick={(event) => event.stopPropagation()}>
            <div class="modal-head">
              <h2>扫描剪贴板密钥</h2>
              <button class="icon-button" title="关闭" onClick={stopInviteScanner}>
                <X size={17} />
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
                <p class="notice info">已识别剪贴板密钥，请确认后加入。</p>
                <div class="scanner-key mono">{scannedInvite()}</div>
                <div class="qr-actions">
                  <button type="button" disabled={busy()} onClick={() => void joinScannedInvite()}>
                    <Upload size={17} />
                    加入剪贴板
                  </button>
                  <button type="button" class="secondary-button" disabled={busy()} onClick={() => void startInviteScanner()}>
                    <Camera size={17} />
                    重新扫描
                  </button>
                </div>
              </div>
            </Show>
          </section>
        </div>
      </Show>

      <Show when={previewModalClip()}>
        <div class="modal-backdrop image-backdrop" onClick={() => setPreviewModalClipId('')}>
          <section class="modal-panel image-panel" onClick={(event) => event.stopPropagation()}>
            <div class="modal-head">
              <h2>{previewModalClip()!.name || '图片预览'}</h2>
              <button class="icon-button" title="关闭" onClick={() => setPreviewModalClipId('')}>
                <X size={17} />
              </button>
            </div>
            <Show when={previewUrls()[previewModalClip()!.id]}>
              <img class="image-preview-large" src={previewUrls()[previewModalClip()!.id]} alt={previewModalClip()!.name || '图片预览'} />
            </Show>
          </section>
        </div>
      </Show>

      <div class="toast-stack">
        <For each={toasts()}>
          {(toast) => (
            <div class={`toast ${toast.kind}`}>
              <span>{toast.message}</span>
              <button class="toast-close" title="关闭提示" onClick={() => dismissToast(toast.id)}>
                <X size={14} />
              </button>
            </div>
          )}
        </For>
      </div>
    </main>
  );
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

function clipboardFilesFromPaste(event: ClipboardEvent): File[] {
  const data = event.clipboardData;
  if (!data) {
    return [];
  }
  const files = [...data.files].map((file) => normalizePastedFile(file));
  if (files.length > 0) {
    return files;
  }
  return [...data.items]
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
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

function canAttemptForegroundSync() {
  return document.visibilityState === 'visible' && document.hasFocus();
}

function canWriteTextClipboard() {
  return typeof navigator.clipboard?.writeText === 'function';
}

function canWriteImageClipboard() {
  const clipboard = navigator.clipboard as (Clipboard & { write?: (items: ClipboardItem[]) => Promise<void> }) | undefined;
  return typeof ClipboardItem !== 'undefined' && typeof clipboard?.write === 'function';
}

function clipboardEventTarget(): (EventTarget & {
  addEventListener: EventTarget['addEventListener'];
  removeEventListener: EventTarget['removeEventListener'];
}) | null {
  const clipboard = navigator.clipboard as unknown as
    | (EventTarget & {
        addEventListener?: EventTarget['addEventListener'];
        removeEventListener?: EventTarget['removeEventListener'];
      })
    | undefined;
  if (!clipboard || typeof clipboard.addEventListener !== 'function' || typeof clipboard.removeEventListener !== 'function') {
    return null;
  }
  return clipboard as EventTarget & {
    addEventListener: EventTarget['addEventListener'];
    removeEventListener: EventTarget['removeEventListener'];
  };
}

function requireClipboardAccess(): Clipboard & {
  read?: () => Promise<ClipboardItem[]>;
} {
  if (!navigator.clipboard) {
    throw new Error('当前浏览器未开放剪贴板能力，请使用 HTTPS 或 localhost 访问。');
  }
  return navigator.clipboard as Clipboard & {
    read?: () => Promise<ClipboardItem[]>;
  };
}

async function sha256Base64Url(bytes: Uint8Array) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytesToArrayBuffer(bytes)));
  return bytesToBase64Url(hash);
}

function imageExtension(mime: string) {
  const subtype = mime.split('/')[1]?.split('+')[0]?.replace(/[^A-Za-z0-9_-]/g, '');
  return subtype || 'png';
}

function loadSyncEnabled(groupID: string) {
  return readStorageObject(syncEnabledStorageKey)[groupID] === true;
}

function saveSyncEnabled(groupID: string, enabled: boolean) {
  const current = readStorageObject(syncEnabledStorageKey);
  if (enabled) {
    current[groupID] = true;
  } else {
    delete current[groupID];
  }
  writeStorageObject(syncEnabledStorageKey, current);
}

function loadSyncState(groupID: string): StoredSyncState {
  const state = readStorageObject(syncStateStorageKey)[groupID];
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return {};
  }
  return state as StoredSyncState;
}

function saveSyncState(groupID: string, state: StoredSyncState) {
  const current = readStorageObject(syncStateStorageKey);
  current[groupID] = {
    localHash: state.localHash,
    localObservedAt: state.localObservedAt,
    remoteClipId: state.remoteClipId,
    remoteHash: state.remoteHash,
    remoteCopiedAt: state.remoteCopiedAt
  };
  writeStorageObject(syncStateStorageKey, current);
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

function clipboardSyncError(err: unknown) {
  if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
    return '浏览器拒绝剪贴板同步。请确认页面在前台，并允许此站点读取/写入剪贴板。';
  }
  return displayError(err);
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
