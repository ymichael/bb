import type { Dirent } from "node:fs";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import matter from "gray-matter";
import { resolveDataDirSkillsRootPath } from "@bb/config/skill-storage-paths";
import type { HostDaemonInjectedSkillSource } from "@bb/host-daemon-contract";
import { z } from "zod";
import type { ServerLogger } from "../../types.js";
import { isFsErrorWithCode } from "../lib/fs-errors.js";
import { REGISTRY_SKILL_PROVENANCE_FILE_NAME } from "./registry-skill-provenance.js";

const SKILL_FILE_NAME = "SKILL.md";
const SKILL_NAME_PATTERN = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const SKILL_FRONTMATTER_DELIMITER = "---";

const skillFrontmatterSchema = z
  .object({
    name: z
      .string()
      .max(64)
      .regex(
        SKILL_NAME_PATTERN,
        "Skill name must use lowercase letters, numbers, and single hyphens",
      ),
    description: z
      .string()
      .max(1024)
      .refine((value) => value.trim().length > 0, {
        message: "Skill description must be non-empty",
      }),
  })
  .passthrough();

export interface ResolveInjectedSkillSourcesArgs {
  additionalSkillsRootPaths?: readonly string[];
  builtinSkillsRootPath: string;
  dataDir: string;
  pluginSkillRoots?: readonly PluginSkillRoot[];
  pluginSkillSelections?: ReadonlyMap<string, ReadonlySet<string>>;
  projectSkillSources?: readonly ProjectInjectedSkillSource[];
  projectSkillsRootPath?: string;
  sharedSkillSources?: readonly SharedInjectedSkillSource[];
  skillTreeRegistry: SkillTreeRegistry;
}

interface PluginSkillRoot {
  pluginId: string;
  rootPath: string;
}

export function discoverPluginSkillIds(
  logger: ServerLogger,
  args: {
    pluginSkillRoots: readonly PluginSkillRoot[];
    skillTreeRegistry: SkillTreeRegistry;
  },
): ReadonlyMap<string, readonly string[]> {
  const idsByPlugin = new Map<string, Set<string>>();
  for (const { pluginId, rootPath } of args.pluginSkillRoots) {
    const ids = idsByPlugin.get(pluginId) ?? new Set<string>();
    for (const source of readSkillsRoot({
      logger,
      skillTreeRegistry: args.skillTreeRegistry,
      skillsRootPath: rootPath,
      sourceType: "data-dir",
    })) {
      ids.add(source.name);
    }
    idsByPlugin.set(pluginId, ids);
  }
  return new Map(
    [...idsByPlugin].map(([pluginId, ids]) => [
      pluginId,
      [...ids].sort(compareStringsByCodePoint),
    ]),
  );
}

type SkillCatalogProvenance =
  | { kind: "builtin" }
  | { kind: "plugin"; pluginId: string }
  | { kind: "project" }
  | { kind: "user" };

export interface ResolvedSkillCatalogEntry {
  provenance: SkillCatalogProvenance;
  runtimeSource: HostDaemonInjectedSkillSource;
}

interface ResolveServerOwnedSkillCatalogEntriesArgs {
  builtinSkillsRootPath: string;
  dataDir: string;
  logger: ServerLogger;
  skillTreeRegistry: SkillTreeRegistry;
}

export type ProjectInjectedSkillSource = Extract<
  HostDaemonInjectedSkillSource,
  { kind: "workspace-path" }
>;
export type SharedInjectedSkillSource = Extract<
  HostDaemonInjectedSkillSource,
  { kind: "host-path" }
>;

export interface SkillTreeEntry {
  bytes: Buffer;
  mode: number;
  path: string;
}

interface SkillTreeManifest {
  entries: readonly SkillTreeEntry[];
  treeHash: string;
}

export class SkillTreeRegistry {
  readonly #rootsByHash = new Map<string, string>();

  register(treeHash: string, sourceRootPath: string): void {
    this.#rootsByHash.set(treeHash, sourceRootPath);
  }

  resolve(treeHash: string): string | undefined {
    return this.#rootsByHash.get(treeHash);
  }
}

interface SkillCandidateSource {
  sourceType: Extract<
    HostDaemonInjectedSkillSource["sourceType"],
    "builtin" | "data-dir" | "project"
  >;
}

interface SkillRootScanArgs extends SkillCandidateSource {
  logger: ServerLogger;
  skillTreeRegistry: SkillTreeRegistry;
  skillsRootPath: string;
}

interface SkillCandidateArgs extends SkillCandidateSource {
  candidatePath: string;
  directoryName: string;
  logger: ServerLogger;
  skillTreeRegistry: SkillTreeRegistry;
}

interface InvalidSkillLogArgs extends SkillCandidateSource {
  candidatePath: string;
  logger: ServerLogger;
  reason: string;
}

interface SkillCollisionLogArgs {
  colliding: readonly HostDaemonInjectedSkillSource[];
  logger: ServerLogger;
  name: string;
}

function compactZodIssues(issues: z.ZodIssue[]): string {
  return issues
    .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
    .join("; ");
}

function hasSupportedFrontmatterDelimiter(content: string): boolean {
  const trimmed = content.trimStart();
  return (
    trimmed.startsWith(`${SKILL_FRONTMATTER_DELIMITER}\n`) ||
    trimmed.startsWith(`${SKILL_FRONTMATTER_DELIMITER}\r\n`)
  );
}

function logInvalidSkill(args: InvalidSkillLogArgs): void {
  args.logger.warn(
    {
      candidatePath: args.candidatePath,
      reason: args.reason,
      sourceType: args.sourceType,
    },
    "Skipping invalid injected skill",
  );
}

function logSkillCollision(args: SkillCollisionLogArgs): void {
  for (const source of args.colliding) {
    args.logger.warn(
      {
        name: args.name,
        sourceRootPath: sourceRootPath(source),
        sourceType: source.sourceType,
      },
      "Skipping colliding injected skill",
    );
  }
}

function sortDirentsByName(left: Dirent, right: Dirent): number {
  return compareStringsByCodePoint(left.name, right.name);
}

function compareStringsByCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function collectSkillTreeEntries(
  rootPath: string,
  currentPath = rootPath,
): SkillTreeEntry[] {
  const entries: SkillTreeEntry[] = [];
  for (const entry of fs
    .readdirSync(currentPath, { withFileTypes: true })
    .sort(sortDirentsByName)) {
    if (
      currentPath === rootPath &&
      entry.name === REGISTRY_SKILL_PROVENANCE_FILE_NAME
    ) {
      continue;
    }
    const entryPath = path.join(currentPath, entry.name);
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Skill tree contains a symlink: ${entryPath}`);
    }
    if (stat.isDirectory()) {
      entries.push(...collectSkillTreeEntries(rootPath, entryPath));
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`Skill tree entry is not a regular file: ${entryPath}`);
    }
    entries.push({
      bytes: fs.readFileSync(entryPath),
      mode: stat.mode & 0o777,
      path: normalizeRelativePath(path.relative(rootPath, entryPath)),
    });
  }
  return entries;
}

export function hashSkillTreeEntries(
  entries: readonly SkillTreeEntry[],
): string {
  const hash = createHash("sha256");
  hash.update("bb-skill-tree-v1");
  for (const entry of [...entries].sort((left, right) =>
    compareStringsByCodePoint(left.path, right.path),
  )) {
    hash.update("\0file\0");
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.mode.toString(8));
    hash.update("\0");
    hash.update(String(entry.bytes.length));
    hash.update("\0");
    hash.update(entry.bytes);
  }
  return hash.digest("hex");
}

export function readSkillTreeManifest(rootPath: string): SkillTreeManifest {
  const entries = collectSkillTreeEntries(rootPath);
  return { entries, treeHash: hashSkillTreeEntries(entries) };
}

function sourceRootPath(source: HostDaemonInjectedSkillSource): string {
  return source.kind === "tree"
    ? `skill-tree:${source.treeHash}`
    : source.sourceRootPath;
}

function toSkillFilePath(candidatePath: string): string {
  return path.join(candidatePath, SKILL_FILE_NAME);
}

function readSkillCandidate(
  args: SkillCandidateArgs,
): HostDaemonInjectedSkillSource | null {
  const skillFilePath = toSkillFilePath(args.candidatePath);
  let skillFileStat;
  try {
    skillFileStat = fs.lstatSync(skillFilePath);
  } catch (error) {
    if (error instanceof Error && isFsErrorWithCode(error, "ENOENT")) {
      logInvalidSkill({
        ...args,
        reason: "Missing SKILL.md",
      });
      return null;
    }
    throw error;
  }

  if (skillFileStat.isSymbolicLink()) {
    logInvalidSkill({
      ...args,
      reason: "SKILL.md is a symlink",
    });
    return null;
  }
  if (!skillFileStat.isFile()) {
    logInvalidSkill({
      ...args,
      reason: "SKILL.md is not a regular file",
    });
    return null;
  }

  const content = fs.readFileSync(skillFilePath, "utf8");
  if (!hasSupportedFrontmatterDelimiter(content)) {
    logInvalidSkill({
      ...args,
      reason: "SKILL.md frontmatter must start with a plain --- delimiter",
    });
    return null;
  }

  let parsed;
  try {
    parsed = matter(content);
  } catch (error) {
    logInvalidSkill({
      ...args,
      reason:
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Invalid SKILL.md frontmatter",
    });
    return null;
  }

  const frontmatter = skillFrontmatterSchema.safeParse(parsed.data);
  if (!frontmatter.success) {
    logInvalidSkill({
      ...args,
      reason: compactZodIssues(frontmatter.error.issues),
    });
    return null;
  }

  if (frontmatter.data.name !== args.directoryName) {
    logInvalidSkill({
      ...args,
      reason: "Frontmatter name must match the skill directory name",
    });
    return null;
  }

  if (args.sourceType === "project") {
    return {
      kind: "workspace-path",
      sourceType: "project",
      name: frontmatter.data.name,
      description: frontmatter.data.description,
      sourceRootPath: args.candidatePath,
      skillFilePath,
    };
  }
  let manifest: SkillTreeManifest;
  try {
    manifest = readSkillTreeManifest(args.candidatePath);
  } catch (error) {
    logInvalidSkill({
      ...args,
      reason:
        error instanceof Error ? error.message : "Unable to read skill tree",
    });
    return null;
  }
  args.skillTreeRegistry.register(manifest.treeHash, args.candidatePath);
  return {
    kind: "tree",
    sourceType: args.sourceType,
    name: frontmatter.data.name,
    description: frontmatter.data.description,
    treeHash: manifest.treeHash,
    entryPath: SKILL_FILE_NAME,
  };
}

export function resolveProjectSkillSourceFromContent(
  logger: ServerLogger,
  args: {
    candidatePath: string;
    content: string;
    directoryName: string;
  },
): ProjectInjectedSkillSource | null {
  if (!hasSupportedFrontmatterDelimiter(args.content)) {
    logInvalidSkill({
      candidatePath: args.candidatePath,
      logger,
      reason: "SKILL.md frontmatter must start with a plain --- delimiter",
      sourceType: "project",
    });
    return null;
  }

  let parsed;
  try {
    parsed = matter(args.content);
  } catch (error) {
    logInvalidSkill({
      candidatePath: args.candidatePath,
      logger,
      reason:
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Invalid SKILL.md frontmatter",
      sourceType: "project",
    });
    return null;
  }

  const frontmatter = skillFrontmatterSchema.safeParse(parsed.data);
  if (!frontmatter.success) {
    logInvalidSkill({
      candidatePath: args.candidatePath,
      logger,
      reason: compactZodIssues(frontmatter.error.issues),
      sourceType: "project",
    });
    return null;
  }
  if (frontmatter.data.name !== args.directoryName) {
    logInvalidSkill({
      candidatePath: args.candidatePath,
      logger,
      reason: "Frontmatter name must match the skill directory name",
      sourceType: "project",
    });
    return null;
  }

  return {
    kind: "workspace-path",
    sourceType: "project",
    name: frontmatter.data.name,
    description: frontmatter.data.description,
    sourceRootPath: args.candidatePath,
    skillFilePath: toSkillFilePath(args.candidatePath),
  };
}

function readSkillsRoot(
  args: SkillRootScanArgs,
): HostDaemonInjectedSkillSource[] {
  let rootStat;
  try {
    rootStat = fs.lstatSync(args.skillsRootPath);
  } catch (error) {
    if (error instanceof Error && isFsErrorWithCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }

  if (rootStat.isSymbolicLink()) {
    args.logger.warn(
      {
        skillsRootPath: args.skillsRootPath,
        sourceType: args.sourceType,
      },
      "Skipping symlinked injected skills root",
    );
    return [];
  }
  if (!rootStat.isDirectory()) {
    args.logger.warn(
      {
        skillsRootPath: args.skillsRootPath,
        sourceType: args.sourceType,
      },
      "Skipping non-directory injected skills root",
    );
    return [];
  }

  const entries = fs
    .readdirSync(args.skillsRootPath, {
      withFileTypes: true,
    })
    .sort(sortDirentsByName);
  const sources: HostDaemonInjectedSkillSource[] = [];

  for (const entry of entries) {
    const candidatePath = path.join(args.skillsRootPath, entry.name);
    if (entry.isSymbolicLink()) {
      logInvalidSkill({
        ...args,
        candidatePath,
        reason: "Skill directory is a symlink",
      });
      continue;
    }
    if (!entry.isDirectory()) {
      logInvalidSkill({
        ...args,
        candidatePath,
        reason: "Skill candidate is not a directory",
      });
      continue;
    }
    const source = readSkillCandidate({
      candidatePath,
      directoryName: entry.name,
      logger: args.logger,
      skillTreeRegistry: args.skillTreeRegistry,
      sourceType: args.sourceType,
    });
    if (source) {
      sources.push(source);
    }
  }

  return sources;
}

export function resolveServerOwnedSkillCatalogEntries(
  args: ResolveServerOwnedSkillCatalogEntriesArgs,
): ResolvedSkillCatalogEntry[] {
  const builtin = readSkillsRoot({
    logger: args.logger,
    skillTreeRegistry: args.skillTreeRegistry,
    skillsRootPath: args.builtinSkillsRootPath,
    sourceType: "builtin",
  }).map((runtimeSource) => ({
    provenance: { kind: "builtin" } as const,
    runtimeSource,
  }));
  const user = readSkillsRoot({
    logger: args.logger,
    skillTreeRegistry: args.skillTreeRegistry,
    skillsRootPath: resolveDataDirSkillsRootPath(args.dataDir),
    sourceType: "data-dir",
  }).map((runtimeSource) => ({
    provenance: { kind: "user" } as const,
    runtimeSource,
  }));
  return [...builtin, ...user];
}

interface ExcludeOverriddenBuiltinsArgs {
  builtinSources: readonly HostDaemonInjectedSkillSource[];
  userSources: readonly HostDaemonInjectedSkillSource[];
}

interface ExcludeOverriddenLowerPriorityUserSourcesArgs {
  higherPrioritySources: readonly HostDaemonInjectedSkillSource[];
  lowerPrioritySources: readonly HostDaemonInjectedSkillSource[];
}

function excludeOverriddenBuiltins(
  logger: ServerLogger,
  args: ExcludeOverriddenBuiltinsArgs,
): HostDaemonInjectedSkillSource[] {
  const userClaimedNames = new Set(
    args.userSources.map((source) => source.name),
  );
  return args.builtinSources.filter((source) => {
    if (!userClaimedNames.has(source.name)) {
      return true;
    }
    logger.debug(
      {
        name: source.name,
        sourceRootPath: sourceRootPath(source),
      },
      "Built-in injected skill overridden by user skill",
    );
    return false;
  });
}

function excludeOverriddenLowerPriorityUserSources(
  logger: ServerLogger,
  args: ExcludeOverriddenLowerPriorityUserSourcesArgs,
): HostDaemonInjectedSkillSource[] {
  const higherPriorityNames = new Set(
    args.higherPrioritySources.map((source) => source.name),
  );
  return args.lowerPrioritySources.filter((source) => {
    if (!higherPriorityNames.has(source.name)) {
      return true;
    }
    logger.debug(
      {
        name: source.name,
        sourceRootPath: sourceRootPath(source),
      },
      "Lower-priority injected skill overridden by higher-priority skill",
    );
    return false;
  });
}

function excludeCollisions(
  logger: ServerLogger,
  sources: readonly HostDaemonInjectedSkillSource[],
): HostDaemonInjectedSkillSource[] {
  const byName = new Map<string, HostDaemonInjectedSkillSource[]>();
  for (const source of sources) {
    const existing = byName.get(source.name) ?? [];
    existing.push(source);
    byName.set(source.name, existing);
  }

  const resolved: HostDaemonInjectedSkillSource[] = [];
  for (const [name, entries] of byName) {
    if (entries.length === 1) {
      const source = entries[0];
      if (source) {
        resolved.push(source);
      }
      continue;
    }
    logSkillCollision({
      colliding: entries,
      logger,
      name,
    });
  }

  return resolved.sort((left, right) =>
    compareStringsByCodePoint(left.name, right.name),
  );
}

export function resolveSkillCatalogEntries(
  logger: ServerLogger,
  args: ResolveInjectedSkillSourcesArgs,
): ResolvedSkillCatalogEntry[] {
  const { skillTreeRegistry } = args;
  if (
    args.projectSkillSources !== undefined &&
    args.projectSkillsRootPath !== undefined
  ) {
    throw new Error(
      "Specify projectSkillSources or projectSkillsRootPath, not both",
    );
  }
  const projectSources = args.projectSkillSources
    ? [...args.projectSkillSources]
    : args.projectSkillsRootPath !== undefined
      ? readSkillsRoot({
          logger,
          skillTreeRegistry,
          skillsRootPath: args.projectSkillsRootPath,
          sourceType: "project",
        })
      : [];
  const sharedProjectSources = (args.sharedSkillSources ?? []).filter(
    (source) => source.sourceType === "shared-project",
  );
  const sharedUserSources = (args.sharedSkillSources ?? []).filter(
    (source) => source.sourceType === "shared-user",
  );
  const builtinSources = readSkillsRoot({
    logger,
    skillTreeRegistry,
    skillsRootPath: args.builtinSkillsRootPath,
    sourceType: "builtin",
  });

  const dataDirSources = readSkillsRoot({
    logger,
    skillTreeRegistry,
    skillsRootPath: resolveDataDirSkillsRootPath(args.dataDir),
    sourceType: "data-dir",
  });
  const inheritedSourceGroups = (args.additionalSkillsRootPaths ?? []).map(
    (skillsRootPath) =>
      readSkillsRoot({
        logger,
        skillTreeRegistry,
        skillsRootPath,
        sourceType: "data-dir",
      }),
  );

  const configuredUserSources = [
    ...dataDirSources,
    ...excludeOverriddenLowerPriorityUserSources(logger, {
      higherPrioritySources: dataDirSources,
      lowerPrioritySources: sharedUserSources,
    }),
  ];
  const userSources = inheritedSourceGroups.reduce<
    HostDaemonInjectedSkillSource[]
  >(
    (higherPrioritySources, lowerPrioritySources) => [
      ...higherPrioritySources,
      ...excludeOverriddenLowerPriorityUserSources(logger, {
        higherPrioritySources,
        lowerPrioritySources,
      }),
    ],
    configuredUserSources,
  );
  const pluginSourceGroups = (args.pluginSkillRoots ?? []).map(
    ({ pluginId, rootPath }) => ({
      pluginId,
      sources: readSkillsRoot({
        logger,
        skillTreeRegistry,
        skillsRootPath: rootPath,
        sourceType: "data-dir",
      }).filter(
        (source) =>
          !args.pluginSkillSelections?.has(pluginId) ||
          args.pluginSkillSelections.get(pluginId)?.has(source.name) === true,
      ),
    }),
  );
  const pluginSources = pluginSourceGroups.reduce<
    HostDaemonInjectedSkillSource[]
  >(
    (higherPrioritySources, { sources: lowerPrioritySources }) => [
      ...higherPrioritySources,
      ...excludeOverriddenLowerPriorityUserSources(logger, {
        higherPrioritySources,
        lowerPrioritySources,
      }),
    ],
    [],
  );
  const activePluginSources = excludeOverriddenLowerPriorityUserSources(
    logger,
    {
      higherPrioritySources: userSources,
      lowerPrioritySources: pluginSources,
    },
  );
  const activeBuiltinSources = excludeOverriddenBuiltins(logger, {
    builtinSources,
    userSources: [...userSources, ...activePluginSources],
  });
  const globalSources = excludeCollisions(logger, [
    ...activeBuiltinSources,
    ...userSources,
    ...activePluginSources,
  ]);
  const activeProjectSources = excludeCollisions(logger, projectSources);
  const activeSharedProjectSources = excludeOverriddenLowerPriorityUserSources(
    logger,
    {
      higherPrioritySources: activeProjectSources,
      lowerPrioritySources: excludeCollisions(logger, sharedProjectSources),
    },
  );
  const projectTierSources = [
    ...activeProjectSources,
    ...activeSharedProjectSources,
  ];
  const projectNames = new Set(projectTierSources.map((source) => source.name));

  const provenanceBySource = new Map<
    HostDaemonInjectedSkillSource,
    SkillCatalogProvenance
  >();
  for (const source of projectSources) {
    provenanceBySource.set(source, { kind: "project" });
  }
  for (const source of sharedProjectSources) {
    provenanceBySource.set(source, { kind: "project" });
  }
  for (const source of sharedUserSources) {
    provenanceBySource.set(source, { kind: "user" });
  }
  for (const source of builtinSources) {
    provenanceBySource.set(source, { kind: "builtin" });
  }
  for (const source of [...dataDirSources, ...inheritedSourceGroups.flat()]) {
    provenanceBySource.set(source, { kind: "user" });
  }
  for (const group of pluginSourceGroups) {
    for (const source of group.sources) {
      provenanceBySource.set(source, {
        kind: "plugin",
        pluginId: group.pluginId,
      });
    }
  }

  return [...projectTierSources, ...globalSources]
    .filter(
      (source) =>
        source.sourceType === "project" ||
        source.sourceType === "shared-project" ||
        !projectNames.has(source.name),
    )
    .sort((left, right) => compareStringsByCodePoint(left.name, right.name))
    .map((runtimeSource) => {
      const provenance = provenanceBySource.get(runtimeSource);
      if (provenance === undefined) {
        throw new Error(`Missing skill provenance for ${runtimeSource.name}`);
      }
      return { provenance, runtimeSource };
    });
}

export function resolveInjectedSkillSources(
  logger: ServerLogger,
  args: ResolveInjectedSkillSourcesArgs,
): HostDaemonInjectedSkillSource[] {
  return resolveSkillCatalogEntries(logger, args).map(
    (entry) => entry.runtimeSource,
  );
}
