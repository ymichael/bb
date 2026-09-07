import { and, asc, eq } from "drizzle-orm";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import { pluginMarketplaceIcons, pluginMarketplaces } from "../schema.js";

export type PluginMarketplaceSourceKind = "https" | "git" | "path";

export interface PluginMarketplaceRow {
  name: string;
  sourceKind: PluginMarketplaceSourceKind;
  manifestUrl: string;
  sourceGitRef: string | null;
  sourceGitCommit: string | null;
  manifestJson: string;
  statsJson: string | null;
  etag: string | null;
  lastModified: string | null;
  lastSuccessfulRefreshAt: number | null;
  lastAttemptedRefreshAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertPluginMarketplaceInput {
  name: string;
  sourceKind: PluginMarketplaceSourceKind;
  manifestUrl: string;
  sourceGitRef: string | null;
  sourceGitCommit: string | null;
  manifestJson: string;
  statsJson: string | null;
  etag: string | null;
  lastModified: string | null;
  lastSuccessfulRefreshAt: number | null;
  lastAttemptedRefreshAt: number | null;
  lastError: string | null;
}

export interface PluginMarketplaceIconRow {
  marketplaceName: string;
  entryId: string;
  sourceUrl: string;
  contentType: string;
  etag: string | null;
  contentHash: string;
  bytes: Buffer;
  updatedAt: number;
}

export type UpsertPluginMarketplaceIconInput = Omit<
  PluginMarketplaceIconRow,
  "updatedAt"
>;

export function getPluginMarketplace(
  db: DbQueryConnection,
  name: string,
): PluginMarketplaceRow | undefined {
  return db
    .select()
    .from(pluginMarketplaces)
    .where(eq(pluginMarketplaces.name, name))
    .get();
}

export function listPluginMarketplaces(
  db: DbQueryConnection,
): PluginMarketplaceRow[] {
  return db
    .select()
    .from(pluginMarketplaces)
    .orderBy(asc(pluginMarketplaces.name))
    .all();
}

export function deletePluginMarketplace(
  db: DbQueryConnection,
  name: string,
): boolean {
  db.delete(pluginMarketplaceIcons)
    .where(eq(pluginMarketplaceIcons.marketplaceName, name))
    .run();
  return (
    db.delete(pluginMarketplaces).where(eq(pluginMarketplaces.name, name)).run()
      .changes > 0
  );
}

export function upsertPluginMarketplace(
  db: DbQueryConnection,
  input: UpsertPluginMarketplaceInput,
): PluginMarketplaceRow {
  const now = Date.now();
  const { name, ...columns } = input;
  db.insert(pluginMarketplaces)
    .values({ name, ...columns, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: pluginMarketplaces.name,
      set: { ...columns, updatedAt: now },
    })
    .run();
  const row = getPluginMarketplace(db, name);
  if (row === undefined) {
    throw new Error(`plugin marketplace "${name}" missing after upsert`);
  }
  return row;
}

export function recordPluginMarketplaceRefreshFailure(
  db: DbConnection,
  name: string,
  attemptedAt: number,
  error: string,
): PluginMarketplaceRow | undefined {
  db.update(pluginMarketplaces)
    .set({
      lastAttemptedRefreshAt: attemptedAt,
      lastError: error,
      updatedAt: attemptedAt,
    })
    .where(eq(pluginMarketplaces.name, name))
    .run();
  return getPluginMarketplace(db, name);
}

export function listPluginMarketplaceIcons(
  db: DbQueryConnection,
  marketplaceName: string,
): PluginMarketplaceIconRow[] {
  return db
    .select()
    .from(pluginMarketplaceIcons)
    .where(eq(pluginMarketplaceIcons.marketplaceName, marketplaceName))
    .all();
}

export function getPluginMarketplaceIcon(
  db: DbQueryConnection,
  marketplaceName: string,
  entryId: string,
): PluginMarketplaceIconRow | undefined {
  return db
    .select()
    .from(pluginMarketplaceIcons)
    .where(
      and(
        eq(pluginMarketplaceIcons.marketplaceName, marketplaceName),
        eq(pluginMarketplaceIcons.entryId, entryId),
      ),
    )
    .get();
}

function upsertPluginMarketplaceIcon(
  db: DbQueryConnection,
  input: UpsertPluginMarketplaceIconInput,
): void {
  const now = Date.now();
  db.insert(pluginMarketplaceIcons)
    .values({ ...input, updatedAt: now })
    .onConflictDoUpdate({
      target: [
        pluginMarketplaceIcons.marketplaceName,
        pluginMarketplaceIcons.entryId,
      ],
      set: {
        sourceUrl: input.sourceUrl,
        contentType: input.contentType,
        etag: input.etag,
        contentHash: input.contentHash,
        bytes: input.bytes,
        updatedAt: now,
      },
    })
    .run();
}

export function replacePluginMarketplaceIcons(
  db: DbQueryConnection,
  marketplaceName: string,
  icons: readonly UpsertPluginMarketplaceIconInput[],
): void {
  db.delete(pluginMarketplaceIcons)
    .where(eq(pluginMarketplaceIcons.marketplaceName, marketplaceName))
    .run();
  for (const icon of icons) upsertPluginMarketplaceIcon(db, icon);
}
