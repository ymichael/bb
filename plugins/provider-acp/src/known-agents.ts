import type { AcpAgentDefinition } from "./agents.js";
import { resolveCursorNativeRoots } from "./native-roots/cursor.js";
import { resolveGrokNativeRoots } from "./native-roots/grok.js";
import { resolveHermesNativeRoots } from "./native-roots/hermes.js";
import { resolveOmpNativeRoots } from "./native-roots/omp.js";
import { resolveOpenCodeNativeRoots } from "./native-roots/opencode.js";

const PLUGIN_ID = "provider-acp";

function declaredIcon(name: string): string {
  return `${PLUGIN_ID}/${name}`;
}

const CLAUDE_SKILLS_ROOT = {
  path: ".claude/skills",
  skipIfManifest: ".claude-plugin/plugin.json",
} as const;
type RootEntry =
  | string
  | { readonly path: string; readonly skipIfManifest?: string };
function entryOf(entry: RootEntry) {
  return typeof entry === "string" ? { path: entry } : entry;
}
function plainRoots(entries: readonly RootEntry[]) {
  return entries.map(entryOf);
}

function recursiveRoots(entries: readonly RootEntry[]) {
  return entries.map((entry) => ({ ...entryOf(entry), recursive: true }));
}

function ancestorRoots(entries: readonly RootEntry[]) {
  return entries.map((entry) => ({ ...entryOf(entry), ancestors: true }));
}

export const KNOWN_ACP_AGENTS: readonly AcpAgentDefinition[] = [
  {
    id: "acp-cursor",
    displayName: "Cursor",
    icon: declaredIcon("cursor"),
    iconTint: { light: "#111827", dark: "#F5F5F5" },
    signInCommand: "cursor-agent login",
    installUrl: "https://cursor.com/docs/cli/installation",
    dialect: "cursor",
    providerUsage: true,
    providerInstallation: true,
    parameterizedModelPicker: true,
    primaryModels: [
      "default",
      "grok-4.6",
      "gpt-5.6-sol",
      "claude-opus-5",
      "claude-fable-5",
      "composer-2.5",
    ],
    reasoningProbePriorityModelIds: ["grok-4.6", "grok-4.5"],
    fork: "none",
    launch: {
      displayName: "Cursor",
      command: "cursor-agent",
      args: ["acp"],
      env: {},
      modelCli: {
        listArgs: ["--list-models"],
        primaryModels: [],
      },
      nativeSkillRoots: {
        user: recursiveRoots([
          ".cursor/skills",
          ".agents/skills",
          CLAUDE_SKILLS_ROOT,
          ".codex/skills",
        ]),
        project: ancestorRoots(
          recursiveRoots([
            ".cursor/skills",
            ".agents/skills",
            CLAUDE_SKILLS_ROOT,
            ".codex/skills",
          ]),
        ),
      },
    },
    nativeRootsResolver: resolveCursorNativeRoots,
  },
  {
    id: "acp-opencode",
    displayName: "opencode",
    icon: declaredIcon("opencode"),
    iconTint: { light: "#2563EB", dark: "#2563EB" },
    signInCommand: "opencode auth login",
    installUrl: "https://opencode.ai/docs",
    visibility: "installed",
    dialect: "opencode",
    supportsManualCompaction: true,
    fork: "tip",
    launch: {
      displayName: "opencode",
      command: "opencode",
      args: ["acp"],
      env: {},
      nativeSkillRoots: {
        user: [CLAUDE_SKILLS_ROOT, ".agents/skills"],
        project: ancestorRoots([
          ".opencode/skills",
          CLAUDE_SKILLS_ROOT,
          ".agents/skills",
        ]),
      },
    },
    nativeRootsResolver: resolveOpenCodeNativeRoots,
  },
  {
    id: "acp-omp",
    displayName: "omp",
    icon: declaredIcon("omp"),
    iconTint: { light: "#9333EA", dark: "#9333EA" },
    signInCommand: "omp login",
    installUrl: "https://github.com/can1357/omp",
    visibility: "installed",
    supportsManualCompaction: true,
    fork: "tip",
    launch: {
      displayName: "omp",
      command: "omp",
      args: ["acp"],
      env: {},
      nativeSkillRoots: {
        user: plainRoots([
          ".agent/skills",
          ".agents/skills",
          CLAUDE_SKILLS_ROOT,
        ]),
        project: ancestorRoots([
          ".omp/skills",
          ".pi/skills",
          ".agent/skills",
          ".agents/skills",
          CLAUDE_SKILLS_ROOT,
          ".codex/skills",
          ".opencode/skills",
        ]),
      },
    },
    nativeRootsResolver: resolveOmpNativeRoots,
  },
  {
    id: "acp-grok",
    displayName: "Grok Build",
    icon: declaredIcon("grok"),
    signInCommand: "grok login",
    installUrl: "https://docs.x.ai/docs/grok-build",
    visibility: "installed",
    dialect: "grok",
    fork: "none",
    reasoningLevels: ["low", "medium", "high"],
    launch: {
      displayName: "Grok Build",
      command: "grok",
      args: ["agent", "stdio"],
      env: {},
      modelCli: {
        listArgs: ["models"],
        selectFlag: "--model",
        primaryModels: ["grok-4.5", "grok-composer-2.5-fast"],
      },
      permissionCli: {
        full: ["--always-approve"],
        insertAfterArgs: 1,
      },
      reasoningCli: {
        flag: "--reasoning-effort",
        supportedLevels: ["low", "medium", "high"],
        levelValues: {
          none: "low",
          xhigh: "high",
          ultracode: "high",
          max: "high",
        },
        defaultLevel: "high",
      },
      nativeSkillRoots: {
        user: recursiveRoots([".agents/skills"]),
        project: [
          { path: ".grok/skills", recursive: true, ancestors: true },
          { path: ".agents/skills", recursive: true, ancestors: true },
        ],
      },
    },
    nativeRootsResolver: resolveGrokNativeRoots,
  },
  {
    id: "acp-hermes-agent",
    displayName: "Hermes Agent",
    icon: declaredIcon("hermes-agent"),
    signInCommand: "hermes login",
    installUrl: "https://hermes-agent.nousresearch.com",
    visibility: "installed",
    fork: "tip",
    reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
    launch: {
      displayName: "Hermes Agent",
      command: "hermes",
      args: ["acp"],
      env: {},
      nativeReasoning: {
        configId: "reasoning_effort",
        supportedLevels: ["none", "low", "medium", "high", "xhigh", "max"],
        defaultLevel: "medium",
      },
    },
    nativeRootsResolver: resolveHermesNativeRoots,
  },
];

export const RESERVED_ACP_PROVIDER_IDS: ReadonlySet<string> = new Set(
  KNOWN_ACP_AGENTS.filter(
    (agent) => (agent.visibility ?? "always") === "always",
  ).map((agent) => agent.id),
);
