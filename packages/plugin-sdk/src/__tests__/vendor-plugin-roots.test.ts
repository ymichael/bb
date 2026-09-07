import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { experimental_nativeRootsResolveOutputSchema } from "../native-roots-contract.js";
import {
  experimental_resolveClaudePluginRoots,
  experimental_resolveVendorPluginRoots,
  type ExperimentalClaudePluginRoots,
  type ExperimentalVendorPluginRoots,
} from "../vendor-plugin-roots.js";

let tempRoot: string;
let homeDir: string;
let cwd: string;
let claudeDir: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), "bb-vendor-plugin-roots-"));
  homeDir = path.join(tempRoot, "home");
  cwd = path.join(tempRoot, "workspace");
  claudeDir = path.join(homeDir, ".claude");
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

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFileEnsuringDir(filePath, JSON.stringify(value, null, 2));
}

async function writePlugin(
  pluginRoot: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  await writeJson(
    path.join(pluginRoot, ".claude-plugin", "plugin.json"),
    manifest,
  );
}

function installed(
  plugins: Record<
    string,
    { scope: string; installPath: string; gitCommitSha?: string }[]
  >,
  registryDir = claudeDir,
): Promise<void> {
  return writeJson(
    path.join(registryDir, "plugins", "installed_plugins.json"),
    {
      version: 2,
      plugins,
    },
  );
}

async function resolve(
  workspace: string | null = cwd,
  env: Record<string, string | undefined> = {},
): Promise<ExperimentalClaudePluginRoots> {
  const roots = await experimental_resolveClaudePluginRoots({
    cwd: workspace,
    homeDir,
    env,
  });
  const parsed = experimental_nativeRootsResolveOutputSchema.safeParse({
    skills: roots.skills,
    commands: roots.commands,
  });
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  return roots;
}

function skillPaths(roots: ExperimentalVendorPluginRoots): string[] {
  return roots.skills.map((root) => root.path);
}

function commandPaths(roots: ExperimentalVendorPluginRoots): string[] {
  return roots.commands.map((root) => root.path);
}

describe("experimental_resolveClaudePluginRoots", () => {
  it("reads the registry from ~/.claude or any CLAUDE_CONFIG_DIR form, and answers nothing without one", async () => {
    for (const [env, expected] of [
      [{}, claudeDir],
      [{ CLAUDE_CONFIG_DIR: "  " }, claudeDir],
      [
        { CLAUDE_CONFIG_DIR: "custom-claude" },
        path.join(homeDir, "custom-claude"),
      ],
      [{ CLAUDE_CONFIG_DIR: "~/moved" }, path.join(homeDir, "moved")],
      [
        { CLAUDE_CONFIG_DIR: path.join(tempRoot, "elsewhere", "..", "abs") },
        path.join(tempRoot, "abs"),
      ],
    ] as const) {
      const roots = await resolve(null, env);
      expect(roots).toEqual({ claudeDir: expected, skills: [], commands: [] });
    }

    const movedDir = path.join(homeDir, "custom-claude");
    const pluginRoot = path.join(homeDir, "moved-plugin");
    await installed(
      { "moved-plugin@market": [{ scope: "user", installPath: pluginRoot }] },
      movedDir,
    );
    await writePlugin(pluginRoot, { name: "moved-plugin" });
    await mkdir(path.join(pluginRoot, "skills"), { recursive: true });
    await installed({
      "stale-plugin@market": [
        { scope: "user", installPath: path.join(claudeDir, "stale") },
      ],
    });
    await writePlugin(path.join(claudeDir, "stale"), { name: "stale-plugin" });
    await mkdir(path.join(claudeDir, "stale", "skills"), { recursive: true });

    const roots = await resolve(cwd, { CLAUDE_CONFIG_DIR: "custom-claude" });
    expect(roots.claudeDir).toBe(movedDir);
    expect(roots.skills).toEqual([
      {
        path: path.join(pluginRoot, "skills"),
        origin: "user",
        namePrefix: "moved-plugin:",
        shape: "skills",
      },
    ]);
  });

  it("resolves an enabled user-scope plugin's default directories, manifest entries, and cache fallback", async () => {
    const cacheRoot = path.join(claudeDir, "plugins", "cache", "test-market");
    await writeJson(path.join(claudeDir, "settings.json"), {
      enabledPlugins: {
        "fallback-plugin@test-market": true,
        "disabled-plugin@test-market": false,
        "tilde-plugin@test-market": true,
      },
    });
    await installed({
      "fallback-plugin@test-market": [
        {
          scope: "user",
          installPath: path.join(cacheRoot, "fallback-plugin", "unknown"),
          gitCommitSha: "abcdef1234567890abcdef1234567890abcdef12",
        },
      ],
      "disabled-plugin@test-market": [
        {
          scope: "user",
          installPath: path.join(cacheRoot, "disabled-plugin", "1.0.0"),
        },
      ],
      "tilde-plugin@test-market": [
        {
          scope: "user",
          installPath: "~/.claude/plugins/cache/test-market/tilde-plugin/1.0.0",
        },
      ],
    });

    const fallbackPluginRoot = path.join(
      cacheRoot,
      "fallback-plugin",
      "abcdef123456",
    );
    const olderPluginRoot = path.join(cacheRoot, "fallback-plugin", "older");
    await writePlugin(olderPluginRoot, { name: "fallback-plugin" });
    await writePlugin(fallbackPluginRoot, {
      name: "fallback-plugin",
      skills: [
        "skills",
        "linked-skill/SKILL.md",
        "linked-skills",
        "single",
        "missing",
        "notes.md",
        "../escape",
        "/abs",
      ],
      commands: ["commands", "extra/deploy.md", "extra/notes.txt", "missing"],
    });
    await writeFileEnsuringDir(
      path.join(fallbackPluginRoot, "SKILL.md"),
      "---\ndescription: root\n---\n",
    );
    await writeFileEnsuringDir(
      path.join(fallbackPluginRoot, "skills", "child-skill", "SKILL.md"),
      "---\ndescription: child\n---\n",
    );
    await writeFileEnsuringDir(
      path.join(fallbackPluginRoot, "commands", "create-widget.md"),
      "---\ndescription: widget\n---\n",
    );
    await writeFileEnsuringDir(
      path.join(fallbackPluginRoot, "extra", "deploy.md"),
      "body",
    );
    await writeFileEnsuringDir(
      path.join(fallbackPluginRoot, "extra", "notes.txt"),
      "body",
    );
    await writeFileEnsuringDir(
      path.join(fallbackPluginRoot, "notes.md"),
      "not a skill\n",
    );
    await writeFileEnsuringDir(
      path.join(fallbackPluginRoot, "single", "SKILL.md"),
      "---\ndescription: the single dir is one skill\n---\n",
    );
    await writeFileEnsuringDir(
      path.join(cacheRoot, "fallback-plugin", "escape", "SKILL.md"),
      "---\ndescription: outside the plugin\n---\n",
    );
    const linkedSkillTarget = path.join(tempRoot, "linked-plugin-skill.md");
    await writeFileEnsuringDir(linkedSkillTarget, "---\nname: linked\n---\n");
    await mkdir(path.join(fallbackPluginRoot, "linked-skill"), {
      recursive: true,
    });
    await symlink(
      linkedSkillTarget,
      path.join(fallbackPluginRoot, "linked-skill", "SKILL.md"),
    );
    const linkedSkillsTarget = path.join(tempRoot, "linked-plugin-skills");
    await writeFileEnsuringDir(
      path.join(linkedSkillsTarget, "nested-skill", "SKILL.md"),
      "---\ndescription: nested\n---\n",
    );
    await symlink(
      linkedSkillsTarget,
      path.join(fallbackPluginRoot, "linked-skills"),
    );

    const disabledPluginRoot = path.join(cacheRoot, "disabled-plugin", "1.0.0");
    await writePlugin(disabledPluginRoot, { name: "disabled-plugin" });
    await mkdir(path.join(disabledPluginRoot, "skills"), { recursive: true });

    const tildePluginRoot = path.join(cacheRoot, "tilde-plugin", "1.0.0");
    await writePlugin(tildePluginRoot, { name: "tilde-plugin" });
    await mkdir(path.join(tildePluginRoot, "skills"), { recursive: true });

    const roots = await resolve();

    const prefixed = (namePrefix: string) => ({ origin: "user", namePrefix });
    expect(roots.skills).toEqual([
      {
        path: path.join(fallbackPluginRoot, "SKILL.md"),
        ...prefixed("fallback-plugin:"),
        shape: "skill-file",
        fallbackName: "fallback-plugin",
      },
      {
        path: path.join(fallbackPluginRoot, "skills"),
        ...prefixed("fallback-plugin:"),
        shape: "skills",
      },
      {
        path: path.join(fallbackPluginRoot, "linked-skill", "SKILL.md"),
        ...prefixed("fallback-plugin:"),
        shape: "skill-file",
      },
      {
        path: path.join(fallbackPluginRoot, "linked-skills"),
        ...prefixed("fallback-plugin:"),
        shape: "skills",
      },
      {
        path: path.join(fallbackPluginRoot, "single"),
        ...prefixed("fallback-plugin:"),
        shape: "skill",
      },
      {
        path: path.join(tildePluginRoot, "skills"),
        ...prefixed("tilde-plugin:"),
        shape: "skills",
      },
    ]);
    expect(roots.commands).toEqual([
      {
        path: path.join(fallbackPluginRoot, "commands"),
        ...prefixed("fallback-plugin:"),
        shape: "commands",
      },
      {
        path: path.join(fallbackPluginRoot, "extra", "deploy.md"),
        ...prefixed("fallback-plugin:"),
        shape: "command-file",
      },
    ]);
  });

  it("falls back to the newest cache entry when the install path and commit are unknown", async () => {
    const cacheRoot = path.join(
      claudeDir,
      "plugins",
      "cache",
      "market",
      "tool",
    );
    await installed({
      "tool@market": [
        { scope: "user", installPath: path.join(cacheRoot, "gone") },
      ],
    });
    const oldRoot = path.join(cacheRoot, "old");
    const newRoot = path.join(cacheRoot, "new");
    const manifestless = path.join(cacheRoot, "no-manifest");
    await writePlugin(oldRoot, { name: "tool" });
    await writePlugin(newRoot, { name: "tool" });
    await mkdir(path.join(oldRoot, "skills"), { recursive: true });
    await mkdir(path.join(newRoot, "skills"), { recursive: true });
    await mkdir(path.join(manifestless, "skills"), { recursive: true });
    const now = Date.now() / 1000;
    await utimes(oldRoot, now - 3600, now - 3600);
    await utimes(newRoot, now, now);
    await utimes(manifestless, now + 3600, now + 3600);

    expect(skillPaths(await resolve(null))).toEqual([
      path.join(newRoot, "skills"),
    ]);
  });

  it("names the plugin from the manifest, then the marketplace id, then the directory", async () => {
    const cacheRoot = path.join(claudeDir, "plugins", "cache");
    const namedRoot = path.join(cacheRoot, "market", "named", "1");
    const idRoot = path.join(cacheRoot, "market", "from-id", "1");
    const bareRoot = path.join(homeDir, "bare-dir");
    await installed({
      "named@market": [{ scope: "user", installPath: namedRoot }],
      "from-id@market": [{ scope: "managed", installPath: idRoot }],
      "no-marketplace": [{ scope: "user", installPath: bareRoot }],
    });
    await writePlugin(namedRoot, { name: "manifest-name" });
    await writePlugin(idRoot, {});
    await writePlugin(bareRoot, {});
    for (const root of [namedRoot, idRoot, bareRoot]) {
      await mkdir(path.join(root, "commands"), { recursive: true });
    }

    const roots = await resolve(null);

    expect(roots.commands).toEqual([
      {
        path: path.join(namedRoot, "commands"),
        origin: "user",
        namePrefix: "manifest-name:",
        shape: "commands",
      },
      {
        path: path.join(idRoot, "commands"),
        origin: "user",
        namePrefix: "from-id:",
        shape: "commands",
      },
      {
        path: path.join(bareRoot, "commands"),
        origin: "user",
        namePrefix: "bare-dir:",
        shape: "commands",
      },
    ]);
  });

  it("honors defaultEnabled and lets project, then local settings override user settings", async () => {
    const cacheRoot = path.join(claudeDir, "plugins", "cache", "market");
    const optOutRoot = path.join(cacheRoot, "opt-out", "1");
    const reenabledRoot = path.join(cacheRoot, "reenabled", "1");
    const localOffRoot = path.join(cacheRoot, "local-off", "1");
    const localWinsRoot = path.join(cacheRoot, "local-wins", "1");
    await installed({
      "opt-out@market": [{ scope: "user", installPath: optOutRoot }],
      "reenabled@market": [{ scope: "user", installPath: reenabledRoot }],
      "local-off@market": [{ scope: "user", installPath: localOffRoot }],
      "local-wins@market": [{ scope: "user", installPath: localWinsRoot }],
    });
    await writePlugin(optOutRoot, { name: "opt-out", defaultEnabled: false });
    await writePlugin(reenabledRoot, { name: "reenabled" });
    await writePlugin(localOffRoot, { name: "local-off" });
    await writePlugin(localWinsRoot, {
      name: "local-wins",
      defaultEnabled: false,
    });
    for (const root of [
      optOutRoot,
      reenabledRoot,
      localOffRoot,
      localWinsRoot,
    ]) {
      await mkdir(path.join(root, "skills"), { recursive: true });
    }
    await writeJson(path.join(claudeDir, "settings.json"), {
      enabledPlugins: { "reenabled@market": false, "local-wins@market": true },
    });
    await writeJson(path.join(cwd, ".claude", "settings.json"), {
      enabledPlugins: { "reenabled@market": true },
    });
    await writeJson(path.join(cwd, ".claude", "settings.local.json"), {
      enabledPlugins: { "local-off@market": false, "local-wins@market": false },
    });

    expect(skillPaths(await resolve(cwd))).toEqual([
      path.join(reenabledRoot, "skills"),
    ]);
    expect(skillPaths(await resolve(null))).toEqual([
      path.join(localOffRoot, "skills"),
      path.join(localWinsRoot, "skills"),
    ]);
  });

  it("answers project- and local-scoped installs only for the workspace that holds them", async () => {
    const projectPluginRoot = path.join(
      cwd,
      ".claude",
      "plugins",
      "cache",
      "market",
      "project-plugin",
      "1.0.0",
    );
    const localPluginRoot = path.join(
      cwd,
      ".claude",
      "plugins",
      "cache",
      "market",
      "local-plugin",
      "1.0.0",
    );
    const outsidePluginRoot = path.join(
      tempRoot,
      "elsewhere",
      "outside-plugin",
    );
    await installed({
      "project-plugin@market": [
        { scope: "project", installPath: projectPluginRoot },
      ],
      "local-plugin@market": [{ scope: "local", installPath: localPluginRoot }],
      "outside-plugin@market": [
        { scope: "project", installPath: outsidePluginRoot },
      ],
    });
    await writePlugin(projectPluginRoot, { name: "project-plugin" });
    await mkdir(path.join(projectPluginRoot, "skills"), { recursive: true });
    await writePlugin(localPluginRoot, { name: "local-plugin" });
    await mkdir(path.join(localPluginRoot, "commands"), { recursive: true });
    await writePlugin(outsidePluginRoot, { name: "outside-plugin" });
    await mkdir(path.join(outsidePluginRoot, "skills"), { recursive: true });

    expect(await resolve(null)).toMatchObject({ skills: [], commands: [] });
    expect(
      await resolve(path.join(tempRoot, "unrelated-workspace")),
    ).toMatchObject({ skills: [], commands: [] });
    const workspace = await resolve(cwd);
    expect(workspace.skills).toEqual([
      {
        path: path.join(projectPluginRoot, "skills"),
        origin: "project",
        namePrefix: "project-plugin:",
        shape: "skills",
      },
    ]);
    expect(workspace.commands).toEqual([
      {
        path: path.join(localPluginRoot, "commands"),
        origin: "project",
        namePrefix: "local-plugin:",
        shape: "commands",
      },
    ]);
  });

  it("follows user-origin component symlinks and refuses project-origin ones", async () => {
    const userPluginRoot = path.join(homeDir, "user-plugin");
    const projectPluginRoot = path.join(cwd, "project-plugin");
    await installed({
      "user-plugin@market": [{ scope: "user", installPath: userPluginRoot }],
      "project-plugin@market": [
        { scope: "project", installPath: projectPluginRoot },
      ],
    });
    const skillsTarget = path.join(tempRoot, "shared-skills");
    await writeFileEnsuringDir(
      path.join(skillsTarget, "one", "SKILL.md"),
      "---\n---\n",
    );
    const skillFileTarget = path.join(tempRoot, "shared-SKILL.md");
    await writeFileEnsuringDir(skillFileTarget, "---\n---\n");
    const commandsTarget = path.join(tempRoot, "shared-commands");
    await writeFileEnsuringDir(path.join(commandsTarget, "go.md"), "body");
    for (const pluginRoot of [userPluginRoot, projectPluginRoot]) {
      await writePlugin(pluginRoot, {
        name: path.basename(pluginRoot),
        skills: ["extra/SKILL.md"],
        commands: ["linked-commands"],
      });
      await symlink(skillsTarget, path.join(pluginRoot, "skills"));
      await symlink(skillFileTarget, path.join(pluginRoot, "SKILL.md"));
      await mkdir(path.join(pluginRoot, "extra"), { recursive: true });
      await symlink(
        skillFileTarget,
        path.join(pluginRoot, "extra", "SKILL.md"),
      );
      await symlink(commandsTarget, path.join(pluginRoot, "commands"));
      await symlink(commandsTarget, path.join(pluginRoot, "linked-commands"));
    }

    const roots = await resolve(cwd);

    expect(skillPaths(roots)).toEqual([
      path.join(userPluginRoot, "SKILL.md"),
      path.join(userPluginRoot, "skills"),
      path.join(userPluginRoot, "extra", "SKILL.md"),
    ]);
    expect(roots.skills.every((root) => root.origin === "user")).toBe(true);
    expect(commandPaths(roots)).toEqual([]);
  });

  it("resolves plugins dropped into the project and user skills directories", async () => {
    const userTool = path.join(claudeDir, "skills", "local-tool");
    const userOff = path.join(claudeDir, "skills", "switched-off");
    const linkedTarget = path.join(tempRoot, "linked-tool-target");
    const userLinked = path.join(claudeDir, "skills", "linked-tool");
    const projectTool = path.join(cwd, ".claude", "skills", "project-tool");
    const projectLinked = path.join(cwd, ".claude", "skills", "project-linked");
    await writePlugin(userTool, { name: "local-tool" });
    await writeFileEnsuringDir(
      path.join(userTool, "SKILL.md"),
      "---\nname: root-action\n---\n",
    );
    await mkdir(path.join(userTool, "skills"), { recursive: true });
    await writePlugin(userOff, { name: "switched-off" });
    await mkdir(path.join(userOff, "skills"), { recursive: true });
    await writePlugin(linkedTarget, { name: "linked-tool" });
    await mkdir(path.join(linkedTarget, "skills"), { recursive: true });
    await symlink(linkedTarget, userLinked);
    await writePlugin(projectTool, {});
    await mkdir(path.join(projectTool, "commands"), { recursive: true });
    await symlink(linkedTarget, projectLinked);
    await writeFileEnsuringDir(
      path.join(claudeDir, "skills", "plain", "SKILL.md"),
      "---\n---\n",
    );
    await writeJson(path.join(claudeDir, "settings.json"), {
      enabledPlugins: { "switched-off@skills-dir": false },
    });

    const roots = await resolve(cwd);

    expect(roots.skills).toEqual([
      {
        path: path.join(userLinked, "skills"),
        origin: "user",
        namePrefix: "linked-tool:",
        shape: "skills",
      },
      {
        path: path.join(userTool, "SKILL.md"),
        origin: "user",
        namePrefix: "local-tool:",
        shape: "skill-file",
        fallbackName: "local-tool",
      },
      {
        path: path.join(userTool, "skills"),
        origin: "user",
        namePrefix: "local-tool:",
        shape: "skills",
      },
    ]);
    expect(roots.commands).toEqual([
      {
        path: path.join(projectTool, "commands"),
        origin: "project",
        namePrefix: "project-tool:",
        shape: "commands",
      },
    ]);
  });

  it("answers each path once, first root wins, and ignores malformed vendor files", async () => {
    const pluginRoot = path.join(cwd, "dup-plugin");
    await installed({
      "dup-plugin@market": [
        { scope: "user", installPath: pluginRoot },
        { scope: "project", installPath: pluginRoot },
      ],
      "dup-plugin@other-market": [
        { scope: "project", installPath: pluginRoot },
      ],
    });
    await writePlugin(pluginRoot, {
      name: "dup-plugin",
      skills: ["skills", "./skills/"],
      commands: "commands",
    });
    await mkdir(path.join(pluginRoot, "skills"), { recursive: true });
    await mkdir(path.join(pluginRoot, "commands"), { recursive: true });
    await writeFileEnsuringDir(
      path.join(claudeDir, "settings.json"),
      "{ not json",
    );
    await writeFileEnsuringDir(
      path.join(cwd, ".claude", "settings.json"),
      "[]",
    );

    const roots = await resolve(cwd);

    expect(roots.skills).toEqual([
      {
        path: path.join(pluginRoot, "skills"),
        origin: "user",
        namePrefix: "dup-plugin:",
        shape: "skills",
      },
    ]);
    expect(roots.commands).toEqual([
      {
        path: path.join(pluginRoot, "commands"),
        origin: "user",
        namePrefix: "dup-plugin:",
        shape: "commands",
      },
    ]);
  });
});

describe("experimental_resolveVendorPluginRoots", () => {
  it("lists a grok-layout plugin's manifest entries only, each directory recursive", async () => {
    const pluginRoot = path.join(homeDir, ".grok", "plugins", "tools");
    await writeFileEnsuringDir(
      path.join(pluginRoot, "SKILL.md"),
      "---\nname: root\n---\n",
    );
    await writeFileEnsuringDir(
      path.join(pluginRoot, "skills", "a", "SKILL.md"),
      "",
    );
    await writeFileEnsuringDir(
      path.join(pluginRoot, "custom", "b", "SKILL.md"),
      "",
    );
    await writeFileEnsuringDir(path.join(pluginRoot, "single", "SKILL.md"), "");
    await writeFileEnsuringDir(path.join(pluginRoot, "one", "SKILL.md"), "");

    const roots = await experimental_resolveVendorPluginRoots({
      plugins: [
        {
          rootPath: pluginRoot,
          name: "tools",
          origin: "user",
          skills: ["custom", "single", "one/SKILL.md", "missing", "../escape"],
        },
      ],
      layout: "grok",
    });

    expect(roots).toEqual({
      skills: [
        {
          path: path.join(pluginRoot, "custom"),
          origin: "user",
          recursive: true,
          namePrefix: "tools:",
          shape: "skills",
        },
        {
          path: path.join(pluginRoot, "single"),
          origin: "user",
          recursive: true,
          namePrefix: "tools:",
          shape: "skills",
        },
        {
          path: path.join(pluginRoot, "one", "SKILL.md"),
          origin: "user",
          namePrefix: "tools:",
          shape: "skill-file",
        },
      ],
      commands: [],
    });
  });

  it("keeps a path for the first plugin that names it, across plugins", async () => {
    const outer = path.join(homeDir, "outer");
    const inner = path.join(outer, "inner");
    await mkdir(path.join(inner, "skills"), { recursive: true });
    await mkdir(path.join(inner, "commands"), { recursive: true });

    const roots = await experimental_resolveVendorPluginRoots({
      plugins: [
        {
          rootPath: outer,
          name: "outer",
          origin: "user",
          skills: "inner/skills",
          commands: ["inner/commands"],
        },
        { rootPath: inner, name: "inner", origin: "project" },
      ],
      layout: "claude",
    });

    expect(roots).toEqual({
      skills: [
        {
          path: path.join(inner, "skills"),
          origin: "user",
          namePrefix: "outer:",
          shape: "skills",
        },
      ],
      commands: [
        {
          path: path.join(inner, "commands"),
          origin: "user",
          namePrefix: "outer:",
          shape: "commands",
        },
      ],
    });
  });
});
