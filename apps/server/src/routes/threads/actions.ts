import {
  archiveThread,
  createDraft,
  deleteDraft,
  getDraft,
  unarchiveThread,
  updateThread,
} from "@bb/db";
import { hostDaemonCommandResultSchemaByType } from "@bb/host-daemon-contract";
import {
  archiveThreadRequestSchema,
  createDraftRequestSchema,
  sendDraftRequestSchema,
  sendMessageRequestSchema,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import type {
  Environment,
  PromptInput,
  Thread,
  ThreadExecutionOptions,
} from "@bb/domain";
import type { AppDeps } from "../../types.js";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { ApiError } from "../../errors.js";
import { encodeDraftContent, toQueuedMessage } from "../../services/drafts.js";
import { maybeCleanupEnvironment } from "../../services/environment-cleanup.js";
import { requireThreadEnvironment } from "../../services/entity-lookup.js";
import { queueCommandAndWait } from "../../services/command-wait.js";
import {
  buildExecutionOptions,
  queueReadyThreadTurnCommand,
  queueTurnSteerCommand,
} from "../../services/thread-commands.js";
import {
  appendClientTurnEvent,
  getLastTurnId,
} from "../../services/thread-events.js";
import { tryTransition } from "../../services/thread-transitions.js";
import { queueManagedEnvironmentReprovision } from "../../services/environment-provisioning.js";
import { MANAGED_REPROVISION_QUEUED } from "../../services/environment-provisioning.js";

function ensureThreadIsWritable(thread: Thread): void {
  if (thread.archivedAt) {
    throw new ApiError(409, "invalid_request", "Thread is archived");
  }
}

function resolveSendMode(
  threadStatus: string,
  requestedMode: "auto" | "start" | "steer",
): "start" | "steer" {
  if (requestedMode === "start") {
    if (threadStatus === "active") {
      throw new ApiError(409, "invalid_request", "Thread is already active");
    }
    return "start";
  }
  if (requestedMode === "steer") {
    if (threadStatus !== "active") {
      throw new ApiError(409, "invalid_request", "Thread is not active");
    }
    return "steer";
  }
  if (threadStatus === "active") {
    return "steer";
  }
  return "start";
}

interface QueueTurnDuringReprovisionArgs {
  deps: Pick<AppDeps, "db" | "hub">;
  environment: Environment;
  execution: ThreadExecutionOptions;
  input: PromptInput[];
  onQueued?: () => void;
  thread: Thread;
}

function queueTurnDuringReprovision(
  args: QueueTurnDuringReprovisionArgs,
): boolean {
  if (args.environment.status === "ready" && args.environment.path) {
    return false;
  }

  if (
    !args.environment.managed ||
    !args.environment.workspaceProvisionType ||
    args.environment.status === "provisioning"
  ) {
    throw new ApiError(409, "invalid_request", "Environment is not ready");
  }

  const reprovisionResult = queueManagedEnvironmentReprovision(args.deps, {
    environment: args.environment,
    thread: args.thread,
  });
  if (reprovisionResult !== MANAGED_REPROVISION_QUEUED) {
    throw new ApiError(409, "invalid_request", "Environment is already provisioning");
  }

  appendClientTurnEvent(args.deps, {
    threadId: args.thread.id,
    environmentId: args.environment.id,
    type: "client/turn/requested",
    input: args.input,
    execution: args.execution,
    initiator: "user",
    requestMethod: "turn/start",
    source: "tell",
  });
  args.onQueued?.();
  return true;
}

function requireReadyThreadEnvironment(environment: Environment): Environment & {
  path: string;
  status: "ready";
} {
  if (environment.status !== "ready" || !environment.path) {
    throw new ApiError(409, "invalid_request", "Environment is not ready");
  }

  return {
    ...environment,
    path: environment.path,
    status: "ready",
  };
}

export function registerThreadActionRoutes(app: Hono, deps: AppDeps): void {
  const { post, del } = typedRoutes<PublicApiSchema>(app, { onValidationError: (msg) => new ApiError(400, "invalid_request", msg) });

  post("/threads/:id/send", sendMessageRequestSchema, async (context, payload) => {
    const { environment, thread } = requireThreadEnvironment(deps.db, context.req.param("id"));
    ensureThreadIsWritable(thread);
    const mode = resolveSendMode(thread.status, payload.mode);
    const execution = buildExecutionOptions(payload, "client/turn/requested");

    if (
      queueTurnDuringReprovision({
        deps,
        environment,
        execution,
        input: payload.input,
        thread,
      })
    ) {
      return context.json({ ok: true });
    }
    const readyEnvironment = requireReadyThreadEnvironment(environment);

    const eventSequence = appendClientTurnEvent(deps, {
      threadId: thread.id,
      environmentId: readyEnvironment.id,
      type: "client/turn/requested",
      input: payload.input,
      execution,
      initiator: "user",
      requestMethod: "turn/start",
      source: "tell",
    });

    if (mode === "start") {
      await queueReadyThreadTurnCommand(deps, {
        thread,
        input: payload.input,
        eventSequence,
        execution,
        environment: {
          id: readyEnvironment.id,
          hostId: readyEnvironment.hostId,
          path: readyEnvironment.path,
        },
      });
      tryTransition(deps.db, deps.hub, thread.id, "active");
    } else {
      const expectedTurnId = getLastTurnId(deps, thread.id);
      if (!expectedTurnId) {
        throw new ApiError(409, "invalid_request", "No active turn to steer");
      }
      await queueTurnSteerCommand(deps, {
        thread,
        input: payload.input,
        eventSequence,
        execution,
        expectedTurnId,
        environment: {
          id: readyEnvironment.id,
          hostId: readyEnvironment.hostId,
          path: readyEnvironment.path,
        },
      });
    }

    return context.json({ ok: true });
  });

  post("/threads/:id/drafts", createDraftRequestSchema, async (context, payload) => {
    const draft = createDraft(deps.db, deps.hub, {
      threadId: context.req.param("id"),
      content: encodeDraftContent(payload.input),
      mode: "auto",
      ...(payload.model ? { model: payload.model } : {}),
      reasoningLevel: payload.reasoningLevel ?? "medium",
      sandboxMode: payload.sandboxMode ?? "danger-full-access",
      ...(payload.serviceTier ? { serviceTier: payload.serviceTier } : {}),
    });
    return context.json(toQueuedMessage(draft), 201);
  });

  post("/threads/:id/drafts/:draftId/send", sendDraftRequestSchema, async (context, payload) => {
    const draft = getDraft(deps.db, context.req.param("draftId"));
    if (!draft || draft.threadId !== context.req.param("id")) {
      throw new ApiError(404, "invalid_request", "Draft not found");
    }
    const queuedMessage = toQueuedMessage(draft);
    const { environment, thread } = requireThreadEnvironment(deps.db, context.req.param("id"));
    ensureThreadIsWritable(thread);
    const mode = resolveSendMode(thread.status, payload.mode ?? queuedMessage.mode);
    const execution: ThreadExecutionOptions = {
      source: "client/turn/requested",
      ...(queuedMessage.model ? { model: queuedMessage.model } : {}),
      reasoningLevel: queuedMessage.reasoningLevel,
      sandboxMode: queuedMessage.sandboxMode,
      ...(queuedMessage.serviceTier
        ? { serviceTier: queuedMessage.serviceTier }
        : {}),
    };

    if (
      queueTurnDuringReprovision({
        deps,
        environment,
        execution,
        input: queuedMessage.content,
        onQueued: () => {
          deleteDraft(deps.db, deps.hub, draft.id);
        },
        thread,
      })
    ) {
      return context.json({ ok: true, queuedMessage });
    }
    const readyEnvironment = requireReadyThreadEnvironment(environment);

    const eventSequence = appendClientTurnEvent(deps, {
      threadId: thread.id,
      environmentId: readyEnvironment.id,
      type: "client/turn/requested",
      input: queuedMessage.content,
      execution,
      initiator: "user",
      requestMethod: "turn/start",
      source: "tell",
    });

    if (mode === "start") {
      await queueReadyThreadTurnCommand(deps, {
        thread,
        input: queuedMessage.content,
        eventSequence,
        execution,
        environment: {
          id: readyEnvironment.id,
          hostId: readyEnvironment.hostId,
          path: readyEnvironment.path,
        },
      });
      tryTransition(deps.db, deps.hub, thread.id, "active");
    } else {
      const expectedTurnId = getLastTurnId(deps, thread.id);
      if (!expectedTurnId) {
        throw new ApiError(409, "invalid_request", "No active turn to steer");
      }
      await queueTurnSteerCommand(deps, {
        thread,
        input: queuedMessage.content,
        eventSequence,
        execution,
        expectedTurnId,
        environment: {
          id: readyEnvironment.id,
          hostId: readyEnvironment.hostId,
          path: readyEnvironment.path,
        },
      });
    }

    deleteDraft(deps.db, deps.hub, draft.id);
    return context.json({ ok: true, queuedMessage });
  });

  del("/threads/:id/drafts/:draftId", (context) => {
    const draft = getDraft(deps.db, context.req.param("draftId"));
    if (!draft || draft.threadId !== context.req.param("id")) {
      throw new ApiError(404, "invalid_request", "Draft not found");
    }
    const deleted = deleteDraft(deps.db, deps.hub, context.req.param("draftId"));
    if (!deleted) {
      throw new ApiError(404, "invalid_request", "Draft not found");
    }
    return context.json({ ok: true });
  });

  post("/threads/:id/stop", async (context) => {
    const { environment, thread } = requireThreadEnvironment(deps.db, context.req.param("id"));
    await queueCommandAndWait(deps, {
      hostId: environment.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "thread.stop",
        environmentId: environment.id,
        threadId: thread.id,
      },
    });
    return context.json({ ok: true });
  });

  post("/threads/:id/archive", archiveThreadRequestSchema, async (context, payload) => {
    const force = payload.force === true;
    const { environment, thread } = requireThreadEnvironment(deps.db, context.req.param("id"));
    if (!force && environment.status === "ready" && environment.path) {
      const mergeBaseBranch = thread.mergeBaseBranch ?? environment.defaultBranch;
      if (!mergeBaseBranch) {
        throw new ApiError(409, "invalid_request", "Thread archive requires a merge base branch");
      }
      const status = hostDaemonCommandResultSchemaByType["workspace.status"].parse(
        await queueCommandAndWait(deps, {
          hostId: environment.hostId,
          timeoutMs: COMMAND_TIMEOUT_MS,
          command: {
            type: "workspace.status",
            environmentId: environment.id,
            environmentStatus: environment.status,
            workspacePath: environment.path,
            mergeBaseBranch,
          },
        }),
      );
      if (
        status.workspaceStatus?.hasUncommittedChanges ||
        status.workspaceStatus?.hasCommittedUnmergedChanges
      ) {
        throw new ApiError(
          409,
          "invalid_request",
          "Thread has uncommitted or unmerged changes",
        );
      }
    }
    if (thread.status === "active") {
      await queueCommandAndWait(deps, {
        hostId: environment.hostId,
        timeoutMs: COMMAND_TIMEOUT_MS,
        command: {
          type: "thread.stop",
          environmentId: environment.id,
          threadId: thread.id,
        },
      });
    }
    archiveThread(deps.db, deps.hub, thread.id);
    await maybeCleanupEnvironment(deps, thread.environmentId);
    return context.json({ ok: true });
  });

  post("/threads/:id/unarchive", (context) => {
    unarchiveThread(deps.db, deps.hub, context.req.param("id"));
    return context.json({ ok: true });
  });

  post("/threads/:id/read", (context) => {
    const thread = updateThread(deps.db, deps.hub, context.req.param("id"), {
      lastReadAt: Date.now(),
    });
    if (!thread) {
      throw new ApiError(404, "thread_not_found", "Thread not found");
    }
    return context.json(thread);
  });

  post("/threads/:id/unread", (context) => {
    const thread = updateThread(deps.db, deps.hub, context.req.param("id"), {
      lastReadAt: null,
    });
    if (!thread) {
      throw new ApiError(404, "thread_not_found", "Thread not found");
    }
    return context.json(thread);
  });
}
