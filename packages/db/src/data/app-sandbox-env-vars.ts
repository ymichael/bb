import { eq } from "drizzle-orm";
import type { DbConnection } from "../connection.js";
import { appSandboxEnvVars } from "../schema.js";

export interface AppSandboxEnvVarRecord {
  createdAt: number;
  encryptedValue: string;
  name: string;
  updatedAt: number;
}

export interface UpsertAppSandboxEnvVarArgs {
  encryptedValue: string;
  name: string;
  updatedAt?: number;
}

function toRecord(
  row: typeof appSandboxEnvVars.$inferSelect,
): AppSandboxEnvVarRecord {
  return {
    createdAt: row.createdAt.getTime(),
    encryptedValue: row.encryptedValue,
    name: row.name,
    updatedAt: row.updatedAt.getTime(),
  };
}

export function getAppSandboxEnvVar(
  db: DbConnection,
  name: string,
): AppSandboxEnvVarRecord | null {
  const row = db
    .select()
    .from(appSandboxEnvVars)
    .where(eq(appSandboxEnvVars.name, name))
    .get();

  return row ? toRecord(row) : null;
}

export function listAppSandboxEnvVars(
  db: DbConnection,
): AppSandboxEnvVarRecord[] {
  return db
    .select()
    .from(appSandboxEnvVars)
    .all()
    .map(toRecord);
}

export function upsertAppSandboxEnvVar(
  db: DbConnection,
  args: UpsertAppSandboxEnvVarArgs,
): AppSandboxEnvVarRecord {
  const now = new Date(args.updatedAt ?? Date.now());

  const row = db
    .insert(appSandboxEnvVars)
    .values({
      createdAt: now,
      encryptedValue: args.encryptedValue,
      name: args.name,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: appSandboxEnvVars.name,
      set: {
        encryptedValue: args.encryptedValue,
        updatedAt: now,
      },
    })
    .returning()
    .get();

  return toRecord(row);
}

export function deleteAppSandboxEnvVar(
  db: DbConnection,
  name: string,
): boolean {
  const deleted = db
    .delete(appSandboxEnvVars)
    .where(eq(appSandboxEnvVars.name, name))
    .returning({ name: appSandboxEnvVars.name })
    .get();
  return deleted !== undefined;
}
