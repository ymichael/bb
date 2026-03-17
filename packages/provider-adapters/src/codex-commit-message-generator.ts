import { spawn } from "node:child_process";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { renderTemplate } from "@bb/templates";
import type { LlmCommitMessageGenerationArgs } from "./llm-completion.js";
import { generateOpenAIResponsesText } from "./openai-responses-model.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PATCH_CHARS = 12_000;
const MAX_OUTPUT_CHARS = 120;
const COMMIT_MESSAGE_MAX_OUTPUT_TOKENS = 120;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function runGit(
  cwd: string,
  args: string[],
  envOverrides?: Record<string, string>,
): Promise<string> {
  return await new Promise((resolveResult) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      ...(envOverrides ? { env: { ...process.env, ...envOverrides } } : {}),
    });
    let stdout = "";
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => resolveResult(""));
    child.on("close", (code) => {
      if (code !== 0) {
        resolveResult("");
        return;
      }
      resolveResult(stdout.trim());
    });
  });
}

function buildPrompt(args: {
  shortstat: string;
  files: string;
  patch: string;
  diffDescription: string;
}): string {
  return renderTemplate("codexCommitMessage", {
    diffDescription: args.diffDescription,
    files: args.files || "(none)",
    patch: args.patch || "(none)",
    shortstat: args.shortstat || "(none)",
  });
}

interface CommitDiffSnapshot {
  shortstat: string;
  files: string;
  patch: string;
}

async function readStagedSnapshot(
  cwd: string,
  envOverrides?: Record<string, string>,
): Promise<CommitDiffSnapshot> {
  return {
    files: await runGit(cwd, ["diff", "--cached", "--name-status"], envOverrides),
    shortstat: await runGit(cwd, ["diff", "--cached", "--shortstat"], envOverrides),
    patch: await runGit(cwd, ["diff", "--cached", "--unified=0", "--no-color"], envOverrides),
  };
}

async function withSyntheticIndexSnapshot(cwd: string): Promise<CommitDiffSnapshot | undefined> {
  const gitIndexPathRaw = await runGit(cwd, ["rev-parse", "--git-path", "index"]);
  if (!gitIndexPathRaw) return undefined;

  const gitIndexPath = isAbsolute(gitIndexPathRaw)
    ? gitIndexPathRaw
    : resolve(cwd, gitIndexPathRaw);
  const tempDir = await mkdtemp(join(tmpdir(), "bb-commit-msg-"));
  const tempIndexPath = join(tempDir, "index");

  try {
    await stat(gitIndexPath).then(() => copyFile(gitIndexPath, tempIndexPath)).catch(() => {});
    const envOverrides = { GIT_INDEX_FILE: tempIndexPath };
    await runGit(cwd, ["add", "-A"], envOverrides);
    return await readStagedSnapshot(cwd, envOverrides);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
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

export function extractConventionalCommitLine(raw: string): string | undefined {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "```" && line !== "```json");

  const conventionalCommitPattern = /^(feat|fix|refactor|test|docs|chore|perf|build|ci|style)(\([^)]+\))?!?:\s+\S/i;
  for (const line of lines) {
    if (!conventionalCommitPattern.test(line)) continue;
    return normalizeCommitMessage(line);
  }
  return undefined;
}

function shouldSuppressCommitMessageGenerationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const normalizedMessage = error.message.toLowerCase();
  return (
    normalizedMessage.includes("openai api key is missing") ||
    normalizedMessage.includes("openai auth is missing") ||
    normalizedMessage.includes("timed out")
  );
}

export async function generateCodexCommitMessage(
  args: LlmCommitMessageGenerationArgs,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string | undefined> {
  const includeUnstaged = args.includeUnstaged !== false;
  const snapshot = includeUnstaged
    ? await withSyntheticIndexSnapshot(args.cwd) ?? await readStagedSnapshot(args.cwd)
    : await readStagedSnapshot(args.cwd);
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

  try {
    const result = await generateOpenAIResponsesText({
      prompt,
      timeoutMs,
      maxOutputTokens: COMMIT_MESSAGE_MAX_OUTPUT_TOKENS,
      temperature: 0,
    });
    const raw = result.text.trim();
    const parsed = extractJsonValue(raw);
    return normalizeCommitMessage(parsed?.message) ?? extractConventionalCommitLine(raw);
  } catch (error) {
    if (shouldSuppressCommitMessageGenerationError(error)) {
      return undefined;
    }
    throw error;
  }
}
