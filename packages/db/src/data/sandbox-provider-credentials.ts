import { eq } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import { createSandboxProviderCredentialId } from "../ids.js";
import { sandboxProviderCredentials } from "../schema.js";

export interface UpsertSandboxProviderCredentialArgs {
  providerId: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  encryptedIdToken: string | null;
  encryptedMetadata: string;
  label: string | null;
  expiresAt: number;
  lastRefreshedAt: number | null;
  lastErrorMessage: string | null;
  updatedAt: number;
}

export interface SandboxProviderCredentialRecord {
  id: string;
  providerId: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  encryptedIdToken: string | null;
  encryptedMetadata: string;
  label: string | null;
  expiresAt: number;
  lastRefreshedAt: number | null;
  lastErrorMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

function toRecord(
  row: typeof sandboxProviderCredentials.$inferSelect,
): SandboxProviderCredentialRecord {
  return {
    id: row.id,
    providerId: row.providerId,
    encryptedAccessToken: row.encryptedAccessToken,
    encryptedRefreshToken: row.encryptedRefreshToken,
    encryptedIdToken: row.encryptedIdToken,
    encryptedMetadata: row.encryptedMetadata,
    label: row.label,
    expiresAt: row.expiresAt.getTime(),
    lastRefreshedAt: row.lastRefreshedAt ? row.lastRefreshedAt.getTime() : null,
    lastErrorMessage: row.lastErrorMessage,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

export function getSandboxProviderCredentialByProviderId(
  db: DbConnection,
  providerId: string,
): SandboxProviderCredentialRecord | null {
  const row = db
    .select()
    .from(sandboxProviderCredentials)
    .where(eq(sandboxProviderCredentials.providerId, providerId))
    .get();

  return row ? toRecord(row) : null;
}

export function listSandboxProviderCredentials(
  db: DbConnection,
): SandboxProviderCredentialRecord[] {
  return db
    .select()
    .from(sandboxProviderCredentials)
    .all()
    .map(toRecord);
}

export function upsertSandboxProviderCredential(
  db: DbConnection,
  args: UpsertSandboxProviderCredentialArgs,
): SandboxProviderCredentialRecord {
  const now = new Date(args.updatedAt);

  const row = db
    .insert(sandboxProviderCredentials)
    .values({
      id: createSandboxProviderCredentialId(),
      providerId: args.providerId,
      encryptedAccessToken: args.encryptedAccessToken,
      encryptedRefreshToken: args.encryptedRefreshToken,
      encryptedIdToken: args.encryptedIdToken,
      encryptedMetadata: args.encryptedMetadata,
      label: args.label,
      expiresAt: new Date(args.expiresAt),
      lastRefreshedAt:
        args.lastRefreshedAt === null ? null : new Date(args.lastRefreshedAt),
      lastErrorMessage: args.lastErrorMessage,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: sandboxProviderCredentials.providerId,
      set: {
        encryptedAccessToken: args.encryptedAccessToken,
        encryptedRefreshToken: args.encryptedRefreshToken,
        encryptedIdToken: args.encryptedIdToken,
        encryptedMetadata: args.encryptedMetadata,
        label: args.label,
        expiresAt: new Date(args.expiresAt),
        lastRefreshedAt:
          args.lastRefreshedAt === null
            ? null
            : new Date(args.lastRefreshedAt),
        lastErrorMessage: args.lastErrorMessage,
        updatedAt: now,
      },
    })
    .returning()
    .get();

  return toRecord(row);
}

export function deleteSandboxProviderCredentialByProviderId(
  db: DbConnection,
  providerId: string,
): boolean {
  const deleted = db
    .delete(sandboxProviderCredentials)
    .where(eq(sandboxProviderCredentials.providerId, providerId))
    .returning({ id: sandboxProviderCredentials.id })
    .get();
  return deleted !== undefined;
}
