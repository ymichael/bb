import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  HostRuntimeMaterialManagedFile,
  HostRuntimeMaterialSnapshot,
} from "@bb/host-daemon-contract";

function expandRuntimeMaterialPath(rawPath: string): string {
  if (!rawPath.startsWith("~/")) {
    throw new Error(
      `Managed runtime material file paths must be home-relative: ${rawPath}`,
    );
  }

  const homeDir = path.resolve(os.homedir());
  const resolvedPath = path.resolve(homeDir, rawPath.slice(2));
  const relativeToHome = path.relative(homeDir, resolvedPath);
  if (
    relativeToHome.startsWith("..")
    || path.isAbsolute(relativeToHome)
  ) {
    throw new Error(
      `Managed runtime material file path escapes the home directory: ${rawPath}`,
    );
  }

  return resolvedPath;
}

function resolveManagedFiles(
  snapshot: HostRuntimeMaterialSnapshot | null,
): Map<string, HostRuntimeMaterialManagedFile> {
  const files = new Map<string, HostRuntimeMaterialManagedFile>();
  for (const file of snapshot?.files ?? []) {
    files.set(expandRuntimeMaterialPath(file.path), file);
  }
  return files;
}

async function writeManagedFile(file: HostRuntimeMaterialManagedFile): Promise<void> {
  const destinationPath = expandRuntimeMaterialPath(file.path);
  await fs.mkdir(path.dirname(destinationPath), {
    recursive: true,
  });
  const temporaryPath = `${destinationPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, file.contents, {
      encoding: "utf8",
      mode: file.mode,
    });
    await fs.chmod(temporaryPath, file.mode);
    await fs.rename(temporaryPath, destinationPath);
    await fs.chmod(destinationPath, file.mode);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function replaceManagedRuntimeFiles(args: {
  nextSnapshot: HostRuntimeMaterialSnapshot;
  previousSnapshot: HostRuntimeMaterialSnapshot | null;
}): Promise<void> {
  const previousFiles = resolveManagedFiles(args.previousSnapshot);
  const nextFiles = resolveManagedFiles(args.nextSnapshot);

  await Promise.all(
    args.nextSnapshot.files.map((file) => writeManagedFile(file)),
  );

  const removedPaths = [...previousFiles.keys()].filter(
    (resolvedPath) => !nextFiles.has(resolvedPath),
  );
  await Promise.all(
    removedPaths.map((resolvedPath) =>
      fs.rm(resolvedPath, { force: true }),
    ),
  );
}

export function resolveRuntimeMaterialEnv(
  env: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      value.startsWith("~/") ? expandRuntimeMaterialPath(value) : value,
    ]),
  );
}
