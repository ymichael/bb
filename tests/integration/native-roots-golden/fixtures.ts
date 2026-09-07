import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const PROVIDER_IDS = [
  "claude-code",
  "codex",
  "pi",
  "acp-cursor",
  "acp-opencode",
  "acp-omp",
  "acp-grok",
  "acp-hermes-agent",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const NATIVE_ROOT_ENV_KEYS = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "OPENCODE_CONFIG_DIR",
  "OMP_PROFILE",
  "PI_PROFILE",
  "PI_CODING_AGENT_DIR",
  "PI_CONFIG_FILES",
  "GROK_HOME",
  "GROK_CLAUDE_SKILLS_ENABLED",
  "GROK_CURSOR_SKILLS_ENABLED",
  "HERMES_HOME",
] as const;
export type NativeRootEnvKey = (typeof NATIVE_ROOT_ENV_KEYS)[number];
export type FixtureEnv = Partial<Record<NativeRootEnvKey, string>>;

export interface FixturePaths {
  root: string;
  home: string;
  workspace: string;
  cwd: string;
}

export interface ExpectedNames {
  present: readonly string[];
  absent: readonly string[];
}

export interface FixtureVariant {
  providerId: ProviderId;
  variant: string;
  env: (paths: FixturePaths) => FixtureEnv;
  build: (paths: FixturePaths) => Promise<void>;
  expected: { workspace: ExpectedNames; userOnly: ExpectedNames };
}

export async function createFixturePaths(): Promise<FixturePaths> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "bb-native-roots-golden-")),
  );
  const home = path.join(root, "home");
  const workspace = path.join(root, "ws");
  const cwd = path.join(workspace, "packages", "app");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(path.join(workspace, ".git"), { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  return { root, home, workspace, cwd };
}

export async function removeFixturePaths(paths: FixturePaths): Promise<void> {
  await fs.rm(paths.root, { recursive: true, force: true });
}

async function writeText(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function skillFileContent(args: {
  name?: string;
  description: string;
}): string {
  const nameLine = args.name === undefined ? "" : `name: ${args.name}\n`;
  return `---\n${nameLine}description: ${args.description}\n---\n# Skill body\n`;
}

async function writeSkill(
  skillsDir: string,
  name: string,
  description = `${name} skill`,
): Promise<void> {
  await writeText(
    path.join(skillsDir, name, "SKILL.md"),
    skillFileContent({ name, description }),
  );
}

async function writeCommand(
  commandsDir: string,
  relativeFile: string,
  description: string,
  argumentHint?: string,
): Promise<void> {
  const hintLine =
    argumentHint === undefined ? "" : `argument-hint: ${argumentHint}\n`;
  await writeText(
    path.join(commandsDir, ...relativeFile.split("/")),
    `---\ndescription: ${description}\n${hintLine}---\nCommand body\n`,
  );
}

async function symlinkDir(target: string, linkPath: string): Promise<void> {
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  await fs.symlink(target, linkPath, "dir");
}

async function writeLinkedSkillsRoot(
  linkPath: string,
  targetDir: string,
  name: string,
): Promise<void> {
  await writeSkill(targetDir, name);
  await symlinkDir(targetDir, linkPath);
}

async function writeLinkedSkill(
  paths: FixturePaths,
  skillsDir: string,
  name: string,
): Promise<void> {
  const target = path.join(paths.root, "linked-skills", name);
  await writeSkill(path.join(paths.root, "linked-skills"), name);
  await symlinkDir(target, path.join(skillsDir, name));
}

const CLAUDE_PLUGIN_MANIFEST = path.join(".claude-plugin", "plugin.json");

async function writeSimpleClaudePlugin(
  pluginRoot: string,
  name: string,
  manifestExtra: Record<string, unknown> = {},
  options: { command?: boolean } = {},
): Promise<void> {
  await writeJson(path.join(pluginRoot, CLAUDE_PLUGIN_MANIFEST), {
    name,
    ...manifestExtra,
  });
  await writeSkill(path.join(pluginRoot, "skills"), `${name}-skill`);
  if (options.command) {
    await writeCommand(
      path.join(pluginRoot, "commands"),
      `${name}-cmd.md`,
      `${name} command`,
    );
  }
}

async function writeClaudePluginInstall(
  paths: FixturePaths,
  claudeDir: string,
): Promise<void> {
  const { root, home, workspace, cwd } = paths;
  const cache = (name: string, version: string): string =>
    path.join(claudeDir, "plugins", "cache", "golden-market", name, version);
  const userPluginRoot = cache("user-plugin", "1.0.0");
  const cachePluginRoot = cache("cache-plugin", "0123456789ab");
  const tildePluginRoot = path.join(
    home,
    ".claude",
    "plugins",
    "cache",
    "golden-market",
    "tilde-plugin",
    "1.0.0",
  );
  const managedPluginRoot = path.join(
    root,
    "managed-plugins",
    "managed-plugin",
  );
  const projectPluginRoot = path.join(
    cwd,
    ".claude",
    "plugins",
    "cache",
    "golden-market",
    "project-plugin",
    "1.0.0",
  );
  const localPluginRoot = path.join(cwd, ".claude", "plugins", "local-plugin");
  const outsidePluginRoot = path.join(
    workspace,
    ".claude",
    "plugins",
    "outside-plugin",
  );

  await writeJson(path.join(claudeDir, "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: {
      "user-plugin@golden-market": [
        { scope: "user", installPath: userPluginRoot },
      ],
      "cache-plugin@golden-market": [
        {
          scope: "user",
          installPath: cache("cache-plugin", "missing"),
          gitCommitSha: "0123456789abcdef0123456789abcdef01234567",
        },
      ],
      "disabled-plugin@golden-market": [
        { scope: "user", installPath: cache("disabled-plugin", "1.0.0") },
      ],
      "default-off-plugin@golden-market": [
        { scope: "user", installPath: cache("default-off-plugin", "1.0.0") },
      ],
      "tilde-plugin@golden-market": [
        {
          scope: "user",
          installPath:
            "~/.claude/plugins/cache/golden-market/tilde-plugin/1.0.0",
        },
      ],
      "managed-plugin@golden-market": [
        { scope: "managed", installPath: managedPluginRoot },
      ],
      "project-plugin@golden-market": [
        { scope: "project", installPath: projectPluginRoot },
      ],
      "local-plugin@golden-market": [
        { scope: "local", installPath: localPluginRoot },
      ],
      "outside-plugin@golden-market": [
        { scope: "project", installPath: outsidePluginRoot },
      ],
    },
  });
  await writeJson(path.join(claudeDir, "settings.json"), {
    enabledPlugins: {
      "user-plugin@golden-market": true,
      "cache-plugin@golden-market": true,
      "disabled-plugin@golden-market": false,
      "tilde-plugin@golden-market": true,
    },
  });
  await writeJson(path.join(cwd, ".claude", "settings.json"), {
    enabledPlugins: {
      "project-plugin@golden-market": true,
      "outside-plugin@golden-market": true,
    },
  });
  await writeJson(path.join(cwd, ".claude", "settings.local.json"), {
    enabledPlugins: { "local-plugin@golden-market": true },
  });

  await writeJson(path.join(userPluginRoot, CLAUDE_PLUGIN_MANIFEST), {
    name: "user-plugin",
    skills: ["skills", "extra-skill/SKILL.md"],
    commands: ["commands", "extra-commands/deploy.md"],
  });
  await writeText(
    path.join(userPluginRoot, "SKILL.md"),
    skillFileContent({ description: "User plugin root skill" }),
  );
  await writeSkill(path.join(userPluginRoot, "skills"), "user-plugin-skill");
  await writeText(
    path.join(userPluginRoot, "extra-skill", "SKILL.md"),
    skillFileContent({
      name: "user-plugin-extra",
      description: "User plugin single-file skill",
    }),
  );
  await writeCommand(
    path.join(userPluginRoot, "commands"),
    "user-plugin-cmd.md",
    "User plugin command",
    "<target>",
  );
  await writeCommand(
    path.join(userPluginRoot, "extra-commands"),
    "deploy.md",
    "User plugin single-file command",
  );

  await writeSimpleClaudePlugin(cachePluginRoot, "cache-plugin");
  await writeSimpleClaudePlugin(
    cache("disabled-plugin", "1.0.0"),
    "disabled-plugin",
  );
  await writeSimpleClaudePlugin(
    cache("default-off-plugin", "1.0.0"),
    "default-off-plugin",
    { defaultEnabled: false },
  );
  await writeSimpleClaudePlugin(tildePluginRoot, "tilde-plugin");
  await writeSimpleClaudePlugin(managedPluginRoot, "managed-plugin");
  await writeSimpleClaudePlugin(
    projectPluginRoot,
    "project-plugin",
    {},
    {
      command: true,
    },
  );
  await writeSimpleClaudePlugin(localPluginRoot, "local-plugin");
  await writeSimpleClaudePlugin(outsidePluginRoot, "outside-plugin");

  for (const [skillsRoot, name] of [
    [path.join(cwd, ".claude", "skills"), "cwd-skills-dir-plugin"],
    [path.join(claudeDir, "skills"), "home-skills-dir-plugin"],
  ] as const) {
    const pluginRoot = path.join(skillsRoot, name);
    await writeJson(path.join(pluginRoot, CLAUDE_PLUGIN_MANIFEST), { name });
    await writeText(
      path.join(pluginRoot, "SKILL.md"),
      skillFileContent({
        name: `${name}-root`,
        description: `${name} root skill`,
      }),
    );
    await writeSkill(path.join(pluginRoot, "skills"), `${name}-child`);
  }
}

const CLAUDE_PLUGIN_USER_SKILLS = [
  "user-plugin:user-plugin",
  "user-plugin:user-plugin-skill",
  "user-plugin:user-plugin-extra",
  "cache-plugin:cache-plugin-skill",
  "tilde-plugin:tilde-plugin-skill",
  "managed-plugin:managed-plugin-skill",
  "home-skills-dir-plugin:home-skills-dir-plugin-root",
  "home-skills-dir-plugin:home-skills-dir-plugin-child",
] as const;
const CLAUDE_PLUGIN_USER_COMMANDS = [
  "user-plugin:user-plugin-cmd",
  "user-plugin:deploy",
] as const;
const CLAUDE_PLUGIN_PROJECT_SKILLS = [
  "project-plugin:project-plugin-skill",
  "local-plugin:local-plugin-skill",
  "cwd-skills-dir-plugin:cwd-skills-dir-plugin-root",
  "cwd-skills-dir-plugin:cwd-skills-dir-plugin-child",
] as const;
const CLAUDE_PLUGIN_PROJECT_COMMANDS = [
  "project-plugin:project-plugin-cmd",
] as const;
const CLAUDE_PLUGIN_ABSENT = [
  "disabled-plugin:disabled-plugin-skill",
  "default-off-plugin:default-off-plugin-skill",
  "outside-plugin:outside-plugin-skill",
] as const;

async function buildClaudeCode(
  paths: FixturePaths,
  claudeDir: string,
): Promise<void> {
  const { root, home, workspace, cwd } = paths;
  await writeSkill(path.join(cwd, ".claude", "skills"), "cwd-claude-skill");
  await writeSkill(
    path.join(workspace, ".claude", "skills"),
    "ws-claude-skill",
  );
  await writeSkill(
    path.join(workspace, "packages", ".claude", "skills"),
    "pkg-claude-skill",
  );
  await writeSkill(
    path.join(root, ".claude", "skills"),
    "above-root-claude-skill",
  );
  await writeSkill(path.join(home, ".claude", "skills"), "home-claude-skill");
  await writeLinkedSkill(
    paths,
    path.join(home, ".claude", "skills"),
    "linked-home-skill",
  );
  if (claudeDir !== path.join(home, ".claude")) {
    await writeSkill(path.join(claudeDir, "skills"), "configdir-claude-skill");
  }
  await writeCommand(
    path.join(cwd, ".claude", "commands"),
    "cwd-review.md",
    "Review the diff",
  );
  await writeCommand(
    path.join(cwd, ".claude", "commands"),
    "frontend/cwd-component.md",
    "Scaffold a component",
    "<name>",
  );
  await writeCommand(
    path.join(workspace, ".claude", "commands"),
    "ws-command.md",
    "Repo root command (not scanned)",
  );
  await writeCommand(
    path.join(claudeDir, "commands"),
    "home-lint.md",
    "Lint everything",
  );
  await writeClaudePluginInstall(paths, claudeDir);
}

const CLAUDE_USER_NAMES = [
  "home-claude-skill",
  "linked-home-skill",
  "home-lint",
  ...CLAUDE_PLUGIN_USER_SKILLS,
  ...CLAUDE_PLUGIN_USER_COMMANDS,
];
const CLAUDE_PROJECT_NAMES = [
  "cwd-claude-skill",
  "ws-claude-skill",
  "pkg-claude-skill",
  "cwd-review",
  "frontend:cwd-component",
  ...CLAUDE_PLUGIN_PROJECT_SKILLS,
  ...CLAUDE_PLUGIN_PROJECT_COMMANDS,
];
const CLAUDE_ABSENT = [
  "ws-command",
  "above-root-claude-skill",
  ...CLAUDE_PLUGIN_ABSENT,
];

function claudeCodeVariant(
  variant: string,
  claudeDirFor: (paths: FixturePaths) => string,
  env: (paths: FixturePaths) => FixtureEnv,
  extraUserNames: readonly string[],
): FixtureVariant {
  return {
    providerId: "claude-code",
    variant,
    env,
    build: (paths) => buildClaudeCode(paths, claudeDirFor(paths)),
    expected: {
      workspace: {
        present: [
          ...CLAUDE_PROJECT_NAMES,
          ...CLAUDE_USER_NAMES,
          ...extraUserNames,
        ],
        absent: CLAUDE_ABSENT,
      },
      userOnly: {
        present: [...CLAUDE_USER_NAMES, ...extraUserNames],
        absent: [...CLAUDE_ABSENT, ...CLAUDE_PROJECT_NAMES],
      },
    },
  };
}

async function writeCodexPlugin(
  pluginRoot: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  await writeJson(
    path.join(pluginRoot, ".codex-plugin", "plugin.json"),
    manifest,
  );
}

async function buildCodex(
  paths: FixturePaths,
  codexHome: string,
): Promise<void> {
  const { root, home, workspace, cwd } = paths;
  await writeSkill(path.join(cwd, ".codex", "skills"), "cwd-codex-skill");
  await writeSkill(path.join(cwd, ".agents", "skills"), "cwd-agents-skill");
  await writeSkill(
    path.join(workspace, ".agents", "skills"),
    "ws-agents-skill",
  );
  await writeSkill(
    path.join(workspace, "packages", ".agents", "skills"),
    "pkg-agents-skill",
  );
  await writeSkill(
    path.join(root, ".agents", "skills"),
    "above-root-agents-skill",
  );
  await writeSkill(path.join(workspace, ".codex", "skills"), "ws-codex-skill");
  await writeSkill(path.join(home, ".codex", "skills"), "home-codex-skill");
  await writeSkill(path.join(home, ".agents", "skills"), "home-agents-skill");
  await writeLinkedSkill(
    paths,
    path.join(home, ".agents", "skills"),
    "linked-agents-skill",
  );
  await writeSkill(
    path.join(codexHome, "skills", ".system"),
    "system-codex-skill",
  );
  if (codexHome !== path.join(home, ".codex")) {
    await writeSkill(path.join(codexHome, "skills"), "codexhome-skill");
  }
  await writeText(
    path.join(codexHome, "config.toml"),
    [
      '[plugins."codex-plugin@golden-market"]',
      "enabled = true",
      '[plugins."disabled-plugin@golden-market"]',
      "enabled = false",
      "",
    ].join("\n"),
  );
  const cache = (name: string): string =>
    path.join(codexHome, "plugins", "cache", "golden-market", name, "1.0.0");
  const codexPluginRoot = cache("codex-plugin");
  await writeCodexPlugin(codexPluginRoot, {
    name: "codex-plugin",
    skills: ["skills", "extra-skill/SKILL.md"],
  });
  await writeText(
    path.join(codexPluginRoot, "SKILL.md"),
    skillFileContent({ description: "Codex plugin root skill" }),
  );
  await writeSkill(path.join(codexPluginRoot, "skills"), "codex-plugin-skill");
  await writeText(
    path.join(codexPluginRoot, "extra-skill", "SKILL.md"),
    skillFileContent({
      name: "codex-plugin-extra",
      description: "Codex plugin single-file skill",
    }),
  );
  await writeCodexPlugin(cache("disabled-plugin"), { name: "disabled-plugin" });
  await writeSkill(
    path.join(cache("disabled-plugin"), "skills"),
    "disabled-plugin-skill",
  );
  await writeCodexPlugin(cache("unlisted-plugin"), { name: "unlisted-plugin" });
  await writeSkill(
    path.join(cache("unlisted-plugin"), "skills"),
    "unlisted-plugin-skill",
  );
}

const CODEX_USER_NAMES = [
  "home-codex-skill",
  "home-agents-skill",
  "linked-agents-skill",
  "system-codex-skill",
  "codex-plugin:codex-plugin",
  "codex-plugin:codex-plugin-skill",
  "codex-plugin:codex-plugin-extra",
  "unlisted-plugin:unlisted-plugin-skill",
];
const CODEX_PROJECT_NAMES = [
  "cwd-codex-skill",
  "cwd-agents-skill",
  "ws-agents-skill",
  "pkg-agents-skill",
];
const CODEX_ABSENT = [
  "ws-codex-skill",
  "above-root-agents-skill",
  "disabled-plugin:disabled-plugin-skill",
];

function codexVariant(
  variant: string,
  codexHomeFor: (paths: FixturePaths) => string,
  env: (paths: FixturePaths) => FixtureEnv,
  extraUserNames: readonly string[],
): FixtureVariant {
  return {
    providerId: "codex",
    variant,
    env,
    build: (paths) => buildCodex(paths, codexHomeFor(paths)),
    expected: {
      workspace: {
        present: [
          ...CODEX_PROJECT_NAMES,
          ...CODEX_USER_NAMES,
          ...extraUserNames,
        ],
        absent: CODEX_ABSENT,
      },
      userOnly: {
        present: [...CODEX_USER_NAMES, ...extraUserNames],
        absent: [...CODEX_ABSENT, ...CODEX_PROJECT_NAMES],
      },
    },
  };
}

async function buildPi(paths: FixturePaths, agentDir: string): Promise<void> {
  const { root, home, workspace, cwd } = paths;
  await writeSkill(path.join(cwd, ".pi", "skills"), "cwd-pi-skill");
  await writeSkill(path.join(cwd, ".agents", "skills"), "cwd-agents-skill");
  await writeSkill(path.join(workspace, ".pi", "skills"), "ws-pi-skill");
  await writeSkill(
    path.join(home, ".pi", "agent", "skills"),
    "home-pi-agent-skill",
  );
  await writeSkill(path.join(home, ".agents", "skills"), "home-agents-skill");
  await writeSkill(path.join(root, "pi-agent", "skills"), "moved-agent-skill");
  await writeJson(path.join(agentDir, "settings.json"), {
    skills: [
      "~/pi-settings-user",
      path.join(root, "pi-settings-abs"),
      "relative-skills",
      "~/.pi/agent/skills",
      "one/SKILL.md",
      "npm:@acme/pi-skills",
      "!disabled-pattern",
    ],
  });
  await writeSkill(path.join(home, "pi-settings-user"), "settings-user-skill");
  await writeSkill(path.join(root, "pi-settings-abs"), "settings-abs-skill");
  await writeSkill(
    path.join(agentDir, "relative-skills"),
    "settings-relative-skill",
  );
  await writeText(
    path.join(agentDir, "one", "SKILL.md"),
    skillFileContent({
      name: "settings-file-skill",
      description: "Single-file settings entry",
    }),
  );
}

const PI_PROJECT_NAMES = ["cwd-pi-skill", "cwd-agents-skill"];
const PI_USER_NAMES = [
  "home-pi-agent-skill",
  "home-agents-skill",
  "settings-user-skill",
  "settings-abs-skill",
  "settings-relative-skill",
];
const PI_ABSENT = ["ws-pi-skill", "settings-file-skill"];

function piVariant(
  variant: string,
  agentDirFor: (paths: FixturePaths) => string,
  env: (paths: FixturePaths) => FixtureEnv,
  movedAgentDir: boolean,
): FixtureVariant {
  const userNames = movedAgentDir
    ? [...PI_USER_NAMES, "moved-agent-skill"]
    : PI_USER_NAMES;
  const absent = movedAgentDir
    ? PI_ABSENT
    : [...PI_ABSENT, "moved-agent-skill"];
  return {
    providerId: "pi",
    variant,
    env,
    build: (paths) => buildPi(paths, agentDirFor(paths)),
    expected: {
      workspace: { present: [...PI_PROJECT_NAMES, ...userNames], absent },
      userOnly: {
        present: userNames,
        absent: [...absent, ...PI_PROJECT_NAMES],
      },
    },
  };
}

const CURSOR_DIRS = [".cursor", ".agents", ".claude", ".codex"] as const;

async function buildCursor(paths: FixturePaths): Promise<void> {
  const { home, workspace, cwd } = paths;
  await writeSkill(path.join(cwd, ".agents", "skills"), "cwd-agents-skill");
  await symlinkDir(
    path.join("..", ".agents", "skills"),
    path.join(cwd, ".cursor", "skills"),
  );
  await writeSkill(path.join(cwd, ".claude", "skills"), "cwd-claude-skill");
  await writeSkill(path.join(cwd, ".codex", "skills"), "cwd-codex-skill");
  await writeSkill(
    path.join(cwd, ".agents", "skills", "team"),
    "nested-agents-skill",
  );
  await writeSkill(
    path.join(workspace, ".cursor", "skills"),
    "ws-cursor-skill",
  );
  for (const dir of CURSOR_DIRS) {
    await writeSkill(
      path.join(home, dir, "skills"),
      `home-${dir.slice(1)}-skill`,
    );
  }
  await writeSkill(
    path.join(home, ".cursor", "skills", "team"),
    "home-nested-cursor-skill",
  );
}

const CURSOR_USER_NAMES = CURSOR_DIRS.map(
  (dir) => `home-${dir.slice(1)}-skill`,
);
const CURSOR_PROJECT_NAMES = [
  "cwd-agents-skill",
  "cwd-claude-skill",
  "cwd-codex-skill",
  "nested-agents-skill",
];
const CURSOR_USER_NAMES_NESTED = ["home-nested-cursor-skill"];
const CURSOR_REPO_ROOT_NAMES = ["ws-cursor-skill"];
const CURSOR_ABSENT: string[] = [];

const CURSOR_VARIANT: FixtureVariant = {
  providerId: "acp-cursor",
  variant: "default",
  env: () => ({}),
  build: buildCursor,
  expected: {
    workspace: {
      present: [
        ...CURSOR_PROJECT_NAMES,
        ...CURSOR_REPO_ROOT_NAMES,
        ...CURSOR_USER_NAMES,
        ...CURSOR_USER_NAMES_NESTED,
      ],
      absent: CURSOR_ABSENT,
    },
    userOnly: {
      present: [...CURSOR_USER_NAMES, ...CURSOR_USER_NAMES_NESTED],
      absent: [
        ...CURSOR_ABSENT,
        ...CURSOR_PROJECT_NAMES,
        ...CURSOR_REPO_ROOT_NAMES,
      ],
    },
  },
};

interface OpenCodeDirs {
  configDir: string;
  customConfigDir: string | null;
}

async function buildOpenCode(
  paths: FixturePaths,
  dirs: OpenCodeDirs,
): Promise<void> {
  const { root, home, workspace, cwd } = paths;
  await writeSkill(path.join(cwd, ".opencode", "skills"), "cwd-opencode-skill");
  await writeSkill(path.join(cwd, ".claude", "skills"), "cwd-claude-skill");
  await writeSkill(path.join(cwd, ".agents", "skills"), "cwd-agents-skill");
  await writeSkill(
    path.join(workspace, ".opencode", "skills"),
    "ws-opencode-skill",
  );
  await writeSkill(
    path.join(root, ".opencode", "skills"),
    "above-root-opencode-skill",
  );
  await writeSkill(
    path.join(workspace, "packages", ".claude", "skills"),
    "pkg-claude-skill",
  );
  await writeSkill(
    path.join(workspace, ".agents", "skills"),
    "ws-agents-skill",
  );
  await writeSkill(
    path.join(dirs.configDir, "skills"),
    "opencode-config-skill",
  );
  await writeSkill(path.join(home, ".claude", "skills"), "home-claude-skill");
  await writeSkill(path.join(home, ".agents", "skills"), "home-agents-skill");
  if (dirs.customConfigDir !== null) {
    await writeSkill(
      path.join(dirs.customConfigDir, "skills"),
      "custom-opencode-skill",
    );
  }
}

const OPENCODE_PROJECT_NAMES = [
  "cwd-opencode-skill",
  "cwd-claude-skill",
  "cwd-agents-skill",
  "ws-opencode-skill",
  "pkg-claude-skill",
  "ws-agents-skill",
];
const OPENCODE_USER_NAMES = [
  "opencode-config-skill",
  "home-claude-skill",
  "home-agents-skill",
];
const OPENCODE_ABSENT = ["above-root-opencode-skill"];

function openCodeVariant(
  variant: string,
  dirsFor: (paths: FixturePaths) => OpenCodeDirs,
  env: (paths: FixturePaths) => FixtureEnv,
  extraUserNames: readonly string[],
): FixtureVariant {
  return {
    providerId: "acp-opencode",
    variant,
    env,
    build: (paths) => buildOpenCode(paths, dirsFor(paths)),
    expected: {
      workspace: {
        present: [
          ...OPENCODE_PROJECT_NAMES,
          ...OPENCODE_USER_NAMES,
          ...extraUserNames,
        ],
        absent: OPENCODE_ABSENT,
      },
      userOnly: {
        present: [...OPENCODE_USER_NAMES, ...extraUserNames],
        absent: [...OPENCODE_ABSENT, ...OPENCODE_PROJECT_NAMES],
      },
    },
  };
}

const OMP_PROJECT_DIRS = [
  ".omp",
  ".pi",
  ".agent",
  ".agents",
  ".claude",
  ".codex",
  ".opencode",
] as const;

interface OmpDirs {
  agentDir: string;
  piAgentDir: string;
}

async function buildOmp(paths: FixturePaths, dirs: OmpDirs): Promise<void> {
  const { root, home, workspace, cwd } = paths;
  for (const dir of OMP_PROJECT_DIRS) {
    await writeSkill(
      path.join(cwd, dir, "skills"),
      `cwd-${dir.slice(1)}-skill`,
    );
  }
  await writeSkill(path.join(workspace, ".omp", "skills"), "ws-omp-skill");
  await writeSkill(
    path.join(workspace, "packages", ".pi", "skills"),
    "pkg-pi-skill",
  );
  await writeSkill(path.join(root, ".omp", "skills"), "above-root-omp-skill");
  await writeSkill(path.join(dirs.agentDir, "skills"), "omp-agent-skill");
  await writeSkill(
    path.join(dirs.agentDir, "managed-skills"),
    "omp-managed-skill",
  );
  await writeSkill(path.join(dirs.piAgentDir, "skills"), "pi-agent-skill");
  await writeSkill(path.join(home, ".agent", "skills"), "home-agent-skill");
  await writeSkill(path.join(home, ".agents", "skills"), "home-agents-skill");
  await writeSkill(path.join(home, ".claude", "skills"), "home-claude-skill");
  await writeSkill(path.join(home, ".codex", "skills"), "home-codex-skill");
  await writeSkill(
    path.join(home, ".config", "opencode", "skills"),
    "opencode-config-skill",
  );
  await writeText(
    path.join(dirs.agentDir, "config.yml"),
    "skills:\n  customDirectories:\n    - ~/omp-custom-user\n",
  );
  await writeSkill(path.join(home, "omp-custom-user"), "omp-custom-user-skill");
  await writeText(
    path.join(cwd, ".omp", "config.yml"),
    "skills:\n  customDirectories:\n    - ../../omp-custom-project\n",
  );
  await writeSkill(
    path.join(workspace, "omp-custom-project"),
    "omp-custom-project-skill",
  );
  await writeClaudePluginInstall(paths, path.join(home, ".claude"));
}

const OMP_PROJECT_NAMES = [
  ...OMP_PROJECT_DIRS.map((dir) => `cwd-${dir.slice(1)}-skill`),
  "ws-omp-skill",
  "pkg-pi-skill",
  "omp-custom-project-skill",
  ...CLAUDE_PLUGIN_PROJECT_SKILLS,
];
const OMP_USER_NAMES = [
  "omp-agent-skill",
  "omp-managed-skill",
  "pi-agent-skill",
  "home-agent-skill",
  "home-agents-skill",
  "home-claude-skill",
  "home-codex-skill",
  "opencode-config-skill",
  ...CLAUDE_PLUGIN_USER_SKILLS,
];
const OMP_ABSENT = [
  "above-root-omp-skill",
  ...CLAUDE_PLUGIN_USER_COMMANDS,
  ...CLAUDE_PLUGIN_PROJECT_COMMANDS,
  ...CLAUDE_PLUGIN_ABSENT,
];

function ompVariant(
  variant: string,
  dirsFor: (paths: FixturePaths) => OmpDirs,
  env: (paths: FixturePaths) => FixtureEnv,
): FixtureVariant {
  return {
    providerId: "acp-omp",
    variant,
    env,
    build: (paths) => buildOmp(paths, dirsFor(paths)),
    expected: {
      workspace: {
        present: [...OMP_PROJECT_NAMES, ...OMP_USER_NAMES],
        absent: [...OMP_ABSENT, "omp-custom-user-skill"],
      },
      userOnly: {
        present: [...OMP_USER_NAMES, "omp-custom-user-skill"],
        absent: [...OMP_ABSENT, ...OMP_PROJECT_NAMES],
      },
    },
  };
}

interface GrokOptions {
  grokDir: string;
  compat: { claude?: boolean; cursor?: boolean };
}

async function writeGrokPlugin(
  pluginRoot: string,
  name: string,
  manifestFile: string,
  manifestExtra: Record<string, unknown> = {},
  skillsDirName = "skills",
): Promise<void> {
  await writeJson(path.join(pluginRoot, manifestFile), {
    name,
    ...manifestExtra,
  });
  await writeSkill(path.join(pluginRoot, skillsDirName), `${name}-skill`);
}

async function buildGrok(
  paths: FixturePaths,
  options: GrokOptions,
): Promise<void> {
  const { root, home, workspace, cwd } = paths;
  const { grokDir } = options;
  await writeSkill(path.join(cwd, ".grok", "skills"), "cwd-grok-skill");
  await writeSkill(path.join(root, ".grok", "skills"), "above-root-grok-skill");
  await writeSkill(
    path.join(cwd, ".grok", "skills", "team"),
    "nested-grok-skill",
  );
  await writeSkill(path.join(cwd, ".agents", "skills"), "cwd-agents-skill");
  await writeSkill(path.join(cwd, ".claude", "skills"), "cwd-claude-skill");
  await writeSkill(path.join(cwd, ".cursor", "skills"), "cwd-cursor-skill");
  await writeSkill(path.join(workspace, ".grok", "skills"), "ws-grok-skill");
  await writeSkill(
    path.join(workspace, ".claude", "skills"),
    "ws-claude-skill",
  );
  await writeSkill(
    path.join(workspace, "packages", ".cursor", "skills"),
    "pkg-cursor-skill",
  );
  await writeSkill(path.join(grokDir, "skills"), "grok-home-skill");
  await writeSkill(
    path.join(grokDir, "skills", "team"),
    "nested-grok-home-skill",
  );
  await writeSkill(path.join(home, ".agents", "skills"), "home-agents-skill");
  await writeSkill(path.join(home, ".claude", "skills"), "home-claude-skill");
  await writeSkill(path.join(home, ".cursor", "skills"), "home-cursor-skill");

  const compatLines = [
    ...(options.compat.claude === undefined
      ? []
      : ["[compat.claude]", `skills = ${options.compat.claude}`]),
    ...(options.compat.cursor === undefined
      ? []
      : ["[compat.cursor]", `skills = ${options.compat.cursor}`]),
  ];
  await writeText(
    path.join(grokDir, "config.toml"),
    [
      "[skills]",
      `paths = ["~/grok-user-paths", ${JSON.stringify(path.join(workspace, "grok-project-paths"))}]`,
      "[plugins]",
      'enabled = ["enabled-grok-plugin", "project-grok-plugin", "registry-grok-plugin", "claude-dir-grok-plugin"]',
      `paths = [${JSON.stringify(path.join(root, "grok-path-plugin"))}]`,
      ...compatLines,
      "",
    ].join("\n"),
  );
  await writeSkill(
    path.join(home, "grok-user-paths", "team"),
    "grok-user-paths-skill",
  );
  await writeSkill(
    path.join(workspace, "grok-project-paths"),
    "grok-project-paths-skill",
  );

  await writeGrokPlugin(
    path.join(grokDir, "plugins", "enabled-grok-plugin"),
    "enabled-grok-plugin",
    path.join(".grok-plugin", "plugin.json"),
  );
  await writeGrokPlugin(
    path.join(grokDir, "plugins", "unlisted-grok-plugin"),
    "unlisted-grok-plugin",
    "plugin.json",
  );
  await writeGrokPlugin(
    path.join(cwd, ".grok", "plugins", "project-grok-plugin"),
    "project-grok-plugin",
    "plugin.json",
    { skills: ["custom-skills"] },
    "custom-skills",
  );
  await writeGrokPlugin(
    path.join(workspace, ".claude", "plugins", "claude-dir-grok-plugin"),
    "claude-dir-grok-plugin",
    CLAUDE_PLUGIN_MANIFEST,
  );
  await writeGrokPlugin(
    path.join(root, "grok-path-plugin"),
    "path-grok-plugin",
    "plugin.json",
  );
  const registryRepo = path.join(root, "grok-registry-repo");
  await writeJson(path.join(grokDir, "installed-plugins", "registry.json"), {
    repos: {
      "golden/repo": {
        path: registryRepo,
        plugins: {
          "registry-grok-plugin": { subdir: "plugins/registry-grok-plugin" },
        },
      },
    },
  });
  await writeGrokPlugin(
    path.join(registryRepo, "plugins", "registry-grok-plugin"),
    "registry-grok-plugin",
    "plugin.json",
  );
  await writeClaudePluginInstall(paths, path.join(home, ".claude"));
}

const GROK_ALWAYS_PROJECT = [
  "cwd-grok-skill",
  "nested-grok-skill",
  "cwd-agents-skill",
  "ws-grok-skill",
  "project-grok-plugin:project-grok-plugin-skill",
  "claude-dir-grok-plugin:claude-dir-grok-plugin-skill",
];
const GROK_ALWAYS_USER = [
  "grok-home-skill",
  "nested-grok-home-skill",
  "home-agents-skill",
  "grok-user-paths-skill",
  "grok-project-paths-skill",
  "enabled-grok-plugin:enabled-grok-plugin-skill",
  "path-grok-plugin:path-grok-plugin-skill",
  "registry-grok-plugin:registry-grok-plugin-skill",
];
const GROK_CLAUDE_PROJECT = [
  "cwd-claude-skill",
  "ws-claude-skill",
  ...CLAUDE_PLUGIN_PROJECT_SKILLS,
];
const GROK_CLAUDE_USER = ["home-claude-skill", ...CLAUDE_PLUGIN_USER_SKILLS];
const GROK_CURSOR_PROJECT = ["cwd-cursor-skill", "pkg-cursor-skill"];
const GROK_CURSOR_USER = ["home-cursor-skill"];
const GROK_ALWAYS_ABSENT = [
  "above-root-grok-skill",
  "unlisted-grok-plugin:unlisted-grok-plugin-skill",
  ...CLAUDE_PLUGIN_USER_COMMANDS,
  ...CLAUDE_PLUGIN_PROJECT_COMMANDS,
  ...CLAUDE_PLUGIN_ABSENT,
];

function grokVariant(
  variant: string,
  optionsFor: (paths: FixturePaths) => GrokOptions,
  env: (paths: FixturePaths) => FixtureEnv,
  effective: { claude: boolean; cursor: boolean },
): FixtureVariant {
  const pick = (on: boolean, names: readonly string[]): readonly string[] =>
    on ? names : [];
  const drop = (on: boolean, names: readonly string[]): readonly string[] =>
    on ? [] : names;
  const userPresent = [
    ...GROK_ALWAYS_USER,
    ...pick(effective.claude, GROK_CLAUDE_USER),
    ...pick(effective.cursor, GROK_CURSOR_USER),
  ];
  const projectPresent = [
    ...GROK_ALWAYS_PROJECT,
    ...pick(effective.claude, GROK_CLAUDE_PROJECT),
    ...pick(effective.cursor, GROK_CURSOR_PROJECT),
  ];
  const compatAbsent = [
    ...drop(effective.claude, [...GROK_CLAUDE_USER, ...GROK_CLAUDE_PROJECT]),
    ...drop(effective.cursor, [...GROK_CURSOR_USER, ...GROK_CURSOR_PROJECT]),
  ];
  return {
    providerId: "acp-grok",
    variant,
    env,
    build: (paths) => buildGrok(paths, optionsFor(paths)),
    expected: {
      workspace: {
        present: [...projectPresent, ...userPresent],
        absent: [...GROK_ALWAYS_ABSENT, ...compatAbsent],
      },
      userOnly: {
        present: userPresent,
        absent: [
          ...GROK_ALWAYS_ABSENT,
          ...compatAbsent,
          ...GROK_ALWAYS_PROJECT,
          ...GROK_CLAUDE_PROJECT,
          ...GROK_CURSOR_PROJECT,
        ],
      },
    },
  };
}

const GROK_SYMLINK_CONTROL_PROJECT = ["ws-grok-skill"];
const GROK_SYMLINK_CONTROL_USER = ["grok-home-skill"];

async function writeGrokSymlinkControls(paths: FixturePaths): Promise<void> {
  await writeSkill(
    path.join(paths.workspace, ".grok", "skills"),
    "ws-grok-skill",
  );
  await writeSkill(path.join(paths.home, ".grok", "skills"), "grok-home-skill");
}

async function buildGrokSymlinkAncestor(paths: FixturePaths): Promise<void> {
  const { workspace } = paths;
  const shared = path.join(workspace, "shared");
  await writeGrokSymlinkControls(paths);
  await writeLinkedSkillsRoot(
    path.join(workspace, "packages", ".grok", "skills"),
    path.join(shared, "pkg-grok-skills"),
    "linked-pkg-grok-skill",
  );
  await writeLinkedSkillsRoot(
    path.join(workspace, "packages", ".agents", "skills"),
    path.join(shared, "pkg-agents-skills"),
    "linked-pkg-agents-skill",
  );
  await writeLinkedSkillsRoot(
    path.join(workspace, "packages", ".cursor", "skills"),
    path.join(shared, "pkg-cursor-skills"),
    "linked-pkg-cursor-skill",
  );
}
const GROK_SYMLINK_ANCESTOR_PROJECT = [
  "linked-pkg-grok-skill",
  "linked-pkg-agents-skill",
  "linked-pkg-cursor-skill",
];

async function buildGrokSymlinkOutside(paths: FixturePaths): Promise<void> {
  const { root, workspace, cwd } = paths;
  const outside = path.join(root, "outside");
  await writeGrokSymlinkControls(paths);
  await writeLinkedSkillsRoot(
    path.join(cwd, ".grok", "skills"),
    path.join(outside, "cwd-grok-skills"),
    "escaped-cwd-grok-skill",
  );
  await writeLinkedSkillsRoot(
    path.join(workspace, "packages", ".grok", "skills"),
    path.join(outside, "pkg-grok-skills"),
    "escaped-pkg-grok-skill",
  );
  await writeLinkedSkillsRoot(
    path.join(workspace, ".agents", "skills"),
    path.join(outside, "ws-agents-skills"),
    "escaped-ws-agents-skill",
  );
  await writeLinkedSkillsRoot(
    path.join(cwd, ".cursor", "skills"),
    path.join(outside, "cwd-cursor-skills"),
    "escaped-cwd-cursor-skill",
  );
}
const GROK_SYMLINK_OUTSIDE_ABSENT = [
  "escaped-cwd-grok-skill",
  "escaped-pkg-grok-skill",
  "escaped-ws-agents-skill",
  "escaped-cwd-cursor-skill",
];

async function buildGrokSymlinkCwd(paths: FixturePaths): Promise<void> {
  const { workspace, cwd } = paths;
  const shared = path.join(workspace, "shared");
  await writeGrokSymlinkControls(paths);
  await writeLinkedSkillsRoot(
    path.join(cwd, ".grok", "skills"),
    path.join(shared, "cwd-grok-skills"),
    "linked-cwd-grok-skill",
  );
  await writeLinkedSkillsRoot(
    path.join(cwd, ".agents", "skills"),
    path.join(shared, "cwd-agents-skills"),
    "linked-cwd-agents-skill",
  );
  await writeLinkedSkillsRoot(
    path.join(cwd, ".claude", "skills"),
    path.join(shared, "cwd-claude-skills"),
    "linked-cwd-claude-skill",
  );
  await writeLinkedSkillsRoot(
    path.join(cwd, ".cursor", "skills"),
    path.join(shared, "cwd-cursor-skills"),
    "linked-cwd-cursor-skill",
  );
}
const GROK_SYMLINK_CWD_PROJECT = [
  "linked-cwd-grok-skill",
  "linked-cwd-agents-skill",
  "linked-cwd-claude-skill",
  "linked-cwd-cursor-skill",
];

function grokSymlinkVariant(
  variant: string,
  build: (paths: FixturePaths) => Promise<void>,
  linked: { present: readonly string[]; absent: readonly string[] },
): FixtureVariant {
  const projectPresent = [...GROK_SYMLINK_CONTROL_PROJECT, ...linked.present];
  return {
    providerId: "acp-grok",
    variant,
    env: () => ({}),
    build,
    expected: {
      workspace: {
        present: [...projectPresent, ...GROK_SYMLINK_CONTROL_USER],
        absent: linked.absent,
      },
      userOnly: {
        present: GROK_SYMLINK_CONTROL_USER,
        absent: [...linked.absent, ...projectPresent],
      },
    },
  };
}

async function buildCursorSymlinkBoundary(paths: FixturePaths): Promise<void> {
  const { root, home, workspace, cwd } = paths;
  await writeSkill(path.join(cwd, ".codex", "skills"), "cwd-codex-skill");
  await writeSkill(path.join(home, ".cursor", "skills"), "home-cursor-skill");
  await writeLinkedSkillsRoot(
    path.join(cwd, ".cursor", "skills"),
    path.join(cwd, "shared", "cursor-skills"),
    "linked-cwd-cursor-skill",
  );
  await writeLinkedSkillsRoot(
    path.join(cwd, ".agents", "skills"),
    path.join(workspace, "shared", "agents-skills"),
    "linked-repo-agents-skill",
  );
  await writeLinkedSkillsRoot(
    path.join(cwd, ".claude", "skills"),
    path.join(root, "outside", "claude-skills"),
    "escaped-claude-skill",
  );
}
const CURSOR_SYMLINK_PROJECT = [
  "cwd-codex-skill",
  "linked-cwd-cursor-skill",
  "linked-repo-agents-skill",
];
const CURSOR_SYMLINK_USER = ["home-cursor-skill"];
const CURSOR_SYMLINK_ABSENT = ["escaped-claude-skill"];

const CURSOR_SYMLINK_VARIANT: FixtureVariant = {
  providerId: "acp-cursor",
  variant: "symlink-boundary",
  env: () => ({}),
  build: buildCursorSymlinkBoundary,
  expected: {
    workspace: {
      present: [...CURSOR_SYMLINK_PROJECT, ...CURSOR_SYMLINK_USER],
      absent: CURSOR_SYMLINK_ABSENT,
    },
    userOnly: {
      present: CURSOR_SYMLINK_USER,
      absent: [...CURSOR_SYMLINK_ABSENT, ...CURSOR_SYMLINK_PROJECT],
    },
  },
};

async function buildHermes(
  paths: FixturePaths,
  hermesDir: string,
  externalDirsYaml: string,
): Promise<void> {
  const { root, cwd } = paths;
  await writeSkill(path.join(hermesDir, "skills"), "top-hermes-skill");
  await writeSkill(
    path.join(hermesDir, "skills", "software"),
    "nested-hermes-skill",
  );
  await writeText(path.join(hermesDir, "config.yaml"), externalDirsYaml);
  await writeSkill(
    path.join(root, "hermes-external", "team"),
    "hermes-external-skill",
  );
  await writeSkill(
    path.join(hermesDir, "relative-external"),
    "hermes-relative-skill",
  );
  await writeSkill(path.join(cwd, ".hermes", "skills"), "cwd-hermes-skill");
}

function hermesVariant(
  variant: string,
  hermesDirFor: (paths: FixturePaths) => string,
  env: (paths: FixturePaths) => FixtureEnv,
  externalDirsYamlFor: (paths: FixturePaths) => string,
  userNames: readonly string[],
): FixtureVariant {
  const names: ExpectedNames = {
    present: userNames,
    absent: ["cwd-hermes-skill"],
  };
  return {
    providerId: "acp-hermes-agent",
    variant,
    env,
    build: (paths) =>
      buildHermes(paths, hermesDirFor(paths), externalDirsYamlFor(paths)),
    expected: { workspace: names, userOnly: names },
  };
}

const defaultClaudeDir = (paths: FixturePaths): string =>
  path.join(paths.home, ".claude");

export const FIXTURE_VARIANTS: readonly FixtureVariant[] = [
  claudeCodeVariant("default", defaultClaudeDir, () => ({}), []),
  claudeCodeVariant(
    "config-dir",
    (paths) => path.join(paths.root, "claude-config"),
    (paths) => ({ CLAUDE_CONFIG_DIR: path.join(paths.root, "claude-config") }),
    ["configdir-claude-skill"],
  ),
  codexVariant(
    "default",
    (paths) => path.join(paths.home, ".codex"),
    () => ({}),
    [],
  ),
  codexVariant(
    "codex-home",
    (paths) => path.join(paths.root, "codex-home"),
    (paths) => ({ CODEX_HOME: path.join(paths.root, "codex-home") }),
    ["codexhome-skill"],
  ),
  piVariant(
    "default",
    (paths) => path.join(paths.home, ".pi", "agent"),
    () => ({}),
    false,
  ),
  piVariant(
    "pi-agent-dir",
    (paths) => path.join(paths.root, "pi-agent"),
    (paths) => ({ PI_CODING_AGENT_DIR: path.join(paths.root, "pi-agent") }),
    true,
  ),
  CURSOR_VARIANT,
  openCodeVariant(
    "default",
    (paths) => ({
      configDir: path.join(paths.home, ".config", "opencode"),
      customConfigDir: null,
    }),
    () => ({}),
    [],
  ),
  openCodeVariant(
    "config-dir",
    (paths) => ({
      configDir: path.join(paths.root, "xdg", "opencode"),
      customConfigDir: path.join(paths.home, "opencode-custom"),
    }),
    (paths) => ({
      XDG_CONFIG_HOME: path.join(paths.root, "xdg"),
      OPENCODE_CONFIG_DIR: "~/opencode-custom",
    }),
    ["custom-opencode-skill"],
  ),
  ompVariant(
    "default",
    (paths) => ({
      agentDir: path.join(paths.home, ".omp", "agent"),
      piAgentDir: path.join(paths.home, ".pi", "agent"),
    }),
    () => ({}),
  ),
  ompVariant(
    "profile",
    (paths) => ({
      agentDir: path.join(paths.home, ".omp", "profiles", "work", "agent"),
      piAgentDir: path.join(paths.home, ".pi", "agent"),
    }),
    () => ({ OMP_PROFILE: "work" }),
  ),
  ompVariant(
    "pi-agent-dir",
    (paths) => ({
      agentDir: path.join(paths.root, "pi-agent"),
      piAgentDir: path.join(paths.root, "pi-agent"),
    }),
    (paths) => ({ PI_CODING_AGENT_DIR: path.join(paths.root, "pi-agent") }),
  ),
  grokVariant(
    "default",
    (paths) => ({ grokDir: path.join(paths.home, ".grok"), compat: {} }),
    () => ({}),
    { claude: true, cursor: true },
  ),
  grokVariant(
    "compat-off",
    (paths) => ({
      grokDir: path.join(paths.home, ".grok"),
      compat: { claude: false, cursor: false },
    }),
    () => ({}),
    { claude: false, cursor: false },
  ),
  grokVariant(
    "env-compat",
    (paths) => ({
      grokDir: path.join(paths.home, ".grok"),
      compat: { claude: false, cursor: true },
    }),
    () => ({
      GROK_CLAUDE_SKILLS_ENABLED: "true",
      GROK_CURSOR_SKILLS_ENABLED: "0",
    }),
    { claude: true, cursor: false },
  ),
  grokVariant(
    "grok-home",
    (paths) => ({ grokDir: path.join(paths.home, "grok-custom"), compat: {} }),
    () => ({ GROK_HOME: "~/grok-custom" }),
    { claude: true, cursor: true },
  ),
  grokSymlinkVariant("symlink-ancestor", buildGrokSymlinkAncestor, {
    present: GROK_SYMLINK_ANCESTOR_PROJECT,
    absent: [],
  }),
  grokSymlinkVariant("symlink-outside", buildGrokSymlinkOutside, {
    present: [],
    absent: GROK_SYMLINK_OUTSIDE_ABSENT,
  }),
  grokSymlinkVariant("symlink-cwd", buildGrokSymlinkCwd, {
    present: GROK_SYMLINK_CWD_PROJECT,
    absent: [],
  }),
  CURSOR_SYMLINK_VARIANT,
  hermesVariant(
    "default",
    (paths) => path.join(paths.home, ".hermes"),
    () => ({}),
    (paths) =>
      `skills:\n  external_dirs:\n    - ${path.join(paths.root, "hermes-external")}\n    - relative-external\n`,
    [
      "top-hermes-skill",
      "nested-hermes-skill",
      "hermes-external-skill",
      "hermes-relative-skill",
    ],
  ),
  hermesVariant(
    "hermes-home",
    (paths) => path.join(paths.root, "hermes-home"),
    (paths) => ({ HERMES_HOME: path.join(paths.root, "hermes-home") }),
    (paths) =>
      `skills:\n  external_dirs: ${path.join(paths.root, "hermes-external")}\n`,
    ["top-hermes-skill", "nested-hermes-skill", "hermes-external-skill"],
  ),
];
