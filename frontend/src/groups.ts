import {
  base64UrlToBytes,
  deriveGroupId,
  deriveKeyHash,
  deriveSigningIdentity,
  generateVaultKey,
  importVaultKey
} from './crypto';
import type { ActiveGroup, SavedGroup } from './types';

const clipboardKeyPrefix = 'olckey1.';
const legacyInvitePrefix = 'olcgrp1.';
const groupsStorageName = 'openlist.clipboard.groups.v1';
const activeGroupStorageName = 'openlist.clipboard.activeGroup.v1';
const oldVaultKeyStorageName = 'openlist.clipboard.vaultKey';
const keyPattern = /^[A-Za-z0-9_-]{43}$/;

export function loadSavedGroups(): SavedGroup[] {
  localStorage.removeItem(oldVaultKeyStorageName);
  const raw = localStorage.getItem(groupsStorageName);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as SavedGroup[];
    return Array.isArray(parsed) ? parsed.filter(isSavedGroup) : [];
  } catch {
    return [];
  }
}

export function saveSavedGroups(groups: SavedGroup[]) {
  localStorage.setItem(groupsStorageName, JSON.stringify(groups));
}

export function activeGroupId(): string {
  return localStorage.getItem(activeGroupStorageName) || '';
}

export function saveActiveGroupId(groupId: string) {
  if (groupId) {
    localStorage.setItem(activeGroupStorageName, groupId);
  } else {
    localStorage.removeItem(activeGroupStorageName);
  }
}

export async function createSavedGroup(name: string): Promise<SavedGroup> {
  const cleaned = cleanGroupName(name);
  if (!cleaned) {
    throw new Error('请先填写剪贴板名称');
  }
  return savedGroupFromVaultKey(generateVaultKey(), cleaned);
}

export async function savedGroupFromInvite(inviteText: string, name = ''): Promise<SavedGroup> {
  const vaultKey = decodeClipboardKey(inviteText);
  return savedGroupFromVaultKey(vaultKey, cleanGroupName(name));
}

export async function activateGroup(group: SavedGroup): Promise<ActiveGroup> {
  const vaultCryptoKey = await importVaultKey(group.vaultKey);
  let signingKey: CryptoKey;
  if (group.privateKeyJwk) {
    signingKey = await crypto.subtle.importKey(
      'jwk',
      group.privateKeyJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    );
  } else {
    signingKey = (await deriveSigningIdentity(group.vaultKey)).signingKey;
  }
  return { ...group, vaultCryptoKey, signingKey };
}

export function upsertGroup(groups: SavedGroup[], next: SavedGroup): SavedGroup[] {
  const existing = groups.find((group) => group.id === next.id);
  if (!existing) {
    return [...groups, next].sort((a, b) => a.name.localeCompare(b.name));
  }
  return groups
    .map((group) =>
      group.id === next.id
        ? {
            ...next,
            name: next.name || existing.name,
            createdAt: existing.createdAt
          }
        : group
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function removeGroup(groups: SavedGroup[], groupId: string): SavedGroup[] {
  return groups.filter((group) => group.id !== groupId);
}

export function isInviteText(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith(clipboardKeyPrefix) || trimmed.startsWith(legacyInvitePrefix) || keyPattern.test(trimmed);
}

export function encodeClipboardKey(vaultKey: string): string {
  return `${clipboardKeyPrefix}${vaultKey}`;
}

export function decodeClipboardKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith(clipboardKeyPrefix)) {
    return validateVaultKey(trimmed.slice(clipboardKeyPrefix.length));
  }
  if (keyPattern.test(trimmed)) {
    return validateVaultKey(trimmed);
  }
  if (trimmed.startsWith(legacyInvitePrefix)) {
    return decodeLegacyVaultKey(trimmed);
  }
  throw new Error('剪贴板密钥格式不正确');
}

async function savedGroupFromVaultKey(vaultKey: string, name: string): Promise<SavedGroup> {
  const groupId = await deriveGroupId(vaultKey);
  const keyHash = await deriveKeyHash(vaultKey);
  const identity = await deriveSigningIdentity(vaultKey);
  const now = Date.now();
  return {
    id: groupId,
    name: name || `Clipboard ${groupId.slice(0, 8)}`,
    vaultKey,
    keyHash,
    publicKeyJwk: identity.publicKeyJwk,
    privateKeyJwk: identity.privateKeyJwk,
    invite: encodeClipboardKey(vaultKey),
    createdAt: now,
    updatedAt: now
  };
}

function validateVaultKey(value: string): string {
  if (!keyPattern.test(value)) {
    throw new Error('剪贴板密钥格式不正确');
  }
  if (base64UrlToBytes(value).byteLength !== 32) {
    throw new Error('剪贴板密钥长度不正确');
  }
  return value;
}

function decodeLegacyVaultKey(value: string): string {
  try {
    const raw = new TextDecoder().decode(base64UrlToBytes(value.slice(legacyInvitePrefix.length)));
    const parsed = JSON.parse(raw) as { vaultKey?: string };
    if (parsed.vaultKey) {
      return validateVaultKey(parsed.vaultKey);
    }
  } catch {
    // Fall through to a consistent user-facing error.
  }
  throw new Error('旧版分享内容无法解析，请改用剪贴板密钥');
}

function cleanGroupName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, 80);
}

function isSavedGroup(value: unknown): value is SavedGroup {
  const group = value as SavedGroup;
  return Boolean(group?.id && group?.vaultKey && group?.keyHash && group?.publicKeyJwk && group?.invite);
}
