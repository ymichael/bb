import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { experimental_nativeRootsResolveOutputSchema } from "@get-bb/plugin-sdk/host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readCodexEnabledPluginSettingsFromToml,
  resolveCodexNativeRoots,
  type CodexResolvedSkillRoot,
} from "./native-roots.js";

let tempRoot: string;
let homeDir: string;
let codexHome: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-native-roots-"));
  homeDir = path.join(tempRoot, "home");
  codexHome = path.join(tempRoot, "codex-home");
  await mkdir(homeDir, { recursive: true });
  await mkdir(codexHome, { recursive: true });
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

async function writePluginManifest(
  pluginRoot: string,
  manifest: unknown,
): Promise<void> {
  await writeFileEnsuringDir(
    path.join(pluginRoot, ".codex-plugin", "plugin.json"),
    JSON.stringify(manifest, null, 2),
  );
}

function cachedPluginRoot(
  marketplace: string,
  plugin: string,
  version: string,
): string {
  return path.join(codexHome, "plugins", "cache", marketplace, plugin, version);
}

async function resolveSkills(
  env: Readonly<Record<string, string | undefined>> = { CODEX_HOME: codexHome },
): Promise<CodexResolvedSkillRoot[]> {
  const answer = await resolveCodexNativeRoots({ homeDir, env });
  expect(answer.commands).toBeUndefined();
  expect(
    experimental_nativeRootsResolveOutputSchema.safeParse(answer).success,
  ).toBe(true);
  return answer.skills ?? [];
}

function homeRoots(home: string): CodexResolvedSkillRoot[] {
  return [
    { path: path.join(home, "skills"), origin: "user", shape: "skills" },
    {
      path: path.join(home, "skills", ".system"),
      origin: "user",
      shape: "skills",
    },
  ];
}

describe("resolveCodexNativeRoots", () => {
  it("answers from ~/.codex when CODEX_HOME is unset or blank", async () => {
    const defaultHome = path.join(homeDir, ".codex");
    expect(await resolveSkills({})).toEqual(homeRoots(defaultHome));
    expect(await resolveSkills({ CODEX_HOME: "   " })).toEqual(
      homeRoots(defaultHome),
    );
  });

  it("follows a moved CODEX_HOME and normalizes its dot segments", async () => {
    expect(await resolveSkills()).toEqual(homeRoots(codexHome));
    const dotted =
      path.join(tempRoot, "elsewhere", "..", "codex-home") + path.sep;
    expect(await resolveSkills({ CODEX_HOME: dotted })).toEqual(
      homeRoots(codexHome),
    );
  });

  it("lists an enabled plugin's default and manifest skill roots with its name prefix", async () => {
    await writeFileEnsuringDir(
      path.join(codexHome, "config.toml"),
      ['[plugins."disabled-plugin@test-market"]', "enabled = false", ""].join(
        "\n",
      ),
    );

    const pluginRoot = cachedPluginRoot("test-market", "local-plugin", "1.0.0");
    await writePluginManifest(pluginRoot, {
      name: "local-plugin",
      skills: [
        "skills",
        "linked-skill/SKILL.md",
        "linked-skills",
        "single",
        "missing",
        "notes.md",
        "../outside",
      ],
    });
    await writeFileEnsuringDir(
      path.join(pluginRoot, "SKILL.md"),
      "---\ndescription: Root Codex plugin skill\n---\n",
    );
    await writeFileEnsuringDir(
      path.join(pluginRoot, "skills", "child-skill", "SKILL.md"),
      "---\ndescription: Child Codex plugin skill\n---\n",
    );
    await writeFileEnsuringDir(
      path.join(pluginRoot, "single", "SKILL.md"),
      "---\ndescription: One skill directory\n---\n",
    );
    await writeFileEnsuringDir(
      path.join(pluginRoot, "notes.md"),
      "not a skill\n",
    );
    await writeFileEnsuringDir(
      path.join(
        codexHome,
        "plugins",
        "cache",
        "test-market",
        "local-plugin",
        "outside",
        "SKILL.md",
      ),
      "---\ndescription: Outside the plugin\n---\n",
    );

    const linkedSkillTarget = path.join(
      tempRoot,
      "codex-linked-plugin-skill.md",
    );
    await writeFileEnsuringDir(
      linkedSkillTarget,
      "---\nname: linked-file-skill\ndescription: Linked Codex file skill\n---\n",
    );
    await mkdir(path.join(pluginRoot, "linked-skill"), { recursive: true });
    await symlink(
      linkedSkillTarget,
      path.join(pluginRoot, "linked-skill", "SKILL.md"),
    );

    const linkedSkillsTarget = path.join(
      tempRoot,
      "codex-linked-plugin-skills",
    );
    await writeFileEnsuringDir(
      path.join(linkedSkillsTarget, "nested-skill", "SKILL.md"),
      "---\ndescription: Linked Codex directory skill\n---\n",
    );
    await symlink(linkedSkillsTarget, path.join(pluginRoot, "linked-skills"));

    const disabledPluginRoot = cachedPluginRoot(
      "test-market",
      "disabled-plugin",
      "1.0.0",
    );
    await writePluginManifest(disabledPluginRoot, { name: "disabled-plugin" });
    await writeFileEnsuringDir(
      path.join(disabledPluginRoot, "skills", "hidden", "SKILL.md"),
      "---\ndescription: Hidden\n---\n",
    );

    await writeFileEnsuringDir(
      path.join(
        cachedPluginRoot("test-market", "not-a-plugin", "1.0.0"),
        "skills",
        "x",
        "SKILL.md",
      ),
      "---\ndescription: No manifest\n---\n",
    );

    const skills = await resolveSkills();
    const namePrefix = "local-plugin:";
    expect(skills).toEqual([
      ...homeRoots(codexHome),
      {
        path: path.join(pluginRoot, "SKILL.md"),
        origin: "user",
        namePrefix,
        shape: "skill-file",
        fallbackName: "local-plugin",
      },
      {
        path: path.join(pluginRoot, "skills"),
        origin: "user",
        namePrefix,
        shape: "skills",
      },
      {
        path: path.join(pluginRoot, "linked-skill", "SKILL.md"),
        origin: "user",
        namePrefix,
        shape: "skill-file",
      },
      {
        path: path.join(pluginRoot, "linked-skills"),
        origin: "user",
        namePrefix,
        shape: "skills",
      },
      {
        path: path.join(pluginRoot, "single"),
        origin: "user",
        namePrefix,
        shape: "skill",
      },
    ]);
  });

  it("names a plugin after its cache directory when the manifest has no name", async () => {
    const pluginRoot = cachedPluginRoot("market", "dir-named", "2.0.0");
    await writePluginManifest(pluginRoot, {});
    await mkdir(path.join(pluginRoot, "skills"), { recursive: true });

    const skills = await resolveSkills();
    expect(skills.slice(2)).toEqual([
      {
        path: path.join(pluginRoot, "skills"),
        origin: "user",
        namePrefix: "dir-named:",
        shape: "skills",
      },
    ]);
  });

  it("reads the most recently modified cached install that has a manifest", async () => {
    const olderRoot = cachedPluginRoot("market", "versioned", "1.0.0");
    const newerRoot = cachedPluginRoot("market", "versioned", "1.1.0");
    const newestWithoutManifest = cachedPluginRoot(
      "market",
      "versioned",
      "2.0.0",
    );
    for (const root of [olderRoot, newerRoot]) {
      await writePluginManifest(root, { name: "versioned" });
      await mkdir(path.join(root, "skills"), { recursive: true });
    }
    await mkdir(path.join(newestWithoutManifest, "skills"), {
      recursive: true,
    });
    const base = Date.now() / 1000;
    await utimes(olderRoot, base - 300, base - 300);
    await utimes(newerRoot, base - 200, base - 200);
    await utimes(newestWithoutManifest, base - 100, base - 100);

    const skills = await resolveSkills();
    expect(skills.slice(2).map((root) => root.path)).toEqual([
      path.join(newerRoot, "skills"),
    ]);
  });

  it("orders plugins by marketplace then plugin name and skips marketplace files", async () => {
    for (const [marketplace, plugin] of [
      ["zeta-market", "alpha"],
      ["alpha-market", "zulu"],
      ["alpha-market", "beta"],
    ] as const) {
      const root = cachedPluginRoot(marketplace, plugin, "1.0.0");
      await writePluginManifest(root, { name: plugin });
      await mkdir(path.join(root, "skills"), { recursive: true });
    }
    await writeFileEnsuringDir(
      path.join(codexHome, "plugins", "cache", "README.md"),
      "",
    );

    const skills = await resolveSkills();
    expect(skills.slice(2).map((root) => root.namePrefix)).toEqual([
      "beta:",
      "zulu:",
      "alpha:",
    ]);
  });

  it("skips a plugin whose manifest is not JSON or names a non-string", async () => {
    const brokenRoot = cachedPluginRoot("market", "broken", "1.0.0");
    await writeFileEnsuringDir(
      path.join(brokenRoot, ".codex-plugin", "plugin.json"),
      "{ not json",
    );
    await mkdir(path.join(brokenRoot, "skills"), { recursive: true });
    const wrongTypeRoot = cachedPluginRoot("market", "wrong-type", "1.0.0");
    await writePluginManifest(wrongTypeRoot, { name: 42 });
    await mkdir(path.join(wrongTypeRoot, "skills"), { recursive: true });

    expect(await resolveSkills()).toEqual(homeRoots(codexHome));
  });
});

describe("readCodexEnabledPluginSettingsFromToml", () => {
  it("reads bare and quoted plugin tables with comments and escapes", () => {
    const enabled = readCodexEnabledPluginSettingsFromToml(
      [
        "[plugins]",
        "enabled = false # a [plugins] table key, not a plugin",
        "",
        "[plugins.bare@market]  # trailing comment",
        "enabled = false",
        "",
        '  [plugins."quoted plugin@market"]',
        "  enabled = true   # re-enabled",
        "",
        '[plugins."esc\\"aped\\\\@market"]',
        "enabled=false",
        "",
        '[plugins."tab\\tname@market"]',
        "enabled = false",
      ].join("\n"),
    );
    expect([...enabled.entries()]).toEqual([
      ["bare@market", false],
      ["quoted plugin@market", true],
      ['esc"aped\\@market', false],
      ["tab\tname@market", false],
    ]);
  });

  it("ends a plugin table at the next table header and keeps the last value", () => {
    const enabled = readCodexEnabledPluginSettingsFromToml(
      [
        "[plugins.first@market]",
        "enabled = false",
        "enabled = true",
        "[other]",
        "enabled = false",
        "[plugins.second@market]",
        "other_key = 1",
        "enabled = maybe",
      ].join("\r\n"),
    );
    expect([...enabled.entries()]).toEqual([["first@market", true]]);
  });
});

describe("resolveCodexNativeRoots contract filtering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops only the roots of a plugin whose name cannot be a name prefix", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const plugins: [directory: string, manifest: Record<string, unknown>][] = [
      ["good-a", { name: "good-a" }],
      ["good-b", { name: "good-b" }],
      ["spaced", { name: "bad name" }],
      ["scoped", { name: "@scope/x" }],
      ["long", { name: "a".repeat(70) }],
      [".hidden", {}],
    ];
    for (const [directory, manifest] of plugins) {
      const root = cachedPluginRoot("test-market", directory, "1.0.0");
      await writePluginManifest(root, manifest);
      await mkdir(path.join(root, "skills"), { recursive: true });
    }

    const skills = await resolveSkills();

    expect(skills).toEqual([
      ...homeRoots(codexHome),
      {
        path: path.join(
          cachedPluginRoot("test-market", "good-a", "1.0.0"),
          "skills",
        ),
        origin: "user",
        namePrefix: "good-a:",
        shape: "skills",
      },
      {
        path: path.join(
          cachedPluginRoot("test-market", "good-b", "1.0.0"),
          "skills",
        ),
        origin: "user",
        namePrefix: "good-b:",
        shape: "skills",
      },
    ]);
    expect(warn).toHaveBeenCalledTimes(4);
    const messages = warn.mock.calls.map(([message]) => String(message));
    for (const directory of ["spaced", "scoped", "long", ".hidden"]) {
      const dropped = path.join(
        cachedPluginRoot("test-market", directory, "1.0.0"),
        "skills",
      );
      expect(messages.some((message) => message.includes(`"${dropped}"`))).toBe(
        true,
      );
    }
  });
});
