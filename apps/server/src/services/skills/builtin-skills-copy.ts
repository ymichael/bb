import { cp } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface CopyBuiltinSkillsArgs {
  skillsRootPath: string;
  targetPath: string;
}

interface ResolveBuiltinSkillsRootPathArgs {
  moduleDir: string;
}

export const BUILTIN_SKILLS_DIRECTORY_NAME = "builtin-skills";
const BUILTIN_SKILLS_SENTINEL_PATH = path.join("bb-cli", "SKILL.md");
const BUILTIN_SKILLS_COPY_MODE = fsConstants.COPYFILE_FICLONE;
const builtinSkillsModuleDir = path.dirname(fileURLToPath(import.meta.url));

function hasBuiltinSkillsRoot(skillsRootPath: string): boolean {
  return existsSync(path.join(skillsRootPath, BUILTIN_SKILLS_SENTINEL_PATH));
}

export function resolveBuiltinSkillsRootPathForModuleDir(
  args: ResolveBuiltinSkillsRootPathArgs,
): string {
  const skillsRootPath = path.resolve(
    args.moduleDir,
    BUILTIN_SKILLS_DIRECTORY_NAME,
  );
  if (!hasBuiltinSkillsRoot(skillsRootPath)) {
    throw new Error(`Missing built-in skills at ${skillsRootPath}`);
  }
  return skillsRootPath;
}

export function resolveBuiltinSkillsRootPath(): string {
  return resolveBuiltinSkillsRootPathForModuleDir({
    moduleDir: builtinSkillsModuleDir,
  });
}

export async function copyBuiltinSkills(
  args: CopyBuiltinSkillsArgs,
): Promise<void> {
  await cp(args.skillsRootPath, args.targetPath, {
    force: false,
    mode: BUILTIN_SKILLS_COPY_MODE,
    recursive: true,
  });
}
