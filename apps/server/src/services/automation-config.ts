import type { automations } from "@bb/db";
import { ZodError } from "zod";
import {
  automationActionSchema,
  automationSchema,
  automationScheduleTriggerSchema,
  type AutomationAction,
  type AutomationScheduleTrigger,
  type AutomationValidation,
} from "@bb/server-contract";
import { ApiError } from "../errors.js";
import type { AppDeps } from "../types.js";
import {
  ScheduleValidationError,
  validateScheduleDefinition,
} from "./schedule-helpers.js";
import { resolveStableThreadRequestEnvironment } from "./thread-request-eligibility.js";

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

export function parseAutomationTriggerConfig(
  triggerConfig: string,
) {
  return automationScheduleTriggerSchema.parse(JSON.parse(triggerConfig));
}

export function parseAutomationAction(
  action: string,
) {
  return automationActionSchema.parse(JSON.parse(action));
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
    validateScheduleDefinition(args.trigger);
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
    if (error instanceof SyntaxError || error instanceof ZodError) {
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
