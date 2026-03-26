import {
  appendThreadEvent,
} from "../services/thread-events.js";
import {
  getDefaultProjectSource,
} from "@bb/db";
import { hostDaemonToolCallRequestSchema } from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import type { PromptInput } from "@bb/domain";
import { promptInputSchema } from "@bb/domain";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { parseJsonBody } from "../services/validation.js";
import { createThreadFromRequest } from "../services/thread-create.js";
import { requireThread } from "../services/entity-lookup.js";
import { requireActiveSession } from "./session-state.js";
import { z } from "zod";

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return Object.fromEntries(Object.entries(value));
}

function resolveToolStringArg(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof record[key] === "string" && record[key].trim().length > 0
    ? record[key].trim()
    : undefined;
}

function resolveToolPromptInput(
  record: Record<string, unknown>,
): PromptInput[] | undefined {
  const prompt = resolveToolStringArg(record, "prompt");
  if (prompt) {
    const promptInput: PromptInput = { type: "text", text: prompt };
    return [promptInput];
  }
  const input = record.input;
  const parsed = z.array(promptInputSchema).safeParse(input);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data;
}

function resolveReasoningLevel(
  record: Record<string, unknown>,
): "low" | "medium" | "high" | "xhigh" | undefined {
  const value = resolveToolStringArg(record, "reasoningLevel");
  return value === "low" || value === "medium" || value === "high" || value === "xhigh"
    ? value
    : undefined;
}

function resolveSandboxMode(
  record: Record<string, unknown>,
): "read-only" | "workspace-write" | "danger-full-access" | undefined {
  const value = resolveToolStringArg(record, "sandboxMode");
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access"
    ? value
    : undefined;
}

export function registerInternalToolCallRoutes(app: Hono, deps: AppDeps): void {
  app.post("/session/tool-call", async (context) => {
    const payload = await parseJsonBody(
      context,
      hostDaemonToolCallRequestSchema,
    );
    requireActiveSession(deps.db, payload.sessionId);

    if (payload.tool === "message_user") {
      const args = toRecord(payload.arguments) ?? {};
      const text =
        resolveToolStringArg(args, "text") ??
        resolveToolStringArg(args, "message");
      if (!text) {
        throw new ApiError(400, "invalid_request", "message_user requires text");
      }

      appendThreadEvent(deps, {
        threadId: payload.threadId,
        turnId: payload.turnId,
        type: "system/manager/user_message",
        data: {
          text,
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

    const parentThread = requireThread(deps.db, payload.threadId);
    const args = toRecord(payload.arguments) ?? {};
    const input = resolveToolPromptInput(args);
    const explicitEnvironmentId = resolveToolStringArg(args, "environmentId");
    const explicitHostId = resolveToolStringArg(args, "hostId");
    const defaultSource = getDefaultProjectSource(deps.db, parentThread.projectId);
    const reasoningLevel = resolveReasoningLevel(args);
    const sandboxMode = resolveSandboxMode(args);

    if (!explicitEnvironmentId && !explicitHostId && !defaultSource) {
      throw new ApiError(409, "invalid_request", "Project has no default source");
    }

    const thread = await createThreadFromRequest(deps, {
      projectId: parentThread.projectId,
      providerId:
        resolveToolStringArg(args, "providerId") ?? parentThread.providerId,
      type: resolveToolStringArg(args, "type") === "manager" ? "manager" : "standard",
      ...(resolveToolStringArg(args, "title")
        ? { title: resolveToolStringArg(args, "title") }
        : {}),
      ...(resolveToolStringArg(args, "model")
        ? { model: resolveToolStringArg(args, "model") }
        : {}),
      ...(reasoningLevel ? { reasoningLevel } : {}),
      ...(sandboxMode ? { sandboxMode } : {}),
      ...(input && input.length > 0 ? { input } : {}),
      environment: explicitEnvironmentId
        ? {
            type: "reuse",
            environmentId: explicitEnvironmentId,
          }
        : {
            type: "host",
            hostId: explicitHostId ?? defaultSource?.hostId ?? "",
            workspace: { type: "managed-worktree" },
          },
      parentThreadId: parentThread.id,
      spawnInitiator: "agent",
    });

    return context.json({
      success: true,
      contentItems: [{ type: "inputText", text: `Spawned thread ${thread.id}` }],
    });
  });
}
