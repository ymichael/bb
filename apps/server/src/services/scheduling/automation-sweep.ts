import {
  claimAutomationScheduledRun,
  type ClaimAutomationScheduledRunResult,
  type DueAutomationCursor,
  getEnvironment,
  listDueAutomations,
  restoreAutomationAfterFailedRun,
} from "@bb/db";
import type {
  AutomationAction,
  AutomationThreadRequest,
} from "@bb/server-contract";
import type { AppDeps } from "../../types.js";
import {
  type AutomationRow,
  parseAutomationAction,
  parseAutomationTriggerConfig,
} from "./automation-config.js";
import { computeNextScheduledTime } from "./schedule-helpers.js";
import { createThreadFromRequest } from "../threads/thread-create.js";
const DUE_AUTOMATION_BATCH_SIZE = 100;

interface SweepDueAutomationsArgs {
  now?: number;
}

interface AutomationExecutionContext {
  action: AutomationAction;
  hostId: string | null;
  nextRunAt: number;
}

function toDueAutomationCursor(automation: AutomationRow): DueAutomationCursor {
  if (automation.nextRunAt === null) {
    throw new Error(`Due automation ${automation.id} is missing nextRunAt`);
  }
  return {
    createdAt: automation.createdAt,
    id: automation.id,
    nextRunAt: automation.nextRunAt,
  };
}

function resolveAutomationHostId(
  deps: Pick<AppDeps, "db">,
  threadRequest: AutomationThreadRequest,
): string | null {
  switch (threadRequest.environment.type) {
    case "host":
      return threadRequest.environment.hostId;
    case "reuse": {
      const environment = getEnvironment(
        deps.db,
        threadRequest.environment.environmentId,
      );
      if (!environment) {
        throw new Error("Automation reuse environment was not found");
      }
      return environment.hostId;
    }
    case "sandbox-host":
      return null;
  }
}

function resolveAutomationExecutionContext(
  deps: Pick<AppDeps, "db">,
  automation: AutomationRow,
  now: number,
): AutomationExecutionContext {
  const action = parseAutomationAction(automation.action);
  const trigger = parseAutomationTriggerConfig(automation.triggerConfig);
  const hostId = resolveAutomationHostId(deps, action.threadRequest);
  const nextRunAt = computeNextScheduledTime({
    cron: trigger.cron,
    now,
    timezone: trigger.timezone,
  });
  return {
    action,
    hostId,
    nextRunAt,
  };
}

async function runAutomation(
  deps: Pick<
    AppDeps,
    | "cloudAuth"
    | "config"
    | "db"
    | "hostLifecycle"
    | "hub"
    | "logger"
    | "machineAuth"
    | "sandboxEnv"
    | "sandboxRegistry"
  >,
  automation: AutomationRow,
  now: number,
): Promise<void> {
  let executionContext: AutomationExecutionContext;
  try {
    executionContext = resolveAutomationExecutionContext(deps, automation, now);
  } catch (error) {
    deps.logger.error(
      {
        automationId: automation.id,
        err: error,
      },
      "Skipping automation with invalid stored configuration",
    );
    return;
  }

  const decision: ClaimAutomationScheduledRunResult = claimAutomationScheduledRun(
    deps.db,
    deps.hub,
    {
      automationId: automation.id,
      expectedNextRunAt: automation.nextRunAt,
      hostId: executionContext.hostId,
      nextRunAt: executionContext.nextRunAt,
    },
  );

  if (!decision.advanced) {
    return;
  }

  if (!decision.shouldCreateThread) {
    deps.logger.info(
      {
        automationId: automation.id,
        reason: decision.reason,
      },
      "Skipped due automation run",
    );
    return;
  }

  try {
    await createThreadFromRequest(deps, {
      ...executionContext.action.threadRequest,
      automationId: automation.id,
      origin: null,
      projectId: automation.projectId,
      type: "standard",
    });
  } catch (error) {
    const restored = restoreAutomationAfterFailedRun(deps.db, deps.hub, {
      automationId: automation.id,
      expectedAdvancedNextRunAt: executionContext.nextRunAt,
      expectedRunCount: automation.runCount + 1,
      projectId: automation.projectId,
      restoredLastRunAt: automation.lastRunAt,
      restoredNextRunAt: executionContext.nextRunAt,
      restoredRunCount: automation.runCount,
    });
    deps.logger.error(
      {
        automationId: automation.id,
        err: error,
        restored,
      },
      "Failed to create a thread for a due automation",
    );
  }
}

export async function sweepDueAutomations(
  deps: Pick<
    AppDeps,
    | "cloudAuth"
    | "config"
    | "db"
    | "hostLifecycle"
    | "hub"
    | "logger"
    | "machineAuth"
    | "sandboxEnv"
    | "sandboxRegistry"
  >,
  args: SweepDueAutomationsArgs = {},
): Promise<void> {
  const now = args.now ?? Date.now();
  let after: DueAutomationCursor | undefined;
  while (true) {
    const dueAutomations = listDueAutomations(
      deps.db,
      {
        now,
        after,
        limit: DUE_AUTOMATION_BATCH_SIZE,
      },
    );
    for (const automation of dueAutomations) {
      try {
        await runAutomation(deps, automation, now);
      } catch (error) {
        deps.logger.error(
          {
            automationId: automation.id,
            err: error,
          },
          "Failed to process a due automation",
        );
      }
    }
    if (dueAutomations.length < DUE_AUTOMATION_BATCH_SIZE) {
      return;
    }
    after = toDueAutomationCursor(dueAutomations[dueAutomations.length - 1]!);
  }
}
