import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { HOST_ARTIFACT_MAX_BYTES } from "@bb/host-daemon-contract";
import type { HostDaemonLogger } from "./logger.js";
import { sha256Hex } from "./sha256-hex.js";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

type FetchNodeArtifact = (args: {
  digest: string;
  byteLength: number;
}) => Promise<Uint8Array>;

type NodeArtifactPruneStrategy =
  | { kind: "keep-only-current" }
  | { kind: "keep-recently-used"; maxAgeMs: number };

interface EnsureCachedNodeArtifactArgs {
  cacheDir: string;
  digest: string;
  byteLength: number;
  fileName: string;
  legacyFileNames?: readonly string[];
  fetchArtifact: FetchNodeArtifact;
  prune: NodeArtifactPruneStrategy;
  logger: Pick<HostDaemonLogger, "debug" | "warn">;
}

const pendingPulls = new Map<string, Promise<string>>();

function describeMismatch(
  digest: string,
  byteLength: number,
  bytes: Uint8Array,
): string | null {
  if (bytes.byteLength !== byteLength) {
    return `expected ${byteLength} bytes, received ${bytes.byteLength}`;
  }
  const actual = sha256Hex(bytes);
  if (actual !== digest) {
    return `expected sha256 ${digest}, received ${actual}`;
  }
  return null;
}

export async function ensureCachedNodeArtifact(
  args: EnsureCachedNodeArtifactArgs,
): Promise<string> {
  if (!DIGEST_PATTERN.test(args.digest)) {
    throw new Error(`Invalid artifact digest: "${args.digest}"`);
  }
  if (args.byteLength > HOST_ARTIFACT_MAX_BYTES) {
    throw new Error(
      `Artifact is too large: ${args.byteLength} bytes exceeds the ${HOST_ARTIFACT_MAX_BYTES}-byte limit`,
    );
  }
  const key = `${args.cacheDir}\0${args.digest}`;
  const pending = pendingPulls.get(key);
  if (pending !== undefined) {
    return pending;
  }
  const pull = ensureCachedNodeArtifactUnlocked(args).finally(() => {
    pendingPulls.delete(key);
  });
  pendingPulls.set(key, pull);
  return pull;
}

async function ensureCachedNodeArtifactUnlocked(
  args: EnsureCachedNodeArtifactArgs,
): Promise<string> {
  const directory = join(args.cacheDir, args.digest);
  const artifactPath = join(directory, args.fileName);
  if (await isVerifiedCachedArtifact(artifactPath, args)) {
    args.logger.debug(
      { cacheDir: args.cacheDir, digest: args.digest },
      "Using cached host artifact",
    );
    await removeLegacyArtifactFiles(directory, args);
    await touchDirectory(directory);
    await pruneStaleDigests(args);
    return artifactPath;
  }

  const migratedLegacyPath = await migrateLegacyArtifact(
    directory,
    artifactPath,
    args,
  );
  if (migratedLegacyPath) {
    await touchDirectory(directory);
    await pruneStaleDigests(args);
    return artifactPath;
  }

  args.logger.debug(
    { cacheDir: args.cacheDir, digest: args.digest },
    "Downloading host artifact",
  );
  await mkdir(directory, { recursive: true });
  let lastMismatch = "unknown mismatch";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const bytes = await args.fetchArtifact({
      digest: args.digest,
      byteLength: args.byteLength,
    });
    const mismatch = describeMismatch(args.digest, args.byteLength, bytes);
    if (mismatch !== null) {
      lastMismatch = mismatch;
      continue;
    }
    const staged = join(directory, `.staged-${randomUUID()}.tmp`);
    try {
      await writeFile(staged, bytes, { mode: 0o600 });
      await rename(staged, artifactPath);
    } catch (error) {
      await rm(staged, { force: true });
      throw error;
    }
    await removeLegacyArtifactFiles(directory, args);
    await pruneStaleDigests(args);
    return artifactPath;
  }
  throw new Error(
    `Host artifact download failed verification after retry: ${lastMismatch}`,
  );
}

async function migrateLegacyArtifact(
  directory: string,
  artifactPath: string,
  args: EnsureCachedNodeArtifactArgs,
): Promise<boolean> {
  for (const legacyFileName of args.legacyFileNames ?? []) {
    if (legacyFileName === args.fileName) continue;
    const legacyPath = join(directory, legacyFileName);
    if (!(await isVerifiedCachedArtifact(legacyPath, args))) continue;

    await rename(legacyPath, artifactPath);
    args.logger.debug(
      {
        cacheDir: args.cacheDir,
        digest: args.digest,
        legacyFileName,
        fileName: args.fileName,
      },
      "Migrated cached host artifact",
    );
    await removeLegacyArtifactFiles(directory, args);
    return true;
  }
  return false;
}

async function removeLegacyArtifactFiles(
  directory: string,
  args: EnsureCachedNodeArtifactArgs,
): Promise<void> {
  const legacyPaths = (args.legacyFileNames ?? [])
    .filter((fileName) => fileName !== args.fileName)
    .map((fileName) => join(directory, fileName));
  const results = await Promise.allSettled(
    legacyPaths.map((path) => rm(path, { force: true })),
  );
  results.forEach((result, index) => {
    if (result.status === "fulfilled") return;
    args.logger.warn(
      { path: legacyPaths[index], err: result.reason },
      "Failed to remove legacy host artifact",
    );
  });
}

async function isVerifiedCachedArtifact(
  artifactPath: string,
  args: EnsureCachedNodeArtifactArgs,
): Promise<boolean> {
  let bytes: Buffer;
  try {
    bytes = await readFile(artifactPath);
  } catch {
    return false;
  }
  if (
    bytes.byteLength === args.byteLength &&
    sha256Hex(bytes) === args.digest
  ) {
    return true;
  }
  await rm(artifactPath, { force: true });
  return false;
}

async function touchDirectory(directory: string): Promise<void> {
  const now = new Date();
  await utimes(directory, now, now).catch(() => undefined);
}

async function pruneStaleDigests(
  args: EnsureCachedNodeArtifactArgs,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(args.cacheDir, { withFileTypes: true });
  } catch (error) {
    args.logger.warn(
      { cacheDir: args.cacheDir, err: error },
      "Failed to inspect host artifact cache",
    );
    return;
  }
  const candidates = entries.filter(
    (entry) =>
      entry.isDirectory() &&
      entry.name !== args.digest &&
      DIGEST_PATTERN.test(entry.name),
  );
  const stale: string[] = [];
  for (const entry of candidates) {
    const directory = join(args.cacheDir, entry.name);
    if (args.prune.kind === "keep-only-current") {
      stale.push(directory);
      continue;
    }
    const stats = await stat(directory).catch(() => null);
    if (stats !== null && Date.now() - stats.mtimeMs > args.prune.maxAgeMs) {
      stale.push(directory);
    }
  }
  const results = await Promise.allSettled(
    stale.map((directory) => rm(directory, { recursive: true, force: true })),
  );
  results.forEach((result, index) => {
    if (result.status === "fulfilled") return;
    args.logger.warn(
      { directory: stale[index], err: result.reason },
      "Failed to prune stale host artifact",
    );
  });
}
