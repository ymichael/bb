import type { HostProviderCommand } from "@bb/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { buildCommandListResponse } from "../../../src/services/threads/provider-command-typeahead.js";

function skill(
  name: string,
  overrides: Partial<HostProviderCommand> = {},
): HostProviderCommand {
  return {
    name,
    source: "skill",
    origin: overrides.origin ?? "user",
    description: overrides.description ?? null,
    argumentHint: overrides.argumentHint ?? null,
  };
}

describe("buildCommandListResponse", () => {
  it("keeps canonical built-ins when project commands collide", () => {
    const response = buildCommandListResponse({
      commands: [
        {
          name: "clear",
          source: "command",
          origin: "project",
          description: "Project clear command",
          argumentHint: null,
        },
        {
          name: "compact",
          source: "command",
          origin: "project",
          description: "Project compact command",
          argumentHint: "<target>",
        },
      ],
      includeBuiltinCompact: true,
      skillCatalog: [],
    });

    expect(response.commands).toEqual([
      {
        name: "clear",
        source: "command",
        origin: "builtin",
        description: "Start fresh context in this thread",
        argumentHint: null,
      },
      {
        name: "compact",
        source: "command",
        origin: "builtin",
        description: "Compact context",
        argumentHint: null,
      },
    ]);
  });

  it("includes plugin provenance on canonical skill rows", () => {
    const response = buildCommandListResponse({
      commands: [],
      includeBuiltinCompact: true,
      skillCatalog: [
        {
          provenance: { kind: "plugin", pluginId: "ottonomous" },
          runtimeSource: {
            kind: "tree",
            sourceType: "data-dir",
            name: "review",
            description: "Review the current change",
            treeHash: "abc123",
            entryPath: "SKILL.md",
          },
        },
      ],
    });

    expect(response.commands).toContainEqual({
      name: "review",
      source: "skill",
      origin: "user",
      description: "Review the current change",
      argumentHint: null,
      pluginId: "ottonomous",
    });
  });

  it("keeps the first user-origin skill when global roots provide the same name", () => {
    const response = buildCommandListResponse({
      commands: [
        skill("bb-cli", { description: "Data-dir override" }),
        skill("bb-cli", { description: "Built-in default" }),
      ],
      includeBuiltinCompact: true,
      skillCatalog: [],
    });

    expect(
      response.commands.filter((command) => command.name === "bb-cli"),
    ).toEqual([
      {
        name: "bb-cli",
        source: "skill",
        origin: "user",
        description: "Data-dir override",
        argumentHint: null,
      },
    ]);
  });

  it("omits the built-in compact row for unsupported providers", () => {
    const response = buildCommandListResponse({
      commands: [],
      includeBuiltinCompact: false,
      skillCatalog: [],
    });

    expect(response.commands).toEqual([
      {
        name: "clear",
        source: "command",
        origin: "builtin",
        description: "Start fresh context in this thread",
        argumentHint: null,
      },
    ]);
  });
});
