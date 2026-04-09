import fs from "node:fs/promises";
import path from "node:path";
import {
  HOST_RUNTIME_MATERIAL_FILE_NAME,
  hostRuntimeMaterialSnapshotSchema,
  type HostRuntimeMaterialSnapshot,
} from "@bb/host-daemon-contract";

function getRuntimeMaterialStatePath(dataDir: string): string {
  return path.join(dataDir, HOST_RUNTIME_MATERIAL_FILE_NAME);
}

export async function readRuntimeMaterialState(
  dataDir: string,
): Promise<HostRuntimeMaterialSnapshot | null> {
  const runtimeMaterialStatePath = getRuntimeMaterialStatePath(dataDir);

  try {
    const raw = await fs.readFile(runtimeMaterialStatePath, "utf8");
    return hostRuntimeMaterialSnapshotSchema.parse(JSON.parse(raw));
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
  snapshot: HostRuntimeMaterialSnapshot,
): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  const runtimeMaterialStatePath = getRuntimeMaterialStatePath(dataDir);
  const temporaryStatePath = `${runtimeMaterialStatePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(snapshot, null, 2);
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
