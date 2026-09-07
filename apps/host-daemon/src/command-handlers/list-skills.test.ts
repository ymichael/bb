import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ProviderNativeRoot,
  ProviderNativeRootSet,
  ProviderNativeRoots,
} from "@bb/domain";
import type { DiscoveredSkill } from "@bb/host-daemon-contract";
import { discoverSkills, type SkillScanRoot } from "../command-discovery.js";
import { CommandDispatchError } from "../command-dispatch-support.js";
import {
  deleteHostSkill,
  resolveSkillScanRoots,
  writeHostSkill,
} from "./list-skills.js";

interface WorkspaceFixture {
  cwd: string;
  dataDir: string;
  homeDir: string;
}

let tempRoot: string;

async function writeSkill(filePath: string, name: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `---\nname: ${name}\ndescription: ${name} skill\n---\n`,
    "utf8",
  );
}

async function makeWorkspaceFixture(): Promise<WorkspaceFixture> {
  const cwd = path.join(tempRoot, "workspace");
  const dataDir = path.join(tempRoot, "bb-data");
  const homeDir = path.join(tempRoot, "home");
  await mkdir(cwd, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  return { cwd, dataDir, homeDir };
}

function declared(
  rootPath: string,
  options: Partial<Omit<ProviderNativeRoot, "path">> = {},
): ProviderNativeRoot {
  return {
    path: rootPath,
    recursive: false,
    ancestors: false,
    namePrefix: "",
    ...options,
  };
}

function skillRoots(
  skills: Partial<ProviderNativeRoots>,
): ProviderNativeRootSet {
  return {
    skills: { user: [], project: [], ...skills },
    commands: { user: [], project: [] },
    resolved: { skills: [], commands: [] },
  };
}

const AGENT_SKILL_ROOTS = skillRoots({
  project: [declared(".agent/skills")],
  user: [declared(".agent/skills")],
});

async function listSkills(
  fixture: WorkspaceFixture,
  cwd: string | null,
  nativeRoots: ProviderNativeRootSet,
  providerId = "test-provider",
): Promise<DiscoveredSkill[]> {
  return discoverSkills({
    roots: await resolveSkillScanRoots({
      providerId,
      cwd,
      homeDir: fixture.homeDir,
      nativeRoots,
    }),
  });
}

function byName(
  skills: DiscoveredSkill[],
  name: string,
): DiscoveredSkill | undefined {
  return skills.find((skill) => skill.name === name);
}

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), "bb-list-skills-"));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("resolveSkillScanRoots + discoverSkills", () => {
  it("classifies the host-owned bb project root and the declared provider roots only", async () => {
    const fixture = await makeWorkspaceFixture();
    const files = {
      "proj-bb": path.join(fixture.cwd, ".bb", "skills", "proj-bb", "SKILL.md"),
      "data-bb": path.join(fixture.dataDir, "skills", "data-bb", "SKILL.md"),
      "proj-agent": path.join(
        fixture.cwd,
        ".agent",
        "skills",
        "proj-agent",
        "SKILL.md",
      ),
      "user-agent": path.join(
        fixture.homeDir,
        ".agent",
        "skills",
        "user-agent",
        "SKILL.md",
      ),
    };
    for (const [name, filePath] of Object.entries(files)) {
      await writeSkill(filePath, name);
    }

    const skills = await listSkills(fixture, fixture.cwd, AGENT_SKILL_ROOTS);

    expect(byName(skills, "proj-bb")).toEqual({
      id: expect.stringMatching(/^skill_[a-f0-9]{64}$/u),
      name: "proj-bb",
      description: "proj-bb skill",
      filePath: files["proj-bb"],
      rootKind: "bb-project",
      linked: false,
    });
    expect(byName(skills, "data-bb")).toBeUndefined();
    expect(byName(skills, "proj-agent")?.rootKind).toBe("provider-project");
    expect(byName(skills, "user-agent")?.rootKind).toBe("provider-user");
    expect(byName(skills, "user-agent")?.filePath).toBe(files["user-agent"]);
  });

  it("keeps native skill IDs stable when the workspace root moves", async () => {
    const firstRoot = path.join(tempRoot, "checkout-a", ".bb", "skills");
    const secondRoot = path.join(tempRoot, "checkout-b", ".bb", "skills");
    await writeSkill(path.join(firstRoot, "review", "SKILL.md"), "review");
    await writeSkill(path.join(secondRoot, "review", "SKILL.md"), "review");

    const [first] = await discoverSkills({
      roots: [
        {
          rootPath: firstRoot,
          shape: "skill",
          namePrefix: "",
          source: "skill",
          origin: "project",
          identitySeed: "bb-project",
          rootKind: "bb-project",
        },
      ],
    });
    const [second] = await discoverSkills({
      roots: [
        {
          rootPath: secondRoot,
          shape: "skill",
          namePrefix: "",
          source: "skill",
          origin: "project",
          identitySeed: "bb-project",
          rootKind: "bb-project",
        },
      ],
    });

    expect(first?.id).toBe(second?.id);
  });

  it("keeps a declared provider skill's ID stable when the workspace root moves", async () => {
    const roots = skillRoots({ project: [declared(".agent/skills")] });
    const ids: string[] = [];
    for (const checkout of ["checkout-a", "checkout-b"]) {
      const cwd = path.join(tempRoot, checkout);
      await writeSkill(
        path.join(cwd, ".agent", "skills", "review", "SKILL.md"),
        "review",
      );
      const skills = await listSkills(
        { cwd, dataDir: "", homeDir: path.join(tempRoot, "home") },
        cwd,
        roots,
      );
      ids.push(byName(skills, "review")?.id ?? "");
    }
    expect(ids[0]).toMatch(/^skill_/u);
    expect(ids[0]).toBe(ids[1]);
  });

  it("drops project roots when cwd is null", async () => {
    const fixture = await makeWorkspaceFixture();
    await writeSkill(
      path.join(fixture.cwd, ".bb", "skills", "proj-bb", "SKILL.md"),
      "proj-bb",
    );
    await writeSkill(
      path.join(fixture.cwd, ".agent", "skills", "proj-agent", "SKILL.md"),
      "proj-agent",
    );
    await writeSkill(
      path.join(fixture.homeDir, ".agent", "skills", "user-agent", "SKILL.md"),
      "user-agent",
    );

    const skills = await listSkills(fixture, null, AGENT_SKILL_ROOTS);

    expect(skills.map((skill) => skill.name)).toEqual(["user-agent"]);
  });

  it("classifies repository and nested ancestor roots as provider project skills with distinct IDs", async () => {
    const fixture = await makeWorkspaceFixture();
    const cwd = path.join(fixture.cwd, "packages", "app");
    await mkdir(path.join(fixture.cwd, ".git"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeSkill(
      path.join(
        fixture.cwd,
        ".agents",
        "skills",
        "repository-skill",
        "SKILL.md",
      ),
      "repository-skill",
    );
    await writeSkill(
      path.join(cwd, ".agents", "skills", "nested-skill", "SKILL.md"),
      "nested-skill",
    );
    await writeSkill(
      path.join(fixture.cwd, ".agents", "skills", "review", "SKILL.md"),
      "review",
    );
    await writeSkill(
      path.join(cwd, ".agents", "skills", "review", "SKILL.md"),
      "review",
    );

    const skills = await listSkills(
      fixture,
      cwd,
      skillRoots({
        project: [declared(".agents/skills", { ancestors: true })],
      }),
    );

    expect(byName(skills, "repository-skill")?.rootKind).toBe(
      "provider-project",
    );
    expect(byName(skills, "nested-skill")?.rootKind).toBe("provider-project");
    const reviews = skills.filter((skill) => skill.name === "review");
    expect(reviews).toHaveLength(2);
    expect(new Set(reviews.map((skill) => skill.id)).size).toBe(2);
  });

  it("marks followed user skill directory and SKILL.md symlinks as linked", async () => {
    const fixture = await makeWorkspaceFixture();
    const skillsRoot = path.join(fixture.homeDir, ".agent", "skills");
    const linkedDirectoryTarget = path.join(tempRoot, "linked-skill-target");
    await writeSkill(
      path.join(linkedDirectoryTarget, "SKILL.md"),
      "linked-directory",
    );
    await mkdir(skillsRoot, { recursive: true });
    await symlink(
      linkedDirectoryTarget,
      path.join(skillsRoot, "linked-directory"),
    );

    const linkedFileTarget = path.join(tempRoot, "linked-skill-file.md");
    await writeSkill(linkedFileTarget, "linked-file");
    const linkedFileRoot = path.join(skillsRoot, "linked-file");
    await mkdir(linkedFileRoot, { recursive: true });
    await symlink(linkedFileTarget, path.join(linkedFileRoot, "SKILL.md"));

    const skills = await listSkills(fixture, fixture.cwd, AGENT_SKILL_ROOTS);

    expect(byName(skills, "linked-directory")?.linked).toBe(true);
    expect(byName(skills, "linked-file")?.linked).toBe(true);
  });

  it("classifies a prefixed declared root as a plugin root", async () => {
    const fixture = await makeWorkspaceFixture();
    await writeSkill(
      path.join(fixture.homeDir, "tools", "skills", "release", "SKILL.md"),
      "release",
    );

    const skills = await listSkills(
      fixture,
      fixture.cwd,
      skillRoots({
        user: [declared("tools/skills", { namePrefix: "release-tools:" })],
      }),
    );

    expect(byName(skills, "release-tools:release")).toMatchObject({
      rootKind: "plugin",
      filePath: path.join(
        fixture.homeDir,
        "tools",
        "skills",
        "release",
        "SKILL.md",
      ),
    });
  });

  it("classifies configured shared user and project roots", async () => {
    const fixture = await makeWorkspaceFixture();
    await writeSkill(
      path.join(
        fixture.homeDir,
        ".agents",
        "skills",
        "user-shared",
        "SKILL.md",
      ),
      "user-shared",
    );
    await writeSkill(
      path.join(fixture.cwd, ".agents", "skills", "project-shared", "SKILL.md"),
      "project-shared",
    );

    const skills = await listSkills(
      fixture,
      fixture.cwd,
      skillRoots({
        user: [declared(".agents/skills")],
        project: [declared(".agents/skills")],
      }),
      "bb-shared",
    );

    expect(byName(skills, "project-shared")?.rootKind).toBe("shared-project");
    expect(byName(skills, "user-shared")?.rootKind).toBe("shared-user");
  });

  it("discovers a project skill through a symlinked shared root", async () => {
    const fixture = await makeWorkspaceFixture();
    await writeSkill(
      path.join(fixture.cwd, ".agents", "skills", "linked-root", "SKILL.md"),
      "linked-root",
    );
    await mkdir(path.join(fixture.cwd, ".shared"), { recursive: true });
    await symlink(
      path.join("..", ".agents", "skills"),
      path.join(fixture.cwd, ".shared", "skills"),
      "dir",
    );

    const skills = await listSkills(
      fixture,
      fixture.cwd,
      skillRoots({ project: [declared(".shared/skills")] }),
      "bb-shared",
    );

    expect(byName(skills, "linked-root")).toMatchObject({
      rootKind: "shared-project",
      linked: true,
    });
  });

  it("classifies a skill through a symlinked recursive .cursor/skills root", async () => {
    const fixture = await makeWorkspaceFixture();
    await writeSkill(
      path.join(fixture.cwd, ".agents", "skills", "impeccable", "SKILL.md"),
      "impeccable",
    );
    await mkdir(path.join(fixture.cwd, ".cursor"), { recursive: true });
    await symlink(
      path.join("..", ".agents", "skills"),
      path.join(fixture.cwd, ".cursor", "skills"),
      "dir",
    );

    const skills = await listSkills(
      fixture,
      fixture.cwd,
      skillRoots({
        project: [declared(".cursor/skills", { recursive: true })],
      }),
    );

    expect(skills.filter((skill) => skill.name === "impeccable")).toHaveLength(
      1,
    );
    expect(byName(skills, "impeccable")).toMatchObject({
      rootKind: "provider-project",
      linked: true,
      filePath: path.join(
        fixture.cwd,
        ".cursor",
        "skills",
        "impeccable",
        "SKILL.md",
      ),
    });
  });
});

describe("discoverSkills marks the linked flag per root shape", () => {
  const USER_SKILL_ROOT = {
    namePrefix: "",
    source: "skill",
    origin: "user",
    identitySeed: "provider-user",
    rootKind: "provider-user",
  } as const;

  async function writeSkillTarget(name: string): Promise<string> {
    const target = path.join(tempRoot, "targets", `${name}.md`);
    await writeSkill(target, name);
    return target;
  }

  async function discoverRoot(
    root: SkillScanRoot,
  ): Promise<[name: string, linked: boolean, filePath: string][]> {
    const skills = await discoverSkills({ roots: [root] });
    return skills.map((skill) => [skill.name, skill.linked, skill.filePath]);
  }

  it("skill-directory: the root directory or its SKILL.md being a symlink", async () => {
    const plainRoot = path.join(tempRoot, "plain-dir");
    await writeSkill(path.join(plainRoot, "SKILL.md"), "plain-dir");
    const linkedRoot = path.join(tempRoot, "linked-dir");
    await symlink(plainRoot, linkedRoot, "dir");
    const fileLinkedRoot = path.join(tempRoot, "file-linked-dir");
    await mkdir(fileLinkedRoot, { recursive: true });
    await symlink(
      await writeSkillTarget("file-linked-dir"),
      path.join(fileLinkedRoot, "SKILL.md"),
    );

    for (const [rootPath, linked] of [
      [plainRoot, false],
      [linkedRoot, true],
      [fileLinkedRoot, true],
    ] as const) {
      expect(
        await discoverRoot({
          ...USER_SKILL_ROOT,
          shape: "skill-directory",
          rootPath,
        }),
      ).toEqual([
        [path.basename(rootPath), linked, path.join(rootPath, "SKILL.md")],
      ]);
    }
  });

  it("skill-file: the SKILL.md itself being a symlink", async () => {
    const plainFile = path.join(tempRoot, "plugin", "SKILL.md");
    await writeSkill(plainFile, "plain-plugin");
    const linkedFile = path.join(tempRoot, "plugin-linked", "SKILL.md");
    await mkdir(path.dirname(linkedFile), { recursive: true });
    await symlink(await writeSkillTarget("linked-plugin"), linkedFile);

    for (const [filePath, name, linked] of [
      [plainFile, "plain-plugin", false],
      [linkedFile, "linked-plugin", true],
    ] as const) {
      expect(
        await discoverRoot({
          ...USER_SKILL_ROOT,
          shape: "skill-file",
          filePath,
          fallbackName: "unused-fallback",
        }),
      ).toEqual([[name, linked, filePath]]);
    }
  });

  it("skill-recursive: only the root being a symlink counts; nested links are not walked", async () => {
    const plainRoot = path.join(tempRoot, "recursive");
    await writeSkill(
      path.join(plainRoot, "category", "nested", "SKILL.md"),
      "nested",
    );
    await writeSkill(
      path.join(tempRoot, "nested-link-target", "SKILL.md"),
      "through-nested-link",
    );
    await symlink(
      path.join(tempRoot, "nested-link-target"),
      path.join(plainRoot, "linked-category"),
      "dir",
    );
    const linkedRoot = path.join(tempRoot, "recursive-linked");
    await symlink(plainRoot, linkedRoot, "dir");

    for (const [rootPath, linked] of [
      [plainRoot, false],
      [linkedRoot, true],
    ] as const) {
      expect(
        await discoverRoot({
          ...USER_SKILL_ROOT,
          shape: "skill-recursive",
          rootPath,
        }),
      ).toEqual([
        [
          "nested",
          linked,
          path.join(rootPath, "category", "nested", "SKILL.md"),
        ],
      ]);
    }
  });

  it("skill: the root, the skill entry, or its SKILL.md being a symlink", async () => {
    const rootPath = path.join(tempRoot, "skills");
    await writeSkill(path.join(rootPath, "plain", "SKILL.md"), "plain");
    await writeSkill(
      path.join(tempRoot, "entry-target", "SKILL.md"),
      "entry-linked",
    );
    await symlink(
      path.join(tempRoot, "entry-target"),
      path.join(rootPath, "entry-linked"),
      "dir",
    );
    await mkdir(path.join(rootPath, "file-linked"), { recursive: true });
    await symlink(
      await writeSkillTarget("file-linked"),
      path.join(rootPath, "file-linked", "SKILL.md"),
    );
    const linkedRoot = path.join(tempRoot, "skills-linked");
    await symlink(rootPath, linkedRoot, "dir");

    expect(
      await discoverRoot({ ...USER_SKILL_ROOT, shape: "skill", rootPath }),
    ).toEqual([
      ["entry-linked", true, path.join(rootPath, "entry-linked", "SKILL.md")],
      ["file-linked", true, path.join(rootPath, "file-linked", "SKILL.md")],
      ["plain", false, path.join(rootPath, "plain", "SKILL.md")],
    ]);
    expect(
      (
        await discoverRoot({
          ...USER_SKILL_ROOT,
          shape: "skill",
          rootPath: linkedRoot,
        })
      ).map(([name, linked]) => [name, linked]),
    ).toEqual([
      ["entry-linked", true],
      ["file-linked", true],
      ["plain", true],
    ]);
  });
});

describe("deleteHostSkill", () => {
  it("deletes a bb-user skill directory", async () => {
    const fixture = await makeWorkspaceFixture();
    const skillDir = path.join(fixture.dataDir, "skills", "doomed");
    await writeSkill(path.join(skillDir, "SKILL.md"), "doomed");

    const result = await deleteHostSkill(
      {
        type: "host.delete_skill",
        scope: "bb-user",
        name: "doomed",
        cwd: null,
        rootPath: null,
      },
      { dataDir: fixture.dataDir },
    );

    expect(await stat(skillDir).catch(() => null)).toBeNull();
    expect(result.deletedPath).toContain("doomed");
  });

  it("deletes a bb-project skill directory under cwd/.bb/skills", async () => {
    const fixture = await makeWorkspaceFixture();
    const skillDir = path.join(fixture.cwd, ".bb", "skills", "proj-doomed");
    await writeSkill(path.join(skillDir, "SKILL.md"), "proj-doomed");

    await deleteHostSkill(
      {
        type: "host.delete_skill",
        scope: "bb-project",
        name: "proj-doomed",
        cwd: fixture.cwd,
        rootPath: null,
      },
      { dataDir: fixture.dataDir },
    );

    expect(await stat(skillDir).catch(() => null)).toBeNull();
  });

  it("deletes a user-owned provider skill inside its discovered root", async () => {
    const fixture = await makeWorkspaceFixture();
    const providerRoot = path.join(fixture.homeDir, ".claude", "skills");
    const skillDir = path.join(providerRoot, "notes");
    await writeSkill(path.join(skillDir, "SKILL.md"), "notes");

    await deleteHostSkill(
      {
        type: "host.delete_skill",
        scope: "provider-user",
        name: "notes",
        cwd: null,
        rootPath: providerRoot,
      },
      { dataDir: fixture.dataDir },
    );

    expect(await stat(skillDir).catch(() => null)).toBeNull();
  });

  it("refuses a name that escapes the root via path traversal", async () => {
    const fixture = await makeWorkspaceFixture();
    await expect(
      deleteHostSkill(
        {
          type: "host.delete_skill",
          scope: "bb-user",
          name: "../evil",
          cwd: null,
          rootPath: null,
        },
        { dataDir: fixture.dataDir },
      ),
    ).rejects.toMatchObject({ code: "invalid_skill_name" });
  });

  it("refuses a skill symlinked outside the bb root after realpath", async () => {
    const fixture = await makeWorkspaceFixture();
    const outside = path.join(tempRoot, "outside", "secret");
    await writeSkill(path.join(outside, "SKILL.md"), "secret");
    const skillsRoot = path.join(fixture.dataDir, "skills");
    await mkdir(skillsRoot, { recursive: true });
    await symlink(outside, path.join(skillsRoot, "link"));

    await expect(
      deleteHostSkill(
        {
          type: "host.delete_skill",
          scope: "bb-user",
          name: "link",
          cwd: null,
          rootPath: null,
        },
        { dataDir: fixture.dataDir },
      ),
    ).rejects.toMatchObject({ code: "skill_outside_root" });
    expect(
      await stat(path.join(outside, "SKILL.md")).catch(() => null),
    ).not.toBeNull();
  });

  it("refuses a skill symlinked to a sibling inside the same root", async () => {
    const fixture = await makeWorkspaceFixture();
    const skillsRoot = path.join(fixture.dataDir, "skills");
    await writeSkill(path.join(skillsRoot, "real", "SKILL.md"), "real");
    await symlink(
      path.join(skillsRoot, "real"),
      path.join(skillsRoot, "alias"),
    );

    await expect(
      deleteHostSkill(
        {
          type: "host.delete_skill",
          scope: "bb-user",
          name: "alias",
          cwd: null,
          rootPath: null,
        },
        { dataDir: fixture.dataDir },
      ),
    ).rejects.toMatchObject({ code: "skill_outside_root" });
    expect(
      await stat(path.join(skillsRoot, "real", "SKILL.md")).catch(() => null),
    ).not.toBeNull();
  });

  it("reports skill_not_found for a missing skill", async () => {
    const fixture = await makeWorkspaceFixture();
    await mkdir(path.join(fixture.dataDir, "skills"), { recursive: true });
    await expect(
      deleteHostSkill(
        {
          type: "host.delete_skill",
          scope: "bb-user",
          name: "ghost",
          cwd: null,
          rootPath: null,
        },
        { dataDir: fixture.dataDir },
      ),
    ).rejects.toBeInstanceOf(CommandDispatchError);
  });

  it("refuses a directory that is not a skill (no SKILL.md)", async () => {
    const fixture = await makeWorkspaceFixture();
    const notSkill = path.join(fixture.dataDir, "skills", "plain");
    await mkdir(notSkill, { recursive: true });
    await writeFile(path.join(notSkill, "README.md"), "not a skill", "utf8");

    await expect(
      deleteHostSkill(
        {
          type: "host.delete_skill",
          scope: "bb-user",
          name: "plain",
          cwd: null,
          rootPath: null,
        },
        { dataDir: fixture.dataDir },
      ),
    ).rejects.toMatchObject({ code: "not_a_skill" });
    expect(await stat(notSkill).catch(() => null)).not.toBeNull();
  });
});

describe("writeHostSkill", () => {
  it("atomically replaces a bb skill only at the expected revision", async () => {
    const fixture = await makeWorkspaceFixture();
    const filePath = path.join(fixture.dataDir, "skills", "review", "SKILL.md");
    const original = "---\nname: review\ndescription: Review\n---\n";
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, original, "utf8");
    const revision = createHash("sha256").update(original).digest("hex");

    const written = await writeHostSkill(
      {
        type: "host.write_skill",
        scope: "bb-user",
        name: "review",
        cwd: null,
        content: "# Updated",
        expectedSha256: revision,
      },
      { dataDir: fixture.dataDir },
    );

    expect(written).toMatchObject({
      outcome: "written",
      filePath: await realpath(filePath),
      sha256: createHash("sha256").update("# Updated").digest("hex"),
    });
    expect(await readFile(filePath, "utf8")).toBe("# Updated");

    const stale = await writeHostSkill(
      {
        type: "host.write_skill",
        scope: "bb-user",
        name: "review",
        cwd: null,
        content: "# Stale overwrite",
        expectedSha256: revision,
      },
      { dataDir: fixture.dataDir },
    );
    expect(stale).toMatchObject({ outcome: "conflict" });
    expect(await readFile(filePath, "utf8")).toBe("# Updated");
  });
});
