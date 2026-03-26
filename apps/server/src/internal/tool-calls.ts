import { getDefaultProjectSource } from "@bb/db";
import { hostDaemonToolCallRequestSchema } from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import {
  messageUserToolArgumentsSchema,
  spawnThreadToolArgumentsSchema,
} from "@bb/domain";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { parseJsonBody, parseValue } from "../services/validation.js";
import { appendThreadEvent } from "../services/thread-events.js";
import { createThreadFromRequest } from "../services/thread-create.js";
import { requireThreadEnvironment } from "../services/entity-lookup.js";
import { requireActiveSession } from "./session-state.js";

export function registerInternalToolCallRoutes(app: Hono, deps: AppDeps): void {
  app.post("/session/tool-call", async (context) => {
    const payload = await parseJsonBody(
      context,
      hostDaemonToolCallRequestSchema,
    );
    const session = requireActiveSession(deps.db, payload.sessionId);
    const { environment, thread: targetThread } = requireThreadEnvironment(
      deps.db,
      payload.threadId,
    );
    if (environment.hostId !== session.hostId) {
      throw new ApiError(
        403,
        "invalid_request",
        "Thread does not belong to the session host",
      );
    }

    if (payload.tool === "message_user") {
      const args = parseValue(payload.arguments ?? {}, messageUserToolArgumentsSchema);

      appendThreadEvent(deps, {
        threadId: payload.threadId,
        turnId: payload.turnId,
        type: "system/manager/user_message",
        data: {
          text: args.text,
          toolCallId: payload.callId,
          turnId: payload.turnId,
        },
      });

      return context.json({
        success: true,
        contentItems: [{ type: "inputText", text: "Message delivered" }],
      });
    }

    if (payload.tool !== "spawn_thread") {
      return context.json({
        success: false,
        contentItems: [{ type: "inputText", text: `Unsupported tool: ${payload.tool}` }],
      });
    }

    const parentThread = targetThread;
    const args = parseValue(payload.arguments ?? {}, spawnThreadToolArgumentsSchema);
    const defaultSource = getDefaultProjectSource(deps.db, parentThread.projectId);

    if (!args.environmentId && !args.hostId && !defaultSource) {
      throw new ApiError(409, "invalid_request", "Project has no default source");
    }

    const childThread = await createThreadFromRequest(deps, {
      projectId: parentThread.projectId,
      providerId: args.providerId ?? parentThread.providerId,
      type: args.type ?? "standard",
      ...(args.title ? { title: args.title } : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(args.reasoningLevel ? { reasoningLevel: args.reasoningLevel } : {}),
      ...(args.sandboxMode ? { sandboxMode: args.sandboxMode } : {}),
      ...(args.input && args.input.length > 0 ? { input: args.input } : {}),
      environment: args.environmentId
        ? {
            type: "reuse",
            environmentId: args.environmentId,
          }
        : {
            type: "host",
            hostId: args.hostId ?? defaultSource?.hostId ?? "",
            workspace: { type: "managed-worktree" },
          },
      parentThreadId: parentThread.id,
      spawnInitiator: "agent",
    });

    return context.json({
      success: true,
      contentItems: [{ type: "inputText", text: `Spawned thread ${childThread.id}` }],
    });
  });
}
