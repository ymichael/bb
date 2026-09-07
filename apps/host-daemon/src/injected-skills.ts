import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveDataDirSkillsRootPath } from "@bb/config/skill-storage-paths";
import type { AgentRuntimeSkillRoot } from "@bb/agent-runtime";
import type { HostDaemonInjectedSkillSource } from "@bb/host-daemon-contract";
import type { HostDaemonSkillTree } from "@bb/host-daemon-contract";
import { isFsErrorWithCode } from "./fs-errors.js";
import type { FetchSkillTree } from "./skill-trees.js";

const STAGING_ROOT_SEGMENTS = ["runtime", "global-skills"] as const;
const STORE_ROOT_SEGMENTS = ["runtime", "skill-store"] as const;
const STORE_CONTENT_DIR = "content";
const STORE_COMPLETE_MARKER = ".complete";
const STORE_LAST_USED_MARKER = ".last-used";
export const MAX_SKILL_STORE_TREES = 64;
const STALE_TEMP_STAGING_DIR_AGE_MS = 60 * 60 * 1000;
const SKILL_FILE_NAME = "SKILL.md";
const SKILL_NAME_PATTERN = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const MAX_STAGED_SKILL_FILES = 1_000;
const MAX_STAGED_SKILL_BYTES = 10 * 1024 * 1024;
const MAX_STAGED_SKILL_DEPTH = 24;
export const EMPTY_SKILL_CATALOG_HASH = createHash("sha256")
  .update("bb-global-skills-v1-empty")
  .digest("hex");

export interface InjectedSkillsLogger {
  debug(context: object, message: string): void;
  warn(context: object, message: string): void;
}

interface StageInjectedSkillSourcesArgs {
  dataDir: string;
  fetchSkillTree?: FetchSkillTree;
  injectedSkillSources: readonly HostDaemonInjectedSkillSource[];
  logger?: InjectedSkillsLogger;
}

interface CleanupInjectedSkillStagingDirsArgs {
  dataDir: string;
  keepCatalogHashes: readonly string[];
  logger?: InjectedSkillsLogger;
}

interface StagedInjectedSkills {
  catalogHash: string;
  skillRoots: readonly AgentRuntimeSkillRoot[];
}

interface CopyInjectedSkillSourceArgs {
  destinationPath: string;
  name: string;
  sourceRootPath: string;
  skillFilePath: string;
}

interface CollectedSkillFile {
  bytes: Buffer;
  mode: number;
  relativePath: string;
}

interface CollectedSkillDirectory {
  relativePath: string;
}

interface CollectedSkillTree {
  directories: CollectedSkillDirectory[];
  files: CollectedSkillFile[];
  source: HostDaemonInjectedSkillSource;
  totalBytes: number;
}

interface CollectSkillTreeArgs {
  source: HostDaemonInjectedSkillSource;
  sourceRootPath: string;
  skillFilePath: string;
}

interface CollectSkillDirectoryArgs {
  name: string;
  sourceRootPath: string;
  skillFilePath: string;
}

interface WalkSkillTreeArgs {
  currentPath: string;
  depth: number;
  rootPath: string;
  state: SkillTreeCollectionState;
}

interface SkillTreeCollectionState {
  directories: CollectedSkillDirectory[];
  files: CollectedSkillFile[];
  totalBytes: number;
}

interface StageTreeArgs {
  skillDirectoryPath: string;
  tree: SkillTreeCollectionState;
}

interface WriteStageRootArgs {
  catalogHash: string;
  dataDir: string;
  trees: readonly CollectedSkillTree[];
}

interface BuildSkillRootsArgs {
  catalogHash: string;
  stageRootPath: string;
  trees: readonly CollectedSkillTree[];
}

interface CatalogSkillEntry {
  description: string;
  name: string;
  sourceRootPath: string;
  sourceType: HostDaemonInjectedSkillSource["sourceType"];
}

interface CatalogFile {
  catalogHash: string;
  generatedAt: string;
  skills: CatalogSkillEntry[];
}

interface CreateCatalogFileArgs {
  catalogHash: string;
  trees: readonly CollectedSkillTree[];
}

const pendingStageRootWrites = new Map<string, Promise<string>>();
const pendingSkillTreePulls = new Map<string, Promise<string>>();
const skillStoreQueues = new Map<string, Promise<void>>();
const activeSkillTreeStages = new Map<string, Map<string, number>>();

async function withSkillStoreQueue<T>(
  dataDir: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = skillStoreQueues.get(dataDir) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(work);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  skillStoreQueues.set(dataDir, tail);
  try {
    return await result;
  } finally {
    if (skillStoreQueues.get(dataDir) === tail) {
      skillStoreQueues.delete(dataDir);
    }
  }
}

function markActiveSkillTreeStages(
  dataDir: string,
  treeHashes: readonly string[],
): void {
  const counts =
    activeSkillTreeStages.get(dataDir) ?? new Map<string, number>();
  for (const treeHash of treeHashes) {
    counts.set(treeHash, (counts.get(treeHash) ?? 0) + 1);
  }
  activeSkillTreeStages.set(dataDir, counts);
}

function unmarkActiveSkillTreeStages(
  dataDir: string,
  treeHashes: readonly string[],
): void {
  const counts = activeSkillTreeStages.get(dataDir);
  if (!counts) return;
  for (const treeHash of treeHashes) {
    const count = counts.get(treeHash) ?? 0;
    if (count <= 1) counts.delete(treeHash);
    else counts.set(treeHash, count - 1);
  }
  if (counts.size === 0) activeSkillTreeStages.delete(dataDir);
}

function createNoopLogger(): InjectedSkillsLogger {
  return {
    debug: () => undefined,
    warn: () => undefined,
  };
}

function resolveStagingRootPath(dataDir: string): string {
  return path.join(dataDir, ...STAGING_ROOT_SEGMENTS);
}

function resolveStageRootPath(dataDir: string, catalogHash: string): string {
  return path.join(resolveStagingRootPath(dataDir), catalogHash);
}

export async function ensureDataDirSkillsRootPath(
  dataDir: string,
): Promise<string> {
  const dataDirSkillsRootPath = resolveDataDirSkillsRootPath(dataDir);
  await fs.mkdir(dataDirSkillsRootPath, { recursive: true });
  return dataDirSkillsRootPath;
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return (
    relativePath.length === 0 ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function sortDirentsByName(left: Dirent, right: Dirent): number {
  return compareStringsByCodePoint(left.name, right.name);
}

function sortTreesByName(
  left: CollectedSkillTree,
  right: CollectedSkillTree,
): number {
  return compareStringsByCodePoint(left.source.name, right.source.name);
}

function compareStringsByCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertUsableSkillDirectory(args: CollectSkillDirectoryArgs): void {
  const { name, sourceRootPath, skillFilePath } = args;
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid injected skill name: ${name}`);
  }
  if (!path.isAbsolute(sourceRootPath)) {
    throw new Error(
      `Injected skill source root must be absolute: ${sourceRootPath}`,
    );
  }
  if (!path.isAbsolute(skillFilePath)) {
    throw new Error(
      `Injected skill file path must be absolute: ${skillFilePath}`,
    );
  }
  if (!isPathWithinRoot(sourceRootPath, skillFilePath)) {
    throw new Error(
      `Injected skill file path escapes source root: ${skillFilePath}`,
    );
  }
  if (path.basename(skillFilePath) !== SKILL_FILE_NAME) {
    throw new Error(
      `Injected skill file path must end with ${SKILL_FILE_NAME}: ${skillFilePath}`,
    );
  }
}

async function walkSkillTree(args: WalkSkillTreeArgs): Promise<void> {
  if (args.depth > MAX_STAGED_SKILL_DEPTH) {
    throw new Error(
      `Skill tree exceeds max depth ${MAX_STAGED_SKILL_DEPTH}: ${args.rootPath}`,
    );
  }

  const entries = (
    await fs.readdir(args.currentPath, {
      withFileTypes: true,
    })
  ).sort(sortDirentsByName);

  for (const entry of entries) {
    const sourcePath = path.join(args.currentPath, entry.name);
    if (!isPathWithinRoot(args.rootPath, sourcePath)) {
      throw new Error(`Skill tree entry escapes source root: ${sourcePath}`);
    }
    const relativePath = normalizeRelativePath(
      path.relative(args.rootPath, sourcePath),
    );
    const entryStat = await fs.lstat(sourcePath);
    if (entryStat.isSymbolicLink()) {
      throw new Error(`Skill tree contains a symlink: ${sourcePath}`);
    }
    if (entryStat.isDirectory()) {
      args.state.directories.push({ relativePath });
      await walkSkillTree({
        currentPath: sourcePath,
        depth: args.depth + 1,
        rootPath: args.rootPath,
        state: args.state,
      });
      continue;
    }
    if (!entryStat.isFile()) {
      throw new Error(`Skill tree entry is not a regular file: ${sourcePath}`);
    }
    if (args.state.files.length + 1 > MAX_STAGED_SKILL_FILES) {
      throw new Error(
        `Skill tree exceeds max file count ${MAX_STAGED_SKILL_FILES}: ${args.rootPath}`,
      );
    }
    if (args.state.totalBytes + entryStat.size > MAX_STAGED_SKILL_BYTES) {
      throw new Error(
        `Skill tree exceeds max byte count ${MAX_STAGED_SKILL_BYTES}: ${args.rootPath}`,
      );
    }
    const bytes = await fs.readFile(sourcePath);
    args.state.files.push({
      bytes,
      mode: entryStat.mode & 0o777,
      relativePath,
    });
    args.state.totalBytes += entryStat.size;
  }
}

async function collectSkillDirectory(
  args: CollectSkillDirectoryArgs,
): Promise<SkillTreeCollectionState> {
  assertUsableSkillDirectory(args);
  const rootStat = await fs.lstat(args.sourceRootPath);
  if (rootStat.isSymbolicLink()) {
    throw new Error(
      `Injected skill source root is a symlink: ${args.sourceRootPath}`,
    );
  }
  if (!rootStat.isDirectory()) {
    throw new Error(
      `Injected skill source root is not a directory: ${args.sourceRootPath}`,
    );
  }
  const skillFileStat = await fs.lstat(args.skillFilePath);
  if (skillFileStat.isSymbolicLink()) {
    throw new Error(`Injected skill file is a symlink: ${args.skillFilePath}`);
  }
  if (!skillFileStat.isFile()) {
    throw new Error(
      `Injected skill file is not a regular file: ${args.skillFilePath}`,
    );
  }

  const state: SkillTreeCollectionState = {
    directories: [],
    files: [],
    totalBytes: 0,
  };
  await walkSkillTree({
    currentPath: args.sourceRootPath,
    depth: 0,
    rootPath: args.sourceRootPath,
    state,
  });

  return state;
}

async function collectSkillTree(
  args: CollectSkillTreeArgs,
): Promise<CollectedSkillTree> {
  const state = await collectSkillDirectory({
    name: args.source.name,
    sourceRootPath: args.sourceRootPath,
    skillFilePath: args.skillFilePath,
  });

  return {
    directories: state.directories,
    files: state.files,
    source: args.source,
    totalBytes: state.totalBytes,
  };
}

function hashCollectedTrees(trees: readonly CollectedSkillTree[]): string {
  const hash = createHash("sha256");
  hash.update("bb-global-skills-v1");
  for (const tree of trees) {
    hash.update("\0skill\0");
    hash.update(tree.source.name);
    hash.update("\0");
    hash.update(tree.source.description);
    hash.update("\0");
    hash.update(tree.source.sourceType);
    hash.update("\0");
    hash.update(
      tree.source.kind === "tree"
        ? tree.source.treeHash
        : tree.source.sourceRootPath,
    );
    for (const file of tree.files) {
      hash.update("\0file\0");
      hash.update(file.relativePath);
      hash.update("\0");
      hash.update(createHash("sha256").update(file.bytes).digest("hex"));
      hash.update("\0");
      hash.update(file.mode.toString(8));
    }
  }
  return hash.digest("hex");
}

async function copyCollectedTree(args: StageTreeArgs): Promise<void> {
  await fs.mkdir(args.skillDirectoryPath, { recursive: true });
  for (const directory of args.tree.directories) {
    await fs.mkdir(path.join(args.skillDirectoryPath, directory.relativePath), {
      recursive: true,
    });
  }
  for (const file of args.tree.files) {
    const destinationPath = path.join(
      args.skillDirectoryPath,
      file.relativePath,
    );
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.writeFile(destinationPath, file.bytes, { mode: file.mode });
    await fs.chmod(destinationPath, file.mode);
  }
}

export async function copyInjectedSkillSource(
  args: CopyInjectedSkillSourceArgs,
): Promise<void> {
  const tree = await collectSkillDirectory({
    name: args.name,
    sourceRootPath: args.sourceRootPath,
    skillFilePath: args.skillFilePath,
  });
  await copyCollectedTree({
    skillDirectoryPath: args.destinationPath,
    tree,
  });
}

function createCatalogFile(args: CreateCatalogFileArgs): CatalogFile {
  return {
    catalogHash: args.catalogHash,
    generatedAt: new Date().toISOString(),
    skills: args.trees.map((tree) => ({
      description: tree.source.description,
      name: tree.source.name,
      sourceRootPath:
        tree.source.kind === "tree"
          ? `skill-tree:${tree.source.treeHash}`
          : tree.source.sourceRootPath,
      sourceType: tree.source.sourceType,
    })),
  };
}

async function writeStageRoot(args: WriteStageRootArgs): Promise<string> {
  const stagingRootPath = resolveStagingRootPath(args.dataDir);
  const stageRootPath = resolveStageRootPath(args.dataDir, args.catalogHash);
  try {
    await fs.access(path.join(stageRootPath, "catalog.json"));
    return stageRootPath;
  } catch (error) {
    if (!isFsErrorWithCode(error, "ENOENT")) {
      throw error;
    }
  }

  await fs.mkdir(stagingRootPath, { recursive: true });
  const tempRootPath = path.join(
    stagingRootPath,
    `.tmp-${args.catalogHash}-${process.pid}-${Date.now()}-${randomUUID()}`,
  );
  await fs.rm(tempRootPath, { recursive: true, force: true });
  await fs.mkdir(path.join(tempRootPath, "skills"), { recursive: true });

  try {
    for (const tree of args.trees) {
      await copyCollectedTree({
        skillDirectoryPath: path.join(tempRootPath, "skills", tree.source.name),
        tree,
      });
    }
    await fs.writeFile(
      path.join(tempRootPath, "catalog.json"),
      `${JSON.stringify(
        createCatalogFile({
          catalogHash: args.catalogHash,
          trees: args.trees,
        }),
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.rename(tempRootPath, stageRootPath);
  } catch (error) {
    if (
      isFsErrorWithCode(error, "EEXIST") ||
      isFsErrorWithCode(error, "ENOTEMPTY")
    ) {
      await fs.rm(tempRootPath, { recursive: true, force: true });
      return stageRootPath;
    }
    await fs.rm(tempRootPath, { recursive: true, force: true });
    throw error;
  }

  return stageRootPath;
}

function stageRootWriteKey(args: WriteStageRootArgs): string {
  return `${args.dataDir}\0${args.catalogHash}`;
}

async function writeStageRootOnce(args: WriteStageRootArgs): Promise<string> {
  const key = stageRootWriteKey(args);
  const pending = pendingStageRootWrites.get(key);
  if (pending) {
    return pending;
  }

  const write = writeStageRoot(args).finally(() => {
    pendingStageRootWrites.delete(key);
  });
  pendingStageRootWrites.set(key, write);
  return write;
}

function buildSkillRoots(args: BuildSkillRootsArgs): AgentRuntimeSkillRoot[] {
  return [
    {
      id: `global-skills:${args.catalogHash}`,
      path: path.join(args.stageRootPath, "skills"),
      skills: args.trees.map((tree) => ({
        name: tree.source.name,
        description: tree.source.description,
      })),
    },
  ];
}

function resolveSkillStoreRootPath(dataDir: string): string {
  return path.join(dataDir, ...STORE_ROOT_SEGMENTS);
}

function resolveStoredTreeRootPath(dataDir: string, treeHash: string): string {
  return path.join(resolveSkillStoreRootPath(dataDir), treeHash);
}

function decodeTreeEntryContent(
  contentBase64: string,
  entryPath: string,
): Buffer {
  const bytes = Buffer.from(contentBase64, "base64");
  const normalizedInput = contentBase64.replace(/=+$/u, "");
  const normalizedDecoded = bytes.toString("base64").replace(/=+$/u, "");
  if (normalizedInput !== normalizedDecoded) {
    throw new Error(
      `Skill tree entry has invalid base64 content: ${entryPath}`,
    );
  }
  return bytes;
}

function validatedTreeEntries(tree: HostDaemonSkillTree): CollectedSkillFile[] {
  const files: CollectedSkillFile[] = [];
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const entry of tree.entries) {
    if (
      entry.path.includes("\\") ||
      path.posix.isAbsolute(entry.path) ||
      entry.path
        .split("/")
        .some((segment) => segment === "" || segment === "..")
    ) {
      throw new Error(`Skill tree entry has unsafe path: ${entry.path}`);
    }
    if (paths.has(entry.path)) {
      throw new Error(`Skill tree contains duplicate path: ${entry.path}`);
    }
    paths.add(entry.path);
    const bytes = decodeTreeEntryContent(entry.contentBase64, entry.path);
    totalBytes += bytes.length;
    if (files.length + 1 > MAX_STAGED_SKILL_FILES) {
      throw new Error(
        `Skill tree exceeds max file count ${MAX_STAGED_SKILL_FILES}`,
      );
    }
    if (totalBytes > MAX_STAGED_SKILL_BYTES) {
      throw new Error(
        `Skill tree exceeds max byte count ${MAX_STAGED_SKILL_BYTES}`,
      );
    }
    files.push({ bytes, mode: entry.mode, relativePath: entry.path });
  }
  return files.sort((left, right) =>
    compareStringsByCodePoint(left.relativePath, right.relativePath),
  );
}

function hashStoredTreeFiles(files: readonly CollectedSkillFile[]): string {
  const hash = createHash("sha256");
  hash.update("bb-skill-tree-v1");
  for (const file of files) {
    hash.update("\0file\0");
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(file.mode.toString(8));
    hash.update("\0");
    hash.update(String(file.bytes.length));
    hash.update("\0");
    hash.update(file.bytes);
  }
  return hash.digest("hex");
}

export async function hashInstalledSkillDirectory(args: {
  name: string;
  skillDirectoryPath: string;
}): Promise<string | null> {
  try {
    const tree = await collectSkillDirectory({
      name: args.name,
      sourceRootPath: args.skillDirectoryPath,
      skillFilePath: path.join(args.skillDirectoryPath, SKILL_FILE_NAME),
    });
    return hashStoredTreeFiles(
      [...tree.files].sort((left, right) =>
        compareStringsByCodePoint(left.relativePath, right.relativePath),
      ),
    );
  } catch {
    return null;
  }
}

async function touchStoredTree(treeRootPath: string): Promise<void> {
  await fs.writeFile(path.join(treeRootPath, STORE_LAST_USED_MARKER), "");
}

async function gcSkillStore(dataDir: string): Promise<void> {
  const exemptTreeHashes = new Set(
    activeSkillTreeStages.get(dataDir)?.keys() ?? [],
  );
  const storeRootPath = resolveSkillStoreRootPath(dataDir);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(storeRootPath, { withFileTypes: true });
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) return;
    throw error;
  }
  const completeTrees: { name: string; usedAt: number }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".tmp-")) {
      continue;
    }
    const treeRootPath = path.join(storeRootPath, entry.name);
    try {
      await fs.access(path.join(treeRootPath, STORE_COMPLETE_MARKER));
      const stat = await fs.stat(
        path.join(treeRootPath, STORE_LAST_USED_MARKER),
      );
      completeTrees.push({ name: entry.name, usedAt: stat.mtimeMs });
    } catch (error) {
      if (!isFsErrorWithCode(error, "ENOENT")) {
        throw error;
      }
    }
  }
  completeTrees.sort(
    (left, right) =>
      right.usedAt - left.usedAt ||
      compareStringsByCodePoint(left.name, right.name),
  );
  const removalCount = Math.max(
    0,
    completeTrees.length - MAX_SKILL_STORE_TREES,
  );
  const evictionCandidates = completeTrees.filter(
    (entry) => !exemptTreeHashes.has(entry.name),
  );
  await Promise.all(
    evictionCandidates
      .slice(Math.max(0, evictionCandidates.length - removalCount))
      .map((entry) =>
        fs.rm(path.join(storeRootPath, entry.name), {
          recursive: true,
          force: true,
        }),
      ),
  );
}

async function writeFetchedTreeToStore(args: {
  dataDir: string;
  tree: HostDaemonSkillTree;
  treeHash: string;
}): Promise<string> {
  if (args.tree.treeHash !== args.treeHash) {
    throw new Error(
      `Fetched skill tree hash mismatch: expected ${args.treeHash}, received ${args.tree.treeHash}`,
    );
  }
  const files = validatedTreeEntries(args.tree);
  const actualHash = hashStoredTreeFiles(files);
  if (actualHash !== args.treeHash) {
    throw new Error(
      `Fetched skill tree content hash mismatch: expected ${args.treeHash}, computed ${actualHash}`,
    );
  }

  const storeRootPath = resolveSkillStoreRootPath(args.dataDir);
  const treeRootPath = resolveStoredTreeRootPath(args.dataDir, args.treeHash);
  await fs.mkdir(storeRootPath, { recursive: true });
  const tempRootPath = path.join(
    storeRootPath,
    `.tmp-${args.treeHash}-${process.pid}-${Date.now()}-${randomUUID()}`,
  );
  const contentRootPath = path.join(tempRootPath, STORE_CONTENT_DIR);
  await fs.mkdir(contentRootPath, { recursive: true });
  try {
    for (const file of files) {
      const destinationPath = path.join(contentRootPath, file.relativePath);
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      await fs.writeFile(destinationPath, file.bytes, { mode: file.mode });
      await fs.chmod(destinationPath, file.mode);
    }
    await fs.writeFile(path.join(tempRootPath, STORE_LAST_USED_MARKER), "");
    await fs.writeFile(
      path.join(tempRootPath, STORE_COMPLETE_MARKER),
      "complete\n",
    );
    await fs.rename(tempRootPath, treeRootPath);
  } catch (error) {
    if (
      isFsErrorWithCode(error, "EEXIST") ||
      isFsErrorWithCode(error, "ENOTEMPTY")
    ) {
      await fs.rm(tempRootPath, { recursive: true, force: true });
    } else {
      await fs.rm(tempRootPath, { recursive: true, force: true });
      throw error;
    }
  }
  await touchStoredTree(treeRootPath);
  await gcSkillStore(args.dataDir);
  return path.join(treeRootPath, STORE_CONTENT_DIR);
}

export async function ensureStoredSkillTree(args: {
  dataDir: string;
  fetchSkillTree: FetchSkillTree;
  treeHash: string;
}): Promise<string> {
  const key = `${args.dataDir}\0${args.treeHash}`;
  const pending = pendingSkillTreePulls.get(key);
  if (pending) {
    return pending;
  }
  const pull = withSkillStoreQueue(args.dataDir, async () => {
    const treeRootPath = resolveStoredTreeRootPath(args.dataDir, args.treeHash);
    try {
      await fs.access(path.join(treeRootPath, STORE_COMPLETE_MARKER));
      await fs.access(path.join(treeRootPath, STORE_CONTENT_DIR));
      await touchStoredTree(treeRootPath);
      await gcSkillStore(args.dataDir);
      return path.join(treeRootPath, STORE_CONTENT_DIR);
    } catch (error) {
      if (!isFsErrorWithCode(error, "ENOENT")) {
        throw error;
      }
    }
    return writeFetchedTreeToStore({
      dataDir: args.dataDir,
      tree: await args.fetchSkillTree(args.treeHash),
      treeHash: args.treeHash,
    });
  }).finally(() => pendingSkillTreePulls.delete(key));
  pendingSkillTreePulls.set(key, pull);
  return pull;
}

export async function stageInjectedSkillSources(
  args: StageInjectedSkillSourcesArgs,
): Promise<StagedInjectedSkills> {
  if (args.injectedSkillSources.length === 0) {
    return {
      catalogHash: EMPTY_SKILL_CATALOG_HASH,
      skillRoots: [],
    };
  }

  const logger = args.logger ?? createNoopLogger();
  const trees: CollectedSkillTree[] = [];
  const sortedSources = [...args.injectedSkillSources].sort((left, right) =>
    compareStringsByCodePoint(left.name, right.name),
  );
  const stagedTreeHashes = sortedSources.flatMap((source) =>
    source.kind === "tree" ? [source.treeHash] : [],
  );
  markActiveSkillTreeStages(args.dataDir, stagedTreeHashes);
  try {
    for (const source of sortedSources) {
      if (source.kind === "tree") {
        try {
          if (args.fetchSkillTree === undefined) {
            throw new Error("Skill tree fetch transport is unavailable");
          }
          const sourceRootPath = await ensureStoredSkillTree({
            dataDir: args.dataDir,
            fetchSkillTree: args.fetchSkillTree,
            treeHash: source.treeHash,
          });
          const skillFilePath = path.resolve(sourceRootPath, source.entryPath);
          if (!isPathWithinRoot(sourceRootPath, skillFilePath)) {
            throw new Error(
              `Injected skill entry path escapes tree: ${source.entryPath}`,
            );
          }
          trees.push(
            await collectSkillTree({ source, sourceRootPath, skillFilePath }),
          );
        } catch (error) {
          logger.warn(
            {
              name: source.name,
              treeHash: source.treeHash,
              sourceType: source.sourceType,
              reason:
                error instanceof Error && error.message.trim().length > 0
                  ? error.message
                  : "Unable to pull injected skill tree",
            },
            "Failed to pull required injected skill tree",
          );
          throw error;
        }
        continue;
      }
      try {
        trees.push(
          await collectSkillTree({
            source,
            sourceRootPath: source.sourceRootPath,
            skillFilePath: source.skillFilePath,
          }),
        );
      } catch (error) {
        logger.warn(
          {
            name: source.name,
            sourceRootPath: source.sourceRootPath,
            sourceType: source.sourceType,
            reason:
              error instanceof Error && error.message.trim().length > 0
                ? error.message
                : "Unable to stage injected skill",
          },
          "Skipping injected skill during staging",
        );
      }
    }
  } finally {
    unmarkActiveSkillTreeStages(args.dataDir, stagedTreeHashes);
    await withSkillStoreQueue(args.dataDir, () => gcSkillStore(args.dataDir));
  }

  const sortedTrees = trees.sort(sortTreesByName);
  if (sortedTrees.length === 0) {
    return {
      catalogHash: EMPTY_SKILL_CATALOG_HASH,
      skillRoots: [],
    };
  }

  const catalogHash = hashCollectedTrees(sortedTrees);
  const stageRootPath = await writeStageRootOnce({
    catalogHash,
    dataDir: args.dataDir,
    trees: sortedTrees,
  });
  return {
    catalogHash,
    skillRoots: buildSkillRoots({
      catalogHash,
      stageRootPath,
      trees: sortedTrees,
    }),
  };
}

export async function cleanupInjectedSkillStagingDirs(
  args: CleanupInjectedSkillStagingDirsArgs,
): Promise<void> {
  const stagingRootPath = resolveStagingRootPath(args.dataDir);
  const keep = new Set(args.keepCatalogHashes);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(stagingRootPath, { withFileTypes: true });
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }

  const logger = args.logger ?? createNoopLogger();
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(stagingRootPath, entry.name);
      if (entry.name.startsWith(".tmp-")) {
        let mtimeMs: number;
        try {
          mtimeMs = (await fs.stat(entryPath)).mtimeMs;
        } catch (error) {
          if (isFsErrorWithCode(error, "ENOENT")) {
            return;
          }
          throw error;
        }
        if (Date.now() - mtimeMs < STALE_TEMP_STAGING_DIR_AGE_MS) {
          return;
        }
        await fs.rm(entryPath, { recursive: true, force: true });
        return;
      }
      if (!entry.isDirectory()) {
        await fs.rm(entryPath, { recursive: true, force: true });
        return;
      }
      if (keep.has(entry.name)) {
        return;
      }
      logger.debug(
        {
          catalogHash: entry.name,
          stagingRootPath,
        },
        "Removing unused injected skill staging directory",
      );
      await fs.rm(entryPath, {
        recursive: true,
        force: true,
      });
    }),
  );
}
