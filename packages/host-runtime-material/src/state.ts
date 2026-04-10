import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  HOST_RUNTIME_MATERIAL_FILE_NAME,
  hostRuntimeMaterialSnapshotSchema,
  type HostRuntimeMaterialSnapshot,
} from "@bb/host-daemon-contract";
import { z } from "zod";

const persistedRuntimeMaterialFileSchema = z.object({
  managedBy: z.string().trim().min(1),
  path: z.string().trim().min(1),
}).strict();

export const hostRuntimeMaterialStateSchema = z.object({
  files: z.array(persistedRuntimeMaterialFileSchema),
  version: hostRuntimeMaterialSnapshotSchema.shape.version,
}).strict();

export type HostRuntimeMaterialState = z.infer<
  typeof hostRuntimeMaterialStateSchema
>;

function getRuntimeMaterialStatePath(dataDir: string): string {
  return path.join(dataDir, HOST_RUNTIME_MATERIAL_FILE_NAME);
}

export function buildHostRuntimeMaterialState(
  snapshot: HostRuntimeMaterialSnapshot,
): HostRuntimeMaterialState {
  return {
    files: snapshot.files.map((file) => ({
      managedBy: file.managedBy,
      path: file.path,
    })),
    version: snapshot.version,
  };
}

export async function readRuntimeMaterialState(
  dataDir: string,
): Promise<HostRuntimeMaterialState | null> {
  const runtimeMaterialStatePath = getRuntimeMaterialStatePath(dataDir);

  try {
    const raw = await fs.readFile(runtimeMaterialStatePath, "utf8");
    return hostRuntimeMaterialStateSchema.parse(JSON.parse(raw));
  } catch (error) {
    const errorCode =
      error instanceof Error && "code" in error ? error.code : undefined;
    if (errorCode === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeRuntimeMaterialState(
  dataDir: string,
  state: HostRuntimeMaterialState,
): Promise<void> {
  await fs.mkdir(dataDir, {
    recursive: true,
    mode: 0o700,
  });
  await fs.chmod(dataDir, 0o700);
  const runtimeMaterialStatePath = getRuntimeMaterialStatePath(dataDir);
  const temporaryStatePath = `${runtimeMaterialStatePath}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
  const payload = JSON.stringify(state, null, 2);
  try {
    await fs.writeFile(temporaryStatePath, `${payload}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(temporaryStatePath, runtimeMaterialStatePath);
  } catch (error) {
    await fs.rm(temporaryStatePath, { force: true }).catch(() => undefined);
    throw error;
  }
}
