import {
  hostDaemonToolCallRequestSchema,
  typedRoutes,
  type HostDaemonInternalSchema,
} from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import { messageUserToolArgumentsSchema, turnScope } from "@bb/domain";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { markSandboxActivity } from "../services/hosts/host-lifecycle.js";
import { runWithDaemonCommandWaitForbidden } from "../services/hosts/command-wait-context.js";
import { parseValue } from "../services/lib/validation.js";
import { appendThreadEvent } from "../services/threads/thread-events.js";
import { requireThreadEnvironment } from "../services/lib/entity-lookup.js";
import { getAuthenticatedDaemon } from "./auth.js";
import { requireAuthorizedActiveSession } from "./session-state.js";

export function registerInternalToolCallRoutes(app: Hono, deps: AppDeps): void {
  const { post } = typedRoutes<HostDaemonInternalSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  post(
    "/session/tool-call",
    hostDaemonToolCallRequestSchema,
    (context, payload) =>
      runWithDaemonCommandWaitForbidden({
        reason: "/session/tool-call",
        work: async () => {
          const daemon = getAuthenticatedDaemon(context);
          const session = requireAuthorizedActiveSession(deps.db, {
            hostId: daemon.hostId,
            sessionId: payload.sessionId,
          });
          const { environment } = requireThreadEnvironment(
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

          void markSandboxActivity(deps, {
            hostId: session.hostId,
            source: "tool-call",
          });

          if (payload.tool === "message_user") {
            const args = parseValue(
              payload.arguments ?? {},
              messageUserToolArgumentsSchema,
            );

            appendThreadEvent(deps, {
              threadId: payload.threadId,
              scope: turnScope(payload.turnId),
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

          return context.json({
            success: false,
            contentItems: [
              { type: "inputText", text: `Unsupported tool: ${payload.tool}` },
            ],
          });
        },
      }),
  );
}
