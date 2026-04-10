import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  HostRuntimeMaterialManagedFile,
  HostRuntimeMaterialSnapshot,
} from "@bb/host-daemon-contract";
import type { HostRuntimeMaterialState } from "./state.js";

function expandRuntimeMaterialPath(rawPath: string): string {
  if (!rawPath.startsWith("~/")) {
    throw new Error(
      `Managed runtime material file paths must be home-relative: ${rawPath}`,
    );
  }
  const relativePath = rawPath.slice(2);
  const hasUnsafeSegment = relativePath
    .split("/")
    .some((segment) => segment === "" || segment === "." || segment === "..");
  if (hasUnsafeSegment) {
    throw new Error(
      `Managed runtime material file path escapes the home directory: ${rawPath}`,
    );
  }

  const homeDir = path.resolve(os.homedir());
  const resolvedPath = path.resolve(homeDir, relativePath);
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

type ManagedFileSetSource = {
  files: Array<Pick<HostRuntimeMaterialManagedFile, "managedBy" | "path">>;
};

function resolveManagedFiles(
  source: ManagedFileSetSource | null,
): Map<string, Pick<HostRuntimeMaterialManagedFile, "managedBy" | "path">> {
  const files = new Map<
    string,
    Pick<HostRuntimeMaterialManagedFile, "managedBy" | "path">
  >();
  for (const file of source?.files ?? []) {
    files.set(expandRuntimeMaterialPath(file.path), file);
  }
  return files;
}

async function writeManagedFile(file: HostRuntimeMaterialManagedFile): Promise<void> {
  const destinationPath = expandRuntimeMaterialPath(file.path);
  await fs.mkdir(path.dirname(destinationPath), {
    recursive: true,
    mode: 0o700,
  });
  const temporaryPath = `${destinationPath}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
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
  previousState: HostRuntimeMaterialState | null;
}): Promise<void> {
  const previousFiles = resolveManagedFiles(args.previousState);
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
