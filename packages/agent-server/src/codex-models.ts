import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  AvailableModel,
  ModelReasoningEffort,
  ReasoningLevel,
} from "@beanbag/agent-core";

const DEFAULT_TIMEOUT_MS = 10_000;

const DEFAULT_REASONING_EFFORTS: ModelReasoningEffort[] = [
  { reasoningEffort: "low", description: "Low reasoning effort" },
  { reasoningEffort: "medium", description: "Medium reasoning effort" },
  { reasoningEffort: "high", description: "High reasoning effort" },
  { reasoningEffort: "xhigh", description: "Extra high reasoning effort" },
];

function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function toReasoningEfforts(value: unknown): ModelReasoningEffort[] {
  if (!Array.isArray(value)) return [];

  const efforts: ModelReasoningEffort[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    if (!isReasoningLevel(record.reasoningEffort)) continue;

    efforts.push({
      reasoningEffort: record.reasoningEffort,
      description:
        typeof record.description === "string"
          ? record.description
          : `${record.reasoningEffort} reasoning effort`,
    });
  }

  return efforts;
}

function toAvailableModel(value: unknown): AvailableModel | null {
  const record = asRecord(value);
  if (!record) return null;

  const id = typeof record.id === "string" ? record.id : null;
  const model = typeof record.model === "string" ? record.model : null;
  if (!id || !model) return null;

  const supportedReasoningEfforts = toReasoningEfforts(
    record.supportedReasoningEfforts,
  );
  const normalizedEfforts =
    supportedReasoningEfforts.length > 0
      ? supportedReasoningEfforts
      : DEFAULT_REASONING_EFFORTS;

  const defaultReasoningEffort = isReasoningLevel(record.defaultReasoningEffort)
    ? record.defaultReasoningEffort
    : normalizedEfforts[0].reasoningEffort;

  return {
    id,
    model,
    displayName:
      typeof record.displayName === "string" ? record.displayName : model,
    description:
      typeof record.description === "string" ? record.description : "",
    supportedReasoningEfforts: normalizedEfforts,
    defaultReasoningEffort,
    isDefault: record.isDefault === true,
  };
}

function parseModelsResponse(result: unknown): AvailableModel[] {
  const response = asRecord(result);
  if (!response || !Array.isArray(response.data)) {
    throw new Error("Invalid response from codex model/list.");
  }

  const models = response.data
    .map((entry) => toAvailableModel(entry))
    .filter((entry): entry is AvailableModel => entry !== null);

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
        name: "beanbag-daemon",
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
