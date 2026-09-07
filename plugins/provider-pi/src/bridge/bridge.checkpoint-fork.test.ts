import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  FULL_PERMISSION_OPTIONS,
  type FakePiBridgeHarness,
  startFakePiBridge,
} from "./test-support.js";

let harness: FakePiBridgeHarness;
let sessionDir: string;

beforeEach(async () => {
  harness = await startFakePiBridge({
    prefix: "bb-pi-checkpoint-fork-",
    initialize: true,
  });
  sessionDir = harness.sessionDir;
  mkdirSync(sessionDir, { recursive: true });
}, 30_000);

afterEach(async () => {
  await harness.teardown();
}, 30_000);

function assistant(text: string, timestamp: number) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-responses",
    provider: "fake-provider",
    model: "fake-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp,
  };
}

it("branches the source session at the checkpoint and leaves the source untouched", async () => {
  const source = SessionManager.create(harness.workspaceDir, sessionDir);
  source.appendMessage({
    role: "user",
    content: "first question",
    timestamp: 1,
  });
  const checkpointId = source.appendMessage(assistant("first answer", 2));
  source.appendMessage({
    role: "user",
    content: "second question",
    timestamp: 3,
  });
  source.appendMessage(assistant("second answer", 4));
  const sourceFile = join(sessionDir, "thr_ckpt_src.jsonl");
  copyFileSync(source.getSessionFile()!, sourceFile);
  const sourceBefore = readFileSync(sourceFile, "utf8");

  const fork = await harness.request(1, "thread/fork", {
    threadId: "thr_ckpt_fork",
    cwd: harness.workspaceDir,
    sourceProviderThreadId: "thr_ckpt_src",
    sourceProviderCheckpointId: checkpointId,
    options: FULL_PERMISSION_OPTIONS,
    instructionMode: "append",
  });
  expect(fork.result).toMatchObject({
    providerThreadId: "thr_ckpt_fork",
    sessionRestorable: true,
  });

  const forkFile = join(sessionDir, "thr_ckpt_fork.jsonl");
  expect(existsSync(forkFile)).toBe(true);
  const forked = SessionManager.open(
    forkFile,
    sessionDir,
    harness.workspaceDir,
  );
  const texts = forked
    .getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => {
      const message = (entry as { message: { role: string; content: unknown } })
        .message;
      return `${message.role}:${typeof message.content === "string" ? message.content : (message.content as { text: string }[]).map((c) => c.text).join("")}`;
    });
  expect(texts).toEqual(["user:first question", "assistant:first answer"]);
  expect(forked.getLeafId()).toBe(checkpointId);
  expect(readFileSync(sourceFile, "utf8")).toBe(sourceBefore);
}, 30_000);

it("refuses a fork whose source session is missing", async () => {
  const fork = await harness.request(1, "thread/fork", {
    threadId: "thr_ckpt_missing",
    cwd: harness.workspaceDir,
    sourceProviderThreadId: "thr_never_existed",
    options: FULL_PERMISSION_OPTIONS,
    instructionMode: "append",
  });
  expect(fork.error).toMatchObject({
    message: expect.stringContaining("source pi session file not found"),
  });
}, 30_000);
