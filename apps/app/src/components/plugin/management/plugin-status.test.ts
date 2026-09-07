import { describe, expect, it } from "vitest";
import {
  EMPTY_PLUGIN_UPDATE_STATE,
  type PluginListItem,
  type PluginUpdateState,
} from "@/hooks/queries/plugin-settings-queries";
import {
  pluginRowSignal,
  pluginRuntimeStatusPresentation,
} from "./plugin-status";
import { makePluginListItem } from "@/test/fixtures/plugins";

function plugin(
  updateState: Partial<PluginUpdateState> = {},
  overrides: Partial<PluginListItem> = {},
): PluginListItem {
  return makePluginListItem({
    id: "linear",
    source: "npm:@example/linear@^1.6.0",
    rootDir: "/plugins/linear",
    version: "1.6.2",
    name: null,
    provenance: "catalog",
    catalogEntryId: "linear",
    publisherLabel: "BB Community",
    sourceDisplay: "npm · @bb-plugins/linear · tracks compatible",
    updateState: { ...EMPTY_PLUGIN_UPDATE_STATE, ...updateState },
    ...overrides,
  });
}

describe("pluginRowSignal (the one-signal rule)", () => {
  it("badges an available compatible update", () => {
    expect(pluginRowSignal(plugin({ availableVersion: "1.7.0" }))).toEqual({
      kind: "update",
      version: "1.7.0",
    });
  });

  it("never badges a newer-but-incompatible release", () => {
    expect(
      pluginRowSignal(
        plugin({
          blockedVersion: "1.9.0",
          blockedReasons: ["requires bb >= 0.15"],
        }),
      ),
    ).toBeNull();
  });

  it("never badges a pinned/quiet plugin", () => {
    expect(pluginRowSignal(plugin())).toBeNull();
  });

  it("surfaces an update-source security refusal", () => {
    expect(
      pluginRowSignal(
        plugin({
          outcome: "unavailable",
          detail:
            "The cached checkout does not prove that this ref was a branch.",
        }),
      ),
    ).toEqual({
      kind: "status",
      icon: "AlertTriangle",
      label: "Needs attention",
      tone: "warning",
      detail: "The cached checkout does not prove that this ref was a branch.",
    });
  });

  it("names a rolled-back update and lets it outrank an available update", () => {
    expect(
      pluginRowSignal(
        plugin({
          availableVersion: "1.7.0",
          lastFailure: { version: "1.7.0", at: 1, detail: "boom" },
        }),
      ),
    ).toEqual({
      kind: "status",
      icon: "RotateCcw",
      label: "Update failed",
      tone: "error",
      detail: "boom",
    });
  });

  it.each([
    ["error", "CircleX", "Failed", "error"],
    ["incompatible", "AlertCircle", "Incompatible", "error"],
    ["missing", "FileQuestion", "Missing", "error"],
    ["needs-configuration", "Settings", "Needs configuration", "warning"],
    ["degraded", "AlertTriangle", "Degraded", "warning"],
  ] as const)(
    "names the %s runtime status instead of collapsing it into attention",
    (status, icon, label, tone) => {
      expect(
        pluginRowSignal(
          plugin(
            {},
            { status, statusDetail: `${status} detail from the server` },
          ),
        ),
      ).toEqual({
        kind: "status",
        icon,
        label,
        tone,
        detail: `${status} detail from the server`,
      });
    },
  );

  it("provides a useful rollback explanation when the server has no detail", () => {
    expect(
      pluginRowSignal(
        plugin({
          lastFailure: { version: "1.7.0", at: 1, detail: "" },
        }),
      ),
    ).toEqual({
      kind: "status",
      icon: "RotateCcw",
      label: "Update failed",
      tone: "error",
      detail: "Update to 1.7.0 failed and was rolled back.",
    });
  });
});

describe("pluginRuntimeStatusPresentation", () => {
  it("keeps healthy and disabled lifecycle states quiet", () => {
    expect(pluginRuntimeStatusPresentation(plugin())).toBeNull();
    expect(
      pluginRuntimeStatusPresentation(
        plugin({}, { enabled: false, status: "disabled" }),
      ),
    ).toBeNull();
  });

  it("gives local and installed plugin errors appropriate recovery", () => {
    expect(
      pluginRuntimeStatusPresentation(
        plugin({}, { status: "error", source: "path:/plugins/linear" }),
      ),
    ).toMatchObject({
      label: "Failed",
      condition: "The plugin couldn't start.",
      recovery: "Fix the plugin, then reload it.",
    });
    expect(
      pluginRuntimeStatusPresentation(plugin({}, { status: "error" })),
    ).toMatchObject({
      label: "Failed",
      condition: "The plugin couldn't start.",
      recovery:
        "Reload the plugin. If it still fails, remove it and install it again.",
    });
  });

  it("gives missing bundled and installed plugins source-appropriate recovery", () => {
    expect(
      pluginRuntimeStatusPresentation(
        plugin(
          {},
          {
            status: "missing",
            provenance: "builtin",
            source: "builtin:linear",
          },
        ),
      ),
    ).toMatchObject({
      recovery: "Restart bb. If the files are still missing, reinstall bb.",
    });
    expect(
      pluginRuntimeStatusPresentation(plugin({}, { status: "missing" })),
    ).toMatchObject({
      recovery: "Remove the plugin, then install it again from its source.",
    });
  });

  it("explains that saved settings automatically retry configuration", () => {
    expect(
      pluginRuntimeStatusPresentation(
        plugin({}, { status: "needs-configuration", hasSettings: true }),
      ),
    ).toMatchObject({
      label: "Needs configuration",
      condition: "Required settings are incomplete.",
      recovery:
        "Complete the Configuration section; bb reloads the plugin after you save.",
    });
  });
});
