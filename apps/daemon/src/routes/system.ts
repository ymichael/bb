import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type {
  AvailableModel,
  SystemEnvironmentInfo,
  SystemProviderInfo,
  SystemStatus,
  ThreadOrchestrator,
} from "@beanbag/agent-core";
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

const openPathSchema = z.object({
  path: z.string().min(1),
});

function openPathInEditor(path: string): void {
  const platform = process.platform;
  const command =
    platform === "darwin"
      ? "open"
      : platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args =
    platform === "darwin"
      ? [path]
      : platform === "win32"
        ? ["/c", "start", "", path]
        : [path];

  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export function createSystemRoutes(
  threadManager: ThreadOrchestrator,
  startTime: number,
  pickFolder: PickFolderFn = pickFolderPath,
  listModels: ListModelsFn = () => threadManager.listModels(),
  getProviderInfo: ProviderInfoFn = () => threadManager.getProviderInfo(),
  listProviders: ProviderCatalogFn = () => threadManager.listProviders(),
  getEnvironmentInfo: EnvironmentInfoFn = () => threadManager.getEnvironmentInfo(),
  listEnvironments: EnvironmentCatalogFn = () => threadManager.listEnvironments(),
  transcribeVoice: TranscribeVoiceFn = transcribeVoiceInput,
) {
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
        openPathInEditor(targetPath);
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
    });
}
