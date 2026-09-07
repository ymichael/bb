import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
  CORE_COMMAND_GROUPS,
  type CommandGroupDeps,
} from "../command-groups.js";

const COMMAND_INDEX_PATH = fileURLToPath(
  new URL(
    "../../../server/src/services/skills/builtin-skills/bb-cli/references/command-index.md",
    import.meta.url,
  ),
);

const BB_CLI_SKILL_ROOT = fileURLToPath(
  new URL(
    "../../../server/src/services/skills/builtin-skills/bb-cli/",
    import.meta.url,
  ),
);

function commandPaths(command: Command, prefix: string[] = []): string[] {
  return command.commands.flatMap((child) => {
    const path = [...prefix, child.name()];
    const aliases = child
      .aliases()
      .map((alias) => [...prefix, alias].join(" "));
    return [path.join(" "), ...aliases, ...commandPaths(child, path)];
  });
}

function readMarkdownTree(directory: string): string {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return readMarkdownTree(entryPath);
      return entry.name.endsWith(".md") ? readFileSync(entryPath, "utf8") : [];
    })
    .join("\n");
}

describe("bb-cli skill command index", () => {
  it("lists every core command path", async () => {
    const program = new Command();
    const deps: CommandGroupDeps = {
      getUrl: () => "http://localhost",
      getContext: () => ({ serverUrl: "http://localhost" }),
    };
    for (const group of CORE_COMMAND_GROUPS) {
      const register = await group.load();
      register(program, deps);
    }

    const index = readFileSync(COMMAND_INDEX_PATH, "utf8");
    const documented = new Set(
      [...index.matchAll(/^- `bb ([^`]+)`$/gm)].map((match) => match[1]),
    );
    expect(documented).toEqual(new Set(commandPaths(program)));
  }, 30_000);

  it("leaves shipped plugin commands to their plugin skills", () => {
    const skill = readMarkdownTree(BB_CLI_SKILL_ROOT);
    expect(skill).not.toMatch(
      /\bbb (?:automation|connect|instructions|github|keep-awake|provider-retry|memory|secret|docs|tasks|workflows)\b/,
    );
    expect(skill).not.toMatch(/\b(?:built-in|builtin|official) plugins?\b/i);
  });
});
