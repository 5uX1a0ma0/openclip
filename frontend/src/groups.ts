import { bytesToBase64Url, base64UrlToBytes, deriveGroupId, generateVaultKey, importVaultKey } from './crypto';
import type { ActiveGroup, GroupInvite, SavedGroup } from './types';

const invitePrefix = 'olcgrp1.';
const groupsStorageName = 'openlist.clipboard.groups.v1';
const activeGroupStorageName = 'openlist.clipboard.activeGroup.v1';
const oldVaultKeyStorageName = 'openlist.clipboard.vaultKey';

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
  const vaultKey = generateVaultKey();
  const groupId = await deriveGroupId(vaultKey);
  const pair = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair;
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const invite = encodeInvite({ version: 1, groupId, vaultKey, signingPrivateJwk: privateKeyJwk });
  const now = Date.now();
  return {
    id: groupId,
    name: cleanGroupName(name, groupId),
    vaultKey,
    publicKeyJwk: publicJwkFromPrivate(privateKeyJwk, publicKeyJwk),
    privateKeyJwk,
    invite,
    createdAt: now,
    updatedAt: now
  };
}

export async function savedGroupFromInvite(inviteText: string, name = ''): Promise<SavedGroup> {
  const invite = decodeInvite(inviteText);
  const derived = await deriveGroupId(invite.vaultKey);
  if (derived !== invite.groupId) {
    throw new Error('邀请码中的 Vault Key 与 groupId 不匹配');
  }
  const publicKeyJwk = publicJwkFromPrivate(invite.signingPrivateJwk);
  const now = Date.now();
  return {
    id: invite.groupId,
    name: cleanGroupName(name, invite.groupId),
    vaultKey: invite.vaultKey,
    publicKeyJwk,
    privateKeyJwk: invite.signingPrivateJwk,
    invite: encodeInvite(invite),
    createdAt: now,
    updatedAt: now
  };
}

export async function activateGroup(group: SavedGroup): Promise<ActiveGroup> {
  const vaultCryptoKey = await importVaultKey(group.vaultKey);
  const signingKey = await crypto.subtle.importKey(
    'jwk',
    group.privateKeyJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  return { ...group, vaultCryptoKey, signingKey };
}

export function upsertGroup(groups: SavedGroup[], next: SavedGroup): SavedGroup[] {
  const existing = groups.find((group) => group.id === next.id);
  if (!existing) {
    return [...groups, next].sort((a, b) => a.name.localeCompare(b.name));
  }
  const defaultName = `Group ${next.id.slice(0, 8)}`;
  return groups
    .map((group) => (group.id === next.id ? { ...next, name: next.name === defaultName ? existing.name : next.name, createdAt: existing.createdAt } : group))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function removeGroup(groups: SavedGroup[], groupId: string): SavedGroup[] {
  return groups.filter((group) => group.id !== groupId);
}

export function isInviteText(value: string): boolean {
  return value.trim().startsWith(invitePrefix);
}

export function encodeInvite(invite: GroupInvite): string {
  return `${invitePrefix}${bytesToBase64Url(new TextEncoder().encode(JSON.stringify(invite)))}`;
}

export function decodeInvite(value: string): GroupInvite {
  const trimmed = value.trim();
  if (!trimmed.startsWith(invitePrefix)) {
    throw new Error('邀请码格式不正确');
  }
  const raw = new TextDecoder().decode(base64UrlToBytes(trimmed.slice(invitePrefix.length)));
  const parsed = JSON.parse(raw) as GroupInvite;
  if (parsed.version !== 1 || !parsed.groupId || !parsed.vaultKey || !parsed.signingPrivateJwk) {
    throw new Error('邀请码内容不完整');
  }
  return parsed;
}

function publicJwkFromPrivate(privateKeyJwk: JsonWebKey, fallback?: JsonWebKey): JsonWebKey {
  const x = privateKeyJwk.x || fallback?.x;
  const y = privateKeyJwk.y || fallback?.y;
  if (!x || !y) {
    throw new Error('签名私钥缺少公钥坐标');
  }
  return {
    kty: 'EC',
    crv: 'P-256',
    x,
    y,
    ext: true,
    key_ops: ['verify']
  };
}

function cleanGroupName(name: string, groupId: string): string {
  const trimmed = name.trim();
  return trimmed || `Group ${groupId.slice(0, 8)}`;
}

function isSavedGroup(value: unknown): value is SavedGroup {
  const group = value as SavedGroup;
  return Boolean(group?.id && group?.vaultKey && group?.privateKeyJwk && group?.publicKeyJwk && group?.invite);
}
