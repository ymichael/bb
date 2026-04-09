import type { CloudAuthProviderId } from "@bb/agent-providers";
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

export interface PersistedCloudAuthCredentialRecord {
  encryptedAccessToken: string;
  encryptedIdToken: string | null;
  encryptedMetadata: string;
  encryptedRefreshToken: string;
  expiresAt: number;
  label: string | null;
  lastErrorMessage: string | null;
  lastRefreshedAt: number | null;
  providerId: CloudAuthProviderId;
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
