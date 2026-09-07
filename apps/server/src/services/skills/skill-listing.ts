import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveDataDirSkillsRootPath } from "@bb/config/skill-storage-paths";
import type { DiscoveredSkill, SkillRootKind } from "@bb/host-daemon-contract";
import type {
  SkillProvider,
  SkillScope,
  SkillSummary,
} from "@bb/server-contract";
import { editableSkillScopeSchema } from "@bb/server-contract";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import {
  callHostOnlineRpc,
  callHostRetryableOnlineRpc,
} from "../hosts/online-rpc.js";
import type { ProjectCommandWorkspace as CommandWorkspace } from "../projects/project-workspace.js";
import { resolveServerOwnedSkillCatalogEntries } from "./injected-skills.js";
import { resolveSkillCatalog } from "./skill-catalog.js";
import { readRegistrySkillProvenance } from "./registry-skill-provenance.js";
import { hostPathDirname, resolveSharedSkills } from "./shared-skills.js";
import {
  providerHasNativeRootSurface,
  scanProviderNativeRoots,
} from "../providers/native-roots.js";

const SKILL_FILE_NAME = "SKILL.md";
const SERVER_SKILL_FILE_LIMIT = 200;
const SERVER_SKILL_CONTENT_LIMIT_BYTES = 25 * 1024 * 1024;

const SKILL_SCOPE_ORDER: readonly SkillScope[] = [
  "bb-project",
  "bb-user",
  "bb-builtin",
  "shared-project",
  "shared-user",
  "provider-project",
  "provider-user",
  "plugin",
];

function hostPathBasename(filePath: string): string {
  return /^[a-zA-Z]:[\\/]/u.test(filePath)
    ? path.win32.basename(filePath)
    : path.posix.basename(filePath);
}

function isBundledProviderSkill(filePath: string): boolean {
  return /(^|[\\/])\.system([\\/]|$)/u.test(filePath);
}

interface MappedScope {
  scope: SkillScope;
  provider: SkillProvider | null;
  manageable: boolean;
}

export function mapSkillScope(
  provider: SkillProvider,
  rootKind: SkillRootKind,
  filePath: string,
): MappedScope {
  switch (rootKind) {
    case "bb-project":
      return { scope: "bb-project", provider: null, manageable: true };
    case "bb-data-dir":
      return { scope: "bb-user", provider: null, manageable: true };
    case "bb-builtin":
      return { scope: "bb-builtin", provider: null, manageable: false };
    case "provider-project":
      return { scope: "provider-project", provider, manageable: true };
    case "provider-user":
      return {
        scope: "provider-user",
        provider,
        manageable: !isBundledProviderSkill(filePath),
      };
    case "shared-project":
      return { scope: "shared-project", provider: null, manageable: false };
    case "shared-user":
      return { scope: "shared-user", provider: null, manageable: false };
    case "plugin":
      return { scope: "plugin", provider, manageable: false };
  }
}

interface ProviderSkillDiscovery {
  provider: SkillProvider;
  skills: DiscoveredSkill[];
}

function compareSkillSummaries(
  left: SkillSummary,
  right: SkillSummary,
): number {
  const scopeDelta =
    SKILL_SCOPE_ORDER.indexOf(left.scope) -
    SKILL_SCOPE_ORDER.indexOf(right.scope);
  if (scopeDelta !== 0) {
    return scopeDelta;
  }
  const providerDelta = (left.provider ?? "").localeCompare(
    right.provider ?? "",
  );
  if (providerDelta !== 0) {
    return providerDelta;
  }
  const nameDelta = left.name.localeCompare(right.name);
  if (nameDelta !== 0) {
    return nameDelta;
  }
  return left.filePath.localeCompare(right.filePath);
}

export function assembleSkillList(
  perProvider: readonly ProviderSkillDiscovery[],
): SkillSummary[] {
  const byPath = new Map<string, SkillSummary>();
  for (const { provider, skills } of perProvider) {
    for (const skill of skills) {
      if (byPath.has(skill.filePath)) {
        continue;
      }
      const mapped = mapSkillScope(provider, skill.rootKind, skill.filePath);
      byPath.set(skill.filePath, {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        provider: mapped.provider,
        scope: mapped.scope,
        pluginId:
          skill.rootKind === "plugin"
            ? (skill.name.split(":", 1)[0] ?? skill.name)
            : null,
        filePath: skill.filePath,
        manageable: mapped.manageable && !skill.linked,
        registrySkillId: null,
      });
    }
  }
  return [...byPath.values()].sort(compareSkillSummaries);
}

function skillId(identitySeed: string, logicalPath: string): string {
  return `skill_${createHash("sha256")
    .update(`${identitySeed}\0${logicalPath}`)
    .digest("hex")}`;
}

function listServerOwnedSkills(deps: AppDeps): SkillSummary[] {
  return resolveServerOwnedSkillCatalogEntries({
    builtinSkillsRootPath: deps.config.builtinSkillsRootPath,
    dataDir: deps.config.dataDir,
    logger: deps.logger,
    skillTreeRegistry: deps.skillTreeRegistry,
  })
    .map(({ provenance, runtimeSource }): SkillSummary | null => {
      if (runtimeSource.kind !== "tree") return null;
      const builtin = provenance.kind === "builtin";
      const rootPath = path.join(
        builtin
          ? deps.config.builtinSkillsRootPath
          : resolveDataDirSkillsRootPath(deps.config.dataDir),
        runtimeSource.name,
      );
      const logicalPath = `${runtimeSource.name}/${runtimeSource.entryPath}`;
      return {
        id: skillId(builtin ? "bb-builtin" : "bb-data-dir", logicalPath),
        name: runtimeSource.name,
        description: runtimeSource.description,
        provider: null,
        scope: builtin ? "bb-builtin" : "bb-user",
        pluginId: null,
        filePath: path.join(rootPath, runtimeSource.entryPath),
        manageable: !builtin,
        registrySkillId: builtin ? null : readRegistrySkillProvenance(rootPath),
      };
    })
    .filter((skill): skill is SkillSummary => skill !== null)
    .sort(compareSkillSummaries);
}

function listBbPluginSkills(deps: AppDeps): SkillSummary[] {
  return resolveSkillCatalog(deps)
    .map(({ provenance, runtimeSource }): SkillSummary | null => {
      if (provenance.kind !== "plugin" || runtimeSource.kind !== "tree") {
        return null;
      }
      const rootPath = deps.skillTreeRegistry.resolve(runtimeSource.treeHash);
      if (rootPath === undefined) return null;
      const logicalPath = `${runtimeSource.name}/${runtimeSource.entryPath}`;
      return {
        id: skillId(`bb-plugin:${provenance.pluginId}`, logicalPath),
        name: runtimeSource.name,
        description: runtimeSource.description,
        provider: null,
        scope: "plugin",
        pluginId: provenance.pluginId,
        filePath: path.join(rootPath, runtimeSource.entryPath),
        manageable: false,
        registrySkillId: null,
      };
    })
    .filter((skill): skill is SkillSummary => skill !== null)
    .sort(compareSkillSummaries);
}

export async function listProjectSkills(
  deps: AppDeps,
  args: { workspace: CommandWorkspace },
): Promise<SkillSummary[]> {
  const skillProviders = deps.providerRegistry
    .list()
    .filter(providerHasNativeRootSurface);
  const [perProvider, sharedSkills] = await Promise.all([
    Promise.all(
      skillProviders.map(
        async (registration): Promise<ProviderSkillDiscovery> => {
          const result = await scanProviderNativeRoots(deps, {
            type: "host.list_skills",
            registration,
            hostId: args.workspace.hostId,
            cwd: args.workspace.cwd,
          });
          return { provider: registration.info.id, skills: result.skills };
        },
      ),
    ),
    resolveSharedSkills(deps, {
      hostId: args.workspace.hostId,
      cwd: args.workspace.cwd,
    }),
  ]);
  return [
    ...assembleSkillList(perProvider),
    ...sharedSkills.summaries,
    ...listServerOwnedSkills(deps),
    ...listBbPluginSkills(deps),
  ].sort(compareSkillSummaries);
}

function isServerOwnedSkill(deps: AppDeps, skill: SkillSummary): boolean {
  const skillDirectoryPath = path.dirname(skill.filePath);
  if (
    skill.scope === "plugin" &&
    skill.provider === null &&
    skill.pluginId !== null
  ) {
    return true;
  }
  if (skill.scope === "bb-user") {
    return (
      path.dirname(skillDirectoryPath) ===
      resolveDataDirSkillsRootPath(deps.config.dataDir)
    );
  }
  return (
    skill.scope === "bb-builtin" &&
    path.dirname(skillDirectoryPath) === deps.config.builtinSkillsRootPath
  );
}

function validateServerSkillRelativePath(relativePath: string): string[] {
  if (
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath)
  ) {
    throw new ApiError(400, "invalid_path", "Path must be relative");
  }
  const segments = relativePath.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.startsWith("."),
    )
  ) {
    throw new ApiError(404, "not_found", "Skill file not found");
  }
  return segments;
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

async function resolveServerSkillFile(
  skill: SkillSummary,
  relativePath: string,
): Promise<string> {
  const segments = validateServerSkillRelativePath(relativePath);
  const rootPath = path.dirname(skill.filePath);
  const candidatePath = path.join(rootPath, ...segments);
  const [realRootPath, realCandidatePath, candidateStat] = await Promise.all([
    fs.realpath(rootPath).catch(() => null),
    fs.realpath(candidatePath).catch(() => null),
    fs.lstat(candidatePath).catch(() => null),
  ]);
  if (
    realRootPath === null ||
    realCandidatePath === null ||
    candidateStat === null ||
    !candidateStat.isFile() ||
    candidateStat.isSymbolicLink() ||
    !isPathWithinRoot(realCandidatePath, realRootPath)
  ) {
    throw new ApiError(404, "not_found", "Skill file not found");
  }
  return realCandidatePath;
}

async function listServerSkillFiles(
  skill: SkillSummary,
): Promise<{ files: string[]; truncated: boolean }> {
  const rootPath = path.dirname(skill.filePath);
  const files: string[] = [];
  let truncated = false;
  async function walk(currentPath: string): Promise<void> {
    const entries = await fs
      .readdir(currentPath, { withFileTypes: true })
      .catch(() => null);
    if (entries === null) return;
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= SERVER_SKILL_FILE_LIMIT) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        if (truncated) return;
      } else if (entry.isFile()) {
        files.push(
          path.relative(rootPath, entryPath).split(path.sep).join("/"),
        );
      }
    }
  }
  await walk(rootPath);
  files.sort((left, right) => {
    if (left === SKILL_FILE_NAME) return -1;
    if (right === SKILL_FILE_NAME) return 1;
    return left.localeCompare(right);
  });
  return { files, truncated };
}

async function resolveProjectSkill(
  deps: AppDeps,
  args: {
    skillId: string;
    workspace: CommandWorkspace;
  },
): Promise<SkillSummary> {
  const skills = await listProjectSkills(deps, { workspace: args.workspace });
  const match = skills.find((skill) => skill.id === args.skillId);
  if (!match) {
    throw new ApiError(404, "not_found", "Skill not found");
  }
  return match;
}

export async function listProjectSkillFiles(
  deps: AppDeps,
  args: {
    skillId: string;
    workspace: CommandWorkspace;
  },
): Promise<{ files: string[]; truncated: boolean }> {
  const skill = await resolveProjectSkill(deps, args);
  if (isServerOwnedSkill(deps, skill)) {
    return listServerSkillFiles(skill);
  }
  const rootPath = hostPathDirname(skill.filePath);
  const result = await callHostRetryableOnlineRpc(deps, {
    hostId: args.workspace.hostId,
    timeoutMs: COMMAND_TIMEOUT_MS,
    command: { type: "host.list_files", path: rootPath, limit: 200 },
  });
  const files = result.files
    .map((file) => file.path)
    .sort((left, right) => {
      if (left === "SKILL.md") return -1;
      if (right === "SKILL.md") return 1;
      return left.localeCompare(right);
    });
  return { files, truncated: result.truncated };
}

export async function readProjectSkill(
  deps: AppDeps,
  args: {
    skillId: string;
    path: string;
    workspace: CommandWorkspace;
  },
): Promise<{ content: string; revision: string }> {
  const skill = await resolveProjectSkill(deps, args);
  if (isServerOwnedSkill(deps, skill)) {
    const filePath = await resolveServerSkillFile(skill, args.path);
    const stat = await fs.stat(filePath);
    if (stat.size > SERVER_SKILL_CONTENT_LIMIT_BYTES) {
      throw new ApiError(413, "file_too_large", "Skill file is too large");
    }
    const contents = await fs.readFile(filePath);
    return {
      content: contents.toString("utf8"),
      revision: createHash("sha256").update(contents).digest("hex"),
    };
  }
  const rootPath = hostPathDirname(skill.filePath);
  const result = await callHostRetryableOnlineRpc(deps, {
    hostId: args.workspace.hostId,
    timeoutMs: COMMAND_TIMEOUT_MS,
    command: {
      type: "host.read_file_relative",
      rootPath,
      path: args.path,
      dotfiles: "deny",
    },
  });
  return {
    content:
      result.contentEncoding === "utf8"
        ? result.content
        : Buffer.from(result.content, "base64").toString("utf8"),
    revision: result.sha256,
  };
}

export async function writeProjectSkill(
  deps: AppDeps,
  args: {
    skillId: string;
    content: string;
    revision: string;
    workspace: CommandWorkspace;
  },
): Promise<{ filePath: string; revision: string }> {
  const skill = await resolveProjectSkill(deps, args);
  const editableScope = editableSkillScopeSchema.safeParse(skill.scope);
  if (!skill.manageable || !editableScope.success) {
    throw new ApiError(
      403,
      "forbidden",
      "Bundled skills cannot be edited in bb",
    );
  }
  if (editableScope.data === "bb-project" && args.workspace.cwd === null) {
    throw new ApiError(
      409,
      "invalid_request",
      "No workspace resolved for this project's skills",
    );
  }
  if (editableScope.data === "bb-user" && isServerOwnedSkill(deps, skill)) {
    const skillFilePath = await resolveServerSkillFile(skill, SKILL_FILE_NAME);
    const currentContents = await fs.readFile(skillFilePath);
    const currentRevision = createHash("sha256")
      .update(currentContents)
      .digest("hex");
    if (currentRevision !== args.revision) {
      throw new ApiError(409, "conflict", "Skill changed before it was saved");
    }
    const currentMode = (await fs.stat(skillFilePath)).mode & 0o777;
    const temporaryPath = `${skillFilePath}.bb-write-${randomUUID()}`;
    try {
      const handle = await fs.open(temporaryPath, "wx", currentMode);
      try {
        await handle.writeFile(args.content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      const latestContents = await fs.readFile(skillFilePath);
      const latestRevision = createHash("sha256")
        .update(latestContents)
        .digest("hex");
      if (latestRevision !== args.revision) {
        throw new ApiError(
          409,
          "conflict",
          "Skill changed before it was saved",
        );
      }
      await fs.rename(temporaryPath, skillFilePath);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
    const revision = createHash("sha256").update(args.content).digest("hex");
    return { filePath: skillFilePath, revision };
  }
  if (editableScope.data !== "bb-user" && editableScope.data !== "bb-project") {
    const result = await callHostOnlineRpc(deps, {
      hostId: args.workspace.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.write_file",
        path: skill.filePath,
        rootPath: hostPathDirname(skill.filePath),
        content: args.content,
        contentEncoding: "utf8",
        createParents: false,
        expectedSha256: args.revision,
      },
    });
    if (result.outcome !== "written") {
      throw new ApiError(409, "conflict", "Skill changed before it was saved");
    }
    return { filePath: skill.filePath, revision: result.sha256 };
  }
  const result = await callHostOnlineRpc(deps, {
    hostId: args.workspace.hostId,
    timeoutMs: COMMAND_TIMEOUT_MS,
    command: {
      type: "host.write_skill",
      scope: editableScope.data,
      name: skill.name,
      cwd: args.workspace.cwd,
      content: args.content,
      expectedSha256: args.revision,
    },
  });
  if (result.outcome === "conflict") {
    throw new ApiError(409, "conflict", "Skill changed before it was saved");
  }
  return { filePath: result.filePath, revision: result.sha256 };
}

export async function deleteProjectSkill(
  deps: AppDeps,
  args: {
    skillId: string;
    workspace: CommandWorkspace;
  },
): Promise<string> {
  const skill = await resolveProjectSkill(deps, args);
  const editableScope = editableSkillScopeSchema.safeParse(skill.scope);
  if (!skill.manageable || !editableScope.success) {
    throw new ApiError(
      403,
      "forbidden",
      "Bundled skills cannot be deleted in bb",
    );
  }
  if (editableScope.data === "bb-project" && args.workspace.cwd === null) {
    throw new ApiError(
      409,
      "invalid_request",
      "No workspace resolved for this project's skills",
    );
  }
  if (editableScope.data === "bb-user" && isServerOwnedSkill(deps, skill)) {
    const skillsRootPath = resolveDataDirSkillsRootPath(deps.config.dataDir);
    const skillDirectoryPath = path.dirname(skill.filePath);
    const [realRootPath, realSkillPath] = await Promise.all([
      fs.realpath(skillsRootPath).catch(() => null),
      fs.realpath(skillDirectoryPath).catch(() => null),
    ]);
    if (
      realRootPath === null ||
      realSkillPath === null ||
      realSkillPath !==
        path.join(realRootPath, path.basename(skillDirectoryPath))
    ) {
      throw new ApiError(404, "not_found", "Skill not found");
    }
    const skillFileStat = await fs
      .lstat(path.join(realSkillPath, SKILL_FILE_NAME))
      .catch(() => null);
    if (
      skillFileStat === null ||
      !skillFileStat.isFile() ||
      skillFileStat.isSymbolicLink()
    ) {
      throw new ApiError(404, "not_found", "Skill not found");
    }
    await fs.rm(realSkillPath, { recursive: true, force: false });
    return realSkillPath;
  }
  let daemonName = skill.name;
  let rootPath: string | null = null;
  if (editableScope.data !== "bb-user" && editableScope.data !== "bb-project") {
    const skillDirPath = hostPathDirname(skill.filePath);
    daemonName = hostPathBasename(skillDirPath);
    rootPath = hostPathDirname(skillDirPath);
  }
  const result = await callHostOnlineRpc(deps, {
    hostId: args.workspace.hostId,
    timeoutMs: COMMAND_TIMEOUT_MS,
    command: {
      type: "host.delete_skill",
      scope: editableScope.data,
      name: daemonName,
      cwd: args.workspace.cwd,
      rootPath,
    },
  });
  return result.deletedPath;
}
