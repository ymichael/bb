import { createHash } from "node:crypto";
import type { HostRuntimeMaterialSnapshot } from "@bb/host-daemon-contract";

function toStableEnvEntries(
  env: Record<string, string>,
): Array<readonly [string, string]> {
  return Object.entries(env).sort(([left], [right]) => left.localeCompare(right));
}

function toStableFiles(
  snapshot: Pick<HostRuntimeMaterialSnapshot, "files">,
): HostRuntimeMaterialSnapshot["files"] {
  return snapshot.files
    .map((file) => ({
      contents: file.contents,
      managedBy: file.managedBy,
      mode: file.mode,
      path: file.path,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function buildHostRuntimeMaterialVersion(
  snapshot: Pick<HostRuntimeMaterialSnapshot, "env" | "files">,
): string {
  const stablePayload = JSON.stringify({
    env: toStableEnvEntries(snapshot.env),
    files: toStableFiles(snapshot),
  });
  return createHash("sha256").update(stablePayload).digest("hex");
}

export function createHostRuntimeMaterialSnapshot(
  args: Pick<HostRuntimeMaterialSnapshot, "env" | "files">,
): HostRuntimeMaterialSnapshot {
  return {
    env: args.env,
    files: args.files,
    version: buildHostRuntimeMaterialVersion(args),
  };
}

export function isEmptyHostRuntimeMaterialSnapshot(
  snapshot: Pick<HostRuntimeMaterialSnapshot, "env" | "files">,
): boolean {
  return Object.keys(snapshot.env).length === 0 && snapshot.files.length === 0;
}
