import {
  hostDaemonToolCallRequestSchema,
  typedRoutes,
  type HostDaemonInternalSchema,
} from "@bb/host-daemon-contract";
import type { ToolCallResponse } from "@bb/domain";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { requireThreadEnvironment } from "../services/lib/entity-lookup.js";
import {
  findPluginAgentTool,
  invokePluginAgentTool,
} from "../services/plugins/plugin-agent-contributions.js";
import {
  handleUpdateEnvironmentDirectoryToolCall,
  UPDATE_ENVIRONMENT_DIRECTORY_TOOL_NAME,
} from "../services/threads/thread-environment-directory.js";
import { requireAuthenticatedDaemonSession } from "./session-state.js";

const textEncoder = new TextEncoder();

function streamToolCallResponse(result: Promise<ToolCallResponse>): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      void result.then(
        (response) => {
          try {
            controller.enqueue(textEncoder.encode(JSON.stringify(response)));
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
        (error) => controller.error(error),
      );
    },
  });
  return new Response(body, {
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
}

export function registerInternalToolCallRoutes(app: Hono, deps: AppDeps): void {
  const { post } = typedRoutes<HostDaemonInternalSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  post(
    "/session/tool-call",
    hostDaemonToolCallRequestSchema,
    async (context, payload) => {
      const session = requireAuthenticatedDaemonSession({
        context,
        db: deps.db,
        sessionId: payload.sessionId,
      });
      const { environment, thread } = requireThreadEnvironment(
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

      if (payload.tool === UPDATE_ENVIRONMENT_DIRECTORY_TOOL_NAME) {
        return context.json(
          await handleUpdateEnvironmentDirectoryToolCall(deps, {
            currentEnvironment: environment,
            input: payload.arguments,
            thread,
            turnId: payload.turnId,
          }),
        );
      }

      const pluginTool = findPluginAgentTool(payload.tool);
      if (pluginTool) {
        return streamToolCallResponse(
          invokePluginAgentTool(pluginTool, {
            input: payload.arguments,
            ctx: {
              threadId: thread.id,
              projectId: thread.projectId,
              signal: context.req.raw.signal,
            },
          }),
        );
      }

      return context.json({
        success: false,
        contentItems: [
          { type: "inputText", text: `Unsupported tool: ${payload.tool}` },
        ],
      });
    },
  );
}
