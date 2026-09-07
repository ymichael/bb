import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HostDaemonOnlineRpcResult } from "@bb/host-daemon-contract";
import {
  CommandDispatchError,
  type CommandOf,
} from "../command-dispatch-support.js";
import {
  copyInjectedSkillSource,
  ensureStoredSkillTree,
  hashInstalledSkillDirectory,
} from "../injected-skills.js";
import type { FetchSkillTree } from "../skill-trees.js";

const GLOBAL_SKILL_ROOT_SEGMENTS: readonly (readonly string[])[] = [
  [".agents", "skills"],
  [".claude", "skills"],
];

interface InstallGlobalSkillsOptions {
  dataDir: string;
  fetchSkillTree?: FetchSkillTree;
  homeDir?: string;
}

interface GlobalSkillsStatusOptions {
  homeDir?: string;
}

function globalSkillPaths(homeDir: string, name: string): string[] {
  return GLOBAL_SKILL_ROOT_SEGMENTS.map((segments) =>
    path.join(homeDir, ...segments, name),
  );
}

export async function readGlobalSkillsStatus(
  command: CommandOf<"host.global_skills_status">,
  options: GlobalSkillsStatusOptions,
): Promise<HostDaemonOnlineRpcResult<"host.global_skills_status">> {
  const homeDir = options.homeDir ?? os.homedir();
  const entries = await Promise.all(
    command.names.flatMap((name) =>
      globalSkillPaths(homeDir, name).map(async (skillDirectoryPath) => ({
        name,
        path: skillDirectoryPath,
        treeHash: await hashInstalledSkillDirectory({
          name,
          skillDirectoryPath,
        }),
      })),
    ),
  );
  return { entries };
}

async function replaceSkillDirectory(args: {
  destinationPath: string;
  name: string;
  skillFilePath: string;
  sourceRootPath: string;
}): Promise<void> {
  const parentPath = path.dirname(args.destinationPath);
  await fs.mkdir(parentPath, { recursive: true });
  const stagingPath = path.join(
    parentPath,
    `.bb-tmp-${args.name}-${process.pid}-${randomUUID()}`,
  );
  try {
    await copyInjectedSkillSource({
      destinationPath: stagingPath,
      name: args.name,
      skillFilePath: args.skillFilePath,
      sourceRootPath: args.sourceRootPath,
    });
    await fs.rm(args.destinationPath, { force: true, recursive: true });
    await fs.rename(stagingPath, args.destinationPath);
  } finally {
    await fs.rm(stagingPath, { force: true, recursive: true });
  }
}

export async function installGlobalSkills(
  command: CommandOf<"host.install_global_skills">,
  options: InstallGlobalSkillsOptions,
): Promise<HostDaemonOnlineRpcResult<"host.install_global_skills">> {
  const { fetchSkillTree } = options;
  if (fetchSkillTree === undefined) {
    throw new CommandDispatchError(
      "skill_tree_transport_unavailable",
      "Skill tree fetch transport is unavailable",
    );
  }
  const homeDir = options.homeDir ?? os.homedir();
  const installations: { name: string; path: string }[] = [];

  for (const skill of command.skills) {
    const sourceRootPath = await ensureStoredSkillTree({
      dataDir: options.dataDir,
      fetchSkillTree,
      treeHash: skill.treeHash,
    });
    const skillFilePath = path.resolve(sourceRootPath, skill.entryPath);
    if (
      path.relative(sourceRootPath, skillFilePath).startsWith("..") ||
      path.isAbsolute(path.relative(sourceRootPath, skillFilePath))
    ) {
      throw new CommandDispatchError(
        "invalid_path",
        `Skill entry path escapes its tree: ${skill.entryPath}`,
      );
    }
    for (const destinationPath of globalSkillPaths(homeDir, skill.name)) {
      await replaceSkillDirectory({
        destinationPath,
        name: skill.name,
        skillFilePath,
        sourceRootPath,
      });
      installations.push({ name: skill.name, path: destinationPath });
    }
  }

  return { installations };
}
