import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import semver from "semver";
import {
  omitNpmScriptPolicyEnv,
  spawnPortableOutputProcess,
} from "@bb/process-utils";

type ParsedGitSelector =
  | { kind: "ref"; ref: string }
  | { kind: "range"; range: string; tagPrefix: string }
  | { kind: "ref-or-range"; ref: string; range: string };

type ParsedPluginSource =
  | { kind: "path"; path: string }
  | { kind: "builtin"; name: string }
  | {
      kind: "git";
      url: string;
      spec: string;
      selector: ParsedGitSelector;
      cachePath: string;
    }
  | {
      kind: "npm";
      name: string;
      spec: string;
      specKind: "default" | "exact" | "tag" | "range";
    };

const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
export const DEFAULT_GIT_REF = "HEAD";
const GIT_RANGE_SPEC_PREFIX = "semver:";
const GIT_REF_SPEC_PREFIX = "ref:";
const BARE_VERSION_SPEC_PATTERN = /^v?\d+(?:\.\d+)*$/u;
const GIT_TAG_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const MAX_GIT_TAG_PREFIX_LENGTH = 128;
const NPM_NAME_PATTERN = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const BUILTIN_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function isCommitSha(ref: string): boolean {
  return COMMIT_SHA_PATTERN.test(ref);
}

function assertSafeSegments(value: string, label: string): void {
  const segments = value.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`invalid ${label} "${value}"`);
  }
}

function isGitSemverRangeSpec(spec: string): boolean {
  return (
    semver.validRange(spec) !== null &&
    semver.valid(spec) === null &&
    !BARE_VERSION_SPEC_PATTERN.test(spec)
  );
}

export function normalizeGitTagPrefix(value: string): string {
  if (value.length === 0) return value;
  if (
    value.length > MAX_GIT_TAG_PREFIX_LENGTH ||
    !GIT_TAG_PREFIX_PATTERN.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.endsWith(".") ||
    value
      .split("/")
      .some((segment) => segment.startsWith(".") || segment.endsWith(".lock"))
  ) {
    throw new Error(`invalid git tag prefix "${value}"`);
  }
  return value;
}

export function gitRangeSourceSpec(args: {
  url: string;
  range: string;
  tagPrefix: string;
}): string {
  const prefix =
    args.tagPrefix.length === 0
      ? ""
      : `${normalizeGitTagPrefix(args.tagPrefix)}:`;
  return `git:${args.url}@${GIT_RANGE_SPEC_PREFIX}${prefix}${args.range}`;
}

export function gitSemverTagName(tagPrefix: string, version: string): string {
  return `${tagPrefix}v${version}`;
}

export function gitSemverTagVersion(
  tag: string,
  tagPrefix: string,
): string | null {
  if (!tag.startsWith(tagPrefix)) return null;
  const rest = tag.slice(tagPrefix.length);
  if (!rest.startsWith("v")) return null;
  const version = rest.slice(1);
  return semver.parse(version)?.version === version ? version : null;
}

function parseGitSelector(spec: string): ParsedGitSelector {
  if (spec.startsWith(GIT_REF_SPEC_PREFIX)) {
    const ref = spec.slice(GIT_REF_SPEC_PREFIX.length);
    if (ref.length === 0) throw new Error("git source has an empty ref");
    return { kind: "ref", ref };
  }
  if (spec.startsWith(GIT_RANGE_SPEC_PREFIX)) {
    const parts = spec.slice(GIT_RANGE_SPEC_PREFIX.length).split(":");
    if (parts.length > 2) {
      throw new Error(`invalid git semver spec "${spec}"`);
    }
    const range = parts[parts.length - 1] ?? "";
    const tagPrefix = normalizeGitTagPrefix(
      parts.length === 2 ? (parts[0] ?? "") : "",
    );
    if (semver.validRange(range) === null) {
      throw new Error(`invalid git semver range "${range}"`);
    }
    return { kind: "range", range, tagPrefix };
  }
  if (spec.includes(":")) {
    throw new Error(
      `invalid git spec "${spec}" — use "ref:<name>" or "semver:[<tagPrefix>:]<range>"`,
    );
  }
  return isGitSemverRangeSpec(spec)
    ? { kind: "ref-or-range", ref: spec, range: spec }
    : { kind: "ref", ref: spec };
}

function parseGitSource(spec: string): ParsedPluginSource {
  const at = spec.lastIndexOf("@");
  if (at === spec.length - 1) {
    throw new Error("git source has an empty ref");
  }
  const urlish = at <= 0 ? spec : spec.slice(0, at);
  const ref = at <= 0 ? DEFAULT_GIT_REF : spec.slice(at + 1);
  if (ref.startsWith("-") || ref.includes("..")) {
    throw new Error(`invalid git ref "${ref}"`);
  }
  const selector = parseGitSelector(ref);
  let url: string;
  let host: string;
  let repoPath: string;
  let decodedUrlish: string;
  try {
    decodedUrlish = decodeURIComponent(urlish);
  } catch {
    throw new Error(`invalid git url "${urlish}"`);
  }
  if (decodedUrlish.split("/").some((segment) => segment === "..")) {
    throw new Error(`invalid git repository path "${urlish}"`);
  }
  if (/^https?:\/\//.test(urlish)) {
    const parsed = new URL(urlish);
    url = urlish;
    host = parsed.host;
    repoPath = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  } else if (urlish.startsWith("/")) {
    url = urlish;
    host = "local";
    repoPath = urlish.replace(/^\/+/, "").replace(/\.git$/, "");
  } else if (/^[a-z0-9]/i.test(urlish)) {
    url = `https://${urlish}`;
    const parsed = new URL(url);
    host = parsed.host;
    repoPath = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
  } else {
    throw new Error(`invalid git url "${urlish}"`);
  }
  if (repoPath.length === 0) {
    throw new Error(`git url "${urlish}" has no repository path`);
  }
  assertSafeSegments(repoPath, "git repository path");
  if (host.includes("..") || host.includes("/")) {
    throw new Error(`invalid git host "${host}"`);
  }
  return {
    kind: "git",
    url,
    spec: ref,
    selector,
    cachePath: `${host}/${repoPath}`,
  };
}

function parseNpmSource(spec: string): ParsedPluginSource {
  const at = spec.lastIndexOf("@");
  const hasSpec = at > 0 && at < spec.length - 1;
  if (at > 0 && at === spec.length - 1) {
    throw new Error(`npm source has an empty version spec: "${spec}"`);
  }
  const name = hasSpec ? spec.slice(0, at) : spec;
  const requestedSpec = hasSpec ? spec.slice(at + 1) : "";
  if (!NPM_NAME_PATTERN.test(name)) {
    throw new Error(`invalid npm package name "${name}"`);
  }
  if (requestedSpec.length === 0) {
    return { kind: "npm", name, spec: "", specKind: "default" };
  }
  if (semver.valid(requestedSpec) !== null) {
    return { kind: "npm", name, spec: requestedSpec, specKind: "exact" };
  }
  if (semver.validRange(requestedSpec) !== null) {
    return { kind: "npm", name, spec: requestedSpec, specKind: "range" };
  }
  if (/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(requestedSpec)) {
    return { kind: "npm", name, spec: requestedSpec, specKind: "tag" };
  }
  throw new Error(`invalid npm version, range, or dist-tag "${requestedSpec}"`);
}

function parseBuiltinSource(spec: string): ParsedPluginSource {
  if (!BUILTIN_NAME_PATTERN.test(spec)) {
    throw new Error(
      `invalid builtin plugin name "${spec}" — use lowercase letters, digits, and dashes`,
    );
  }
  return { kind: "builtin", name: spec };
}

export function parsePluginSource(source: string): ParsedPluginSource {
  if (source.startsWith("builtin:")) return parseBuiltinSource(source.slice(8));
  if (source.startsWith("git:")) return parseGitSource(source.slice(4));
  if (source.startsWith("npm:")) return parseNpmSource(source.slice(4));
  if (/^https?:\/\//iu.test(source)) return parseGitSource(source);
  const path = source.startsWith("path:") ? source.slice(5) : source;
  if (path.length === 0) throw new Error("install source path is empty");
  return { kind: "path", path };
}

export function normalizePluginSubdirectory(value: string): string {
  const trimmed = value.startsWith("./") ? value.slice(2) : value;
  if (
    trimmed.length === 0 ||
    trimmed.startsWith("/") ||
    trimmed.includes("\\") ||
    /^[a-zA-Z]:/.test(trimmed)
  ) {
    throw new Error(`invalid plugin subdirectory "${value}"`);
  }
  assertSafeSegments(trimmed, "plugin subdirectory");
  if (trimmed.split("/").includes(".git")) {
    throw new Error(`invalid plugin subdirectory "${value}"`);
  }
  return trimmed;
}

export function nestedPluginRoots(root: string, paths: string[]): string[] {
  const relatives = paths
    .map((path) => relative(root, path))
    .filter(
      (path) =>
        path.length > 0 && path !== ".." && !path.startsWith(`..${sep}`),
    )
    .sort((left, right) => left.length - right.length);
  const kept: string[] = [];
  for (const candidate of relatives) {
    if (kept.includes(candidate)) continue;
    if (kept.some((parent) => candidate.startsWith(`${parent}${sep}`))) {
      continue;
    }
    kept.push(candidate);
  }
  return kept;
}

export function pluginRootDir(
  checkoutDir: string,
  subdirectory: string | null,
): string {
  return subdirectory === null
    ? checkoutDir
    : join(checkoutDir, ...subdirectory.split("/"));
}

export function npmInstallPrefix(
  dataDir: string,
  name: string,
  version: string,
): string {
  return join(dataDir, "plugins", "npm", ...`${name}@${version}`.split("/"));
}

function resolveInside(
  root: string,
  segments: string[],
  label: string,
): string {
  for (const segment of segments) assertSafeSegments(segment, label);
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, ...segments);
  const pathFromRoot = relative(absoluteRoot, target);
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`)
  ) {
    throw new Error(`invalid ${label} cache path`);
  }
  return target;
}

export async function realPathInside(
  root: string,
  target: string,
  label: string,
  allowRoot = false,
): Promise<string> {
  const [realRoot, realTarget] = await Promise.all([
    realpath(root),
    realpath(target),
  ]);
  const fromRoot = relative(realRoot, realTarget);
  if (fromRoot === "" && !allowRoot) {
    throw new Error(`${label} resolves to its root`);
  }
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new Error(`${label} resolves outside its root`);
  }
  return realTarget;
}

export function npmArtifactCacheDir(
  dataDir: string,
  packageName: string,
  version: string,
): string {
  if (!NPM_NAME_PATTERN.test(packageName)) {
    throw new Error(`invalid npm package name "${packageName}"`);
  }
  return resolveInside(
    join(dataDir, "plugins", "cache", "npm"),
    [...packageName.split("/"), version],
    "npm artifact",
  );
}

export function gitArtifactCacheDir(
  dataDir: string,
  cachePath: string,
  commit: string,
): string {
  if (!isCommitSha(commit)) throw new Error(`invalid git commit "${commit}"`);
  return resolveInside(
    join(dataDir, "plugins", "cache", "git"),
    [...cachePath.split("/"), commit],
    "git artifact",
  );
}

export async function hashInstallDir(rootDir: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const name = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const stats = await lstat(path);
      if (stats.isDirectory()) {
        hash.update(`d\0${name}\0`);
        await visit(path, name);
      } else if (stats.isSymbolicLink()) {
        hash.update(`l\0${name}\0${await readlink(path)}\0`);
      } else if (stats.isFile()) {
        hash.update(`f\0${name}\0${stats.mode & 0o777}\0`);
        hash.update(await readFile(path));
      }
    }
  }
  await visit(rootDir, "");
  return `sha256:${hash.digest("hex")}`;
}

async function fsyncTree(rootDir: string): Promise<void> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(rootDir, entry.name);
    if (entry.isDirectory()) await fsyncTree(path);
    else if (entry.isFile()) {
      const handle = await open(path, constants.O_RDONLY);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }
  const handle = await open(rootDir, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return false;
    }
    throw error;
  }
}

export async function recoverInterruptedGitPluginPromotion(
  targetDir: string,
): Promise<void> {
  const corruptDir = `${targetDir}.corrupt`;
  const promotingDir = `${targetDir}.promoting`;
  const corruptExists = await pathExists(corruptDir);
  if (!corruptExists) {
    await rm(promotingDir, { recursive: true, force: true });
    return;
  }
  const targetExists = await pathExists(targetDir);
  if (targetExists) {
    await rm(corruptDir, { recursive: true, force: true });
  } else {
    await mkdir(dirname(targetDir), { recursive: true });
    await rename(corruptDir, targetDir);
  }
  await rm(promotingDir, { recursive: true, force: true });
}

export async function promoteImmutableDir(args: {
  stagingDir: string;
  targetDir: string;
  contentHash: string;
}): Promise<void> {
  await rm(`${args.targetDir}.promoting`, { recursive: true, force: true });
  const corruptDir = `${args.targetDir}.corrupt`;
  let movedCorruptTarget = false;
  try {
    if ((await hashInstallDir(args.targetDir)) === args.contentHash) {
      await rm(args.stagingDir, { recursive: true, force: true });
      return;
    }
    await rm(corruptDir, { recursive: true, force: true });
    await rename(args.targetDir, corruptDir);
    movedCorruptTarget = true;
  } catch {}
  await rm(`${args.targetDir}.promoting`, { recursive: true, force: true });
  try {
    await rename(args.stagingDir, args.targetDir);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EXDEV"
    ) {
      if (movedCorruptTarget) await rename(corruptDir, args.targetDir);
      throw error;
    }
    const copyDir = `${args.targetDir}.promoting`;
    try {
      await cp(args.stagingDir, copyDir, {
        recursive: true,
        preserveTimestamps: true,
      });
      await fsyncTree(copyDir);
      await rename(copyDir, args.targetDir);
      const parent = await open(dirname(args.targetDir), constants.O_RDONLY);
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
      await rm(args.stagingDir, { recursive: true, force: true });
    } catch (copyError) {
      if (movedCorruptTarget) await rename(corruptDir, args.targetDir);
      throw copyError;
    } finally {
      await rm(copyDir, { recursive: true, force: true });
    }
  }
  if (movedCorruptTarget) {
    await rm(corruptDir, { recursive: true, force: true });
  }
}

export async function promoteGitPluginArtifact(args: {
  stagingDir: string;
  targetDir: string;
  subdirectory: string | null;
  contentHash: string;
  preserveNestedRoots: string[];
}): Promise<string> {
  const targetExists = await stat(args.targetDir)
    .then(() => true)
    .catch(() => false);
  if (!targetExists) {
    await promoteImmutableDir({
      stagingDir: args.stagingDir,
      targetDir: args.targetDir,
      contentHash: args.contentHash,
    });
    return args.contentHash;
  }
  const stagingRoot = await realPathInside(
    args.stagingDir,
    pluginRootDir(args.stagingDir, args.subdirectory),
    "git plugin subdirectory",
    args.subdirectory === null,
  );
  const targetRoot = pluginRootDir(args.targetDir, args.subdirectory);
  let preservedCount = 0;
  try {
    if (
      (await hashInstallDir(targetRoot).catch(() => null)) === args.contentHash
    ) {
      await rm(args.stagingDir, { recursive: true, force: true });
      return args.contentHash;
    }
    await mkdir(dirname(targetRoot), { recursive: true });
    for (const nested of args.preserveNestedRoots) {
      const from = join(targetRoot, nested);
      const exists = await stat(from)
        .then(() => true)
        .catch(() => false);
      if (!exists) continue;
      const to = join(stagingRoot, nested);
      await rm(to, { recursive: true, force: true });
      const resolvedFrom = await realPathInside(
        args.targetDir,
        from,
        "nested git plugin root",
      );
      await cp(resolvedFrom, to, {
        recursive: true,
        preserveTimestamps: true,
      });
      preservedCount += 1;
    }
    await promoteImmutableDir({
      stagingDir: stagingRoot,
      targetDir: targetRoot,
      contentHash: args.contentHash,
    });
  } finally {
    await rm(args.stagingDir, { recursive: true, force: true });
  }
  return preservedCount === 0
    ? args.contentHash
    : await hashInstallDir(targetRoot);
}

export async function runInstallCommand(
  command: string,
  args: string[],
  options?: {
    notFoundHint?: string;
    maxStdoutBytes?: number;
  },
): Promise<string> {
  const timeoutMs = 5 * 60_000;
  const child = spawnPortableOutputProcess({
    command,
    args,
    env: omitNpmScriptPolicyEnv(process.env),
  });
  let stderr = "";
  let stdout = "";
  let stdoutBytes = 0;
  let overflowed = false;
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    stdoutBytes += chunk.byteLength;
    const limit = options?.maxStdoutBytes;
    if (limit === undefined) {
      if (stdout.length > 8192) stdout = stdout.slice(-8192);
    } else if (stdoutBytes > limit && !overflowed) {
      overflowed = true;
      child.kill("SIGKILL");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 8192) stderr = stderr.slice(-8192);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ENOENT") {
        reject(
          new Error(
            options?.notFoundHint ?? `"${command}" was not found on PATH`,
          ),
        );
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (overflowed) {
        reject(
          new Error(
            `${command} ${args[0]} produced more than ${options?.maxStdoutBytes} bytes of output`,
          ),
        );
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const tail = stderr.trim().slice(-1000);
      reject(
        new Error(
          `${command} ${args[0]} failed (exit ${code ?? "signal"})${tail ? `: ${tail}` : ""}`,
        ),
      );
    });
  });
  return stdout.trim();
}
