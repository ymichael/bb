import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKFLOW_SETTINGS,
  WORKFLOW_SETTING_DESCRIPTORS,
  parseStoredWorkflowSettings,
  registerWorkflowSettings,
  validateWorkflowSettings,
  type WorkflowSettings,
} from "./settings.js";

function rawSettings(overrides: Partial<WorkflowSettings> = {}) {
  return {
    maxActiveRuns: 4,
    maxConcurrentAgents: 8,
    maxAgentCalls: 100,
    totalRunTimeoutMs: 86_400_000,
    retentionDays: 30,
    maxNotificationBytes: 16_384,
    ...overrides,
  };
}

describe("workflow settings policy", () => {
  it("keeps descriptor defaults and immutable internal defaults aligned", () => {
    const descriptorDefaults = {
      maxActiveRuns: WORKFLOW_SETTING_DESCRIPTORS.maxActiveRuns.default,
      maxConcurrentAgents:
        WORKFLOW_SETTING_DESCRIPTORS.maxConcurrentAgents.default,
      maxAgentCalls: WORKFLOW_SETTING_DESCRIPTORS.maxAgentCalls.default,
      totalRunTimeoutMs: WORKFLOW_SETTING_DESCRIPTORS.totalRunTimeoutMs.default,
      retentionDays: WORKFLOW_SETTING_DESCRIPTORS.retentionDays.default,
      maxNotificationBytes:
        WORKFLOW_SETTING_DESCRIPTORS.maxNotificationBytes.default,
    };

    expect(validateWorkflowSettings(descriptorDefaults)).toEqual(
      DEFAULT_WORKFLOW_SETTINGS,
    );
    expect(Object.isFrozen(DEFAULT_WORKFLOW_SETTINGS)).toBe(true);
  });

  it("accepts typed custom values without parsing strings", () => {
    const parsed = validateWorkflowSettings({
      maxActiveRuns: 12,
      maxConcurrentAgents: 16,
      maxAgentCalls: 750,
      totalRunTimeoutMs: 172_800_000,
      retentionDays: 90,
      maxNotificationBytes: 65_536,
    });

    expect(parsed).toEqual({
      maxActiveRuns: 12,
      maxConcurrentAgents: 16,
      maxAgentCalls: 750,
      totalRunTimeoutMs: 172_800_000,
      retentionDays: 90,
      maxNotificationBytes: 65_536,
    });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([
    ["fractional", 4.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("rejects a %s numeric value", (_category, value) => {
    expect(() =>
      validateWorkflowSettings(rawSettings({ maxActiveRuns: value })),
    ).toThrow();
  });

  it.each([
    ["maxActiveRuns", 0, 33, "Maximum active runs"],
    ["maxConcurrentAgents", 0, 65, "Per-run agent concurrency"],
    ["maxAgentCalls", 0, 1001, "Maximum agent calls"],
    ["totalRunTimeoutMs", 59_999, 604_800_001, "Total run timeout"],
    ["retentionDays", 0, 3651, "Retention days"],
    ["maxNotificationBytes", 1023, 262_145, "Maximum notification bytes"],
  ] as const)(
    "enforces lower and upper bounds for %s",
    (key, below, above, label) => {
      expect(() =>
        validateWorkflowSettings(rawSettings({ [key]: below })),
      ).toThrow(new RegExp(label));
      expect(() =>
        validateWorkflowSettings(rawSettings({ [key]: above })),
      ).toThrow(new RegExp(label));
    },
  );

  it("registers descriptors and returns parsed fake-host values", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "workflows",
      settings: {
        maxActiveRuns: " 6 ",
        maxAgentCalls: "250",
      },
    });
    const settings = registerWorkflowSettings(bb);

    expect(harness.registrations.settingsDescriptors).toEqual(
      WORKFLOW_SETTING_DESCRIPTORS,
    );
    await expect(settings.get()).resolves.toEqual({
      ...DEFAULT_WORKFLOW_SETTINGS,
      maxActiveRuns: 6,
      maxAgentCalls: 250,
    });

    const changes: Array<{
      next: WorkflowSettings;
      previous: WorkflowSettings;
    }> = [];
    settings.onChange((next, previous) => changes.push({ next, previous }));
    await harness.setSettings({ maxConcurrentAgents: 12 });

    expect(changes).toHaveLength(1);
    expect(changes[0]?.previous.maxConcurrentAgents).toBe(8);
    expect(changes[0]?.next.maxConcurrentAgents).toBe(12);
  });

  it("falls back from a nonnumeric legacy stored string", async () => {
    const { bb } = createFakePluginHost({
      pluginId: "workflows",
      settings: { retentionDays: "forever" },
    });

    await expect(registerWorkflowSettings(bb).get()).resolves.toMatchObject({
      retentionDays: 7,
    });
  });

  it("rejects string and out-of-range updates", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "workflows" });
    const settings = registerWorkflowSettings(bb);
    const changes: WorkflowSettings[] = [];
    const errors: string[] = [];
    settings.onChange(
      (next) => changes.push(next),
      (error) => errors.push(error.message),
    );

    await expect(harness.setSettings({ maxActiveRuns: "6" })).rejects.toThrow(
      "expects a finite number",
    );
    await expect(harness.setSettings({ maxActiveRuns: 0 })).rejects.toThrow(
      "Maximum active runs must be from 1 through 32",
    );
    expect(errors).toEqual([]);
    expect(changes).toEqual([]);
    await harness.setSettings({ retentionDays: 14, maxActiveRuns: 6 });
    expect(changes.at(-1)).toMatchObject({
      retentionDays: 14,
      maxActiveRuns: 6,
    });
  });

  it("round-trips current snapshots and tolerates the removed stall timeout", () => {
    expect(parseStoredWorkflowSettings(DEFAULT_WORKFLOW_SETTINGS)).toEqual(
      DEFAULT_WORKFLOW_SETTINGS,
    );
    expect(
      parseStoredWorkflowSettings({
        ...DEFAULT_WORKFLOW_SETTINGS,
        workerStallTimeoutMs: 1_800_000,
      }),
    ).toEqual(DEFAULT_WORKFLOW_SETTINGS);
    expect(() => parseStoredWorkflowSettings({ maxActiveRuns: 4 })).toThrow(
      "unexpected fields",
    );
    expect(() =>
      parseStoredWorkflowSettings({
        ...DEFAULT_WORKFLOW_SETTINGS,
        unknownPolicy: 1,
      }),
    ).toThrow("unexpected fields");
  });
});
