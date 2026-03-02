import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type {
  AvailableModel,
  OpenPathEditor,
  OpenPathRequest,
  Thread,
  SystemEnvironmentInfo,
  SystemProviderInfo,
  SystemStatus,
  ThreadOrchestrator,
} from "@beanbag/agent-core";
import { assertNever } from "@beanbag/agent-core";
import { pickFolderPath } from "../folder-picker.js";
import { invalidRequestError } from "../domain-errors.js";
import { sendRouteError } from "./error-response.js";
import {
  type TranscribeVoiceInputArgs,
  type TranscribeVoiceInputResult,
  transcribeVoiceInput,
} from "../voice-transcription.js";

type PickFolderFn = () => Promise<string | null>;
type ListModelsFn = () => Promise<AvailableModel[]>;
type ProviderInfoFn = () => SystemProviderInfo;
type ProviderCatalogFn = () => SystemProviderInfo[];
type EnvironmentInfoFn = () => SystemEnvironmentInfo;
type EnvironmentCatalogFn = () => SystemEnvironmentInfo[];
type TranscribeVoiceFn = (
  args: TranscribeVoiceInputArgs,
) => Promise<TranscribeVoiceInputResult>;
type OpenPathFn = (args: OpenPathRequest) => void;
type RequestShutdownFn = (reason: string) => void;

export interface CreateSystemRoutesOptions {
  pickFolder?: PickFolderFn;
  listModels?: ListModelsFn;
  getProviderInfo?: ProviderInfoFn;
  listProviders?: ProviderCatalogFn;
  getEnvironmentInfo?: EnvironmentInfoFn;
  listEnvironments?: EnvironmentCatalogFn;
  transcribeVoice?: TranscribeVoiceFn;
  openPath?: OpenPathFn;
  requestShutdown?: RequestShutdownFn;
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

const RESTART_POLICY_BY_STATUS: Record<Thread["status"], string> = {
  created: "reprovision",
  provisioning: "mark-provisioning-failed",
  active: "attempt-resume-or-idle",
  idle: "noop",
  provisioning_failed: "noop",
};

function isShutdownBlockingStatus(status: Thread["status"]): boolean {
  switch (status) {
    case "created":
    case "provisioning":
    case "active":
      return true;
    case "idle":
    case "provisioning_failed":
      return false;
    default:
      return assertNever(status);
  }
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

function openPathInEditor(request: OpenPathRequest): void {
  const path = request.path;
  const customCommand = request.command?.trim();

  if (customCommand) {
    const quotedPath = JSON.stringify(path);
    const commandWithPath = customCommand.includes("{path}")
      ? customCommand.replaceAll("{path}", quotedPath)
      : `${customCommand} ${quotedPath}`;
    const result = spawnSync(commandWithPath, {
      stdio: "ignore",
      shell: true,
    });
    if (result.error) {
      throw result.error;
    }
    if ((result.status ?? 0) !== 0) {
      throw new Error(`Open command failed: ${customCommand}`);
    }
    return;
  }

  const editor = request.editor ?? "system_default";

  const editorCommand = toEditorCommand(editor);
  if (editorCommand) {
    const editorResult = spawnSync(editorCommand, [path], { stdio: "ignore" });
    if (editorResult.error) {
      throw editorResult.error;
    }
    if ((editorResult.status ?? 0) !== 0) {
      throw new Error(`Editor command failed: ${editorCommand}`);
    }
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
  const result = spawnSync(command, commandArgs, { stdio: "ignore" });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 0) !== 0) {
    throw new Error(`Failed to open path: ${path}`);
  }
}

export function createSystemRoutes(
  threadManager: ThreadOrchestrator,
  startTime: number,
  opts: CreateSystemRoutesOptions = {},
) {
  const pickFolder = opts.pickFolder ?? pickFolderPath;
  const listModels = opts.listModels ?? (() => threadManager.listModels());
  const getProviderInfo = opts.getProviderInfo ?? (() => threadManager.getProviderInfo());
  const listProviders = opts.listProviders ?? (() => threadManager.listProviders());
  const getEnvironmentInfo = opts.getEnvironmentInfo ?? (() => threadManager.getEnvironmentInfo());
  const listEnvironments = opts.listEnvironments ?? (() => threadManager.listEnvironments());
  const transcribeVoice = opts.transcribeVoice ?? transcribeVoiceInput;
  const openPath = opts.openPath ?? openPathInEditor;
  const requestShutdown = opts.requestShutdown ?? (() => {});

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
          return c.json({ error: "Expected multipart file field named 'file'" }, 400);
        }
        const promptField = body.prompt;
        const prompt = typeof promptField === "string" ? promptField : undefined;
        const transcription = await transcribeVoice({ file, prompt });
        return c.json(transcription, 200);
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/models", async (c) => {
      try {
        const models = await listModels();
        return c.json(models);
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/provider", async (c) => {
      try {
        return c.json(getProviderInfo());
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/providers", async (c) => {
      try {
        return c.json(listProviders());
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/environment", async (c) => {
      try {
        return c.json(getEnvironmentInfo());
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
      return c.json({
        restartPolicyByStatus: RESTART_POLICY_BY_STATUS,
        shutdownBlockingStatuses: ["created", "provisioning", "active"] as const,
      });
    })
    .post("/shutdown", async (c) => {
      try {
        const bodyRaw = await c.req.json<unknown>().catch(() => ({}));
        const parsed = shutdownRequestSchema.safeParse(bodyRaw);
        if (!parsed.success) {
          throw invalidRequestError("Invalid shutdown request body");
        }
        const force = parsed.data.force === true;
        const blockingThreads = threadManager
          .list({ includeArchived: false })
          .filter((thread) => isShutdownBlockingStatus(thread.status))
          .map((thread) => ({
            id: thread.id,
            status: thread.status,
            projectId: thread.projectId,
          }));
        if (!force && blockingThreads.length > 0) {
          return c.json({
            code: "shutdown_blocked",
            message: "Daemon shutdown blocked by active thread work",
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
    });
}
