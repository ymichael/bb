import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type {
  AvailableModel,
  ServerRuntimeMode,
  OpenPathEditor,
  OpenPathRequest,
  SystemEnvironmentInfo,
  SystemHealthReport,
  SystemProviderInfo,
  Thread,
  SystemStatus,
  ThreadOrchestrator,
} from "@bb/core";
import { assertNever } from "@bb/core";
import { pickFolderPath } from "../folder-picker.js";
import { invalidRequestError } from "../domain-errors.js";
import { sendRouteError } from "./error-response.js";
import {
  type TranscribeVoiceInputArgs,
  type TranscribeVoiceInputResult,
  transcribeVoiceInput,
} from "../voice-transcription.js";

type PickFolderFn = () => Promise<string | null>;
type ListModelsFn = (
  providerId?: string,
  environmentId?: string,
) => Promise<AvailableModel[]>;
type ProviderInfoFn = (environmentId?: string) => Promise<SystemProviderInfo>;
type ProviderCatalogFn = (environmentId?: string) => Promise<SystemProviderInfo[]>;
type EnvironmentCatalogFn = () => SystemEnvironmentInfo[];
type TranscribeVoiceFn = (
  args: TranscribeVoiceInputArgs,
) => Promise<TranscribeVoiceInputResult>;
type OpenPathFn = (args: OpenPathRequest) => void;
type RequestShutdownFn = (reason: string) => void;
type RequestRestartFn = (reason: string) => void;
type ShouldRestartFn = () => boolean;
type RuntimeModeFn = () => ServerRuntimeMode;
type HealthReportFn = () => SystemHealthReport | Promise<SystemHealthReport>;

export interface CreateSystemRoutesOptions {
  pickFolder?: PickFolderFn;
  listModels?: ListModelsFn;
  getProviderInfo?: ProviderInfoFn;
  listProviders?: ProviderCatalogFn;
  listEnvironments?: EnvironmentCatalogFn;
  transcribeVoice?: TranscribeVoiceFn;
  openPath?: OpenPathFn;
  requestShutdown?: RequestShutdownFn;
  requestRestart?: RequestRestartFn;
  shouldRestart?: ShouldRestartFn;
  getRuntimeMode?: RuntimeModeFn;
  getHealthReport?: HealthReportFn;
}

const openPathSchema = z.object({
  path: z.string().min(1),
  target: z.enum(["file", "directory"]).optional(),
  editor: z.enum(["system_default", "vscode", "cursor", "zed", "windsurf"]).optional(),
  command: z.string().min(1).optional(),
});

const shutdownRequestSchema = z.object({
  force: z.boolean().optional(),
});

const modelsQuerySchema = z.object({
  providerId: z.string().min(1).optional(),
  environmentId: z.string().min(1).optional(),
});

const providerCatalogQuerySchema = z.object({
  environmentId: z.string().min(1).optional(),
});

const RESTART_POLICY_BY_STATUS: Record<Thread["status"], string> = {
  created: "noop",
  provisioning: "noop",
  provisioned: "noop",
  error: "noop",
  active: "noop",
  idle: "noop",
  provisioning_failed: "noop",
};

function isShutdownBlockingStatus(status: Thread["status"]): boolean {
  switch (status) {
    case "created":
    case "provisioning":
    case "provisioned":
    case "active":
      return true;
    case "idle":
    case "error":
    case "provisioning_failed":
      return false;
    default:
      return assertNever(status);
  }
}

function collectBlockingThreads(threadManager: ThreadOrchestrator): Array<{
  id: string;
  status: Thread["status"];
  projectId: string;
}> {
  return threadManager
    .list({ includeArchived: false })
    .filter((thread) => isShutdownBlockingStatus(thread.status))
    .map((thread) => ({
      id: thread.id,
      status: thread.status,
      projectId: thread.projectId,
    }));
}

function toEditorCommand(editor: OpenPathEditor): string | null {
  switch (editor) {
    case "system_default":
      return null;
    case "vscode":
      return "code";
    case "cursor":
      return "cursor";
    case "zed":
      return "zed";
    case "windsurf":
      return "windsurf";
  }
}

export function openPathInEditor(request: OpenPathRequest): void {
  const path = request.path;
  const customCommand = request.command?.trim();

  if (customCommand) {
    const quotedPath = JSON.stringify(path);
    const commandWithPath = customCommand.includes("{path}")
      ? customCommand.replaceAll("{path}", quotedPath)
      : `${customCommand} ${quotedPath}`;
    const child = spawn(commandWithPath, {
      stdio: "ignore",
      shell: true,
      detached: true,
    });
    child.unref();
    return;
  }

  const editor = request.editor ?? "system_default";

  const editorCommand = toEditorCommand(editor);
  if (editorCommand) {
    const child = spawn(editorCommand, [path], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    return;
  }

  const platform = process.platform;
  const command =
    platform === "darwin"
      ? "open"
      : platform === "win32"
        ? "cmd"
        : "xdg-open";
  const commandArgs =
    platform === "darwin"
      ? [path]
      : platform === "win32"
        ? ["/c", "start", "", path]
        : [path];
  const child = spawn(command, commandArgs, {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}

export function createSystemRoutes(
  threadManager: ThreadOrchestrator,
  startTime: number,
  opts: CreateSystemRoutesOptions = {},
) {
  const pickFolder = opts.pickFolder ?? pickFolderPath;
  const listModels = opts.listModels ?? ((providerId?: string, environmentId?: string) =>
    threadManager.listModels(providerId, environmentId));
  const getProviderInfo = opts.getProviderInfo ?? ((environmentId?: string) =>
    threadManager.getProviderInfo(environmentId));
  const listProviders = opts.listProviders ?? ((environmentId?: string) =>
    threadManager.listProviders(environmentId));
  const listEnvironments = opts.listEnvironments ?? (() => threadManager.listEnvironments());
  const transcribeVoice = opts.transcribeVoice ?? transcribeVoiceInput;
  const openPath = opts.openPath ?? openPathInEditor;
  const requestShutdown = opts.requestShutdown ?? (() => {});
  const requestRestart = opts.requestRestart ?? (() => {});
  const shouldRestart = opts.shouldRestart ?? (() => false);
  const getRuntimeMode = opts.getRuntimeMode ?? (() => "production");
  const getHealthReport = opts.getHealthReport;

  return new Hono()
    .get("/status", async (c) => {
      try {
        const runningThreads = threadManager.getRunningCount();
        const totalThreads = threadManager.list().length;

        const status: SystemStatus = {
          runningThreads,
          totalThreads,
          uptime: Math.floor((Date.now() - startTime) / 1000),
        };

        return c.json(status);
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/health", async (c) => {
      try {
        if (getHealthReport) {
          return c.json(await getHealthReport());
        }

        const threads = threadManager.list({ includeArchived: true });
        const fallbackReport: SystemHealthReport = {
          generatedAt: Date.now(),
          uptime: Math.floor((Date.now() - startTime) / 1000),
          projectCount: 0,
          runningThreads: threadManager.getRunningCount(),
          threadCounts: {
            total: threads.length,
            archived: threads.filter((thread) => thread.archivedAt !== undefined).length,
            created: threads.filter((thread) => thread.status === "created").length,
            provisioning: threads.filter((thread) => thread.status === "provisioning").length,
            provisioned: threads.filter((thread) => thread.status === "provisioned").length,
            provisioningFailed: threads.filter(
              (thread) => thread.status === "provisioning_failed",
            ).length,
            error: threads.filter((thread) => thread.status === "error").length,
            active: threads.filter((thread) => thread.status === "active").length,
            idle: threads.filter((thread) => thread.status === "idle").length,
          },
          environmentDaemon: {
            activeSessionCount: 0,
            activeSessions: [],
          },
          storage: {
            totalBytes: 0,
            buckets: [],
          },
        };
        return c.json(fallbackReport);
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .post("/pick-folder", async (c) => {
      try {
        const path = await pickFolder();
        return c.json({ path });
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .post("/open-path", zValidator("json", openPathSchema), async (c) => {
      try {
        const body = c.req.valid("json");
        const targetPath = body.path.trim();
        if (!isAbsolute(targetPath)) {
          throw invalidRequestError("Path must be absolute");
        }
        if (!existsSync(targetPath)) {
          throw invalidRequestError("Path does not exist");
        }
        openPath({
          path: targetPath,
          target: body.target ?? "file",
          editor: body.editor ?? "system_default",
          command: body.command?.trim() || undefined,
        });
        return c.json({ ok: true });
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .post("/voice-transcription", async (c) => {
      try {
        const body = await c.req.parseBody();
        const file = body.file;
        if (!(file instanceof File)) {
          throw invalidRequestError("Expected multipart file field named 'file'");
        }
        const promptField = body.prompt;
        const prompt = typeof promptField === "string" ? promptField : undefined;
        const transcription = await transcribeVoice({ file, prompt });
        return c.json(transcription, 200);
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/models", zValidator("query", modelsQuerySchema), async (c) => {
      try {
        const { providerId, environmentId } = c.req.valid("query");
        const models = await listModels(providerId, environmentId);
        return c.json(models);
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/provider", zValidator("query", providerCatalogQuerySchema), async (c) => {
      try {
        const { environmentId } = c.req.valid("query");
        return c.json(await getProviderInfo(environmentId));
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/providers", zValidator("query", providerCatalogQuerySchema), async (c) => {
      try {
        const { environmentId } = c.req.valid("query");
        return c.json(await listProviders(environmentId));
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/environments", async (c) => {
      try {
        return c.json(listEnvironments());
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/restart-policy", async (c) => {
      const runtimeMode = getRuntimeMode();
      return c.json({
        runtimeMode,
        restartPolicyByStatus: RESTART_POLICY_BY_STATUS,
        shutdownBlockingStatuses: ["created", "provisioning", "provisioned", "active"] as const,
        shouldRestart: runtimeMode === "development" ? shouldRestart() : false,
      });
    })
    .post("/shutdown", zValidator("json", shutdownRequestSchema), async (c) => {
      try {
        const body = c.req.valid("json");
        const force = body.force === true;
        const blockingThreads = collectBlockingThreads(threadManager);
        if (!force && blockingThreads.length > 0) {
          return c.json({
            code: "shutdown_blocked",
            message: "Server shutdown blocked by active thread work",
            blockingThreads,
          }, 409);
        }

        setTimeout(() => {
          requestShutdown("system/shutdown");
        }, 0);

        return c.json({
          ok: true,
          forced: force,
          blockingThreadsCount: blockingThreads.length,
        });
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .post("/restart", zValidator("json", shutdownRequestSchema), async (c) => {
      try {
        const body = c.req.valid("json");
        const force = body.force === true;
        const blockingThreads = collectBlockingThreads(threadManager);
        if (!force && blockingThreads.length > 0) {
          return c.json({
            code: "shutdown_blocked",
            message: "Server shutdown blocked by active thread work",
            blockingThreads,
          }, 409);
        }

        setTimeout(() => {
          requestRestart("system/restart");
        }, 0);

        return c.json({
          ok: true,
          forced: force,
          blockingThreadsCount: blockingThreads.length,
          restarting: true as const,
        });
      } catch (err) {
        return sendRouteError(c, err);
      }
    });
}
