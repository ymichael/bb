import type { CloudAuthCrypto } from "./crypto.js";
import type { StoredCloudAuthCredential } from "./provider-definitions.js";

export interface CloudAuthResolvedCredential<
  TCredential extends StoredCloudAuthCredential = StoredCloudAuthCredential,
> {
  credential: TCredential;
  label: string | null;
  lastErrorMessage: string | null;
  lastRefreshedAt: number | null;
  providerId: TCredential["providerId"];
  updatedAt: number;
}

export interface BuildCloudAuthCredentialUpsertArgs {
  credential: StoredCloudAuthCredential;
  crypto: CloudAuthCrypto;
  label: string | null;
  lastErrorMessage: string | null;
  lastRefreshedAt: number | null;
  updatedAt: number;
}

export interface EncryptedCloudAuthCredentialRecord {
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  encryptedIdToken: string | null;
  encryptedMetadata: string;
  expiresAt: number;
  providerId: string;
}

export interface EncryptedCloudAuthCredentialUpsert
  extends EncryptedCloudAuthCredentialRecord
{
  label: string | null;
  lastErrorMessage: string | null;
  lastRefreshedAt: number | null;
  updatedAt: number;
}
