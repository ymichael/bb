import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ProviderCommitMessageGeneratorArgs } from "./provider-adapter.js";

const DEFAULT_TIMEOUT_MS = 45_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PATCH_CHARS = 12_000;
const MAX_OUTPUT_CHARS = 120;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function runGit(
  cwd: string,
  args: string[],
  envOverrides?: Record<string, string>,
): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
    ...(envOverrides ? { env: { ...process.env, ...envOverrides } } : {}),
  });
  if (result.status !== 0) return "";
  return result.stdout?.trim() ?? "";
}

function normalizeEventType(value: string): string {
  return value.toLowerCase().replaceAll(".", "/");
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

function buildPrompt(args: {
  shortstat: string;
  files: string;
  patch: string;
  diffDescription: string;
}): string {
  return [
    `Write a concise git commit message for ${args.diffDescription}.`,
    "Rules:",
    "- Return ONLY JSON: {\"message\":\"...\"}",
    "- Use conventional commit style (feat|fix|refactor|test|docs|chore|perf|build|ci|style).",
    "- Use imperative mood, max 72 characters.",
    "- Single line only, no body.",
    "",
    "Shortstat:",
    args.shortstat || "(none)",
    "",
    "Files (name-status):",
    args.files || "(none)",
    "",
    "Patch excerpt:",
    args.patch || "(none)",
  ].join("\n");
}

interface CommitDiffSnapshot {
  shortstat: string;
  files: string;
  patch: string;
}

function readStagedSnapshot(
  cwd: string,
  envOverrides?: Record<string, string>,
): CommitDiffSnapshot {
  return {
    files: runGit(cwd, ["diff", "--cached", "--name-status"], envOverrides),
    shortstat: runGit(cwd, ["diff", "--cached", "--shortstat"], envOverrides),
    patch: runGit(cwd, ["diff", "--cached", "--unified=0", "--no-color"], envOverrides),
  };
}

function withSyntheticIndexSnapshot(cwd: string): CommitDiffSnapshot | undefined {
  const gitIndexPathRaw = runGit(cwd, ["rev-parse", "--git-path", "index"]);
  if (!gitIndexPathRaw) return undefined;

  const gitIndexPath = isAbsolute(gitIndexPathRaw)
    ? gitIndexPathRaw
    : resolve(cwd, gitIndexPathRaw);
  const tempDir = mkdtempSync(join(tmpdir(), "beanbag-commit-msg-"));
  const tempIndexPath = join(tempDir, "index");

  try {
    if (existsSync(gitIndexPath)) {
      copyFileSync(gitIndexPath, tempIndexPath);
    }
    const envOverrides = { GIT_INDEX_FILE: tempIndexPath };
    runGit(cwd, ["add", "-A"], envOverrides);
    return readStagedSnapshot(cwd, envOverrides);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
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

function normalizeCommitMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const firstLine = value.split("\n")[0] ?? "";
  const normalized = firstLine.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= MAX_OUTPUT_CHARS) return normalized;
  return normalized.slice(0, MAX_OUTPUT_CHARS).trimEnd();
}

export async function generateCodexCommitMessage(
  args: ProviderCommitMessageGeneratorArgs,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string | undefined> {
  const includeUnstaged = args.includeUnstaged !== false;
  const snapshot = includeUnstaged
    ? withSyntheticIndexSnapshot(args.cwd) ?? readStagedSnapshot(args.cwd)
    : readStagedSnapshot(args.cwd);
  const files = snapshot.files;
  if (!files) return undefined;
  const shortstat = snapshot.shortstat;
  const patchRaw = snapshot.patch;
  const patch = patchRaw.length <= MAX_PATCH_CHARS ? patchRaw : patchRaw.slice(0, MAX_PATCH_CHARS);
  const prompt = buildPrompt({
    shortstat,
    files,
    patch,
    diffDescription: includeUnstaged
      ? "the currently staged + unstaged changes that will be committed"
      : "the currently staged changes",
  });

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

  const pending = new Map<number, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();

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
      }, 1_000).unref();
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
    const error = new Error(`codex app-server exited before commit message generation (${reason}).`);
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

    if (
      method === "item/streamed" ||
      method === "item/updated" ||
      method === "item/completed" ||
      method === "thread/item/updated"
    ) {
      const fragments: string[] = [];
      collectTextFragments(params, fragments);
      if (fragments.length > 0) {
        sawDelta = true;
        responseText += fragments.join("");
      }
      return;
    }

    if (
      method === "turn/completed" ||
      method === "turn/end" ||
      method === "response/completed" ||
      method === "task/completed"
    ) {
      settleCompletion();
    }
  });

  const sendRequest = (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for "${method}" response.`));
      }, REQUEST_TIMEOUT_MS);

      pending.set(id, { resolve, reject, timeout });

      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });
      child.stdin!.write(`${payload}\n`);
    });
  };

  const timeout = setTimeout(() => {
    settleCompletion(new Error(`Timed out after ${timeoutMs}ms.`));
  }, timeoutMs);

  try {
    await sendRequest("initialize", {
      clientInfo: { name: "beanbag", version: "0.0.1" },
      capabilities: {},
    });

    const startResult = await sendRequest("thread/start", {
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
    const payload = asRecord(startResult);
    const threadId = typeof payload?.threadId === "string"
      ? payload.threadId
      : typeof asRecord(payload?.thread)?.id === "string"
        ? String(asRecord(payload?.thread)?.id)
        : undefined;
    if (!threadId) throw new Error("Missing thread id from thread/start.");

    await sendRequest("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }],
    });

    await completion;

    if (!sawDelta && responseText.trim().length === 0) {
      return undefined;
    }

    const parsed = extractJsonValue(responseText.trim());
    return normalizeCommitMessage(parsed?.message);
  } finally {
    clearTimeout(timeout);
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
    }
    pending.clear();
    close();
  }
}
