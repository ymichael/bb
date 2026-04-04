import { eq } from "drizzle-orm";
import {
  advanceAutomationAfterRunInTransaction,
  automations,
  type DueAutomationCursor,
  getActiveSession,
  getEnvironment,
  hasOpenAutomationThread,
  listDueAutomations,
  restoreAutomationAfterFailedRun,
} from "@bb/db";
import type {
  AutomationAction,
  CreateThreadRequest,
} from "@bb/server-contract";
import type { AppDeps } from "../types.js";
import { parseAutomationAction, parseAutomationTriggerConfig } from "./automation-config.js";
import { computeNextScheduledTime } from "./schedule-helpers.js";
import { createThreadFromRequest } from "./thread-create.js";

type AutomationRow = typeof automations.$inferSelect;
const DUE_AUTOMATION_BATCH_SIZE = 100;

interface SweepDueAutomationsArgs {
  now?: number;
}

interface AdvanceAutomationDecision {
  advanced: boolean;
  reason: "host-disconnected" | "lost-race" | "open-thread" | "run";
  shouldCreateThread: boolean;
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
  threadRequest: Omit<CreateThreadRequest, "projectId">,
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
    timezone: trigger.timezone,
    now,
  });
  return {
    action,
    hostId,
    nextRunAt,
  };
}

function advanceAutomationForSweep(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    automation: AutomationRow;
    hostConnected: boolean;
    nextRunAt: number;
  },
): AdvanceAutomationDecision {
  const result = deps.db.transaction((tx) => {
    const current = tx.select()
      .from(automations)
      .where(eq(automations.id, args.automation.id))
      .get();
    if (
      !current ||
      !current.enabled ||
      current.triggerType !== "schedule" ||
      current.nextRunAt !== args.automation.nextRunAt
    ) {
      return {
        advanced: false,
        reason: "lost-race",
        shouldCreateThread: false,
      } satisfies AdvanceAutomationDecision;
    }

    const shouldCreateThread =
      args.hostConnected &&
      !hasOpenAutomationThread(tx, args.automation.id);
    const advanced = advanceAutomationAfterRunInTransaction(tx, {
      automationId: args.automation.id,
      expectedNextRunAt: args.automation.nextRunAt,
      nextRunAt: args.nextRunAt,
    });

    if (!advanced) {
      return {
        advanced: false,
        reason: "lost-race",
        shouldCreateThread: false,
      } satisfies AdvanceAutomationDecision;
    }

    if (!args.hostConnected) {
      return {
        advanced: true,
        reason: "host-disconnected",
        shouldCreateThread: false,
      } satisfies AdvanceAutomationDecision;
    }

    if (!shouldCreateThread) {
      return {
        advanced: true,
        reason: "open-thread",
        shouldCreateThread: false,
      } satisfies AdvanceAutomationDecision;
    }

    return {
      advanced: true,
      reason: "run",
      shouldCreateThread: true,
    } satisfies AdvanceAutomationDecision;
  }, { behavior: "immediate" });

  if (result.advanced) {
    deps.hub.notifyProject(args.automation.projectId, ["automations-changed"]);
  }
  return result;
}

async function runAutomation(
  deps: Pick<AppDeps, "config" | "db" | "hub" | "logger">,
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

  const hostConnected =
    executionContext.hostId === null ||
    getActiveSession(deps.db, executionContext.hostId) !== null;
  const decision = advanceAutomationForSweep(deps, {
    automation,
    hostConnected,
    nextRunAt: executionContext.nextRunAt,
  });

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
      restoredNextRunAt: automation.nextRunAt,
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
  deps: Pick<AppDeps, "config" | "db" | "hub" | "logger">,
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
