import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ExperimentalClaudePluginRoots,
  ExperimentalVendorPluginRoots,
} from "@get-bb/plugin-sdk/host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  filterClaudeNativeRoots,
  resolveClaudeNativeRoots,
} from "./native-roots.js";

interface Fixture {
  cwd: string;
  homeDir: string;
  claudeDir: string;
}

let tempRoot: string;

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

async function makeFixture(): Promise<Fixture> {
  const homeDir = path.join(tempRoot, "home");
  const cwd = path.join(tempRoot, "workspace");
  await mkdir(homeDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  return { cwd, homeDir, claudeDir: path.join(homeDir, ".claude") };
}

function resolve(
  fixture: Fixture,
  cwd: string | null,
  env: Record<string, string | undefined> = {},
): Promise<ExperimentalVendorPluginRoots> {
  return resolveClaudeNativeRoots({ cwd, homeDir: fixture.homeDir, env });
}

function skillPaths(roots: ExperimentalVendorPluginRoots): string[] {
  return roots.skills.map((root) => root.path);
}

function commandPaths(roots: ExperimentalVendorPluginRoots): string[] {
  return roots.commands.map((root) => root.path);
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

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), "bb-claude-native-roots-"));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("resolveClaudeNativeRoots", () => {
  it("always answers the user skills and commands directories, even when nothing exists", async () => {
    const fixture = await makeFixture();

    const roots = await resolve(fixture, null);

    expect(roots).toEqual({
      skills: [
        {
          path: path.join(fixture.claudeDir, "skills"),
          origin: "user",
          shape: "skills",
          skipIfManifest: ".claude-plugin/plugin.json",
        },
      ],
      commands: [
        {
          path: path.join(fixture.claudeDir, "commands"),
          origin: "user",
          shape: "commands",
        },
      ],
    });
  });

  it("reads the user directories and the plugin registry from CLAUDE_CONFIG_DIR", async () => {
    const fixture = await makeFixture();
    const movedDir = path.join(fixture.homeDir, "custom-claude");
    const pluginRoot = path.join(fixture.homeDir, "moved-plugin");
    await writeJson(path.join(movedDir, "plugins", "installed_plugins.json"), {
      version: 2,
      plugins: {
        "moved-plugin@market": [{ scope: "user", installPath: pluginRoot }],
      },
    });
    await writePlugin(pluginRoot, { name: "moved-plugin" });
    await mkdir(path.join(pluginRoot, "skills"), { recursive: true });
    await writeJson(
      path.join(fixture.claudeDir, "plugins", "installed_plugins.json"),
      {
        version: 2,
        plugins: {
          "stale-plugin@market": [
            {
              scope: "user",
              installPath: path.join(fixture.claudeDir, "stale"),
            },
          ],
        },
      },
    );
    await writePlugin(path.join(fixture.claudeDir, "stale"), {
      name: "stale-plugin",
    });
    await mkdir(path.join(fixture.claudeDir, "stale", "skills"), {
      recursive: true,
    });

    const roots = await resolve(fixture, fixture.cwd, {
      CLAUDE_CONFIG_DIR: "custom-claude",
    });

    expect(skillPaths(roots)).toEqual([
      path.join(movedDir, "skills"),
      path.join(pluginRoot, "skills"),
    ]);
    expect(commandPaths(roots)).toEqual([path.join(movedDir, "commands")]);
    expect(roots.skills[1]).toMatchObject({
      origin: "user",
      namePrefix: "moved-plugin:",
      shape: "skills",
    });
  });

  it("keeps the user root, unprefixed, when a plugin installed at the config directory claims its path", async () => {
    const fixture = await makeFixture();
    await writeJson(
      path.join(fixture.claudeDir, "plugins", "installed_plugins.json"),
      {
        version: 2,
        plugins: {
          "home-plugin@local": [
            { scope: "user", installPath: fixture.claudeDir },
          ],
        },
      },
    );
    await writePlugin(fixture.claudeDir, {
      name: "home-plugin",
      skills: ["skills"],
      commands: "commands",
    });
    await writeFileEnsuringDir(path.join(fixture.claudeDir, "SKILL.md"), "");
    await mkdir(path.join(fixture.claudeDir, "skills"), { recursive: true });
    await mkdir(path.join(fixture.claudeDir, "commands"), { recursive: true });

    const roots = await resolve(fixture, fixture.cwd);

    expect(roots).toEqual({
      skills: [
        {
          path: path.join(fixture.claudeDir, "skills"),
          origin: "user",
          shape: "skills",
          skipIfManifest: ".claude-plugin/plugin.json",
        },
        {
          path: path.join(fixture.claudeDir, "SKILL.md"),
          origin: "user",
          namePrefix: "home-plugin:",
          shape: "skill-file",
          fallbackName: "home-plugin",
        },
      ],
      commands: [
        {
          path: path.join(fixture.claudeDir, "commands"),
          origin: "user",
          shape: "commands",
        },
      ],
    });
  });
});

describe("resolveClaudeNativeRoots contract filtering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops only the roots of a plugin whose name cannot be a name prefix", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fixture = await makeFixture();
    const cacheRoot = path.join(
      fixture.claudeDir,
      "plugins",
      "cache",
      "market",
    );
    const goodA = path.join(cacheRoot, "good-a", "1");
    const goodB = path.join(cacheRoot, "good-b", "1");
    const spaced = path.join(cacheRoot, "spaced", "1");
    const scoped = path.join(cacheRoot, "scoped", "1");
    const long = path.join(cacheRoot, "long", "1");
    const hidden = path.join(fixture.homeDir, ".hidden");
    await writeJson(
      path.join(fixture.claudeDir, "plugins", "installed_plugins.json"),
      {
        version: 2,
        plugins: {
          "good-a@market": [{ scope: "user", installPath: goodA }],
          "spaced@market": [{ scope: "user", installPath: spaced }],
          "scoped@market": [{ scope: "user", installPath: scoped }],
          "long@market": [{ scope: "user", installPath: long }],
          "no-marketplace": [{ scope: "user", installPath: hidden }],
          "good-b@market": [{ scope: "user", installPath: goodB }],
        },
      },
    );
    await writePlugin(goodA, { name: "good-a" });
    await writePlugin(goodB, { name: "good-b" });
    await writePlugin(spaced, { name: "bad name" });
    await writePlugin(scoped, { name: "@scope/x" });
    await writePlugin(long, { name: "a".repeat(70) });
    await writePlugin(hidden, {});
    for (const root of [goodA, goodB, spaced, scoped, long, hidden]) {
      await mkdir(path.join(root, "skills"), { recursive: true });
      await mkdir(path.join(root, "commands"), { recursive: true });
    }

    const roots = await resolve(fixture, null);

    expect(skillPaths(roots)).toEqual([
      path.join(fixture.claudeDir, "skills"),
      path.join(goodA, "skills"),
      path.join(goodB, "skills"),
    ]);
    expect(commandPaths(roots)).toEqual([
      path.join(fixture.claudeDir, "commands"),
      path.join(goodA, "commands"),
      path.join(goodB, "commands"),
    ]);
    expect(warn).toHaveBeenCalledTimes(8);
    const messages = warn.mock.calls.map(([message]) => String(message));
    for (const root of [spaced, scoped, long, hidden]) {
      for (const side of ["skills", "commands"]) {
        expect(
          messages.some((message) =>
            message.includes(`"${path.join(root, side)}"`),
          ),
        ).toBe(true);
      }
    }
  });

  it("keeps the first 256 command roots of 260 plugins and warns once", () => {
    const warn = vi.fn();
    const claudeDir = path.join(
      path.parse(process.cwd()).root,
      "claude-config",
    );
    const cacheRoot = path.join(claudeDir, "plugins", "cache", "market");
    const pluginCommands: ExperimentalClaudePluginRoots["commands"] =
      Array.from({ length: 260 }, (_, index) => {
        const name = `plugin-${String(index).padStart(3, "0")}`;
        return {
          path: path.join(cacheRoot, name, "1", "commands"),
          origin: "user",
          namePrefix: `${name}:`,
          shape: "commands",
        };
      });

    const roots = filterClaudeNativeRoots(
      { claudeDir, skills: [], commands: pluginCommands },
      warn,
    );

    expect(roots.commands).toHaveLength(256);
    expect(commandPaths(roots).slice(0, 2)).toEqual([
      path.join(claudeDir, "commands"),
      path.join(cacheRoot, "plugin-000", "1", "commands"),
    ]);
    expect(roots.commands[255]?.namePrefix).toBe("plugin-254:");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `resolveNativeRoots: kept the first 256 of 261 commands roots; dropped 5 from "${path.join(cacheRoot, "plugin-255", "1", "commands")}" on`,
    );
  });
});
