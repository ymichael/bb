import { describe, expect, it, vi } from "vitest";
import {
  setupCommandOutputTestEnvironment,
  collectLogLines,
  runCommand,
} from "../helpers/command-output-harness.js";
import { registerGuideCommand } from "../../commands/guide.js";

describe("bb guide command output", () => {
  setupCommandOutputTestEnvironment();

  it("bb guide unknown chapter lists available chapters", async () => {
    await expect(
      runCommand(["guide", "missing"], registerGuideCommand),
    ).rejects.toThrow("process.exit:1");

    const errorOutput = collectLogLines(vi.mocked(console.error)).join("\n");
    expect(errorOutput).toContain("Unknown guide chapter 'missing'");
    expect(errorOutput).toContain(
      "Available: threads, environments, agent-configuration, providers, projects, machines, terminals, browser, customization, plugins, automations.",
    );
  });

  it("bb guide terminals documents explicit scopes and ID-only mutations", async () => {
    await runCommand(["guide", "terminals"], registerGuideCommand);

    const output = collectLogLines(vi.mocked(console.log)).join("\n");
    expect(output).toContain("exactly one explicit scope");
    expect(output).toContain("bb terminal list --thread <thread-id>");
    expect(output).toContain("bb terminal rename <terminal-id> <title>");
  });
});
