import { describe, expect, it } from "vitest";
import { Command } from "commander";
import { renderTemplate } from "@bb/templates";
import { registerMarketplaceCommands } from "../commands/marketplace.js";
import { registerPluginCommands } from "../commands/plugin.js";

function buildGroupCommand(name: "plugin" | "marketplace"): Command {
  const program = new Command();
  registerPluginCommands(program, () => "http://localhost");
  registerMarketplaceCommands(program, () => "http://localhost");
  const group = program.commands.find((command) => command.name() === name);
  expect(group).toBeDefined();
  if (group === undefined) throw new Error(`missing "${name}" command group`);
  return group;
}

function buildPluginCommand(): Command {
  return buildGroupCommand("plugin");
}

describe("plugins guide chapter", () => {
  it("mentions every bb plugin subcommand", () => {
    const plugin = buildPluginCommand();
    const names = plugin.commands.map((command) => command.name());
    expect(names.length).toBeGreaterThan(0);

    const guide = renderTemplate("bbGuidePlugins", {});
    for (const name of names) {
      const pattern = new RegExp(`bb plugin (?:[a-z-]+\\|)*${name}\\b`);
      expect(
        guide,
        `"bb plugin ${name}" is not documented in bb-guide-plugins.md`,
      ).toMatch(pattern);
    }
  });

  it("mentions every declared bb plugin option flag", () => {
    const plugin = buildPluginCommand();
    const guide = renderTemplate("bbGuidePlugins", {});
    let optionCount = 0;
    for (const command of plugin.commands) {
      for (const option of command.options) {
        optionCount += 1;
        const forms = [option.long, option.short].filter(
          (form): form is string => typeof form === "string",
        );
        expect(forms.length).toBeGreaterThan(0);
        expect(
          forms.some((form) => guide.includes(form)),
          `"bb plugin ${command.name()}" flag "${option.flags}" is not documented in bb-guide-plugins.md`,
        ).toBe(true);
      }
    }
    expect(optionCount).toBeGreaterThan(0);
  });

  it("mentions every bb marketplace subcommand", () => {
    const marketplace = buildGroupCommand("marketplace");
    const names = marketplace.commands.map((command) => command.name());
    expect(names.length).toBeGreaterThan(0);

    const guide = renderTemplate("bbGuidePlugins", {});
    for (const name of names) {
      expect(
        guide,
        `"bb marketplace ${name}" is not documented in bb-guide-plugins.md`,
      ).toMatch(new RegExp(`bb marketplace ${name}\\b`));
    }
  });
});
