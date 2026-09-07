import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginTimelineRendererProps } from "@get-bb/plugin-sdk";
import {
  getPluginSlotSnapshot,
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "./plugin-slots";
import { resolveTimelineRenderer } from "./plugin-slot-resolvers";
import { makePluginRegistrationSet as registrationSet } from "@/test/fixtures/plugins";

function Renderer(_props: PluginTimelineRendererProps) {
  return null;
}

afterEach(() => {
  resetPluginSlotStoreForTest();
  vi.restoreAllMocks();
});

describe("experimental_timelineRenderer slots", () => {
  it("keeps a plugin's own kinds and drops a kind in another plugin's namespace", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setPluginSlotRegistrations(
      "echo-provider",
      registrationSet({
        timelineRenderers: [
          { kind: "echo-provider/receipt", component: Renderer },
          { kind: "tool", component: Renderer },
          { kind: "provider-codex/goal", component: Renderer },
        ],
      }),
    );
    const slots = getPluginSlotSnapshot().timelineRenderers;
    expect(slots.map((slot) => slot.kind)).toEqual([
      "echo-provider/receipt",
      "tool",
    ]);
    expect(slots.every((slot) => slot.pluginId === "echo-provider")).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('timeline renderer for "provider-codex/goal"'),
    );
  });

  it("resolves an extension row by kind and a tool row by the thread's provider plugin", () => {
    setPluginSlotRegistrations(
      "echo-provider",
      registrationSet({
        timelineRenderers: [
          { kind: "echo-provider/receipt", component: Renderer },
          { kind: "tool", component: Renderer },
        ],
      }),
    );
    setPluginSlotRegistrations(
      "provider-codex",
      registrationSet({
        timelineRenderers: [{ kind: "tool", component: Renderer }],
      }),
    );
    const slots = getPluginSlotSnapshot().timelineRenderers;

    expect(
      resolveTimelineRenderer(slots, {
        kind: "extension",
        extensionKind: "echo-provider/receipt",
      })?.pluginId,
    ).toBe("echo-provider");
    expect(
      resolveTimelineRenderer(slots, {
        kind: "extension",
        extensionKind: "echo-provider/mood",
      }),
    ).toBeNull();

    expect(
      resolveTimelineRenderer(slots, {
        kind: "tool",
        providerPluginId: "provider-codex",
      })?.pluginId,
    ).toBe("provider-codex");
    expect(
      resolveTimelineRenderer(slots, {
        kind: "tool",
        providerPluginId: "echo-provider",
      })?.pluginId,
    ).toBe("echo-provider");
    expect(
      resolveTimelineRenderer(slots, { kind: "tool", providerPluginId: null }),
    ).toBeNull();
  });
});
