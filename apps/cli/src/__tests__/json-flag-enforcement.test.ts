import { describe, expect, it } from "vitest";
import { Command } from "commander";

// Import all register functions
import { registerStatusCommand } from "../commands/status.js";
import { registerProjectCommands } from "../commands/project.js";
import { registerProviderCommands } from "../commands/provider.js";
import { registerManagerCommands } from "../commands/manager.js";
import { registerThreadCommands } from "../commands/thread.js";
import { registerServerCommands } from "../commands/server.js";
// Commands intentionally excluded from --json requirement
const EXCLUDED_COMMANDS = new Set<string>();

function collectLeafCommands(cmd: Command, prefix = ""): Array<{ path: string; cmd: Command }> {
  const results: Array<{ path: string; cmd: Command }> = [];
  for (const sub of cmd.commands) {
    const fullPath = prefix ? `${prefix} ${sub.name()}` : sub.name();
    const children = sub.commands;
    if (children.length === 0) {
      results.push({ path: fullPath, cmd: sub });
    } else {
      results.push(...collectLeafCommands(sub, fullPath));
    }
  }
  return results;
}

describe("CLI --json flag enforcement", () => {
  it("all CLI commands support --json", () => {
    const program = new Command();
    const getUrl = () => "http://localhost";

    registerStatusCommand(program, getUrl);
    registerProjectCommands(program, getUrl);
    registerProviderCommands(program, getUrl);
    registerManagerCommands(program, getUrl);
    registerThreadCommands(program, getUrl);
    registerServerCommands(program, getUrl);

    const commands = collectLeafCommands(program);
    const missing: string[] = [];

    for (const { path, cmd } of commands) {
      if (EXCLUDED_COMMANDS.has(path)) continue;
      const hasJson = cmd.options.some((opt) => opt.long === "--json");
      if (!hasJson) missing.push(path);
    }

    expect(missing).toEqual([]);
  });
});
