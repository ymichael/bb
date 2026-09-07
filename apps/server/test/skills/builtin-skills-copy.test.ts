import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILTIN_SKILLS_DIRECTORY_NAME,
  copyBuiltinSkills,
  resolveBuiltinSkillsRootPath,
  resolveBuiltinSkillsRootPathForModuleDir,
} from "../../src/services/skills/builtin-skills-copy.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "bb-builtin-skills-copy-"));
  tempDirs.push(dir);
  return dir;
}

async function readBuiltinSkill(skillName: string): Promise<string> {
  return readFile(
    path.join(resolveBuiltinSkillsRootPath(), skillName, "SKILL.md"),
    "utf8",
  );
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("builtin skills copy", () => {
  it("copies the bundled skills so the dist layout resolves beside the module", async () => {
    const moduleDir = await makeTempDir();
    const targetPath = path.join(moduleDir, BUILTIN_SKILLS_DIRECTORY_NAME);

    await copyBuiltinSkills({
      skillsRootPath: resolveBuiltinSkillsRootPath(),
      targetPath,
    });

    expect(resolveBuiltinSkillsRootPathForModuleDir({ moduleDir })).toBe(
      targetPath,
    );
    await expect(
      readFile(path.join(targetPath, "bb-cli", "SKILL.md"), "utf8"),
    ).resolves.toBe(await readBuiltinSkill("bb-cli"));
  });

  it("throws when the sentinel skill is missing beside the module", async () => {
    const moduleDir = await makeTempDir();

    expect(() =>
      resolveBuiltinSkillsRootPathForModuleDir({ moduleDir }),
    ).toThrow("Missing built-in skills at");
  });
});
