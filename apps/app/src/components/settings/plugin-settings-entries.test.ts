import { describe, expect, it } from "vitest";
import { buildPluginSettingsEntries } from "./plugin-settings-entries";

describe("buildPluginSettingsEntries", () => {
  it("only includes enabled plugins with declared or custom settings", () => {
    const installedPlugins = [
      {
        enabled: true,
        hasSettings: false,
        icon: null,
        id: "workflows",
        name: null,
      },
      {
        enabled: false,
        hasSettings: false,
        icon: null,
        id: "disabled",
        name: "Disabled",
      },
      {
        enabled: true,
        hasSettings: true,
        icon: "linear-icon",
        id: "linear",
        name: "Linear",
      },
      {
        enabled: true,
        hasSettings: false,
        icon: null,
        id: "plain",
        name: "Plain",
      },
    ];
    const entries = buildPluginSettingsEntries({
      installedPlugins,
      settingsSections: [{ pluginId: "workflows" }],
    });

    expect(entries).toEqual([
      { icon: "linear-icon", id: "linear", label: "Linear" },
      { icon: null, id: "workflows", label: "workflows" },
    ]);
  });
});
