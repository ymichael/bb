import {
  createAutomation,
  deleteAutomation,
  getAutomation,
  listAutomations,
  updateAutomation,
} from "@bb/db";
import {
  type AutomationAction,
  type AutomationScheduleTrigger,
  createAutomationRequestSchema,
  typedRoutes,
  updateAutomationRequestSchema,
  type CreateAutomationRequest,
  type PublicApiSchema,
  type UpdateAutomationConfigRequest,
  type UpdateAutomationEnabledRequest,
  type UpdateAutomationRequest,
} from "@bb/server-contract";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import type { AppDeps } from "../types.js";
import {
  buildStableThreadRequestProjectData,
  parseAutomationAction,
  parseAutomationTriggerConfig,
  safeParseAutomationDefinition,
  serializeAutomationAction,
  serializeAutomationTrigger,
  toAutomationResponse,
  toAutomationResponseWithProjectData,
  validateStoredAutomationDefinition,
} from "../services/automation-config.js";
import {
  ScheduleValidationError,
  computeNextScheduledTime,
  validateScheduleDefinition,
} from "../services/schedule-helpers.js";
import {
  requirePublicProject,
} from "../services/entity-lookup.js";
import { resolveStableThreadRequestEnvironment } from "../services/thread-request-eligibility.js";

interface BuildAutomationConfigUpdateInputArgs {
  current: NonNullable<ReturnType<typeof getAutomation>>;
  payload: UpdateAutomationConfigRequest;
}

interface BuildAutomationEnabledUpdateInputArgs {
  current: NonNullable<ReturnType<typeof getAutomation>>;
  payload: UpdateAutomationEnabledRequest;
}

interface CreateAutomationValues {
  action: CreateAutomationRequest["action"];
  autoArchive: boolean;
  enabled: boolean;
  name: string;
  trigger: CreateAutomationRequest["trigger"];
}

interface ValidateAutomationActionProjectScopeArgs {
  action: AutomationAction;
  projectId: string;
}

function requireProjectAutomation(
  deps: Pick<AppDeps, "db">,
  args: {
    automationId: string;
    projectId: string;
  },
) {
  const automation = getAutomation(deps.db, args.automationId);
  if (!automation || automation.projectId !== args.projectId) {
    throw new ApiError(404, "invalid_request", "Automation not found");
  }
  return automation;
}

function resolveNextRunAtForCreate(
  payload: CreateAutomationValues,
) {
  validateScheduleDefinition(payload.trigger);
  if (!payload.enabled) {
    return null;
  }
  return computeScheduledNextRunAt(payload.trigger);
}

function computeScheduledNextRunAt(
  trigger: AutomationScheduleTrigger,
) {
  return computeNextScheduledTime({
    cron: trigger.cron,
    now: Date.now(),
    timezone: trigger.timezone,
  });
}

function resolveCreateAutomationValues(
  payload: CreateAutomationRequest,
): CreateAutomationValues {
  return {
    name: payload.name,
    enabled: payload.enabled ?? true,
    trigger: payload.trigger,
    action: payload.action,
    autoArchive: payload.autoArchive ?? false,
  };
}

function buildAutomationConfigUpdateInput(
  args: BuildAutomationConfigUpdateInputArgs,
) {
  const nextTrigger = args.payload.trigger
    ?? parseAutomationTriggerConfig(args.current.triggerConfig);
  if (args.payload.trigger !== undefined) {
    validateScheduleDefinition(args.payload.trigger);
  }
  const nextRunAt = args.payload.trigger !== undefined
    ? (args.current.enabled
        ? computeScheduledNextRunAt(nextTrigger)
        : null)
    : undefined;

  return {
    ...(args.payload.name !== undefined ? { name: args.payload.name } : {}),
    ...(args.payload.trigger !== undefined
      ? {
          triggerType: args.payload.trigger.triggerType,
          triggerConfig: serializeAutomationTrigger(args.payload.trigger),
        }
      : {}),
    ...(args.payload.action !== undefined
      ? { action: serializeAutomationAction(args.payload.action) }
      : {}),
    ...(args.payload.autoArchive !== undefined
      ? { autoArchive: args.payload.autoArchive }
      : {}),
    nextRunAt,
  };
}

function buildAutomationEnabledUpdateInput(
  deps: Pick<AppDeps, "db">,
  args: BuildAutomationEnabledUpdateInputArgs,
) {
  if (!args.payload.enabled) {
    return {
      enabled: false,
      nextRunAt: null,
    };
  }

  const { parsedDefinition, validation } = validateStoredAutomationDefinition(
    deps,
    args.current,
  );
  if (!validation.isValid || parsedDefinition === null) {
    return {
      enabled: true,
      nextRunAt: null,
    };
  }

  return {
    enabled: true,
    nextRunAt:
      args.current.enabled && args.current.nextRunAt !== null
        ? undefined
        : computeScheduledNextRunAt(parsedDefinition.trigger),
  };
}

function validateAutomationActionProjectScope(
  deps: Pick<AppDeps, "db">,
  args: ValidateAutomationActionProjectScopeArgs,
): void {
  resolveStableThreadRequestEnvironment(deps, {
    environment: args.action.threadRequest.environment,
    projectId: args.projectId,
  });
}

function isAutomationEnabledUpdate(
  payload: UpdateAutomationRequest,
): payload is UpdateAutomationEnabledRequest {
  return "enabled" in payload;
}

export function registerAutomationRoutes(app: Hono, deps: AppDeps): void {
  const { get, post, patch, del } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  get("/projects/:id/automations", (context) => {
    const projectId = context.req.param("id");
    requirePublicProject(deps.db, projectId);
    const automations = listAutomations(deps.db, projectId);
    const parsedAutomations = automations.map((automation) => ({
      automation,
      ...safeParseAutomationDefinition(automation),
    }));
    const hostIds = new Set<string>();
    const environmentIds = new Set<string>();

    for (const parsed of parsedAutomations) {
      const action = parsed.parsedDefinition?.action;
      if (!action) {
        continue;
      }

      switch (action.threadRequest.environment.type) {
        case "host":
          hostIds.add(action.threadRequest.environment.hostId);
          break;
        case "reuse":
          environmentIds.add(action.threadRequest.environment.environmentId);
          break;
        case "sandbox-host":
          break;
        default: {
          const exhaustiveCheck: never = action.threadRequest.environment;
          throw new Error(
            `Unsupported automation thread environment: ${exhaustiveCheck}`,
          );
        }
      }
    }

    const projectData = buildStableThreadRequestProjectData(deps, {
      projectId,
      hostIds: [...hostIds],
      environmentIds: [...environmentIds],
    });
    const responses = parsedAutomations.flatMap(({ automation, parsedDefinition }) => {
      try {
        if (parsedDefinition === null) {
          deps.logger.warn(
            {
              automationId: automation.id,
              projectId,
            },
            "Skipping malformed automation row in list response",
          );
          return [];
        }
        return [
          toAutomationResponseWithProjectData(
            automation,
            parsedDefinition,
            projectData,
          ),
        ];
      } catch (error) {
        deps.logger.warn(
          {
            automationId: automation.id,
            err: error,
            projectId,
          },
          "Skipping malformed automation row in list response",
        );
        return [];
      }
    });
    return context.json(responses);
  });

  post("/projects/:id/automations", createAutomationRequestSchema, (context, payload) => {
    const projectId = context.req.param("id");
    requirePublicProject(deps.db, projectId);

    try {
      const values = resolveCreateAutomationValues(payload);
      validateAutomationActionProjectScope(deps, {
        action: values.action,
        projectId,
      });
      const automation = createAutomation(deps.db, deps.hub, {
        projectId,
        name: values.name,
        enabled: values.enabled,
        triggerType: values.trigger.triggerType,
        triggerConfig: serializeAutomationTrigger(values.trigger),
        action: serializeAutomationAction(values.action),
        autoArchive: values.autoArchive,
        nextRunAt: resolveNextRunAtForCreate(values),
      });
      return context.json(toAutomationResponse(deps, automation), 201);
    } catch (error) {
      if (error instanceof ScheduleValidationError) {
        throw new ApiError(400, "invalid_request", error.message);
      }
      throw error;
    }
  });

  patch(
    "/projects/:id/automations/:automationId",
    updateAutomationRequestSchema,
    (context, payload) => {
      const projectId = context.req.param("id");
      requirePublicProject(deps.db, projectId);
      const current = requireProjectAutomation(deps, {
        projectId,
        automationId: context.req.param("automationId"),
      });

      try {
        const updateInput = isAutomationEnabledUpdate(payload)
          ? buildAutomationEnabledUpdateInput(deps, {
              current,
              payload,
            })
          : (() => {
              const nextAction = payload.action ?? parseAutomationAction(current.action);
              validateAutomationActionProjectScope(deps, {
                action: nextAction,
                projectId,
              });
              return buildAutomationConfigUpdateInput({
                current,
                payload,
              });
            })();
        const updated = updateAutomation(
          deps.db,
          deps.hub,
          current.id,
          updateInput,
        );
        if (!updated) {
          throw new ApiError(404, "invalid_request", "Automation not found");
        }
        return context.json(toAutomationResponse(deps, updated));
      } catch (error) {
        if (error instanceof ScheduleValidationError) {
          throw new ApiError(400, "invalid_request", error.message);
        }
        throw error;
      }
    },
  );

  del("/projects/:id/automations/:automationId", (context) => {
    const projectId = context.req.param("id");
    requirePublicProject(deps.db, projectId);
    requireProjectAutomation(deps, {
      projectId,
      automationId: context.req.param("automationId"),
    });
    deleteAutomation(deps.db, deps.hub, context.req.param("automationId"));
    return context.json({ ok: true });
  });
}
