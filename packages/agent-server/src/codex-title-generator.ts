import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { PromptInput } from "@beanbag/agent-core";
import type { ProviderTitleGeneratorArgs } from "./provider-adapter.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PROMPT_CHARS = 1200;
const MAX_THREAD_NAME_LENGTH = 38;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeEventType(value: string): string {
  return value.toLowerCase().replaceAll(".", "/");
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function collectTextFragments(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (value.length > 0) out.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectTextFragments(entry, out);
    }
    return;
  }

  const record = asRecord(value);
  if (!record) return;
  const candidates = [record.delta, record.text, record.content, record.value];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    collectTextFragments(candidate, out);
  }
}

function extractPromptText(input: PromptInput[]): string {
  const textParts: string[] = [];
  for (const chunk of input) {
    if (chunk.type !== "text") continue;
    const trimmed = chunk.text.trim();
    if (!trimmed) continue;
    textParts.push(trimmed);
  }
  return textParts.join("\n\n");
}

function cleanPromptText(value: string): string {
  if (!value) return "";

  const withoutImages = value.replace(/\[image(?: x\d+)?\]/gi, " ");
  const withoutSkills = withoutImages.replace(
    /(^|\s)\$[A-Za-z0-9_-]+(?=\s|$)/g,
    " ",
  );
  const normalized = withoutSkills.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_PROMPT_CHARS) {
    return normalized;
  }
  return normalized.slice(0, MAX_PROMPT_CHARS);
}

function buildRunMetadataPrompt(cleanedPrompt: string): string {
  return (
    "You create concise run metadata for a coding task.\n" +
    "Return ONLY a JSON object with keys:\n" +
    "- title: short, clear, 3-7 words, Title Case\n" +
    "- worktreeName: lower-case, kebab-case slug prefixed with one of: feat/, fix/, chore/, test/, docs/, refactor/, perf/, build/, ci/, style/.\n\n" +
    "Choose fix/ when the task is a bug fix, error, regression, crash, or cleanup. Use the closest match for chores/tests/docs/refactors/perf/build/ci/style. Otherwise use feat/.\n\n" +
    "Examples:\n" +
    "{\"title\":\"Fix Login Redirect Loop\",\"worktreeName\":\"fix/login-redirect-loop\"}\n" +
    "{\"title\":\"Add Workspace Home View\",\"worktreeName\":\"feat/workspace-home\"}\n" +
    "{\"title\":\"Update Lint Config\",\"worktreeName\":\"chore/update-lint-config\"}\n" +
    "{\"title\":\"Add Coverage Tests\",\"worktreeName\":\"test/add-coverage-tests\"}\n\n" +
    `Task:\n${cleanedPrompt}`
  );
}

function extractJsonValue(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function clampThreadTitle(title: string): string | undefined {
  const normalized = title.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= MAX_THREAD_NAME_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_THREAD_NAME_LENGTH)}…`;
}

function parseRunMetadataTitle(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const payload = extractJsonValue(trimmed);
  if (!payload) return undefined;

  const title = typeof payload.title === "string" ? payload.title : "";
  return clampThreadTitle(title);
}

function extractThreadIdFromResult(result: unknown): string | undefined {
  const payload = asRecord(result);
  if (!payload) return undefined;

  if (typeof payload.threadId === "string" && payload.threadId.trim().length > 0) {
    return payload.threadId;
  }

  const thread = asRecord(payload.thread);
  if (thread && typeof thread.id === "string" && thread.id.trim().length > 0) {
    return thread.id;
  }

  return undefined;
}

export async function generateCodexThreadTitle(
  args: ProviderTitleGeneratorArgs,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string | undefined> {
  const rawPrompt = extractPromptText(args.input);
  const cleanedPrompt = cleanPromptText(rawPrompt);
  if (!cleanedPrompt) return undefined;

  const metadataPrompt = buildRunMetadataPrompt(cleanedPrompt);
  const child = spawn("codex", ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: args.cwd,
  });

  if (!child.stdin || !child.stdout) {
    throw new Error("Failed to start codex app-server.");
  }

  const readline = createInterface({ input: child.stdout });
  let requestId = 0;
  let isClosed = false;
  let completionSettled = false;
  let responseText = "";
  let sawDelta = false;

  const pending = new Map<
    number,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const settleCompletion = (error?: Error): void => {
    if (completionSettled) return;
    completionSettled = true;
    if (error) {
      rejectCompletion(error);
      return;
    }
    resolveCompletion();
  };

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
    if (!completionSettled) {
      settleCompletion(new Error(`Failed to start codex app-server: ${err.message}`));
    }
    rejectPending(new Error(`Failed to start codex app-server: ${err.message}`));
  });

  child.once("exit", (code, signal) => {
    if (completionSettled || isClosed) return;
    const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
    const error = new Error(`codex app-server exited before title generation (${reason}).`);
    settleCompletion(error);
    rejectPending(error);
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
    if (!message) return;

    if (typeof message.id === "number") {
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
      return;
    }

    if (typeof message.method !== "string") return;

    const method = normalizeEventType(message.method);
    const params = message.params;

    if (method === "item/agentmessage/delta") {
      const chunks: string[] = [];
      collectTextFragments(params, chunks);
      if (chunks.length > 0) {
        responseText += chunks.join("");
        sawDelta = true;
      }
      return;
    }

    if (method === "item/completed" && !sawDelta) {
      const payload = asRecord(params);
      const item = asRecord(payload?.item);
      const typeToken =
        typeof item?.type === "string" ? normalizeToken(item.type) : "";
      if (typeToken !== "agentmessage") return;

      const chunks: string[] = [];
      collectTextFragments(item?.text, chunks);
      if (chunks.length === 0) {
        collectTextFragments(item?.content, chunks);
      }
      const text = chunks.join("");
      if (text) {
        responseText = text;
      }
      return;
    }

    if (method === "turn/error") {
      const payload = asRecord(params);
      const error =
        typeof payload?.error === "string"
          ? payload.error
          : typeof payload?.message === "string"
            ? payload.message
            : "Turn failed during metadata generation.";
      settleCompletion(new Error(error));
      return;
    }

    if (method === "turn/completed" || method === "turn/end") {
      settleCompletion();
    }
  });

  const sendRequest = (
    method: string,
    params: Record<string, unknown>,
    requestTimeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> => {
    if (isClosed) {
      return Promise.reject(new Error("codex app-server is not running."));
    }

    const id = ++requestId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for codex response to ${method}.`));
      }, requestTimeoutMs);

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

    const startResult = await sendRequest("thread/start", {
      approvalPolicy: "never",
      cwd: args.cwd,
    });
    const providerThreadId = extractThreadIdFromResult(startResult);
    if (!providerThreadId) {
      throw new Error("Failed to resolve thread ID for metadata generation.");
    }

    await sendRequest("turn/start", {
      threadId: providerThreadId,
      input: [{ type: "text", text: metadataPrompt }],
      cwd: args.cwd,
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly" },
    });

    await Promise.race([
      completion,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Timed out waiting for metadata generation.")),
          timeoutMs,
        ),
      ),
    ]);

    try {
      await sendRequest("thread/archive", { threadId: providerThreadId }, 5_000);
    } catch {
      // Best-effort cleanup only.
    }

    return parseRunMetadataTitle(responseText);
  } finally {
    close();
    rejectPending(new Error("codex app-server request closed."));
  }
}

