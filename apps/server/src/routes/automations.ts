import {
  createAutomation,
  deleteAutomation,
  getAutomation,
  getProjectSourceByHost,
  listAutomations,
  updateAutomation,
} from "@bb/db";
import {
  type AutomationAction,
  createAutomationRequestSchema,
  typedRoutes,
  updateAutomationRequestSchema,
  type CreateAutomationRequest,
  type PublicApiSchema,
  type UpdateAutomationRequest,
} from "@bb/server-contract";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import type { AppDeps } from "../types.js";
import {
  parseAutomationAction,
  parseAutomationTriggerConfig,
  serializeAutomationAction,
  serializeAutomationTrigger,
  toAutomationResponse,
} from "../services/automation-config.js";
import {
  ScheduleValidationError,
  computeNextScheduledTime,
  validateScheduleDefinition,
} from "../services/schedule-helpers.js";
import {
  requireEnvironment,
  requireHostWithStatus,
  requireProject,
} from "../services/entity-lookup.js";

interface BuildAutomationUpdateInputArgs {
  current: NonNullable<ReturnType<typeof getAutomation>>;
  payload: UpdateAutomationRequest;
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
  if (!payload.enabled) {
    return null;
  }
  validateScheduleDefinition(payload.trigger);
  return computeNextScheduledTime({
    ...payload.trigger,
    now: Date.now(),
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

function buildAutomationUpdateInput(
  args: BuildAutomationUpdateInputArgs,
) {
  const nextTrigger = args.payload.trigger
    ?? parseAutomationTriggerConfig(args.current.triggerConfig);
  const nextEnabled = args.payload.enabled ?? args.current.enabled;
  const shouldRecomputeNextRunAt =
    args.payload.trigger !== undefined ||
    (args.current.enabled === false && nextEnabled) ||
    (args.current.nextRunAt === null && nextEnabled);

  const nextRunAt = nextEnabled === false
    ? null
    : shouldRecomputeNextRunAt
      ? (() => {
          validateScheduleDefinition(nextTrigger);
          return computeNextScheduledTime({
            ...nextTrigger,
            now: Date.now(),
          });
        })()
      : undefined;

  return {
    ...(args.payload.name !== undefined ? { name: args.payload.name } : {}),
    ...(args.payload.enabled !== undefined ? { enabled: args.payload.enabled } : {}),
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
    ...(nextRunAt !== undefined ? { nextRunAt } : {}),
  };
}

function validateAutomationActionProjectScope(
  deps: Pick<AppDeps, "db">,
  args: ValidateAutomationActionProjectScopeArgs,
): void {
  const environment = args.action.threadRequest.environment;
  if (environment.type === "sandbox-host") {
    return;
  }

  if (environment.type === "reuse") {
    const reusedEnvironment = requireEnvironment(deps.db, environment.environmentId);
    if (reusedEnvironment.projectId !== args.projectId) {
      throw new ApiError(
        409,
        "invalid_request",
        "Environment belongs to a different project",
      );
    }
    return;
  }

  requireHostWithStatus(deps.db, environment.hostId);
  if (!getProjectSourceByHost(deps.db, args.projectId, environment.hostId)) {
    throw new ApiError(
      409,
      "invalid_request",
      "Host is not configured for this project",
    );
  }
}

export function registerAutomationRoutes(app: Hono, deps: AppDeps): void {
  const { get, post, patch, del } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  get("/projects/:id/automations", (context) => {
    const projectId = context.req.param("id");
    requireProject(deps.db, projectId);
    return context.json(
      listAutomations(deps.db, projectId).map(toAutomationResponse),
    );
  });

  post("/projects/:id/automations", createAutomationRequestSchema, (context, payload) => {
    const projectId = context.req.param("id");
    requireProject(deps.db, projectId);

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
      return context.json(toAutomationResponse(automation), 201);
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
      requireProject(deps.db, projectId);
      const current = requireProjectAutomation(deps, {
        projectId,
        automationId: context.req.param("automationId"),
      });

      try {
        const nextAction = payload.action ?? parseAutomationAction(current.action);
        validateAutomationActionProjectScope(deps, {
          action: nextAction,
          projectId,
        });
        const updated = updateAutomation(
          deps.db,
          deps.hub,
          current.id,
          buildAutomationUpdateInput({
            current,
            payload,
          }),
        );
        if (!updated) {
          throw new ApiError(404, "invalid_request", "Automation not found");
        }
        return context.json(toAutomationResponse(updated));
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
    requireProject(deps.db, projectId);
    requireProjectAutomation(deps, {
      projectId,
      automationId: context.req.param("automationId"),
    });
    deleteAutomation(deps.db, deps.hub, context.req.param("automationId"));
    return context.json({ ok: true });
  });
}
