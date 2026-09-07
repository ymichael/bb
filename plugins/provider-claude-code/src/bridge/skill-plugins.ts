import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ClaudeSkillPluginRoot {
  id: string;
  path: string;
}

interface ClaudePluginManifest {
  $schema: string;
  name: string;
  version: string;
  description: string;
  author: { name: string };
  skills: string;
}

const MANIFEST_SCHEMA = "https://anthropic.com/claude-code/plugin.schema.json";

function pluginDirectoryName(root: ClaudeSkillPluginRoot): string {
  return createHash("sha256")
    .update(`${root.id}\0${root.path}`)
    .digest("hex")
    .slice(0, 16);
}

export const CLAUDE_SKILL_PLUGIN_NAME = "bb-global-skills";

function pluginNameFor(
  root: ClaudeSkillPluginRoot,
  takenBy: ReadonlyMap<string, string>,
): string {
  const directory = pluginDirectoryName(root);
  const owner = takenBy.get(CLAUDE_SKILL_PLUGIN_NAME);
  if (owner === undefined || owner === directory) {
    return CLAUDE_SKILL_PLUGIN_NAME;
  }
  return `${CLAUDE_SKILL_PLUGIN_NAME}-${directory.slice(0, 8)}`;
}

export function ensureClaudeSkillPlugin(args: {
  pluginsRoot: string;
  root: ClaudeSkillPluginRoot;
  takenNames?: Map<string, string>;
}): string {
  const directory = pluginDirectoryName(args.root);
  const pluginPath = join(args.pluginsRoot, directory);
  const takenNames = args.takenNames ?? new Map<string, string>();
  const name = pluginNameFor(args.root, takenNames);
  takenNames.set(name, directory);
  mkdirSync(join(pluginPath, ".claude-plugin"), { recursive: true });
  const manifest: ClaudePluginManifest = {
    $schema: MANIFEST_SCHEMA,
    name,
    version: "0.1.0",
    description: `Skills injected by bb (${args.root.id}).`,
    author: { name: "bb" },
    skills: "./skills",
  };
  writeFileSync(
    join(pluginPath, ".claude-plugin", "plugin.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  const skillsLink = join(pluginPath, "skills");
  let current: string | null = null;
  try {
    current = lstatSync(skillsLink).isSymbolicLink()
      ? readlinkSync(skillsLink)
      : "";
  } catch {
    current = null;
  }
  if (current !== args.root.path) {
    rmSync(skillsLink, { recursive: true, force: true });
    symlinkSync(args.root.path, skillsLink, "dir");
  }
  return pluginPath;
}

export function createClaudeSkillPluginsRoot(baseDir = tmpdir()): string {
  mkdirSync(baseDir, { recursive: true });
  return mkdtempSync(join(baseDir, "bb-claude-skill-plugins-"));
}
