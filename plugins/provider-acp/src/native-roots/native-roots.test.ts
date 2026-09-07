import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { experimental_nativeRootsResolveOutputSchema } from "@get-bb/plugin-sdk/host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveGrokNativeRoots } from "./grok.js";
import { resolveHermesNativeRoots } from "./hermes.js";
import { resolveOmpNativeRoots } from "./omp.js";
import { resolveOpenCodeNativeRoots } from "./opencode.js";
import type {
  AcpNativeRootsEnvironment,
  AcpNativeRootsResolver,
  AcpNativeRootsResolverArgs,
  AcpResolvedSkillRoot,
} from "./resolver.js";

let tempRoot: string;
let homeDir: string;
let cwd: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), "bb-acp-native-roots-"));
  homeDir = path.join(tempRoot, "home");
  cwd = path.join(tempRoot, "workspace");
  await mkdir(homeDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

async function writeFileEnsuringDir(
  filePath: string,
  content: string,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

function argsFor(
  env: AcpNativeRootsEnvironment = {},
  workspace: string | null = cwd,
): AcpNativeRootsResolverArgs {
  return { cwd: workspace, homeDir, env };
}

async function resolveSkills(
  resolver: AcpNativeRootsResolver,
  args: AcpNativeRootsResolverArgs,
): Promise<AcpResolvedSkillRoot[]> {
  const answer = await resolver(args);
  const parsed = experimental_nativeRootsResolveOutputSchema.safeParse(answer);
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  return answer.skills ?? [];
}

function home(...segments: string[]): string {
  return path.join(homeDir, ...segments);
}

function byPath(
  roots: readonly AcpResolvedSkillRoot[],
  rootPath: string,
): AcpResolvedSkillRoot | undefined {
  return roots.find((root) => root.path === rootPath);
}

async function writeSkill(rootPath: string, name: string): Promise<void> {
  await writeFileEnsuringDir(
    path.join(rootPath, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name}\n---\n`,
  );
}

describe("opencode", () => {
  it("follows XDG_CONFIG_HOME and adds the OPENCODE_CONFIG_DIR skills", async () => {
    const roots = await resolveSkills(resolveOpenCodeNativeRoots, argsFor());
    expect(roots).toEqual([
      {
        path: home(".config", "opencode", "skills"),
        origin: "user",
        recursive: false,
        shape: "skills",
      },
    ]);

    const moved = await resolveSkills(
      resolveOpenCodeNativeRoots,
      argsFor({
        XDG_CONFIG_HOME: "custom-xdg",
        OPENCODE_CONFIG_DIR: "~/custom-opencode",
      }),
    );
    expect(moved.map((root) => root.path)).toEqual([
      home("custom-xdg", "opencode", "skills"),
      home("custom-opencode", "skills"),
    ]);
  });
});

describe("omp", () => {
  it("reads the agent, pi, codex and opencode skill directories", async () => {
    const roots = await resolveSkills(resolveOmpNativeRoots, argsFor());
    expect(roots.map((root) => root.path)).toEqual([
      home(".omp", "agent", "skills"),
      home(".omp", "agent", "managed-skills"),
      home(".pi", "agent", "skills"),
      home(".codex", "skills"),
      home(".config", "opencode", "skills"),
    ]);
    expect(
      roots.every((root) => root.origin === "user" && root.recursive === false),
    ).toBe(true);
  });

  it("follows a named profile and the moved pi and codex homes", async () => {
    const roots = await resolveSkills(
      resolveOmpNativeRoots,
      argsFor({
        OMP_PROFILE: "work",
        PI_CODING_AGENT_DIR: "~/pi-agent",
        CODEX_HOME: path.join(tempRoot, "codex-home"),
      }),
    );
    const paths = roots.map((root) => root.path);
    expect(paths).toContain(
      home(".omp", "profiles", "work", "agent", "skills"),
    );
    expect(paths).toContain(home("pi-agent", "skills"));
    expect(paths).toContain(path.join(tempRoot, "codex-home", "skills"));
    const fallback = await resolveSkills(
      resolveOmpNativeRoots,
      argsFor({ OMP_PROFILE: "default", PI_CODING_AGENT_DIR: "~/pi-agent" }),
    );
    expect(fallback.slice(0, 3).map((root) => root.path)).toEqual([
      home("pi-agent", "skills"),
      home("pi-agent", "managed-skills"),
      home("pi-agent", "skills"),
    ]);
  });

  it("lists skills.customDirectories from the user config as user roots", async () => {
    const skillRoot = path.join(tempRoot, "omp-configured-skills");
    await writeFileEnsuringDir(
      home(".omp", "agent", "config.yml"),
      `skills:\n  customDirectories:\n    - ${skillRoot}\n    - ~/shared/SKILL.md\n`,
    );
    const roots = await resolveSkills(resolveOmpNativeRoots, argsFor());
    expect(byPath(roots, skillRoot)).toEqual({
      path: skillRoot,
      origin: "user",
      recursive: false,
      shape: "skills",
    });
    expect(byPath(roots, home("shared", "SKILL.md"))).toMatchObject({
      origin: "user",
      shape: "skill-file",
    });
  });

  it("marks a project configuration's custom directories as project roots", async () => {
    const skillRoot = path.join(cwd, "team-skills");
    await mkdir(path.join(cwd, ".git"), { recursive: true });
    await writeFileEnsuringDir(
      home(".omp", "agent", "config.yml"),
      `skills:\n  customDirectories:\n    - ${path.join(tempRoot, "user-skills")}\n`,
    );
    await writeFileEnsuringDir(
      path.join(cwd, ".omp", "config.yml"),
      `skills:\n  customDirectories:\n    - ${skillRoot}\n`,
    );
    const roots = await resolveSkills(resolveOmpNativeRoots, argsFor());
    expect(byPath(roots, path.join(tempRoot, "user-skills"))).toBeUndefined();
    expect(byPath(roots, skillRoot)).toMatchObject({ origin: "project" });

    const userOnly = await resolveSkills(
      resolveOmpNativeRoots,
      argsFor({}, null),
    );
    expect(byPath(userOnly, skillRoot)).toBeUndefined();
    expect(byPath(userOnly, path.join(tempRoot, "user-skills"))).toBeDefined();
  });

  it("reads PI_CONFIG_FILES relative to the workspace and expands $VARS", async () => {
    const extraConfig = path.join(tempRoot, "extra", "config.yml");
    await writeFileEnsuringDir(
      extraConfig,
      "skills:\n  customDirectories:\n    - $SKILLS_BASE/team\n",
    );
    const roots = await resolveSkills(
      resolveOmpNativeRoots,
      argsFor({
        PI_CONFIG_FILES: extraConfig,
        SKILLS_BASE: path.join(tempRoot, "base"),
      }),
    );
    expect(byPath(roots, path.join(tempRoot, "base", "team"))).toMatchObject({
      origin: "user",
    });
  });

  it("includes the installed Claude plugins' skills", async () => {
    const pluginRoot = home(
      ".claude",
      "plugins",
      "cache",
      "market",
      "tools",
      "1.0.0",
    );
    await writeFileEnsuringDir(
      home(".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "tools@market": [{ scope: "user", installPath: pluginRoot }],
        },
      }),
    );
    await writeFileEnsuringDir(
      path.join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "tools", commands: "commands" }),
    );
    await writeSkill(path.join(pluginRoot, "skills"), "release");
    await writeFileEnsuringDir(
      path.join(pluginRoot, "commands", "ship.md"),
      "ship",
    );

    const roots = await resolveSkills(resolveOmpNativeRoots, argsFor());
    expect(byPath(roots, path.join(pluginRoot, "skills"))).toEqual({
      path: path.join(pluginRoot, "skills"),
      origin: "user",
      namePrefix: "tools:",
      shape: "skills",
    });
    expect(roots.some((root) => root.path.includes("commands"))).toBe(false);
  });
});

describe("hermes", () => {
  it("scans the hermes skills tree and the configured external directories", async () => {
    await writeFileEnsuringDir(
      home(".hermes", "config.yaml"),
      `skills:\n  external_dirs:\n    - ${path.join(tempRoot, "hermes-external")}\n    - shared\n    - ~/home-skills\n`,
    );
    const roots = await resolveSkills(resolveHermesNativeRoots, argsFor());
    expect(roots).toEqual([
      {
        path: home(".hermes", "skills"),
        origin: "user",
        recursive: true,
        shape: "skills",
      },
      {
        path: path.join(tempRoot, "hermes-external"),
        origin: "user",
        recursive: true,
        shape: "skills",
      },
      {
        path: home(".hermes", "shared"),
        origin: "user",
        recursive: true,
        shape: "skills",
      },
      {
        path: home("home-skills"),
        origin: "user",
        recursive: true,
        shape: "skills",
      },
    ]);
  });

  it("accepts a single external_dirs string and follows HERMES_HOME", async () => {
    await writeFileEnsuringDir(
      home("custom-hermes", "config.yaml"),
      "skills:\n  external_dirs: extra\n",
    );
    const roots = await resolveSkills(
      resolveHermesNativeRoots,
      argsFor({ HERMES_HOME: "custom-hermes" }),
    );
    expect(roots.map((root) => root.path)).toEqual([
      home("custom-hermes", "skills"),
      home("custom-hermes", "extra"),
    ]);
  });
});

describe("grok", () => {
  const compatPaths = (): string[] => [
    path.join(cwd, ".claude", "skills"),
    home(".claude", "skills"),
    path.join(cwd, ".cursor", "skills"),
    home(".cursor", "skills"),
  ];

  it("reads its own tree and, by default, the Claude and Cursor trees", async () => {
    const roots = await resolveSkills(resolveGrokNativeRoots, argsFor());
    expect(roots.map((root) => root.path)).toEqual([
      home(".grok", "skills"),
      ...compatPaths(),
    ]);
    expect(byPath(roots, path.join(cwd, ".claude", "skills"))).toEqual({
      path: path.join(cwd, ".claude", "skills"),
      origin: "project",
      recursive: true,
      ancestors: true,
      shape: "skills",
      skipIfManifest: ".claude-plugin/plugin.json",
    });
    expect(byPath(roots, home(".cursor", "skills"))).toEqual({
      path: home(".cursor", "skills"),
      origin: "user",
      recursive: true,
      shape: "skills",
    });
    expect(byPath(roots, home(".grok", "skills"))).toMatchObject({
      recursive: true,
    });
  });

  it("follows GROK_HOME for the skills tree and the config", async () => {
    await writeFileEnsuringDir(
      home("custom-grok", "config.toml"),
      "[compat.cursor]\nskills = false\n",
    );
    const roots = await resolveSkills(
      resolveGrokNativeRoots,
      argsFor({ GROK_HOME: "custom-grok" }),
    );
    const paths = roots.map((root) => root.path);
    expect(paths).toContain(home("custom-grok", "skills"));
    expect(
      paths.some((rootPath) =>
        rootPath.endsWith(`${path.sep}.cursor${path.sep}skills`),
      ),
    ).toBe(false);
  });

  it("drops the compat trees the config disables, unless the environment re-enables them", async () => {
    await writeFileEnsuringDir(
      home(".grok", "config.toml"),
      "[compat.cursor]\nskills = false\n[compat.claude]\nskills = false\n",
    );
    const disabled = await resolveSkills(resolveGrokNativeRoots, argsFor());
    expect(disabled.map((root) => root.path)).toEqual([
      home(".grok", "skills"),
    ]);

    const reenabled = await resolveSkills(
      resolveGrokNativeRoots,
      argsFor({
        GROK_CLAUDE_SKILLS_ENABLED: "1",
        GROK_CURSOR_SKILLS_ENABLED: "true",
      }),
    );
    expect(reenabled.map((root) => root.path)).toEqual([
      home(".grok", "skills"),
      ...compatPaths(),
    ]);
  });

  it("drops the Claude trees and the Claude plugins when the environment disables them", async () => {
    const pluginRoot = home("claude-plugin");
    await writeFileEnsuringDir(
      home(".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "tools@market": [{ scope: "user", installPath: pluginRoot }],
        },
      }),
    );
    await writeFileEnsuringDir(
      path.join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "tools" }),
    );
    await writeSkill(path.join(pluginRoot, "skills"), "release");

    const withCompat = await resolveSkills(resolveGrokNativeRoots, argsFor());
    expect(byPath(withCompat, path.join(pluginRoot, "skills"))).toMatchObject({
      namePrefix: "tools:",
    });

    const without = await resolveSkills(
      resolveGrokNativeRoots,
      argsFor({ GROK_CLAUDE_SKILLS_ENABLED: "false" }),
    );
    expect(without.map((root) => root.path)).toEqual([
      home(".grok", "skills"),
      path.join(cwd, ".cursor", "skills"),
      home(".cursor", "skills"),
    ]);
  });

  it("lists skills.paths recursively, project-origin inside the repository", async () => {
    await mkdir(path.join(cwd, ".git"), { recursive: true });
    const userSkills = path.join(tempRoot, "grok-configured-skills");
    const projectSkills = path.join(cwd, "team", "skills");
    await writeFileEnsuringDir(
      home(".grok", "config.toml"),
      `[skills]\npaths = [${JSON.stringify(userSkills)}, "team/skills", "~/one/SKILL.md"]\n`,
    );
    const roots = await resolveSkills(resolveGrokNativeRoots, argsFor());
    expect(byPath(roots, userSkills)).toEqual({
      path: userSkills,
      origin: "user",
      recursive: true,
      shape: "skills",
    });
    expect(byPath(roots, projectSkills)).toMatchObject({
      origin: "project",
      recursive: true,
    });
    expect(byPath(roots, home("one", "SKILL.md"))).toMatchObject({
      shape: "skill-file",
    });
    const userOnly = await resolveSkills(
      resolveGrokNativeRoots,
      argsFor({}, null),
    );
    expect(byPath(userOnly, userSkills)).toMatchObject({ origin: "user" });
    expect(byPath(userOnly, home("team", "skills"))).toMatchObject({
      origin: "user",
    });
  });

  it("lists an enabled home plugin's skills under its name and skips the rest", async () => {
    await writeFileEnsuringDir(
      home(".grok", "config.toml"),
      '[plugins]\nenabled = ["release-tools", "org/renamed"]\ndisabled = ["auto-off"]\npaths = ["~/auto-plugins/auto-on", "~/auto-plugins/auto-off"]\n',
    );
    for (const name of ["release-tools", "unlisted"]) {
      await writeSkill(home(".grok", "plugins", name, "skills"), "release");
    }
    await writeFileEnsuringDir(
      home(".claude", "plugins", "renamed-dir", "plugin.json"),
      JSON.stringify({
        name: "renamed",
        skills: ["custom-skills", "one/SKILL.md"],
      }),
    );
    await writeSkill(
      home(".claude", "plugins", "renamed-dir", "custom-skills"),
      "a",
    );
    await writeFileEnsuringDir(
      home(".claude", "plugins", "renamed-dir", "one", "SKILL.md"),
      "---\nname: one\n---\n",
    );
    for (const name of ["auto-on", "auto-off"]) {
      await writeSkill(home("auto-plugins", name, "skills"), "x");
    }

    const roots = await resolveSkills(resolveGrokNativeRoots, argsFor());
    const plugins = roots.filter((root) => root.namePrefix !== undefined);
    expect(plugins).toEqual([
      {
        path: home(".grok", "plugins", "release-tools", "skills"),
        origin: "user",
        recursive: true,
        namePrefix: "release-tools:",
        shape: "skills",
      },
      {
        path: home(".claude", "plugins", "renamed-dir", "custom-skills"),
        origin: "user",
        recursive: true,
        namePrefix: "renamed:",
        shape: "skills",
      },
      {
        path: home(".claude", "plugins", "renamed-dir", "one", "SKILL.md"),
        origin: "user",
        namePrefix: "renamed:",
        shape: "skill-file",
      },
      {
        path: home("auto-plugins", "auto-on", "skills"),
        origin: "user",
        recursive: true,
        namePrefix: "auto-on:",
        shape: "skills",
      },
    ]);
  });

  it("reads a manifest that mistypes a Claude manifest field as absent", async () => {
    await writeFileEnsuringDir(
      home(".grok", "config.toml"),
      '[plugins]\nenabled = ["renamed", "dir-name", "flagged", "flag-dir"]\n',
    );
    await writeFileEnsuringDir(
      home(".grok", "plugins", "dir-name", "plugin.json"),
      JSON.stringify({ name: "renamed", skills: ["custom"], commands: 5 }),
    );
    await writeFileEnsuringDir(
      home(".claude", "plugins", "flag-dir", ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "flagged",
        skills: ["custom"],
        defaultEnabled: "yes",
      }),
    );
    for (const pluginRoot of [
      home(".grok", "plugins", "dir-name"),
      home(".claude", "plugins", "flag-dir"),
    ]) {
      await writeSkill(path.join(pluginRoot, "custom"), "x");
      await writeSkill(path.join(pluginRoot, "skills"), "y");
    }

    const roots = await resolveSkills(resolveGrokNativeRoots, argsFor());
    const plugins = roots.filter((root) => root.namePrefix !== undefined);
    expect(plugins).toEqual([
      {
        path: home(".grok", "plugins", "dir-name", "skills"),
        origin: "user",
        recursive: true,
        namePrefix: "dir-name:",
        shape: "skills",
      },
      {
        path: home(".claude", "plugins", "flag-dir", "skills"),
        origin: "user",
        recursive: true,
        namePrefix: "flag-dir:",
        shape: "skills",
      },
    ]);
  });

  it("finds plugins through the install registry and the repository's plugin directories", async () => {
    await mkdir(path.join(cwd, ".git"), { recursive: true });
    const nested = path.join(cwd, "packages", "app");
    await mkdir(nested, { recursive: true });
    await writeFileEnsuringDir(
      home(".grok", "config.toml"),
      '[plugins]\nenabled = ["registered", "repo-plugin"]\ninstall_dir = "~/grok-installs"\n',
    );
    const repoPath = path.join(tempRoot, "registry-repo");
    await writeFileEnsuringDir(
      home("grok-installs", "registry.json"),
      JSON.stringify({
        repos: {
          "org/repo": {
            path: repoPath,
            plugins: { registered: { subdir: "plugins/registered" } },
          },
        },
      }),
    );
    await writeSkill(
      path.join(repoPath, "plugins", "registered", "skills"),
      "r",
    );
    await writeSkill(
      path.join(cwd, ".grok", "plugins", "repo-plugin", "skills"),
      "p",
    );

    const roots = await resolveSkills(
      resolveGrokNativeRoots,
      argsFor({}, nested),
    );
    expect(
      byPath(roots, path.join(repoPath, "plugins", "registered", "skills")),
    ).toMatchObject({
      origin: "user",
      namePrefix: "registered:",
    });
    expect(
      byPath(
        roots,
        path.join(cwd, ".grok", "plugins", "repo-plugin", "skills"),
      ),
    ).toMatchObject({
      origin: "project",
      namePrefix: "repo-plugin:",
    });
  });
});
