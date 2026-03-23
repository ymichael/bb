import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AvailableModel } from "@bb/domain";
import { z } from "zod";
import { asRecord } from "../shared/parse-utils.js";

const DEFAULT_TIMEOUT_MS = 10_000;

const reasoningLevelSchema = z.enum(["low", "medium", "high", "xhigh"]);

const reasoningEffortOptionSchema = z.object({
  reasoningEffort: reasoningLevelSchema,
  description: z.string(),
}).passthrough();

const DEFAULT_REASONING_EFFORTS: z.infer<typeof reasoningEffortOptionSchema>[] = [
  { reasoningEffort: "low", description: "Low reasoning effort" },
  { reasoningEffort: "medium", description: "Medium reasoning effort" },
  { reasoningEffort: "high", description: "High reasoning effort" },
  { reasoningEffort: "xhigh", description: "Extra high reasoning effort" },
];

const codexModelSchema = z.object({
  id: z.string(),
  model: z.string(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
  supportedReasoningEfforts: z.array(reasoningEffortOptionSchema).optional(),
  defaultReasoningEffort: reasoningLevelSchema.optional(),
}).passthrough();

const codexModelListResponseSchema = z.object({
  data: z.array(codexModelSchema),
}).passthrough();

function toAvailableModel(raw: z.infer<typeof codexModelSchema>): AvailableModel {
  const efforts = raw.supportedReasoningEfforts?.length
    ? raw.supportedReasoningEfforts
    : DEFAULT_REASONING_EFFORTS;

  return {
    id: raw.id,
    model: raw.model,
    displayName: raw.displayName ?? raw.model,
    description: raw.description ?? "",
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort: raw.defaultReasoningEffort ?? efforts[0].reasoningEffort,
    isDefault: raw.isDefault ?? false,
  };
}

function parseModelsResponse(result: unknown): AvailableModel[] {
  const parsed = codexModelListResponseSchema.safeParse(result);
  if (!parsed.success) {
    throw new Error("Invalid response from codex model/list.");
  }

  const models = parsed.data.data.map(toAvailableModel);

  if (models.length === 0) {
    throw new Error("Codex model/list returned no supported models.");
  }

  return models;
}

export async function listCodexModels(
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<AvailableModel[]> {
  const child = spawn("codex", ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (!child.stdin || !child.stdout) {
    throw new Error("Failed to start codex app-server.");
  }

  const readline = createInterface({ input: child.stdout });
  let requestId = 0;
  let isClosed = false;

  const pending = new Map<
    number,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  const rejectPending = (error: Error): void => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  };

  const close = (): void => {
    if (isClosed) return;
    isClosed = true;
    readline.close();
    if (!child.stdin.destroyed) {
      child.stdin.end();
    }
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, 1000).unref();
    }
  };

  child.once("error", (err) => {
    if (isClosed) return;
    isClosed = true;
    rejectPending(new Error(`Failed to start codex app-server: ${err.message}`));
  });

  child.once("exit", (code, signal) => {
    if (isClosed) return;
    isClosed = true;
    const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
    rejectPending(new Error(`codex app-server exited before model/list (${reason}).`));
  });

  readline.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }

    const message = asRecord(parsed);
    if (!message || typeof message.id !== "number") return;

    const request = pending.get(message.id);
    if (!request) return;

    clearTimeout(request.timeout);
    pending.delete(message.id);

    const errorObj = asRecord(message.error);
    if (errorObj && typeof errorObj.message === "string") {
      request.reject(new Error(errorObj.message));
      return;
    }

    request.resolve(message.result);
  });

  const sendRequest = (
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> => {
    if (isClosed) {
      return Promise.reject(new Error("codex app-server is not running."));
    }

    const id = ++requestId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for codex response to ${method}.`));
      }, timeoutMs);

      pending.set(id, { resolve, reject, timeout });

      const message = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });

      child.stdin!.write(`${message}\n`, (error) => {
        if (!error) return;
        clearTimeout(timeout);
        pending.delete(id);
        reject(new Error(`Failed to send ${method} request: ${error.message}`));
      });
    });
  };

  try {
    await sendRequest("initialize", {
      clientInfo: {
        name: "bb-server",
        version: "0.0.1",
      },
    });

    const result = await sendRequest("model/list", {});
    return parseModelsResponse(result);
  } finally {
    close();
    rejectPending(new Error("codex app-server request closed."));
  }
}
