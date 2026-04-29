import {
  createThread,
  deleteThread,
  getEnvironment,
  getProject,
  getThread,
  listConnectedHostIds,
  queueCommand,
} from "@bb/db";
import { hostDaemonCommandResultSchemaByType } from "@bb/host-daemon-contract";
import {
  replayRunRequestSchema,
  typedRoutes,
  type PublicApiSchema,
  type ReplayCaptureDetail,
  type ReplayCaptureHostSummary,
} from "@bb/server-contract";
import {
  isReplayCaptureId,
  type ReplayCaptureManifest,
} from "@bb/replay-capture";
import type { Hono } from "hono";
import { COMMAND_TIMEOUT_MS } from "../constants.js";
import { ApiError } from "../errors.js";
import type { AppDeps } from "../types.js";
import { queueCommandAndWait } from "../services/hosts/command-wait.js";
import { ensureHostSessionReadyForWork } from "../services/hosts/host-lifecycle.js";
import { appendClientTurnEvent } from "../services/threads/thread-events.js";

interface ResolvedReplayCapture {
  environmentId: string;
  hostId: string;
  projectId: string;
  providerId: string;
  title: string | null;
}

interface CaptureEnrichment {
  title: string | null;
  projectName: string | null;
}

function firstNonBlank(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function loadCaptureEnrichment(
  deps: AppDeps,
  args: { projectId: string; threadId: string },
): CaptureEnrichment {
  const thread = getThread(deps.db, args.threadId);
  const project = getProject(deps.db, args.projectId);
  return {
    title: firstNonBlank(thread?.title, thread?.titleFallback),
    projectName: firstNonBlank(project?.name),
  };
}

function toDetail(
  hostId: string,
  manifest: ReplayCaptureManifest,
  enrichment: CaptureEnrichment,
): ReplayCaptureDetail {
  return {
    ...manifest,
    hostId,
    title: enrichment.title,
    projectName: enrichment.projectName,
  };
}

function requireReplayCaptureId(captureId: string): void {
  if (!isReplayCaptureId(captureId)) {
    throw new ApiError(400, "invalid_request", "Invalid replay capture id");
  }
}

function resolveManifestReplayTarget(
  manifest: ReplayCaptureDetail,
): ResolvedReplayCapture {
  return {
    environmentId: manifest.environmentId,
    hostId: manifest.hostId,
    projectId: manifest.projectId,
    providerId: manifest.providerId,
    title: manifest.title,
  };
}

function parseReplayCaptureListResult(value: unknown) {
  return hostDaemonCommandResultSchemaByType["replay.capture_list"].parse(
    value,
  );
}

function parseReplayCaptureGetResult(value: unknown): ReplayCaptureManifest {
  return hostDaemonCommandResultSchemaByType["replay.capture_get"].parse(value);
}

function isReplayCaptureNotFound(error: unknown): boolean {
  return (
    error instanceof ApiError && error.body.code === "replay_capture_not_found"
  );
}

async function listHostCaptures(
  deps: AppDeps,
  hostId: string,
): Promise<ReplayCaptureHostSummary[]> {
  const result = parseReplayCaptureListResult(
    await queueCommandAndWait(deps, {
      hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "replay.capture_list",
      },
    }),
  );
  return result.captures.map((capture): ReplayCaptureHostSummary => {
    const enrichment = loadCaptureEnrichment(deps, {
      projectId: capture.projectId,
      threadId: capture.threadId,
    });
    return {
      ...capture,
      hostId,
      title: enrichment.title,
      projectName: enrichment.projectName,
    };
  });
}

async function listCaptures(
  deps: AppDeps,
): Promise<ReplayCaptureHostSummary[]> {
  const hostIds = [...new Set(listConnectedHostIds(deps.db))];
  const perHostCaptures = await Promise.all(
    hostIds.map(async (hostId) => {
      try {
        return await listHostCaptures(deps, hostId);
      } catch (error) {
        deps.logger.warn(
          { err: error, hostId },
          "Skipping replay captures from host after capture list command failed",
        );
        return [];
      }
    }),
  );

  return perHostCaptures
    .flat()
    .sort((left, right) => right.capturedAt - left.capturedAt);
}

async function getHostCapture(
  deps: AppDeps,
  hostId: string,
  captureId: string,
): Promise<ReplayCaptureDetail> {
  const manifest = parseReplayCaptureGetResult(
    await queueCommandAndWait(deps, {
      hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "replay.capture_get",
        captureId,
      },
    }),
  );
  const enrichment = loadCaptureEnrichment(deps, {
    projectId: manifest.projectId,
    threadId: manifest.threadId,
  });
  return toDetail(hostId, manifest, enrichment);
}

async function findCapture(
  deps: AppDeps,
  captureId: string,
): Promise<ReplayCaptureDetail> {
  requireReplayCaptureId(captureId);

  let firstUnexpectedError: Error | null = null;
  for (const hostId of new Set(listConnectedHostIds(deps.db))) {
    try {
      return await getHostCapture(deps, hostId, captureId);
    } catch (error) {
      if (isReplayCaptureNotFound(error)) {
        continue;
      }
      deps.logger.warn(
        { err: error, captureId, hostId },
        "Failed to resolve replay capture from host",
      );
      if (!firstUnexpectedError) {
        firstUnexpectedError =
          error instanceof Error
            ? error
            : new Error("Unexpected replay capture resolution failure");
      }
    }
  }

  if (firstUnexpectedError) {
    throw firstUnexpectedError;
  }
  throw new ApiError(
    404,
    "replay_capture_not_found",
    "Replay capture not found",
  );
}

async function deleteCapture(
  deps: AppDeps,
  captureId: string,
): Promise<void> {
  requireReplayCaptureId(captureId);

  let firstUnexpectedError: Error | null = null;
  let deleted = false;
  for (const hostId of new Set(listConnectedHostIds(deps.db))) {
    try {
      await queueCommandAndWait(deps, {
        hostId,
        timeoutMs: COMMAND_TIMEOUT_MS,
        command: {
          type: "replay.capture_delete",
          captureId,
        },
      });
      deleted = true;
    } catch (error) {
      if (isReplayCaptureNotFound(error)) {
        continue;
      }
      deps.logger.warn(
        { err: error, captureId, hostId },
        "Failed to delete replay capture on host",
      );
      if (!firstUnexpectedError) {
        firstUnexpectedError =
          error instanceof Error
            ? error
            : new Error("Unexpected replay capture delete failure");
      }
    }
  }

  if (deleted) {
    return;
  }
  if (firstUnexpectedError) {
    throw firstUnexpectedError;
  }
  throw new ApiError(
    404,
    "replay_capture_not_found",
    "Replay capture not found",
  );
}

export function registerDevelopmentOnlyReplayRoutes(
  app: Hono,
  deps: AppDeps,
): void {
  const { del, get, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  get("/development-only/replay/captures", async (context) => {
    return context.json({ captures: await listCaptures(deps) });
  });

  del("/development-only/replay/captures/:id", async (context) => {
    await deleteCapture(deps, context.req.param("id"));
    return context.json({ ok: true as const });
  });

  post(
    "/development-only/replay/captures/:id/runs",
    replayRunRequestSchema,
    async (context, payload) => {
      const manifest = await findCapture(deps, context.req.param("id"));
      const resolved = resolveManifestReplayTarget(manifest);
      const environment = getEnvironment(deps.db, resolved.environmentId);
      if (!environment) {
        throw new ApiError(
          404,
          "environment_not_found",
          "Replay environment not found",
        );
      }
      if (environment.hostId !== resolved.hostId) {
        throw new ApiError(
          409,
          "replay_capture_host_mismatch",
          "Replay capture belongs to a different host than its environment",
        );
      }
      if (environment.projectId !== resolved.projectId) {
        throw new ApiError(
          409,
          "replay_capture_project_mismatch",
          "Replay capture belongs to a different project than its environment",
        );
      }
      const session = await ensureHostSessionReadyForWork(deps, {
        hostId: resolved.hostId,
      });
      const replayThread = createThread(deps.db, deps.hub, {
        projectId: resolved.projectId,
        environmentId: resolved.environmentId,
        providerId: resolved.providerId,
        status: "created",
        title: `[Replay] ${resolved.title ?? manifest.captureId}`,
      });
      try {
        appendClientTurnEvent(deps, {
          threadId: replayThread.id,
          environmentId: resolved.environmentId,
          type: "client/turn/requested",
          input: manifest.userInput,
          execution: manifest.execution,
          initiator: "user",
          requestMethod:
            manifest.kind === "thread-start" ? "thread/start" : "turn/start",
          source: "tell",
          target: { kind: "new-turn" },
        });
        const command = queueCommand(deps.db, deps.hub, {
          hostId: resolved.hostId,
          sessionId: session.id,
          type: "replay.run",
          payload: JSON.stringify({
            type: "replay.run",
            captureId: manifest.captureId,
            environmentId: resolved.environmentId,
            threadId: replayThread.id,
            speed: payload.speed,
          }),
        });
        return context.json(
          {
            commandId: command.id,
            replayThreadId: replayThread.id,
            projectId: replayThread.projectId,
          },
          201,
        );
      } catch (error) {
        deleteThread(deps.db, deps.hub, replayThread.id);
        throw error;
      }
    },
  );
}
