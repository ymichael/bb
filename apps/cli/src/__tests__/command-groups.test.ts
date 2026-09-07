import { describe, expect, it } from "vitest";
import { Command } from "commander";
import {
  CORE_COMMAND_GROUPS,
  selectCommandGroups,
  type CommandGroupDeps,
} from "../command-groups.js";

const ALL_GROUP_NAMES = CORE_COMMAND_GROUPS.map((group) => group.name);

describe("selectCommandGroups", () => {
  it("needs no command group to answer --version", () => {
    expect(selectCommandGroups("--version")).toEqual([]);
    expect(selectCommandGroups("-V")).toEqual([]);
  });

  it("needs only the named group for a core command", () => {
    expect(selectCommandGroups("thread").map((group) => group.name)).toEqual([
      "thread",
    ]);
    expect(selectCommandGroups("status").map((group) => group.name)).toEqual([
      "status",
    ]);
  });

  it("needs every group, in help order, whenever commander shows the full program", () => {
    for (const firstArg of [undefined, "help", "--help", "-h", "linear"]) {
      expect(
        selectCommandGroups(firstArg).map((group) => group.name),
        `firstArg=${String(firstArg)}`,
      ).toEqual(ALL_GROUP_NAMES);
    }
  });
});

describe("CORE_COMMAND_GROUPS", () => {
  it("registers exactly the top-level commands it names, in order, with no aliases", async () => {
    const program = new Command();
    const deps: CommandGroupDeps = {
      getUrl: () => "http://localhost",
      getContext: () => ({ serverUrl: "http://localhost" }),
    };
    for (const group of CORE_COMMAND_GROUPS) {
      const register = await group.load();
      register(program, deps);
    }
    expect(program.commands.map((command) => command.name())).toEqual(
      ALL_GROUP_NAMES,
    );
    expect(program.commands.flatMap((command) => command.aliases())).toEqual(
      [],
    );
  }, 30_000);
});
