import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveDataDirSkillsRootPath } from "@bb/config/skill-storage-paths";
import matter from "gray-matter";
import { ApiError } from "../../errors.js";
import {
  REGISTRY_SKILL_PROVENANCE_FILE_NAME,
  writeRegistrySkillProvenance,
} from "./registry-skill-provenance.js";

const SKILL_FILE_NAME = "SKILL.md";
const SKILLS_INSTALL_TIMEOUT_MS = 120_000;
const MAX_INSTALL_OUTPUT_BYTES = 1_000_000;
const MAX_SKILL_FILES = 1_000;
const MAX_SKILL_DIRECTORIES = 1_000;
const MAX_SKILL_BYTES = 10 * 1024 * 1024;
const MAX_SKILL_DEPTH = 24;
const REGISTRY_SKILLS_CLI_VERSION = "1.5.19";
const REGISTRY_SKILL_NAME_PATTERN =
  /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

interface InstallCommandResult {
  ok: boolean;
  stderr: string;
  stdout: string;
}

function appendBounded(current: string, chunk: unknown): string {
  if (current.length >= MAX_INSTALL_OUTPUT_BYTES) return current;
  return `${current}${String(chunk)}`.slice(0, MAX_INSTALL_OUTPUT_BYTES);
}

function registrySkillsCliInvocation(args: {
  cwd: string;
  packageRef: string;
  skillId: string;
}): {
  args: string[];
  command: string;
  options: { cwd: string; env: NodeJS.ProcessEnv };
} {
  const allowedKeys =
    process.platform === "win32"
      ? [
          "PATH",
          "Path",
          "PATHEXT",
          "SYSTEMROOT",
          "SystemRoot",
          "COMSPEC",
          "ComSpec",
          "TEMP",
          "TMP",
          "USERPROFILE",
          "APPDATA",
          "LOCALAPPDATA",
        ]
      : ["PATH", "HOME", "TMPDIR"];
  const env: NodeJS.ProcessEnv = { DISABLE_TELEMETRY: "1" };
  for (const key of allowedKeys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: [
      "-y",
      `skills@${REGISTRY_SKILLS_CLI_VERSION}`,
      "add",
      args.packageRef,
      "--agent",
      "universal",
      "--skill",
      args.skillId,
      "--copy",
      "--yes",
    ],
    options: { cwd: args.cwd, env },
  };
}

async function runRegistrySkillsCli(args: {
  cwd: string;
  packageRef: string;
  skillId: string;
}): Promise<InstallCommandResult> {
  const invocation = registrySkillsCliInvocation({
    cwd: args.cwd,
    packageRef: args.packageRef,
    skillId: args.skillId,
  });
  return new Promise((resolve) => {
    const child = spawn(
      invocation.command,
      invocation.args,
      invocation.options,
    );
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: InstallCommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, SKILLS_INSTALL_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ ok: false, stdout, stderr: stderr || error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({
        ok: !timedOut && code === 0,
        stdout,
        stderr: timedOut ? "Skill install timed out" : stderr,
      });
    });
  });
}

async function validateSkillFile(
  skillFilePath: string,
  skillId: string,
): Promise<void> {
  const content = await fs.readFile(skillFilePath, "utf8").catch(() => null);
  if (content === null) {
    throw new ApiError(
      422,
      "registry_skill_invalid",
      "Skill is missing SKILL.md",
    );
  }
  let data: Record<string, unknown>;
  try {
    data = matter(content).data;
  } catch {
    throw new ApiError(
      422,
      "registry_skill_invalid",
      "Skill has invalid frontmatter",
    );
  }
  if (
    data.name !== skillId ||
    typeof data.description !== "string" ||
    data.description.trim().length === 0 ||
    data.description.length > 1_024
  ) {
    throw new ApiError(
      422,
      "registry_skill_invalid",
      "Skill metadata does not match the registry entry",
    );
  }
}

async function copyBoundedSkillTree(args: {
  destinationPath: string;
  sourcePath: string;
}): Promise<void> {
  const entries = await collectBoundedSkillTree(args.sourcePath);
  await fs.mkdir(args.destinationPath, { recursive: true });
  for (const entry of entries) {
    const destinationPath = path.join(args.destinationPath, entry.path);
    if (entry.kind === "directory") {
      await fs.mkdir(destinationPath);
      continue;
    }
    await fs.copyFile(path.join(args.sourcePath, entry.path), destinationPath);
    await fs.chmod(destinationPath, entry.mode);
  }
}

type SkillTreeEntry =
  | { kind: "directory"; path: string }
  | { kind: "file"; mode: number; path: string; size: number };

async function collectBoundedSkillTree(
  rootPath: string,
): Promise<SkillTreeEntry[]> {
  const rootStat = await fs.lstat(rootPath);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Skill root is not a directory");
  }
  const entries: SkillTreeEntry[] = [];
  let fileCount = 0;
  let directoryCount = 0;
  let totalBytes = 0;

  async function walk(currentPath: string, depth: number): Promise<void> {
    if (depth > MAX_SKILL_DEPTH) {
      throw new Error(`Skill tree exceeds max depth ${MAX_SKILL_DEPTH}`);
    }
    const children = await fs.readdir(currentPath, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const childPath = path.join(currentPath, child.name);
      const relativePath = path.relative(rootPath, childPath);
      const stat = await fs.lstat(childPath);
      if (stat.isSymbolicLink()) {
        throw new Error("Skill tree contains a symlink");
      }
      if (stat.isDirectory()) {
        directoryCount += 1;
        if (directoryCount > MAX_SKILL_DIRECTORIES) {
          throw new Error("Skill tree exceeds installation limits");
        }
        entries.push({ kind: "directory", path: relativePath });
        await walk(childPath, depth + 1);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error("Skill tree contains a special file");
      }
      fileCount += 1;
      totalBytes += stat.size;
      if (fileCount > MAX_SKILL_FILES || totalBytes > MAX_SKILL_BYTES) {
        throw new Error("Skill tree exceeds installation limits");
      }
      entries.push({
        kind: "file",
        mode: stat.mode & 0o777,
        path: relativePath,
        size: stat.size,
      });
    }
  }

  await walk(rootPath, 0);
  return entries;
}

async function boundedSkillTreesMatch(
  leftRootPath: string,
  rightRootPath: string,
): Promise<boolean> {
  try {
    const [leftEntries, rightEntries] = await Promise.all([
      collectBoundedSkillTree(leftRootPath),
      collectBoundedSkillTree(rightRootPath),
    ]);
    if (leftEntries.length !== rightEntries.length) return false;
    for (const [index, left] of leftEntries.entries()) {
      const right = rightEntries[index];
      if (
        right === undefined ||
        left.kind !== right.kind ||
        left.path !== right.path
      ) {
        return false;
      }
      if (left.kind === "directory" || right.kind === "directory") continue;
      if (
        left.size !== right.size ||
        (process.platform !== "win32" && left.mode !== right.mode)
      ) {
        return false;
      }
      const [leftBytes, rightBytes] = await Promise.all([
        fs.readFile(path.join(leftRootPath, left.path)),
        fs.readFile(path.join(rightRootPath, right.path)),
      ]);
      if (!leftBytes.equals(rightBytes)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function installConflict(skillId: string): ApiError {
  return new ApiError(
    409,
    "skill_install_conflict",
    `Skill "${skillId}" already exists with different or unsafe contents; bb left it unchanged`,
  );
}

export async function installServerRegistrySkill(args: {
  dataDir: string;
  packageRef: string;
  registrySkillId: string;
  skillId: string;
}): Promise<{ filePath: string }> {
  if (!REGISTRY_SKILL_NAME_PATTERN.test(args.skillId)) {
    throw new ApiError(
      400,
      "invalid_registry_skill",
      "Registry skill id is invalid",
    );
  }
  const extractionRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "bb-registry-skill-"),
  );
  const skillsRootPath = resolveDataDirSkillsRootPath(args.dataDir);
  await fs.mkdir(skillsRootPath, { recursive: true });
  const finalSkillPath = path.join(skillsRootPath, args.skillId);
  const temporarySkillPath = path.join(
    skillsRootPath,
    `.tmp-import-${args.skillId}-${randomUUID()}`,
  );
  try {
    const existingTarget = await fs.lstat(finalSkillPath).catch(() => null);
    const existingProvenanceFile =
      existingTarget === null
        ? null
        : await fs
            .lstat(
              path.join(finalSkillPath, REGISTRY_SKILL_PROVENANCE_FILE_NAME),
            )
            .catch(() => null);
    if (
      existingTarget !== null &&
      (!existingTarget.isDirectory() ||
        existingTarget.isSymbolicLink() ||
        existingProvenanceFile !== null)
    ) {
      throw new ApiError(
        409,
        "skill_already_installed",
        `Skill "${args.skillId}" is already installed in bb`,
      );
    }
    const result = await runRegistrySkillsCli({
      cwd: extractionRoot,
      packageRef: args.packageRef,
      skillId: args.skillId,
    });
    if (!result.ok) {
      const detail = result.stderr.trim() || result.stdout.trim();
      throw new ApiError(
        502,
        "registry_install_failed",
        detail || "Unable to download the skill package",
      );
    }
    const extractedSkillPath = path.join(
      extractionRoot,
      ".agents",
      "skills",
      args.skillId,
    );
    await validateSkillFile(
      path.join(extractedSkillPath, SKILL_FILE_NAME),
      args.skillId,
    );
    try {
      await copyBoundedSkillTree({
        sourcePath: extractedSkillPath,
        destinationPath: temporarySkillPath,
      });
    } catch (error) {
      throw new ApiError(
        422,
        "registry_skill_invalid",
        error instanceof Error ? error.message : "Downloaded skill is invalid",
      );
    }
    if (existingTarget !== null) {
      if (!(await boundedSkillTreesMatch(temporarySkillPath, finalSkillPath))) {
        throw installConflict(args.skillId);
      }
      try {
        await writeRegistrySkillProvenance({
          registrySkillId: args.registrySkillId,
          skillDirectoryPath: finalSkillPath,
        });
      } catch {
        throw installConflict(args.skillId);
      }
      return { filePath: path.join(finalSkillPath, SKILL_FILE_NAME) };
    }
    try {
      await writeRegistrySkillProvenance({
        registrySkillId: args.registrySkillId,
        skillDirectoryPath: temporarySkillPath,
      });
    } catch (error) {
      throw new ApiError(
        422,
        "registry_skill_invalid",
        error instanceof Error ? error.message : "Downloaded skill is invalid",
      );
    }
    try {
      await fs.rename(temporarySkillPath, finalSkillPath);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "EEXIST" || error.code === "ENOTEMPTY")
      ) {
        throw new ApiError(
          409,
          "skill_already_installed",
          `Skill "${args.skillId}" is already installed in bb`,
        );
      }
      throw error;
    }
    return { filePath: path.join(finalSkillPath, SKILL_FILE_NAME) };
  } finally {
    await Promise.all([
      fs.rm(extractionRoot, { recursive: true, force: true }),
      fs.rm(temporarySkillPath, { recursive: true, force: true }),
    ]);
  }
}
