import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveDataDirSkillsRootPath } from "@bb/config/skill-storage-paths";
import type {
  HostDaemonOnlineRpcResult,
  SkillRootKind,
} from "@bb/host-daemon-contract";
import {
  CommandDispatchError,
  type CommandOf,
  ExpectedCommandDispatchError,
} from "../command-dispatch-support.js";
import {
  type CommandScanRoot,
  discoverSkills,
  type SkillScanRoot,
} from "../command-discovery.js";
import {
  type DeclaredScanRootResolution,
  resolveDeclaredScanRoots,
} from "./list-commands.js";
import { writeHostFile } from "./file-write.js";

const SKILL_FILE_NAME = "SKILL.md";

type SkillRootResolution = DeclaredScanRootResolution;

function createBbSkillScanRoot(
  rootPath: string,
  rootKind: Extract<SkillRootKind, `bb-${string}`>,
): SkillScanRoot {
  return {
    rootPath,
    shape: "skill",
    namePrefix: "",
    source: "skill",
    origin: rootKind === "bb-project" ? "project" : "user",
    identitySeed: rootKind,
    rootKind,
  };
}

function resolveBbSkillScanRoots(
  resolution: SkillRootResolution,
): SkillScanRoot[] {
  const roots: SkillScanRoot[] = [];
  if (resolution.cwd !== null) {
    roots.push(
      createBbSkillScanRoot(
        path.join(resolution.cwd, ".bb", "skills"),
        "bb-project",
      ),
    );
  }
  return roots;
}

function classifySkillRoot(
  root: CommandScanRoot,
  resolution: SkillRootResolution,
): Pick<SkillScanRoot, "identitySeed" | "rootKind"> | null {
  if (root.source !== "skill") {
    return null;
  }
  if (root.namePrefix !== "") {
    const rootPath = "rootPath" in root ? root.rootPath : root.filePath;
    return {
      identitySeed: `plugin:${resolution.providerId}:${root.namePrefix}:${rootPath}`,
      rootKind: "plugin",
    };
  }
  if (root.skillIdentitySeed === undefined) {
    return null;
  }
  const shared = resolution.providerId === "bb-shared";
  return {
    identitySeed: root.skillIdentitySeed,
    rootKind: shared
      ? root.origin === "project"
        ? "shared-project"
        : "shared-user"
      : root.origin === "project"
        ? "provider-project"
        : "provider-user",
  };
}

export async function resolveSkillScanRoots(
  resolution: SkillRootResolution,
): Promise<SkillScanRoot[]> {
  const skillRoots = resolveBbSkillScanRoots(resolution);
  const providerRoots = await resolveDeclaredScanRoots(resolution);
  for (const root of providerRoots) {
    const classification = classifySkillRoot(root, resolution);
    if (classification === null) {
      continue;
    }
    skillRoots.push({ ...root, ...classification });
  }
  return skillRoots;
}

export async function listHostSkills(
  command: CommandOf<"host.list_skills">,
  _options: { dataDir: string },
): Promise<HostDaemonOnlineRpcResult<"host.list_skills">> {
  if (command.cwd !== null && !path.isAbsolute(command.cwd)) {
    throw new CommandDispatchError("invalid_path", "cwd must be absolute");
  }
  const roots = await resolveSkillScanRoots({
    cwd: command.cwd,
    homeDir: os.homedir(),
    providerId: command.providerId,
    nativeRoots: command.nativeRoots,
  });
  const skills = await discoverSkills({ roots });
  return { skills };
}

function isSafeSkillName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    name === path.basename(name) &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

function resolveDeletableSkillRoot(
  args: {
    scope: CommandOf<"host.delete_skill">["scope"];
    cwd: string | null;
    rootPath: string | null;
  },
  dataDir: string,
): string {
  if (args.scope === "bb-user") {
    return resolveDataDirSkillsRootPath(dataDir);
  }
  if (args.scope === "bb-project") {
    const cwd = args.cwd;
    if (cwd === null) {
      throw new CommandDispatchError(
        "invalid_path",
        "cwd is required for a bb-project skill",
      );
    }
    if (!path.isAbsolute(cwd)) {
      throw new CommandDispatchError("invalid_path", "cwd must be absolute");
    }
    return path.join(cwd, ".bb", "skills");
  }
  if (args.rootPath === null || !path.isAbsolute(args.rootPath)) {
    throw new CommandDispatchError(
      "invalid_path",
      "rootPath must be absolute for a provider skill",
    );
  }
  return args.rootPath;
}

async function realpathOrNull(targetPath: string): Promise<string | null> {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return null;
  }
}

export async function deleteHostSkill(
  command: CommandOf<"host.delete_skill">,
  options: { dataDir: string },
): Promise<HostDaemonOnlineRpcResult<"host.delete_skill">> {
  if (!isSafeSkillName(command.name)) {
    throw new CommandDispatchError(
      "invalid_skill_name",
      "Skill name must be a single path segment",
    );
  }
  const root = resolveDeletableSkillRoot(
    {
      scope: command.scope,
      cwd: command.cwd,
      rootPath: command.rootPath,
    },
    options.dataDir,
  );
  const skillDirPath = path.join(root, command.name);

  const realRoot = await realpathOrNull(root);
  const realTarget = await realpathOrNull(skillDirPath);
  if (realRoot === null || realTarget === null) {
    throw new ExpectedCommandDispatchError(
      "skill_not_found",
      `Skill "${command.name}" not found`,
    );
  }
  if (realTarget !== path.join(realRoot, command.name)) {
    throw new CommandDispatchError(
      "skill_outside_root",
      "Refusing to delete a skill that resolves outside its skill root",
    );
  }

  const targetStat = await fs.stat(realTarget).catch(() => null);
  if (targetStat === null || !targetStat.isDirectory()) {
    throw new ExpectedCommandDispatchError(
      "skill_not_found",
      `Skill "${command.name}" not found`,
    );
  }
  const skillFileStat = await fs
    .stat(path.join(realTarget, SKILL_FILE_NAME))
    .catch(() => null);
  if (skillFileStat === null || !skillFileStat.isFile()) {
    throw new CommandDispatchError(
      "not_a_skill",
      `"${command.name}" is not a skill directory`,
    );
  }

  await fs.rm(realTarget, { recursive: true, force: false });
  return { deletedPath: realTarget };
}

export async function writeHostSkill(
  command: CommandOf<"host.write_skill">,
  options: { dataDir: string },
): Promise<HostDaemonOnlineRpcResult<"host.write_skill">> {
  if (!isSafeSkillName(command.name)) {
    throw new CommandDispatchError(
      "invalid_skill_name",
      "Skill name must be a single path segment",
    );
  }
  const root = resolveDeletableSkillRoot(
    { scope: command.scope, cwd: command.cwd, rootPath: null },
    options.dataDir,
  );
  const realRoot = await realpathOrNull(root);
  const realTarget = await realpathOrNull(path.join(root, command.name));
  if (realRoot === null || realTarget === null) {
    throw new ExpectedCommandDispatchError(
      "skill_not_found",
      `Skill "${command.name}" not found`,
    );
  }
  if (realTarget !== path.join(realRoot, command.name)) {
    throw new CommandDispatchError(
      "skill_outside_root",
      "Refusing to edit a skill that resolves outside its bb root",
    );
  }
  const skillFilePath = path.join(realTarget, SKILL_FILE_NAME);
  const skillFileStat = await fs.stat(skillFilePath).catch(() => null);
  if (skillFileStat === null || !skillFileStat.isFile()) {
    throw new ExpectedCommandDispatchError(
      "skill_not_found",
      `Skill "${command.name}" not found`,
    );
  }
  const result = await writeHostFile({
    type: "host.write_file",
    path: skillFilePath,
    rootPath: realTarget,
    content: command.content,
    contentEncoding: "utf8",
    createParents: false,
    expectedSha256: command.expectedSha256,
  });
  if (result.outcome === "conflict") {
    return result;
  }
  return {
    outcome: "written",
    filePath: skillFilePath,
    sha256: result.sha256,
  };
}
