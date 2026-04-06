import {
  listEnvironmentsByIds,
  listHostsByIds,
  listProjectSources,
  type automations,
} from "@bb/db";
import { ZodError } from "zod";
import { z } from "zod";
import {
  automationActionSchema,
  automationSchema,
  automationScheduleTriggerSchema,
  scheduleTimezoneSchema,
  type AutomationAction,
  type AutomationScheduleTrigger,
  type AutomationValidation,
} from "@bb/server-contract";
import { ApiError } from "../errors.js";
import type { AppDeps } from "../types.js";
import { parseJsonValue, parseJsonWithSchema } from "./json-parsing.js";
import {
  ScheduleValidationError,
  serializeScheduleDefinitionAsCron,
  validateScheduleDefinition,
} from "./schedule-helpers.js";
import {
  resolveStableThreadRequestEnvironment,
  resolveStableThreadRequestEnvironmentFromProjectData,
  type StableThreadRequestProjectData,
} from "./thread-request-eligibility.js";

export type AutomationRow = typeof automations.$inferSelect;
export const MALFORMED_AUTOMATION_CONFIGURATION_MESSAGE =
  "Automation configuration is malformed and must be edited before it can run.";

export interface ComputeAutomationValidationArgs {
  action: AutomationAction;
  projectId: string;
  trigger: AutomationScheduleTrigger;
}

export interface ParsedAutomationDefinition {
  action: AutomationAction;
  trigger: AutomationScheduleTrigger;
}

export interface StoredAutomationValidationResult {
  parsedDefinition: ParsedAutomationDefinition | null;
  validation: AutomationValidation;
}

export interface SafeParsedAutomationDefinitionResult {
  parsedDefinition: ParsedAutomationDefinition | null;
}

const scheduleTimeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/u, "Expected time in HH:MM format");
const scheduleWeekdaySchema = z.enum([
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
]);

const legacyScheduleDefinitionSchema = z.discriminatedUnion("kind", [
  z.object({
    intervalHours: z.number().int().min(1).max(24),
    kind: z.literal("hourly"),
    minute: z.number().int().min(0).max(59),
    timezone: scheduleTimezoneSchema,
  }),
  z.object({
    kind: z.literal("daily"),
    times: z.array(scheduleTimeOfDaySchema).min(1),
    timezone: scheduleTimezoneSchema,
  }),
  z.object({
    kind: z.literal("weekly"),
    times: z.array(scheduleTimeOfDaySchema).min(1),
    timezone: scheduleTimezoneSchema,
    weekdays: z.array(scheduleWeekdaySchema).min(1),
  }),
  z.object({
    dayOfMonth: z.number().int().min(1).max(31),
    kind: z.literal("monthly"),
    times: z.array(scheduleTimeOfDaySchema).min(1),
    timezone: scheduleTimezoneSchema,
  }),
]);

const legacyAutomationScheduleTriggerSchema = z.object({
  triggerType: z.literal("schedule"),
  schedule: legacyScheduleDefinitionSchema,
});

export function parseAutomationTriggerConfig(
  triggerConfig: string,
) {
  const parsed = parseJsonValue(triggerConfig);
  const nextTrigger = automationScheduleTriggerSchema.safeParse(parsed);
  if (nextTrigger.success) {
    return nextTrigger.data;
  }

  const legacyTrigger = legacyAutomationScheduleTriggerSchema.parse(parsed);
  return {
    triggerType: "schedule",
    cron: serializeScheduleDefinitionAsCron(legacyTrigger.schedule),
    timezone: legacyTrigger.schedule.timezone,
  } satisfies AutomationScheduleTrigger;
}

export function parseAutomationAction(
  action: string,
) {
  return parseJsonWithSchema(action, automationActionSchema);
}

export function parseAutomationDefinition(
  row: Pick<AutomationRow, "action" | "triggerConfig">,
): ParsedAutomationDefinition {
  return {
    action: parseAutomationAction(row.action),
    trigger: parseAutomationTriggerConfig(row.triggerConfig),
  };
}

export function computeAutomationValidation(
  deps: Pick<AppDeps, "db">,
  args: ComputeAutomationValidationArgs,
): AutomationValidation {
  const validationIssues: string[] = [];

  try {
    validateScheduleDefinition({
      cron: args.trigger.cron,
      timezone: args.trigger.timezone,
    });
  } catch (error) {
    if (error instanceof ScheduleValidationError) {
      validationIssues.push(error.message);
    } else {
      throw error;
    }
  }

  try {
    resolveStableThreadRequestEnvironment(deps, {
      environment: args.action.threadRequest.environment,
      projectId: args.projectId,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      validationIssues.push(error.message);
    } else {
      throw error;
    }
  }

  return {
    isValid: validationIssues.length === 0,
    validationIssues,
  };
}

export function buildStableThreadRequestProjectData(
  deps: Pick<AppDeps, "db">,
  args: {
    environmentIds: readonly string[];
    hostIds: readonly string[];
    projectId: string;
  },
): StableThreadRequestProjectData {
  return {
    environmentsById: new Map(
      listEnvironmentsByIds(deps.db, args.environmentIds).map((environment) => [
        environment.id,
        environment,
      ]),
    ),
    existingHostIds: new Set(
      listHostsByIds(deps.db, args.hostIds).map((host) => host.id),
    ),
    projectId: args.projectId,
    projectSources: listProjectSources(deps.db, args.projectId),
  };
}

export function computeAutomationValidationWithProjectData(
  args: ComputeAutomationValidationArgs & {
    projectData: StableThreadRequestProjectData;
  },
): AutomationValidation {
  const validationIssues: string[] = [];

  try {
    validateScheduleDefinition({
      cron: args.trigger.cron,
      timezone: args.trigger.timezone,
    });
  } catch (error) {
    if (error instanceof ScheduleValidationError) {
      validationIssues.push(error.message);
    } else {
      throw error;
    }
  }

  try {
    resolveStableThreadRequestEnvironmentFromProjectData(
      args.projectData,
      args.action.threadRequest.environment,
    );
  } catch (error) {
    if (error instanceof ApiError) {
      validationIssues.push(error.message);
    } else {
      throw error;
    }
  }

  return {
    isValid: validationIssues.length === 0,
    validationIssues,
  };
}

export function safeParseAutomationDefinition(
  row: Pick<AutomationRow, "action" | "triggerConfig">,
): SafeParsedAutomationDefinitionResult {
  try {
    return {
      parsedDefinition: parseAutomationDefinition(row),
    };
  } catch (error) {
    if (
      error instanceof ScheduleValidationError ||
      error instanceof SyntaxError ||
      error instanceof ZodError
    ) {
      return {
        parsedDefinition: null,
      };
    }
    throw error;
  }
}

export function validateStoredAutomationDefinition(
  deps: Pick<AppDeps, "db">,
  row: Pick<AutomationRow, "action" | "projectId" | "triggerConfig">,
): StoredAutomationValidationResult {
  try {
    const parsedDefinition = parseAutomationDefinition(row);
    return {
      parsedDefinition,
      validation: computeAutomationValidation(deps, {
        action: parsedDefinition.action,
        projectId: row.projectId,
        trigger: parsedDefinition.trigger,
      }),
    };
  } catch (error) {
    if (
      error instanceof ScheduleValidationError ||
      error instanceof SyntaxError ||
      error instanceof ZodError
    ) {
      return {
        parsedDefinition: null,
        validation: {
          isValid: false,
          validationIssues: [MALFORMED_AUTOMATION_CONFIGURATION_MESSAGE],
        },
      };
    }
    throw error;
  }
}

export function toAutomationResponse(
  deps: Pick<AppDeps, "db">,
  row: AutomationRow,
) {
  const { action, trigger } = parseAutomationDefinition(row);
  const validation = computeAutomationValidation(deps, {
    action,
    projectId: row.projectId,
    trigger,
  });

  return automationSchema.parse({
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    enabled: row.enabled,
    trigger,
    action,
    autoArchive: row.autoArchive,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    runCount: row.runCount,
    isValid: validation.isValid,
    validationIssues: validation.validationIssues,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export function toAutomationResponseWithProjectData(
  row: AutomationRow,
  parsedDefinition: ParsedAutomationDefinition,
  projectData: StableThreadRequestProjectData,
) {
  const validation = computeAutomationValidationWithProjectData({
    action: parsedDefinition.action,
    projectId: row.projectId,
    trigger: parsedDefinition.trigger,
    projectData,
  });

  return automationSchema.parse({
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    enabled: row.enabled,
    trigger: parsedDefinition.trigger,
    action: parsedDefinition.action,
    autoArchive: row.autoArchive,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    runCount: row.runCount,
    isValid: validation.isValid,
    validationIssues: validation.validationIssues,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export function serializeAutomationTrigger(
  trigger: AutomationScheduleTrigger,
) {
  return JSON.stringify(trigger);
}

export function serializeAutomationAction(
  action: AutomationAction,
) {
  return JSON.stringify(action);
}
