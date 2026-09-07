import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
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
  ProviderResolvedNativeRoot,
  ProviderResolvedNativeRoots,
} from "@bb/domain";
import type { HostProviderCommand } from "@bb/host-daemon-contract";
import {
  type CommandScanRoot,
  discoverProviderCommands,
} from "./command-discovery.js";
import { resolveDeclaredScanRoots } from "./command-handlers/list-commands.js";

const PROVIDER_ID = "test-provider";

interface WorkspaceFixture {
  cwd: string;
  homeDir: string;
}

let tempRoot: string;

async function writeFileEnsuringDir(
  filePath: string,
  content: string,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function makeWorkspaceFixture(): Promise<WorkspaceFixture> {
  const cwd = path.join(tempRoot, "workspace");
  const homeDir = path.join(tempRoot, "home");
  await mkdir(cwd, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  return { cwd, homeDir };
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

function resolved(
  rootPath: string,
  origin: ProviderResolvedNativeRoot["origin"],
  shape: ProviderResolvedNativeRoot["shape"],
  options: Partial<
    Pick<ProviderResolvedNativeRoot, "ancestors" | "namePrefix" | "recursive">
  > = {},
): ProviderResolvedNativeRoot {
  return {
    path: rootPath,
    origin,
    shape,
    recursive: false,
    ancestors: false,
    namePrefix: "",
    ...options,
  };
}

function nativeRoots(
  set: {
    skills?: Partial<ProviderNativeRoots>;
    commands?: Partial<ProviderNativeRoots>;
    resolved?: Partial<ProviderResolvedNativeRoots>;
  } = {},
): ProviderNativeRootSet {
  return {
    skills: { user: [], project: [], ...set.skills },
    commands: { user: [], project: [], ...set.commands },
    resolved: { skills: [], commands: [], ...set.resolved },
  };
}

const SKILLS_AND_COMMANDS = nativeRoots({
  skills: {
    project: [declared(".agent/skills")],
    user: [declared(".agent/skills")],
  },
  commands: {
    project: [declared(".agent/commands")],
    user: [declared(".agent/commands")],
  },
});

async function resolveRoots(
  fixture: WorkspaceFixture,
  cwd: string | null,
  roots: ProviderNativeRootSet,
): Promise<CommandScanRoot[]> {
  return resolveDeclaredScanRoots({
    providerId: PROVIDER_ID,
    cwd,
    homeDir: fixture.homeDir,
    nativeRoots: roots,
  });
}

async function discover(
  fixture: WorkspaceFixture,
  cwd: string | null,
  roots: ProviderNativeRootSet = SKILLS_AND_COMMANDS,
): Promise<HostProviderCommand[]> {
  return discoverProviderCommands({
    roots: await resolveRoots(fixture, cwd, roots),
  });
}

function byName(
  commands: HostProviderCommand[],
  name: string,
): HostProviderCommand | undefined {
  return commands.find((command) => command.name === name);
}

function rootPathOf(root: CommandScanRoot): string {
  return "rootPath" in root ? root.rootPath : root.filePath;
}

function skillFile(name: string, description = name): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n`;
}

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), "bb-command-discovery-"));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("discoverProviderCommands over declared roots", () => {
  it("parses project skills, namespaced commands, and frontmatter", async () => {
    const fixture = await makeWorkspaceFixture();
    await writeFileEnsuringDir(
      path.join(fixture.cwd, ".agent", "skills", "x", "SKILL.md"),
      "---\nname: frontmatter-name-ignored\ndescription: The x skill\nargument-hint: <target>\n---\nBody",
    );
    await writeFileEnsuringDir(
      path.join(fixture.cwd, ".agent", "commands", "review.md"),
      "---\ndescription: Review the diff\n---\nReview body",
    );
    await writeFileEnsuringDir(
      path.join(fixture.cwd, ".agent", "commands", "frontend", "component.md"),
      "---\ndescription: Scaffold a component\nargument-hint: <name>\n---\nBody",
    );

    const commands = await discover(fixture, fixture.cwd);

    expect(byName(commands, "x")).toEqual({
      name: "x",
      source: "skill",
      origin: "project",
      description: "The x skill",
      argumentHint: "<target>",
    });
    expect(byName(commands, "review")).toEqual({
      name: "review",
      source: "command",
      origin: "project",
      description: "Review the diff",
      argumentHint: null,
    });
    expect(byName(commands, "frontend:component")).toEqual({
      name: "frontend:component",
      source: "command",
      origin: "project",
      description: "Scaffold a component",
      argumentHint: "<name>",
    });
  });

  it("tags user-home roots with origin 'user'", async () => {
    const fixture = await makeWorkspaceFixture();
    await writeFileEnsuringDir(
      path.join(fixture.homeDir, ".agent", "skills", "deploy", "SKILL.md"),
      skillFile("deploy", "Deploy it"),
    );
    await writeFileEnsuringDir(
      path.join(fixture.homeDir, ".agent", "commands", "lint.md"),
      "---\ndescription: Lint everything\n---\n",
    );

    const commands = await discover(fixture, fixture.cwd);

    expect(byName(commands, "deploy")).toMatchObject({
      origin: "user",
      source: "skill",
    });
    expect(byName(commands, "lint")).toMatchObject({
      origin: "user",
      source: "command",
    });
  });

  it("returns empty for missing dirs without throwing", async () => {
    const fixture = await makeWorkspaceFixture();
    expect(await discover(fixture, fixture.cwd)).toEqual([]);
  });

  it("produces a name-only record for malformed frontmatter", async () => {
    const fixture = await makeWorkspaceFixture();
    await writeFileEnsuringDir(
      path.join(fixture.cwd, ".agent", "commands", "broken.md"),
      "---\ndescription: [unterminated\n---\nBody",
    );
    await writeFileEnsuringDir(
      path.join(fixture.cwd, ".agent", "commands", "no-frontmatter.md"),
      "Just a body, no frontmatter at all.",
    );

    const commands = await discover(fixture, fixture.cwd);

    expect(byName(commands, "broken")).toEqual({
      name: "broken",
      source: "command",
      origin: "project",
      description: null,
      argumentHint: null,
    });
    expect(byName(commands, "no-frontmatter")).toEqual({
      name: "no-frontmatter",
      source: "command",
      origin: "project",
      description: null,
      argumentHint: null,
    });
  });

  it("derives skill name from the directory (ignoring frontmatter name) and coerces a non-string description to null", async () => {
    const fixture = await makeWorkspaceFixture();
    await writeFileEnsuringDir(
      path.join(fixture.cwd, ".agent", "skills", "real-dir", "SKILL.md"),
      "---\nname: bogus\ndescription:\n  - not\n  - a\n  - string\n---\nBody",
    );
    await writeFileEnsuringDir(
      path.join(fixture.cwd, ".agent", "skills", "bare", "SKILL.md"),
      "No frontmatter at all.",
    );

    const commands = await discover(fixture, fixture.cwd);

    expect(byName(commands, "bogus")).toBeUndefined();
    expect(byName(commands, "real-dir")).toEqual({
      name: "real-dir",
      source: "skill",
      origin: "project",
      description: null,
      argumentHint: null,
    });
    expect(byName(commands, "bare")).toEqual({
      name: "bare",
      source: "skill",
      origin: "project",
      description: null,
      argumentHint: null,
    });
  });

  it("skips a skill-shaped directory that holds the root's declared manifest marker", async () => {
    const fixture = await makeWorkspaceFixture();
    for (const name of ["plain-skill", "vendor-plugin"]) {
      await writeFileEnsuringDir(
        path.join(fixture.homeDir, ".agent", "skills", name, "SKILL.md"),
        skillFile(name),
      );
    }
    await writeFileEnsuringDir(
      path.join(
        fixture.homeDir,
        ".agent",
        "skills",
        "vendor-plugin",
        ".vendor-plugin",
        "plugin.json",
      ),
      "{}",
    );

    const marked = await discover(
      fixture,
      null,
      nativeRoots({
        skills: {
          user: [
            declared(".agent/skills", {
              skipIfManifest: ".vendor-plugin/plugin.json",
            }),
          ],
        },
      }),
    );
    expect(marked.map((command) => command.name)).toEqual(["plain-skill"]);

    const unmarked = await discover(
      fixture,
      null,
      nativeRoots({ skills: { user: [declared(".agent/skills")] } }),
    );
    expect(unmarked.map((command) => command.name).sort()).toEqual([
      "plain-skill",
      "vendor-plugin",
    ]);
  });

  it("skips project roots and returns only user-origin records when cwd is null", async () => {
    const fixture = await makeWorkspaceFixture();
    await writeFileEnsuringDir(
      path.join(fixture.cwd, ".agent", "commands", "project-only.md"),
      "---\ndescription: project\n---\n",
    );
    await writeFileEnsuringDir(
      path.join(fixture.cwd, ".agent", "skills", "project-skill", "SKILL.md"),
      skillFile("project-skill"),
    );
    await writeFileEnsuringDir(
      path.join(fixture.homeDir, ".agent", "commands", "user-only.md"),
      "---\ndescription: user\n---\n",
    );

    const roots = await resolveRoots(fixture, null, SKILLS_AND_COMMANDS);
    expect(roots.map((root) => root.origin)).toEqual(["user", "user"]);

    const commands = await discover(fixture, null);
    expect(commands.map((command) => command.name)).toEqual(["user-only"]);
  });

  it("enforces the depth cap on deep command trees", async () => {
    const fixture = await makeWorkspaceFixture();
    const commandsRoot = path.join(fixture.cwd, ".agent", "commands");
    const deepSegments = Array.from({ length: 30 }, (_, index) => `d${index}`);
    await writeFileEnsuringDir(
      path.join(commandsRoot, ...deepSegments, "deep.md"),
      "---\ndescription: too deep\n---\n",
    );
    await writeFileEnsuringDir(
      path.join(commandsRoot, "shallow.md"),
      "---\ndescription: ok\n---\n",
    );

    const commands = await discover(fixture, fixture.cwd);

    expect(byName(commands, "shallow")).toBeDefined();
    expect(commands.some((command) => command.name.endsWith("deep"))).toBe(
      false,
    );
  });

  it("enforces the entry-count cap", async () => {
    const fixture = await makeWorkspaceFixture();
    const commandsRoot = path.join(fixture.cwd, ".agent", "commands");
    const fileCount = 1_050;
    await Promise.all(
      Array.from({ length: fileCount }, (_, index) =>
        writeFileEnsuringDir(
          path.join(commandsRoot, `cmd-${index}.md`),
          "body",
        ),
      ),
    );

    const commands = await discover(fixture, fixture.cwd);

    expect(commands.length).toBe(1_000);
  });

  it("does not follow symlinked command files or directories", async () => {
    const fixture = await makeWorkspaceFixture();
    const commandsRoot = path.join(fixture.cwd, ".agent", "commands");
    await mkdir(commandsRoot, { recursive: true });

    const outsideDir = path.join(tempRoot, "outside");
    await writeFileEnsuringDir(
      path.join(outsideDir, "secret.md"),
      "---\ndescription: secret\n---\n",
    );
    await writeFileEnsuringDir(
      path.join(commandsRoot, "real.md"),
      "---\ndescription: real\n---\n",
    );
    await symlink(
      path.join(outsideDir, "secret.md"),
      path.join(commandsRoot, "linked.md"),
    );
    await symlink(outsideDir, path.join(commandsRoot, "linked-dir"));

    const commands = await discover(fixture, fixture.cwd);

    expect(byName(commands, "real")).toBeDefined();
    expect(byName(commands, "linked")).toBeUndefined();
    expect(byName(commands, "linked-dir:secret")).toBeUndefined();
  });

  it("shares the entry-count cap across recursive roots", async () => {
    const fixture = await makeWorkspaceFixture();
    const fullRoot = path.join(fixture.cwd, "full-root");
    const secondRoot = path.join(fixture.cwd, "second-root");
    await Promise.all(
      Array.from({ length: 1_000 }, (_, index) =>
        writeFileEnsuringDir(path.join(fullRoot, `entry-${index}.txt`), ""),
      ),
    );
    await writeFileEnsuringDir(
      path.join(secondRoot, "late", "SKILL.md"),
      skillFile("late"),
    );

    const commands = await discover(
      fixture,
      fixture.cwd,
      nativeRoots({
        skills: {
          project: [
            declared("full-root", { recursive: true }),
            declared("second-root", { recursive: true }),
          ],
        },
      }),
    );

    expect(byName(commands, "late")).toBeUndefined();
  });

  it("rejects a recursive project root linked outside the workspace", async () => {
    const fixture = await makeWorkspaceFixture();
    const outsideRoot = path.join(tempRoot, "outside-recursive-root");
    const linkedRoot = path.join(fixture.cwd, ".cursor", "skills");
    await writeFileEnsuringDir(
      path.join(outsideRoot, "leaked", "SKILL.md"),
      skillFile("leaked"),
    );
    await mkdir(path.dirname(linkedRoot), { recursive: true });
    await symlink(outsideRoot, linkedRoot, "dir");

    const commands = await discover(
      fixture,
      fixture.cwd,
      nativeRoots({
        skills: { project: [declared(".cursor/skills", { recursive: true })] },
      }),
    );

    expect(commands).toEqual([]);
  });

  it("discovers skills through a .cursor/skills root symlink inside the workspace", async () => {
    const fixture = await makeWorkspaceFixture();
    await writeFileEnsuringDir(
      path.join(fixture.cwd, ".agents", "skills", "impeccable", "SKILL.md"),
      skillFile("impeccable", "Improve interface quality"),
    );
    await mkdir(path.join(fixture.cwd, ".cursor"), { recursive: true });
    await symlink(
      path.join("..", ".agents", "skills"),
      path.join(fixture.cwd, ".cursor", "skills"),
      "dir",
    );

    const commands = await discover(
      fixture,
      fixture.cwd,
      nativeRoots({
        skills: { project: [declared(".cursor/skills", { recursive: true })] },
      }),
    );

    expect(commands).toEqual([
      {
        name: "impeccable",
        source: "skill",
        origin: "project",
        description: "Improve interface quality",
        argumentHint: null,
      },
    ]);
  });

  it("does not follow project-origin symlinked skill directories or skill files", async () => {
    const fixture = await makeWorkspaceFixture();
    const skillsRoot = path.join(fixture.cwd, ".agent", "skills");
    await mkdir(skillsRoot, { recursive: true });

    const outsideSkillDirectory = path.join(
      tempRoot,
      "outside-skill-directory",
    );
    await writeFileEnsuringDir(
      path.join(outsideSkillDirectory, "SKILL.md"),
      skillFile("leaked"),
    );
    await symlink(outsideSkillDirectory, path.join(skillsRoot, "leaked"));

    const outsideSkillFile = path.join(tempRoot, "outside-skill-file.md");
    await writeFileEnsuringDir(outsideSkillFile, skillFile("linked-file"));
    const linkedFileSkillRoot = path.join(skillsRoot, "linked-file");
    await mkdir(linkedFileSkillRoot, { recursive: true });
    await symlink(outsideSkillFile, path.join(linkedFileSkillRoot, "SKILL.md"));

    const commands = await discover(fixture, fixture.cwd);

    expect(byName(commands, "leaked")).toBeUndefined();
    expect(byName(commands, "linked-file")).toBeUndefined();
  });

  it("follows user-origin symlinked skill directories and skill files", async () => {
    const fixture = await makeWorkspaceFixture();
    const skillsRoot = path.join(fixture.homeDir, ".agent", "skills");
    await mkdir(skillsRoot, { recursive: true });

    const linkedDirectoryTarget = path.join(
      tempRoot,
      "linked-directory-target",
    );
    await writeFileEnsuringDir(
      path.join(linkedDirectoryTarget, "SKILL.md"),
      skillFile("symlinked-directory", "linked directory"),
    );
    await symlink(
      linkedDirectoryTarget,
      path.join(skillsRoot, "symlinked-directory"),
    );

    const symlinkedFileTarget = path.join(tempRoot, "linked-file-target.md");
    await writeFileEnsuringDir(
      symlinkedFileTarget,
      skillFile("symlinked-file", "linked file"),
    );
    const symlinkedFileSkillRoot = path.join(skillsRoot, "symlinked-file");
    await mkdir(symlinkedFileSkillRoot, { recursive: true });
    await symlink(
      symlinkedFileTarget,
      path.join(symlinkedFileSkillRoot, "SKILL.md"),
    );

    const commands = await discover(fixture, fixture.cwd);

    expect(byName(commands, "symlinked-directory")).toEqual({
      name: "symlinked-directory",
      source: "skill",
      origin: "user",
      description: "linked directory",
      argumentHint: null,
    });
    expect(byName(commands, "symlinked-file")).toEqual({
      name: "symlinked-file",
      source: "skill",
      origin: "user",
      description: "linked file",
      argumentHint: null,
    });
  });

  it("degrades to other roots when a root directory is unreadable", async () => {
    const fixture = await makeWorkspaceFixture();
    await writeFileEnsuringDir(
      path.join(fixture.homeDir, ".agent", "skills", "ok", "SKILL.md"),
      "---\ndescription: readable\n---\n",
    );
    const blockedDir = path.join(fixture.cwd, ".agent", "commands");
    await writeFileEnsuringDir(
      path.join(blockedDir, "secret.md"),
      "---\ndescription: secret\n---\n",
    );
    await chmod(blockedDir, 0o000);
    try {
      let unreadable = false;
      try {
        await readdir(blockedDir);
      } catch {
        unreadable = true;
      }
      if (!unreadable) return;

      const commands = await discover(fixture, fixture.cwd);
      expect(byName(commands, "ok")).toBeDefined();
      expect(byName(commands, "secret")).toBeUndefined();
    } finally {
      await chmod(blockedDir, 0o755);
    }
  });
});

describe("resolveDeclaredScanRoots", () => {
  it("orders declared roots project, user for skills then commands", async () => {
    const fixture = await makeWorkspaceFixture();
    await writeFileEnsuringDir(
      path.join(fixture.homeDir, ".agents", "skills", "user-amp", "SKILL.md"),
      skillFile("user-amp", "User Amp skill"),
    );
    await writeFileEnsuringDir(
      path.join(fixture.cwd, ".amp", "skills", "project-amp", "SKILL.md"),
      skillFile("project-amp", "Project Amp skill"),
    );

    const roots = await resolveRoots(
      fixture,
      fixture.cwd,
      nativeRoots({
        skills: {
          user: [declared(".agents/skills")],
          project: [declared(".amp/skills")],
        },
        commands: {
          user: [declared(".amp/commands")],
          project: [declared(".amp/commands")],
        },
      }),
    );

    expect(roots).toEqual([
      {
        boundaryPath: fixture.cwd,
        rootPath: path.join(fixture.cwd, ".amp", "skills"),
        shape: "skill",
        namePrefix: "",
        source: "skill",
        origin: "project",
        skillIdentitySeed: `${PROVIDER_ID}:provider-project:.amp/skills`,
      },
      {
        rootPath: path.join(fixture.homeDir, ".agents", "skills"),
        shape: "skill",
        namePrefix: "",
        source: "skill",
        origin: "user",
        skillIdentitySeed: `${PROVIDER_ID}:provider-user:.agents/skills`,
      },
      {
        boundaryPath: fixture.cwd,
        rootPath: path.join(fixture.cwd, ".amp", "commands"),
        shape: "command",
        namePrefix: "",
        source: "command",
        origin: "project",
      },
      {
        rootPath: path.join(fixture.homeDir, ".amp", "commands"),
        shape: "command",
        namePrefix: "",
        source: "command",
        origin: "user",
      },
    ]);

    const commands = await discoverProviderCommands({ roots });
    expect(commands.map((command) => [command.name, command.origin])).toEqual([
      ["project-amp", "project"],
      ["user-amp", "user"],
    ]);
  });

  it("returns no roots for an empty root set", async () => {
    const fixture = await makeWorkspaceFixture();
    expect(await resolveRoots(fixture, fixture.cwd, nativeRoots())).toEqual([]);
  });

  it("walks a declared project root from the repository root through the cwd", async () => {
    const fixture = await makeWorkspaceFixture();
    const serviceRoot = path.join(fixture.cwd, "services");
    const cwd = path.join(serviceRoot, "api");
    await mkdir(path.join(fixture.cwd, ".git"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    for (const [directory, name] of [
      [fixture.cwd, "repository-skill"],
      [serviceRoot, "service-skill"],
      [cwd, "cwd-skill"],
    ] as const) {
      await writeFileEnsuringDir(
        path.join(directory, ".agents", "skills", name, "SKILL.md"),
        skillFile(name),
      );
      await writeFileEnsuringDir(
        path.join(directory, ".agents", "commands", `${name}-command.md`),
        "---\ndescription: command\n---\n",
      );
    }

    const roots = await resolveRoots(
      fixture,
      cwd,
      nativeRoots({
        skills: { project: [declared(".agents/skills", { ancestors: true })] },
        commands: {
          project: [declared(".agents/commands", { ancestors: true })],
        },
      }),
    );

    expect(roots.filter((root) => root.source === "skill")).toEqual(
      [
        [fixture.cwd, ""],
        [serviceRoot, "services"],
        [cwd, "services/api"],
      ].map(([directory, relativeDirectory]) => ({
        boundaryPath: fixture.cwd,
        rootPath: path.join(directory, ".agents", "skills"),
        shape: "skill",
        namePrefix: "",
        source: "skill",
        origin: "project",
        skillIdentitySeed: `${PROVIDER_ID}:provider-project:.agents/skills:${relativeDirectory}`,
      })),
    );
    expect(
      roots
        .filter((root) => root.source === "command")
        .map((root) => rootPathOf(root)),
    ).toEqual(
      [fixture.cwd, serviceRoot, cwd].map((directory) =>
        path.join(directory, ".agents", "commands"),
      ),
    );

    const commands = await discoverProviderCommands({ roots });
    expect(
      commands.map((command) => [command.name, command.origin]).sort(),
    ).toEqual([
      ["cwd-skill", "project"],
      ["cwd-skill-command", "project"],
      ["repository-skill", "project"],
      ["repository-skill-command", "project"],
      ["service-skill", "project"],
      ["service-skill-command", "project"],
    ]);
  });

  it("does not walk above a cwd without a repository marker and lists the cwd once", async () => {
    const fixture = await makeWorkspaceFixture();
    const cwd = path.join(fixture.cwd, "standalone");
    await mkdir(cwd, { recursive: true });
    await writeFileEnsuringDir(
      path.join(fixture.cwd, ".agents", "skills", "parent-skill", "SKILL.md"),
      skillFile("parent-skill"),
    );
    await writeFileEnsuringDir(
      path.join(cwd, ".agents", "skills", "cwd-skill", "SKILL.md"),
      skillFile("cwd-skill"),
    );

    const roots = await resolveRoots(
      fixture,
      cwd,
      nativeRoots({
        skills: { project: [declared(".agents/skills", { ancestors: true })] },
      }),
    );

    expect(roots).toEqual([
      {
        boundaryPath: cwd,
        rootPath: path.join(cwd, ".agents", "skills"),
        shape: "skill",
        namePrefix: "",
        source: "skill",
        origin: "project",
        skillIdentitySeed: `${PROVIDER_ID}:provider-project:.agents/skills:`,
      },
    ]);
    const commands = await discoverProviderCommands({ roots });
    expect(commands.map((command) => command.name)).toEqual(["cwd-skill"]);
  });

  it("maps recursive declared roots to skill-recursive, bounded to the workspace for project roots", async () => {
    const fixture = await makeWorkspaceFixture();
    await writeFileEnsuringDir(
      path.join(fixture.cwd, ".grok", "skills", "team", "nested", "SKILL.md"),
      skillFile("nested"),
    );
    await writeFileEnsuringDir(
      path.join(fixture.homeDir, ".grok", "skills", "deep", "home", "SKILL.md"),
      skillFile("home"),
    );

    const roots = await resolveRoots(
      fixture,
      fixture.cwd,
      nativeRoots({
        skills: {
          project: [declared(".grok/skills", { recursive: true })],
          user: [declared(".grok/skills", { recursive: true })],
        },
      }),
    );

    expect(roots).toEqual([
      {
        boundaryPath: fixture.cwd,
        rootPath: path.join(fixture.cwd, ".grok", "skills"),
        shape: "skill-recursive",
        namePrefix: "",
        source: "skill",
        origin: "project",
        skillIdentitySeed: `${PROVIDER_ID}:provider-project:.grok/skills`,
      },
      {
        rootPath: path.join(fixture.homeDir, ".grok", "skills"),
        shape: "skill-recursive",
        namePrefix: "",
        source: "skill",
        origin: "user",
        skillIdentitySeed: `${PROVIDER_ID}:provider-user:.grok/skills`,
      },
    ]);
    const commands = await discoverProviderCommands({ roots });
    expect(commands.map((command) => [command.name, command.origin])).toEqual([
      ["nested", "project"],
      ["home", "user"],
    ]);
  });

  it("treats a prefixed declared root as a plugin root without an identity seed", async () => {
    const fixture = await makeWorkspaceFixture();
    await writeFileEnsuringDir(
      path.join(fixture.homeDir, "tools", "skills", "release", "SKILL.md"),
      skillFile("release", "Publish a release"),
    );
    await writeFileEnsuringDir(
      path.join(fixture.homeDir, "tools", "commands", "widget.md"),
      "---\ndescription: Create a widget\n---\n",
    );

    const roots = await resolveRoots(
      fixture,
      fixture.cwd,
      nativeRoots({
        skills: {
          user: [declared("tools/skills", { namePrefix: "release-tools:" })],
        },
        commands: {
          user: [declared("tools/commands", { namePrefix: "release-tools:" })],
        },
      }),
    );

    expect(roots).toEqual([
      {
        rootPath: path.join(fixture.homeDir, "tools", "skills"),
        shape: "skill",
        namePrefix: "release-tools:",
        source: "skill",
        origin: "user",
      },
      {
        rootPath: path.join(fixture.homeDir, "tools", "commands"),
        shape: "command",
        namePrefix: "release-tools:",
        source: "command",
        origin: "user",
      },
    ]);
    const commands = await discoverProviderCommands({ roots });
    expect(commands.map((command) => command.name)).toEqual([
      "release-tools:release",
      "release-tools:widget",
    ]);
  });

  it("maps each resolved shape to its scan root and discovers through them", async () => {
    const fixture = await makeWorkspaceFixture();
    const pluginRoot = path.join(fixture.homeDir, "plugins", "local-plugin");
    const systemSkills = path.join(fixture.homeDir, "system", "skills");
    const missingSkills = path.join(
      fixture.homeDir,
      "system",
      "no-such-skills",
    );
    const teamSkills = path.join(fixture.cwd, "team-skills");
    await writeFileEnsuringDir(
      path.join(systemSkills, "docs", "SKILL.md"),
      skillFile("docs", "System docs"),
    );
    await writeFileEnsuringDir(
      path.join(teamSkills, "release", "nested", "SKILL.md"),
      skillFile("nested", "Nested team skill"),
    );
    await writeFileEnsuringDir(
      path.join(pluginRoot, "SKILL.md"),
      "---\ndescription: Root plugin skill\n---\n",
    );
    await writeFileEnsuringDir(
      path.join(pluginRoot, "single-skill", "SKILL.md"),
      "---\ndescription: One skill directory\n---\n",
    );
    await writeFileEnsuringDir(
      path.join(pluginRoot, "skills", "child-skill", "SKILL.md"),
      "---\ndescription: Child plugin skill\n---\n",
    );
    await writeFileEnsuringDir(
      path.join(pluginRoot, "commands", "create-widget.md"),
      "---\ndescription: Create a widget\n---\n",
    );
    await writeFileEnsuringDir(
      path.join(pluginRoot, "extra", "deploy.md"),
      "---\ndescription: Deploy\n---\n",
    );
    const linkedSkillTarget = path.join(tempRoot, "linked-plugin-skill.md");
    await writeFileEnsuringDir(
      linkedSkillTarget,
      skillFile("linked-file-skill", "Linked file skill"),
    );
    await mkdir(path.join(pluginRoot, "linked-skill"), { recursive: true });
    await symlink(
      linkedSkillTarget,
      path.join(pluginRoot, "linked-skill", "SKILL.md"),
    );

    const roots = await resolveRoots(
      fixture,
      fixture.cwd,
      nativeRoots({
        resolved: {
          skills: [
            resolved(systemSkills, "user", "skills"),
            resolved(missingSkills, "user", "skills"),
            resolved(teamSkills, "project", "skills", { recursive: true }),
            resolved(path.join(pluginRoot, "SKILL.md"), "user", "skill-file", {
              namePrefix: "local-plugin:",
            }),
            resolved(
              path.join(pluginRoot, "linked-skill", "SKILL.md"),
              "user",
              "skill-file",
              { namePrefix: "local-plugin:" },
            ),
            resolved(path.join(pluginRoot, "single-skill"), "user", "skill", {
              namePrefix: "local-plugin:",
            }),
            resolved(path.join(pluginRoot, "skills"), "user", "skills", {
              namePrefix: "local-plugin:",
            }),
          ],
          commands: [
            resolved(path.join(pluginRoot, "commands"), "user", "commands", {
              namePrefix: "local-plugin:",
            }),
            resolved(
              path.join(pluginRoot, "extra", "deploy.md"),
              "user",
              "command-file",
              { namePrefix: "local-plugin:" },
            ),
          ],
        },
      }),
    );

    expect(roots).toEqual([
      {
        rootPath: systemSkills,
        shape: "skill",
        namePrefix: "",
        source: "skill",
        origin: "user",
        skillIdentitySeed: `${PROVIDER_ID}:provider-user:${systemSkills}`,
      },
      {
        rootPath: missingSkills,
        shape: "skill",
        namePrefix: "",
        source: "skill",
        origin: "user",
        skillIdentitySeed: `${PROVIDER_ID}:provider-user:${missingSkills}`,
      },
      {
        boundaryPath: fixture.cwd,
        rootPath: teamSkills,
        shape: "skill-recursive",
        namePrefix: "",
        source: "skill",
        origin: "project",
        skillIdentitySeed: `${PROVIDER_ID}:provider-project:${teamSkills}`,
      },
      {
        filePath: path.join(pluginRoot, "SKILL.md"),
        fallbackName: "local-plugin",
        shape: "skill-file",
        namePrefix: "local-plugin:",
        source: "skill",
        origin: "user",
      },
      {
        filePath: path.join(pluginRoot, "linked-skill", "SKILL.md"),
        fallbackName: "linked-skill",
        shape: "skill-file",
        namePrefix: "local-plugin:",
        source: "skill",
        origin: "user",
      },
      {
        rootPath: path.join(pluginRoot, "single-skill"),
        shape: "skill-directory",
        namePrefix: "local-plugin:",
        source: "skill",
        origin: "user",
      },
      {
        rootPath: path.join(pluginRoot, "skills"),
        shape: "skill",
        namePrefix: "local-plugin:",
        source: "skill",
        origin: "user",
      },
      {
        rootPath: path.join(pluginRoot, "commands"),
        shape: "command",
        namePrefix: "local-plugin:",
        source: "command",
        origin: "user",
      },
      {
        filePath: path.join(pluginRoot, "extra", "deploy.md"),
        shape: "command-file",
        namePrefix: "local-plugin:",
        source: "command",
        origin: "user",
      },
    ]);

    const commands = await discoverProviderCommands({ roots });
    expect(
      commands.map((command) => [
        command.name,
        command.source,
        command.origin,
        command.description,
      ]),
    ).toEqual([
      ["docs", "skill", "user", "System docs"],
      ["nested", "skill", "project", "Nested team skill"],
      ["local-plugin:local-plugin", "skill", "user", "Root plugin skill"],
      ["local-plugin:linked-file-skill", "skill", "user", "Linked file skill"],
      ["local-plugin:single-skill", "skill", "user", "One skill directory"],
      ["local-plugin:child-skill", "skill", "user", "Child plugin skill"],
      ["local-plugin:create-widget", "command", "user", "Create a widget"],
      ["local-plugin:deploy", "command", "user", "Deploy"],
    ]);
  });

  it("seeds a prefix-less resolved skill file and skill directory by path", async () => {
    const fixture = await makeWorkspaceFixture();
    const skillDirectory = path.join(fixture.homeDir, "one-skill");
    const skillFilePath = path.join(fixture.cwd, "notes", "SKILL.md");

    const roots = await resolveRoots(
      fixture,
      fixture.cwd,
      nativeRoots({
        resolved: {
          skills: [
            resolved(skillDirectory, "user", "skill"),
            resolved(skillFilePath, "project", "skill-file"),
          ],
        },
      }),
    );

    expect(roots).toEqual([
      {
        rootPath: skillDirectory,
        shape: "skill-directory",
        namePrefix: "",
        source: "skill",
        origin: "user",
        skillIdentitySeed: `${PROVIDER_ID}:provider-user:${skillDirectory}`,
      },
      {
        filePath: skillFilePath,
        fallbackName: "notes",
        shape: "skill-file",
        namePrefix: "",
        source: "skill",
        origin: "project",
        skillIdentitySeed: `${PROVIDER_ID}:provider-project:${skillFilePath}`,
      },
    ]);
  });

  it("walks ancestors for a resolved project root inside the cwd only", async () => {
    const fixture = await makeWorkspaceFixture();
    const cwd = path.join(fixture.cwd, "packages", "app");
    await mkdir(path.join(fixture.cwd, ".git"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    const outsideRoot = path.join(tempRoot, "elsewhere", ".agents", "skills");

    const roots = await resolveRoots(
      fixture,
      cwd,
      nativeRoots({
        resolved: {
          skills: [
            resolved(path.join(cwd, ".agents", "skills"), "project", "skills", {
              ancestors: true,
            }),
            resolved(outsideRoot, "project", "skills", { ancestors: true }),
          ],
        },
      }),
    );

    expect(
      roots.map((root) => [rootPathOf(root), root.skillIdentitySeed]),
    ).toEqual([
      [
        path.join(fixture.cwd, ".agents", "skills"),
        `${PROVIDER_ID}:provider-project:.agents/skills:`,
      ],
      [
        path.join(fixture.cwd, "packages", ".agents", "skills"),
        `${PROVIDER_ID}:provider-project:.agents/skills:packages`,
      ],
      [
        path.join(cwd, ".agents", "skills"),
        `${PROVIDER_ID}:provider-project:.agents/skills:packages/app`,
      ],
      [outsideRoot, `${PROVIDER_ID}:provider-project:${outsideRoot}`],
    ]);
    expect(
      roots.map((root) => ("boundaryPath" in root ? root.boundaryPath : null)),
    ).toEqual([fixture.cwd, fixture.cwd, fixture.cwd, fixture.cwd]);
  });

  it("keeps the first root per path across declared and resolved roots", async () => {
    const fixture = await makeWorkspaceFixture();
    const userRoot = path.join(fixture.homeDir, ".agents", "skills");
    const projectRoot = path.join(fixture.cwd, ".agents", "skills");
    await writeFileEnsuringDir(
      path.join(userRoot, "shared", "SKILL.md"),
      skillFile("shared"),
    );

    const roots = await resolveRoots(
      fixture,
      fixture.cwd,
      nativeRoots({
        skills: {
          user: [declared(".agents/skills")],
          project: [declared(".agents/skills")],
        },
        commands: { project: [declared(".agents/skills")] },
        resolved: {
          skills: [
            resolved(userRoot, "user", "skills", { recursive: true }),
            resolved(projectRoot, "project", "skills", {
              namePrefix: "vendor:",
            }),
          ],
        },
      }),
    );

    expect(roots).toEqual([
      {
        boundaryPath: fixture.cwd,
        rootPath: projectRoot,
        shape: "skill",
        namePrefix: "",
        source: "skill",
        origin: "project",
        skillIdentitySeed: `${PROVIDER_ID}:provider-project:.agents/skills`,
      },
      {
        rootPath: userRoot,
        shape: "skill",
        namePrefix: "",
        source: "skill",
        origin: "user",
        skillIdentitySeed: `${PROVIDER_ID}:provider-user:.agents/skills`,
      },
    ]);
    const commands = await discoverProviderCommands({ roots });
    expect(commands.map((command) => command.name)).toEqual(["shared"]);
  });
});
