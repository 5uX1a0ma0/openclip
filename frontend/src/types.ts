export type ClipKind = 'text' | 'image' | 'file';

export type ClipEntry = {
  id: string;
  blobId: string;
  kind: ClipKind;
  name: string;
  mime: string;
  preview: string;
  size: number;
  encryptedSize: number;
  contentHash?: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  expiresAt: number | null;
  pinned: boolean;
};

export type Tombstone = {
  id: string;
  deletedAt: number;
};

export type ClipIndex = {
  version: 1;
  updatedAt: number;
  clips: ClipEntry[];
  deleted: Tombstone[];
};

export type IndexResponse = {
  hash: string;
  blob: string;
};

export type IndexEvent = {
  hash: string;
};

export type BlobResponse = {
  clipId: string;
  size: number;
  hash: string;
};

export type SavedGroup = {
  id: string;
  name: string;
  vaultKey: string;
  keyHash: string;
  publicKeyJwk: JsonWebKey;
  invite: string;
  createdAt: number;
  updatedAt: number;
};

export type ActiveGroup = SavedGroup & {
  vaultCryptoKey: CryptoKey;
  signingKey: CryptoKey;
};

export type GroupAuth = {
  id: string;
  signingKey: CryptoKey;
};

export type GroupMetadata = {
  groupId: string;
  name: string;
};
