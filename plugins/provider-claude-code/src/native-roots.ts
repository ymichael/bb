import path from "node:path";
import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import {
  experimental_filterResolvedNativeRoots,
  experimental_resolveClaudePluginRoots,
  type ExperimentalClaudePluginRoots,
  type ExperimentalClaudePluginRootsArgs,
  type ExperimentalVendorPluginRoots,
} from "@get-bb/plugin-sdk/host";

export const CLAUDE_NATIVE_ROOTS_DECLARATION: Pick<
  PluginProviderDeclaration,
  | "experimental_nativeSkillRoots"
  | "experimental_nativeCommandRoots"
  | "experimental_resolvesNativeRoots"
> = {
  experimental_nativeSkillRoots: {
    user: [
      { path: ".claude/skills", skipIfManifest: ".claude-plugin/plugin.json" },
    ],
    project: [
      {
        path: ".claude/skills",
        ancestors: true,
        skipIfManifest: ".claude-plugin/plugin.json",
      },
    ],
  },
  experimental_nativeCommandRoots: {
    project: [".claude/commands"],
  },
  experimental_resolvesNativeRoots: true,
};

const CLAUDE_PLUGIN_MANIFEST_MARKER = ".claude-plugin/plugin.json";

type ClaudeResolvedRoot = ExperimentalVendorPluginRoots["skills"][number];

export function filterClaudeNativeRoots(
  plugins: ExperimentalClaudePluginRoots,
  warn: (message: string) => void,
): ExperimentalVendorPluginRoots {
  const userSkillsRoot: ClaudeResolvedRoot = {
    path: path.join(plugins.claudeDir, "skills"),
    origin: "user",
    shape: "skills",
    skipIfManifest: CLAUDE_PLUGIN_MANIFEST_MARKER,
  };
  const userCommandsRoot: ClaudeResolvedRoot = {
    path: path.join(plugins.claudeDir, "commands"),
    origin: "user",
    shape: "commands",
  };

  return experimental_filterResolvedNativeRoots(
    {
      skills: [
        userSkillsRoot,
        ...plugins.skills.filter((root) => root.path !== userSkillsRoot.path),
      ],
      commands: [
        userCommandsRoot,
        ...plugins.commands.filter(
          (root) => root.path !== userCommandsRoot.path,
        ),
      ],
    },
    { warn },
  ).answer;
}

export async function resolveClaudeNativeRoots(
  args: ExperimentalClaudePluginRootsArgs,
): Promise<ExperimentalVendorPluginRoots> {
  const plugins = await experimental_resolveClaudePluginRoots(args);
  return filterClaudeNativeRoots(plugins, console.warn);
}
