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
  createDraftRequestSchema,
  sendDraftRequestSchema,
  sendMessageRequestSchema,
} from "@bb/server-contract";
import type {
  Thread,
  ThreadExecutionOptions,
} from "@bb/domain";
import type { Hono } from "hono";
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
import { parseJsonBody } from "../../services/validation.js";
import { queueManagedEnvironmentReprovision } from "../../services/environment-provisioning.js";
import { MANAGED_REPROVISION_QUEUED } from "../../services/environment-provisioning.js";

function ensureThreadIsWritable(thread: Thread): void {
  if (thread.archivedAt) {
    throw new ApiError(409, "invalid_request", "Thread is archived");
  }
}

function resolveSendMode(
  threadStatus: string,
  requestedMode: "auto" | "start" | "steer" | undefined,
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

export function registerThreadActionRoutes(app: Hono, deps: AppDeps): void {
  app.post("/threads/:id/send", async (context) => {
    const payload = await parseJsonBody(context, sendMessageRequestSchema);
    const { environment, thread } = requireThreadEnvironment(deps.db, context.req.param("id"));
    ensureThreadIsWritable(thread);
    const mode = resolveSendMode(thread.status, payload.mode);
    const execution = buildExecutionOptions(payload, "client/turn/requested");

    if (environment.status !== "ready" || !environment.path) {
      if (
        environment.managed &&
        environment.workspaceProvisionType &&
        environment.status !== "provisioning"
      ) {
        const reprovisionResult = queueManagedEnvironmentReprovision(deps, {
          environment,
          thread,
        });
        if (reprovisionResult !== MANAGED_REPROVISION_QUEUED) {
          throw new ApiError(409, "invalid_request", "Environment is already provisioning");
        }
        appendClientTurnEvent(deps, {
          threadId: thread.id,
          environmentId: environment.id,
          type: "client/turn/requested",
          input: payload.input,
          execution,
          initiator: "user",
          requestMethod: "turn/start",
          source: "tell",
        });
        return context.json({ ok: true });
      }
      throw new ApiError(409, "invalid_request", "Environment is not ready");
    }

    const eventSequence = appendClientTurnEvent(deps, {
      threadId: thread.id,
      environmentId: environment.id,
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
          id: environment.id,
          hostId: environment.hostId,
          path: environment.path,
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
          id: environment.id,
          hostId: environment.hostId,
          path: environment.path,
        },
      });
    }

    return context.json({ ok: true });
  });

  app.post("/threads/:id/drafts", async (context) => {
    const payload = await parseJsonBody(context, createDraftRequestSchema);
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

  app.post("/threads/:id/drafts/:draftId/send", async (context) => {
    const payload = await parseJsonBody(context, sendDraftRequestSchema);
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

    if (environment.status !== "ready" || !environment.path) {
      if (
        environment.managed &&
        environment.workspaceProvisionType &&
        environment.status !== "provisioning"
      ) {
        const reprovisionResult = queueManagedEnvironmentReprovision(deps, {
          environment,
          thread,
        });
        if (reprovisionResult !== MANAGED_REPROVISION_QUEUED) {
          throw new ApiError(409, "invalid_request", "Environment is already provisioning");
        }
        appendClientTurnEvent(deps, {
          threadId: thread.id,
          environmentId: environment.id,
          type: "client/turn/requested",
          input: queuedMessage.content,
          execution,
          initiator: "user",
          requestMethod: "turn/start",
          source: "tell",
        });
        deleteDraft(deps.db, deps.hub, draft.id);
        return context.json({ ok: true, queuedMessage });
      }
      throw new ApiError(409, "invalid_request", "Environment is not ready");
    }

    const eventSequence = appendClientTurnEvent(deps, {
      threadId: thread.id,
      environmentId: environment.id,
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
          id: environment.id,
          hostId: environment.hostId,
          path: environment.path,
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
          id: environment.id,
          hostId: environment.hostId,
          path: environment.path,
        },
      });
    }

    deleteDraft(deps.db, deps.hub, draft.id);
    return context.json({ ok: true, queuedMessage });
  });

  app.delete("/threads/:id/drafts/:draftId", (context) => {
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

  app.post("/threads/:id/stop", async (context) => {
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

  app.post("/threads/:id/archive", async (context) => {
    const body = await context.req.json().catch(() => ({}));
    const force =
      !!body &&
      typeof body === "object" &&
      "force" in body &&
      body.force === true;
    const { environment, thread } = requireThreadEnvironment(deps.db, context.req.param("id"));
    if (!force && environment.status === "ready" && environment.path) {
      const status = hostDaemonCommandResultSchemaByType["workspace.status"].parse(
        await queueCommandAndWait(deps, {
          hostId: environment.hostId,
          timeoutMs: COMMAND_TIMEOUT_MS,
          command: {
            type: "workspace.status",
            environmentId: environment.id,
            workspacePath: environment.path,
            ...(thread.mergeBaseBranch
              ? { mergeBaseBranch: thread.mergeBaseBranch }
              : {}),
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

  app.post("/threads/:id/unarchive", (context) => {
    unarchiveThread(deps.db, deps.hub, context.req.param("id"));
    return context.json({ ok: true });
  });

  app.post("/threads/:id/read", (context) => {
    const thread = updateThread(deps.db, deps.hub, context.req.param("id"), {
      lastReadAt: Date.now(),
    });
    if (!thread) {
      throw new ApiError(404, "thread_not_found", "Thread not found");
    }
    return context.json(thread);
  });

  app.post("/threads/:id/unread", (context) => {
    const thread = updateThread(deps.db, deps.hub, context.req.param("id"), {
      lastReadAt: null,
    });
    if (!thread) {
      throw new ApiError(404, "thread_not_found", "Thread not found");
    }
    return context.json(thread);
  });
}
