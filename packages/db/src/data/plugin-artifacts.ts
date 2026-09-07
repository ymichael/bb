import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import { installedPlugins, pluginArtifacts } from "../schema.js";

export interface PluginArtifactRow {
  id: string;
  pluginId: string;
  sourceKind: "npm" | "git";
  npmResolvedVersion: string | null;
  gitResolvedCommit: string | null;
  gitCheckoutRoot: string | null;
  path: string;
  integrity: string | null;
  contentHash: string | null;
  validationResult: "pending" | "valid";
  createdAt: number;
  updatedAt: number;
  validatedAt: number | null;
}

interface PluginArtifactInputBase {
  id: string;
  pluginId: string;
  path: string;
  contentHash: string | null;
  validationResult: "pending" | "valid";
  validatedAt: number | null;
}

export type CreatePluginArtifactInput = PluginArtifactInputBase &
  (
    | {
        sourceKind: "npm";
        npmResolvedVersion: string;
        gitResolvedCommit: null;
        gitCheckoutRoot: null;
        integrity: string;
      }
    | {
        sourceKind: "git";
        npmResolvedVersion: null;
        gitResolvedCommit: string;
        gitCheckoutRoot: string;
        integrity: string | null;
      }
  );

export function createPluginArtifact(
  db: DbConnection,
  artifact: CreatePluginArtifactInput,
): PluginArtifactRow {
  if (
    (artifact.sourceKind === "npm" &&
      (typeof artifact.npmResolvedVersion !== "string" ||
        artifact.npmResolvedVersion.length === 0 ||
        typeof artifact.integrity !== "string" ||
        artifact.gitResolvedCommit !== null ||
        artifact.gitCheckoutRoot !== null)) ||
    (artifact.sourceKind === "git" &&
      (typeof artifact.gitResolvedCommit !== "string" ||
        artifact.gitResolvedCommit.length === 0 ||
        typeof artifact.gitCheckoutRoot !== "string" ||
        artifact.gitCheckoutRoot.length === 0 ||
        artifact.npmResolvedVersion !== null))
  ) {
    throw new Error(
      "plugin artifact resolution fields do not match its source kind",
    );
  }
  const now = Date.now();
  db.insert(pluginArtifacts)
    .values({ ...artifact, createdAt: now, updatedAt: now })
    .run();
  const row = getPluginArtifact(db, artifact.id);
  if (!row) throw new Error(`plugin artifact missing after insert: ${artifact.id}`);
  return row;
}

export function getPluginArtifact(
  db: DbConnection,
  id: string,
): PluginArtifactRow | undefined {
  return db.select().from(pluginArtifacts).where(eq(pluginArtifacts.id, id)).get();
}

export function listPluginArtifacts(
  db: DbConnection,
  pluginId: string,
): PluginArtifactRow[] {
  return db
    .select()
    .from(pluginArtifacts)
    .where(eq(pluginArtifacts.pluginId, pluginId))
    .orderBy(asc(pluginArtifacts.createdAt), asc(pluginArtifacts.id))
    .all();
}

export function listPendingGitPluginArtifacts(
  db: DbConnection,
): PluginArtifactRow[] {
  return db
    .select()
    .from(pluginArtifacts)
    .where(
      and(
        eq(pluginArtifacts.sourceKind, "git"),
        eq(pluginArtifacts.validationResult, "pending"),
      ),
    )
    .orderBy(asc(pluginArtifacts.createdAt), asc(pluginArtifacts.id))
    .all();
}

export function listPluginArtifactsUnderPath(
  db: DbConnection,
  directory: string,
  separator: string,
): PluginArtifactRow[] {
  const prefix = directory.endsWith(separator)
    ? directory
    : `${directory}${separator}`;
  const pattern = `${prefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  return db
    .select()
    .from(pluginArtifacts)
    .where(sql`${pluginArtifacts.path} LIKE ${pattern} ESCAPE '\\'`)
    .orderBy(asc(pluginArtifacts.path), asc(pluginArtifacts.id))
    .all();
}

export function listPluginArtifactsAtOrUnderPath(
  db: DbConnection,
  directory: string,
  separator: string,
): PluginArtifactRow[] {
  const prefix = directory.endsWith(separator)
    ? directory
    : `${directory}${separator}`;
  const pattern = `${prefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  return db
    .select()
    .from(pluginArtifacts)
    .where(
      or(
        eq(pluginArtifacts.path, directory),
        sql`${pluginArtifacts.path} LIKE ${pattern} ESCAPE '\\'`,
      ),
    )
    .orderBy(asc(pluginArtifacts.path), asc(pluginArtifacts.id))
    .all();
}

export function listPluginArtifactsInGitCheckout(
  db: DbConnection,
  checkoutRoot: string,
): PluginArtifactRow[] {
  return db
    .select()
    .from(pluginArtifacts)
    .where(eq(pluginArtifacts.gitCheckoutRoot, checkoutRoot))
    .orderBy(asc(pluginArtifacts.path), asc(pluginArtifacts.id))
    .all();
}

export function listRecentPluginArtifacts(
  db: DbConnection,
  pluginId: string,
  limit: number,
): PluginArtifactRow[] {
  return db
    .select()
    .from(pluginArtifacts)
    .where(
      and(
        eq(pluginArtifacts.pluginId, pluginId),
        eq(pluginArtifacts.validationResult, "valid"),
      ),
    )
    .orderBy(desc(pluginArtifacts.updatedAt), desc(pluginArtifacts.id))
    .limit(limit)
    .all();
}

export function getPluginArtifactByResolution(
  db: DbConnection,
  resolution:
    | {
        sourceKind: "npm";
        pluginId: string;
        path: string;
        version: string;
        integrity: string;
      }
    | { sourceKind: "git"; pluginId: string; path: string; commit: string },
): PluginArtifactRow | undefined {
  if (resolution.sourceKind === "npm") {
    return db
      .select()
      .from(pluginArtifacts)
      .where(
        and(
          eq(pluginArtifacts.sourceKind, "npm"),
          eq(pluginArtifacts.pluginId, resolution.pluginId),
          eq(pluginArtifacts.path, resolution.path),
          eq(pluginArtifacts.npmResolvedVersion, resolution.version),
          eq(pluginArtifacts.integrity, resolution.integrity),
        ),
      )
      .get();
  }
  return db
    .select()
    .from(pluginArtifacts)
    .where(
      and(
        eq(pluginArtifacts.sourceKind, "git"),
        eq(pluginArtifacts.pluginId, resolution.pluginId),
        eq(pluginArtifacts.path, resolution.path),
        eq(pluginArtifacts.gitResolvedCommit, resolution.commit),
      ),
    )
    .get();
}

export function setPluginArtifactValidation(
  db: DbConnection,
  id: string,
  validation:
    | {
        contentHash: string;
        validationResult: "pending";
        validatedAt: null;
      }
    | {
        contentHash: string;
        validationResult: "valid";
        validatedAt: number;
      },
): boolean {
  return (
    db
      .update(pluginArtifacts)
      .set({ ...validation, updatedAt: Date.now() })
      .where(eq(pluginArtifacts.id, id))
      .run().changes > 0
  );
}

export function setPluginArtifactGitCheckoutRoot(
  db: DbConnection,
  id: string,
  checkoutRoot: string,
): boolean {
  return (
    db
      .update(pluginArtifacts)
      .set({ gitCheckoutRoot: checkoutRoot, updatedAt: Date.now() })
      .where(
        and(
          eq(pluginArtifacts.id, id),
          eq(pluginArtifacts.sourceKind, "git"),
          isNull(pluginArtifacts.gitCheckoutRoot),
        ),
      )
      .run().changes > 0
  );
}

export function deletePluginArtifact(db: DbConnection, id: string): boolean {
  return db.transaction((tx) => {
    tx.update(installedPlugins)
      .set({ activeArtifactId: null, updatedAt: Date.now() })
      .where(eq(installedPlugins.activeArtifactId, id))
      .run();
    return (
      tx.delete(pluginArtifacts).where(eq(pluginArtifacts.id, id)).run()
        .changes > 0
    );
  });
}
