import type {
  BbPluginApi,
  PluginSettingDescriptors,
  PluginSettingsValues,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

interface IntegerField {
  label: string;
  minimum: number;
  maximum: number;
}

const INTEGER_FIELDS = Object.freeze({
  maxActiveRuns: {
    label: "Maximum active runs",
    minimum: 1,
    maximum: 32,
  },
  maxConcurrentAgents: {
    label: "Per-run agent concurrency",
    minimum: 1,
    maximum: 64,
  },
  maxAgentCalls: {
    label: "Maximum agent calls",
    minimum: 1,
    maximum: 1_000,
  },
  totalRunTimeoutMs: {
    label: "Total run timeout",
    minimum: 60_000,
    maximum: 604_800_000,
  },
  retentionDays: {
    label: "Retention days",
    minimum: 1,
    maximum: 3_650,
  },
  maxNotificationBytes: {
    label: "Maximum notification bytes",
    minimum: 1_024,
    maximum: 262_144,
  },
});

function boundedIntegerSchema(field: IntegerField) {
  const rangeMessage = `${field.label} must be from ${field.minimum} through ${field.maximum}`;
  return z
    .number()
    .int(`${field.label} must be a whole number`)
    .min(field.minimum, rangeMessage)
    .max(field.maximum, rangeMessage);
}

const workflowSettingsSchema = z.object({
  maxActiveRuns: boundedIntegerSchema(INTEGER_FIELDS.maxActiveRuns),
  maxConcurrentAgents: boundedIntegerSchema(INTEGER_FIELDS.maxConcurrentAgents),
  maxAgentCalls: boundedIntegerSchema(INTEGER_FIELDS.maxAgentCalls),
  totalRunTimeoutMs: boundedIntegerSchema(INTEGER_FIELDS.totalRunTimeoutMs),
  retentionDays: boundedIntegerSchema(INTEGER_FIELDS.retentionDays),
  maxNotificationBytes: boundedIntegerSchema(
    INTEGER_FIELDS.maxNotificationBytes,
  ),
});

export type WorkflowSettings = z.infer<typeof workflowSettingsSchema>;

export const WORKFLOW_SETTING_DESCRIPTORS = {
  maxActiveRuns: {
    type: "number",
    label: "Maximum active runs",
    description: "Concurrent workflow runs across the plugin (1-32).",
    experimental_schema: workflowSettingsSchema.shape.maxActiveRuns,
    default: 4,
  },
  maxConcurrentAgents: {
    type: "number",
    label: "Per-run agent concurrency",
    description: "Agent calls that one workflow may run concurrently (1-64).",
    experimental_schema: workflowSettingsSchema.shape.maxConcurrentAgents,
    default: 8,
  },
  maxAgentCalls: {
    type: "number",
    label: "Maximum agent calls",
    description: "Agent calls allowed during one workflow run (1-1000).",
    experimental_schema: workflowSettingsSchema.shape.maxAgentCalls,
    default: 100,
  },
  totalRunTimeoutMs: {
    type: "number",
    label: "Total run timeout (milliseconds)",
    description:
      "Fail a workflow after this total duration in milliseconds (60000-604800000).",
    experimental_schema: workflowSettingsSchema.shape.totalRunTimeoutMs,
    default: 86_400_000,
  },
  retentionDays: {
    type: "number",
    label: "Retention (days)",
    description: "Days to retain completed workflow data (1-3650).",
    experimental_schema: workflowSettingsSchema.shape.retentionDays,
    default: 7,
  },
  maxNotificationBytes: {
    type: "number",
    label: "Maximum notification bytes",
    description:
      "Maximum UTF-8 size of a completion notification (1024-262144).",
    experimental_schema: workflowSettingsSchema.shape.maxNotificationBytes,
    default: 16_384,
  },
} as const satisfies PluginSettingDescriptors;

type DeclaredWorkflowSettings = PluginSettingsValues<
  typeof WORKFLOW_SETTING_DESCRIPTORS
>;

export const DEFAULT_WORKFLOW_SETTINGS: Readonly<WorkflowSettings> =
  Object.freeze({
    maxActiveRuns: 4,
    maxConcurrentAgents: 8,
    maxAgentCalls: 100,
    totalRunTimeoutMs: 24 * 60 * 60 * 1_000,
    retentionDays: 7,
    maxNotificationBytes: 16 * 1_024,
  });

export function validateWorkflowSettings(
  values: Readonly<DeclaredWorkflowSettings>,
): WorkflowSettings {
  return Object.freeze(workflowSettingsSchema.parse(values));
}

const LEGACY_STORED_SETTING_KEYS = new Set(["workerStallTimeoutMs"]);

export function parseStoredWorkflowSettings(value: unknown): WorkflowSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Workflow settings snapshot must be an object");
  }
  const object = value as Record<string, unknown>;
  const expected = Object.keys(INTEGER_FIELDS);
  const actual = Object.keys(object);
  if (
    expected.some((key) => !Object.hasOwn(object, key)) ||
    actual.some(
      (key) =>
        !Object.hasOwn(INTEGER_FIELDS, key) &&
        !LEGACY_STORED_SETTING_KEYS.has(key),
    )
  ) {
    throw new Error("Workflow settings snapshot has unexpected fields");
  }
  const stored = Object.fromEntries(
    expected.map((key) => {
      const value = object[key];
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new Error(`Workflow settings snapshot.${key} must be an integer`);
      }
      return [key, value];
    }),
  ) as WorkflowSettings;
  return validateWorkflowSettings(stored);
}

interface WorkflowSettingsHandle {
  get(): Promise<WorkflowSettings>;
  onChange(
    listener: (next: WorkflowSettings, previous: WorkflowSettings) => void,
    onInvalid?: (error: Error) => void,
  ): void;
}

export function registerWorkflowSettings(
  bb: Pick<BbPluginApi, "settings">,
): WorkflowSettingsHandle {
  const handle = bb.settings.define(WORKFLOW_SETTING_DESCRIPTORS);
  let lastValid = DEFAULT_WORKFLOW_SETTINGS;
  return {
    async get() {
      const validated = validateWorkflowSettings(await handle.get());
      lastValid = validated;
      return validated;
    },
    onChange(listener, onInvalid) {
      handle.onChange((next, previous) => {
        try {
          const validatedNext = validateWorkflowSettings(next);
          let parsedPrevious = lastValid;
          try {
            parsedPrevious = validateWorkflowSettings(previous);
          } catch {}
          lastValid = validatedNext;
          listener(validatedNext, parsedPrevious);
        } catch (error) {
          onInvalid?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });
    },
  };
}
